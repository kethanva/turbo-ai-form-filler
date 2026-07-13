// Converted from modules/ai/llm_manager.py
import { Secrets, loadSecrets, loadPersonals, getPersonalsSync, hasConfiguredApiKeys } from '../config_loader.js';
import { groqCreateClient, groqAnswerQuestion, groqExtractSkills, GroqClient } from './groqConnections.js';
import { huggingfaceCreateClient, huggingfaceAnswerQuestion, huggingfaceExtractSkills, HuggingFaceClient } from './huggingfaceConnections.js';
import { fuzzyAnswerQuestion, fuzzyExtractSkills } from '../fuzzy_matcher.js';
import { printLog, proxyFetch } from '../helpers.js';

interface LLMClients {
  groq: GroqClient | null;
  huggingface: HuggingFaceClient | null;
}

export class LLMManager {
  private clients: LLMClients;
  private providerPriority: string[];
  private fuzzyFallbackEnabled: boolean;
  private cooldownEndTime: Date | null;
  private currentFallbackIndex: number;

  constructor() {
    this.clients = {
      groq: null,
      huggingface: null
    };
    this.providerPriority = ["groq", "huggingface"];
    this.fuzzyFallbackEnabled = true;
    this.cooldownEndTime = null;
    this.currentFallbackIndex = 0;
  }

  /**
   * Removes duplicate items from comma-separated multi-select answers only.
   * Never rewrite free-text sentences that happen to contain commas.
   */
  private deduplicateResponse(answer: string, questionType: string): string {
    if (questionType !== 'multiple_select' && questionType !== 'checkbox') {
      return answer;
    }
    if (!answer.includes(',')) {
      return answer;
    }

    const items = answer.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const uniqueItems = [...new Set(items)];
    if (uniqueItems.length < items.length) {
      printLog(`🔧 Deduplicated multi-select: ${items.length} items → ${uniqueItems.length} unique items`);
      return uniqueItems.join(', ');
    }
    return answer;
  }

  async initializeClients(secrets: Secrets): Promise<void> {
    // Only attempt providers that actually have a key — createClient logs a
    // critical error for missing keys, which is pure noise in fuzzy-only mode.
    const groqKey = (secrets.groq_api_key || '').trim();
    const hfKey = (secrets.huggingface_api_key || '').trim();

    try {
      this.clients.groq = groqKey ? groqCreateClient(secrets) : null;
    } catch (e) {
      printLog(`Failed to init Groq: ${e}`);
    }

    try {
      this.clients.huggingface = hfKey ? huggingfaceCreateClient(secrets) : null;
    } catch (e) {
      printLog(`Failed to init HuggingFace: ${e}`);
    }

    if (!groqKey && !hfKey) {
      printLog('No LLM API keys configured — answers will come from offline fuzzy matching.');
    }
  }

  async getAnswer(
    question: string,
    options?: string[],
    questionType: string = "text",
    jobDescription?: string,
    userInformationAll?: string,
    configContext?: string
  ): Promise<string | null> {
    // Check cooldown
    if (this.cooldownEndTime) {
      if (new Date() < this.cooldownEndTime) {
        printLog(`LLM Cooldown active until ${this.cooldownEndTime}. Using Fuzzy Logic.`);
        return this.fuzzyAnswer(question, options, jobDescription);
      } else {
        printLog("LLM Cooldown ended. Resetting cycle.");
        this.cooldownEndTime = null;
        this.currentFallbackIndex = 0;
      }
    }

    const secrets = await loadSecrets();

    // Fuzzy-only mode: no keys means no provider can ever answer — skip the
    // provider loop entirely instead of erroring per field.
    if (!hasConfiguredApiKeys(secrets)) {
      return this.fuzzyAnswer(question, options, jobDescription);
    }

    const personalsData = getPersonalsSync() || await loadPersonals();

    // Always inject structured Entry arrays when the question targets a repeating section,
    // even if user_information_all is present (free-text alone loses indexing).
    let finalUserInfo = userInformationAll || configContext || JSON.stringify(personalsData);
    const hasEntryRef =
      /\[\s*(?:(?:Position|Education)\s+)?Entry:\s*\d+\s*\]/i.test(question) ||
      /(?:position|education)\s+entry[:\s]*\d+/i.test(question);

    if (hasEntryRef) {
      const experienceData = JSON.stringify(personalsData.experience_details || [], null, 2);
      const educationData = JSON.stringify(personalsData.education_details || [], null, 2);

      finalUserInfo = `
=== STRUCTURED DATA FOR REPEATING SECTIONS ===

**EXPERIENCE_DETAILS** (use for [Position Entry: N] / Work Experience):
${experienceData}

**EDUCATION_DETAILS** (use for [Education Entry: N] / Education):
${educationData}

**CRITICAL INDEXING INSTRUCTIONS:**
- Array indices are 0-based. [Entry: N] / [Position Entry: N] / [Education Entry: N] → index (N - 1).
- [Position Entry: N] → experience_details[N-1]
- [Education Entry: N] → education_details[N-1]
- DO NOT use the first entry if the question asks for Entry 2, 3, etc.
- If the requested index does not exist in the array, return "N/A".

=== General Context ===
${finalUserInfo}
`;
      printLog(`🔧 Injected structured context for Entry-based question: "${question.substring(0, 80)}"`);
    }

    // Try providers in order starting from current fallback index
    for (let i = this.currentFallbackIndex; i < this.providerPriority.length; i++) {
      const provider = this.providerPriority[i];
      let client = this.clients[provider as keyof LLMClients];

      if (!client) {
        // Try to re-init if None
        await this.initializeClients(secrets);
        client = this.clients[provider as keyof LLMClients];
        if (!client) continue;
      }

      //printLog(`Attempting answer with ${provider}...`);
      try {
        let answer: string | null = null;

        if (provider === "groq") {
          answer = await groqAnswerQuestion(
            client as GroqClient,
            question,
            options,
            questionType,
            jobDescription,
            undefined,
            finalUserInfo,
            configContext
          );
        } else if (provider === "huggingface") {
          answer = await huggingfaceAnswerQuestion(
            client as HuggingFaceClient,
            question,
            options,
            questionType,
            jobDescription,
            undefined,
            finalUserInfo,
            configContext
          );
        }

        // Validate answer
        printLog(`🔍 LLM Provider ${provider} raw answer: [${answer}] (type: ${typeof answer})`);
        if (answer && typeof answer === 'string' && answer.trim().length > 0) {
          // Only treat as an error if the whole reply is a short error sentence.
          // Long answers that merely mention "error" are valid content.
          const trimmed = answer.trim();
          const looksLikeApiError =
            trimmed.length < 200 &&
            /^(error|api error|failed|exception)\b[:\s]/i.test(trimmed);
          if (looksLikeApiError) {
            printLog(`LLM Provider ${provider} returned error message: ${trimmed}`);
            continue;
          }

          // Deduplicate only multi-select / checkbox list answers
          const cleanedAnswer = this.deduplicateResponse(answer, questionType);
          return cleanedAnswer;
        } else {
          if (answer === null) {
            printLog(`LLM Provider ${provider} returned None (likely API error)`);
          } else if (typeof answer === 'object') {
            printLog(`LLM Provider ${provider} returned error dict: ${JSON.stringify(answer)}`);
          } else if (!answer || (typeof answer === 'string' && answer.trim().length === 0)) {
            printLog(`LLM Provider ${provider} returned empty answer`);
          }
          continue;
        }
      } catch (e) {
        const errorMsg = String(e);
        if (errorMsg.includes('402') || errorMsg.includes('Insufficient Balance')) {
          printLog(`LLM Provider ${provider} failed: Insufficient balance/payment required`);
        } else if (errorMsg.includes('401') || errorMsg.toLowerCase().includes('authentication')) {
          printLog(`LLM Provider ${provider} failed: Authentication error - check API key`);
        } else if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('rate limit')) {
          printLog(`LLM Provider ${provider} failed: Rate limit exceeded`);
        } else if (errorMsg.toLowerCase().includes('connection') || errorMsg.toLowerCase().includes('timeout')) {
          printLog(`LLM Provider ${provider} failed: Connection/timeout error`);
        } else {
          printLog(`LLM Provider ${provider} failed: ${errorMsg.substring(0, 200)}`);
        }
        continue;
      }
    }

    // If all providers failed
    const anyClientConfigured = !!(this.clients.groq || this.clients.huggingface);
    printLog("All LLM providers failed. Trying Fuzzy Logic.");
    const fuzzyAns = this.fuzzyAnswer(question, options, jobDescription);

    // Only cooldown on real provider failures (rate limits / outages), not missing API keys.
    if (anyClientConfigured) {
      printLog("Activating 2 minute cooldown for LLMs.");
      this.cooldownEndTime = new Date(Date.now() + 2 * 60 * 1000);
    } else {
      printLog("Skipping LLM cooldown — no API clients configured. Add keys in Options.");
    }
    this.currentFallbackIndex = 0;

    if (fuzzyAns && typeof fuzzyAns === 'string' && fuzzyAns.trim().length > 0) {
      return fuzzyAns;
    }

    printLog("Fuzzy Logic also failed to provide an answer.");
    return null;
  }

  // Batch answer multiple questions in a single LLM call for speed.
  // Returns answers keyed by question index to avoid collisions on duplicate labels.
  async getBatchAnswers(
    questionsList: { question: string; options?: string[]; questionType?: string }[],
    jobDescription?: string,
    userInformationAll?: string,
    configContext?: string
  ): Promise<Map<number, string>> {
    const results = new Map<number, string>();

    if (questionsList.length === 0) return results;

    // Honor cooldown — don't hammer APIs that just failed.
    if (this.cooldownEndTime && new Date() < this.cooldownEndTime) {
      printLog(`Batch skipped: LLM cooldown active until ${this.cooldownEndTime}`);
      return results;
    }
    if (this.cooldownEndTime && new Date() >= this.cooldownEndTime) {
      this.cooldownEndTime = null;
      this.currentFallbackIndex = 0;
    }

    // No clients → no provider can answer the batch; per-field fuzzy fallback
    // in the caller handles it. Skip building the (large) batch prompt.
    if (!this.clients.groq && !this.clients.huggingface) {
      printLog('Batch skipped: no LLM clients — falling back to per-field matching.');
      return results;
    }

    // Build a combined prompt for all questions
    const personalsData = getPersonalsSync() || await loadPersonals();
    const userInfo = userInformationAll || configContext || JSON.stringify(personalsData);

    // Explicitly add structured data for repeaters
    const experienceData = JSON.stringify(personalsData.experience_details || [], null, 2);
    const educationData = JSON.stringify(personalsData.education_details || [], null, 2);

    // Dynamic "Present" date — always use the last day of the current year so
    // jobs marked "Present" get a correct end date regardless of when the prompt runs.
    const presentDateStr = `12/31/${new Date().getFullYear()}`;

    let batchPrompt = `You are a helpful assistant filling out a form.

=== PRIMARY DATA SOURCE (USE THIS FOR [Entry: X] QUESTIONS) ===

WORK EXPERIENCE ARRAY (experience_details):
${experienceData}

EDUCATION ARRAY (education_details):
${educationData}

=== CRITICAL INSTRUCTIONS ===

**ARRAY INDEXING (READ THIS CAREFULLY)**:
JavaScript arrays start at index 0. Formula: array[Entry_Number - 1]
- [Position Entry: N] or Work/Professional Experience → experience_details[N-1]
- [Education Entry: N] or Education/School → education_details[N-1]
- Bare [Entry: N] → use experience_details for job fields, education_details for school/degree fields

1. **FOR ANY QUESTION WITH [Entry: X]**: Extract ONLY from the arrays above.
   - Look up array index (Entry_Number - 1) and return that entry's real field values.
   - Job Title → .title | Company/Employer → .companyKey | Location → .location
   - School → .institution | Degree → .degree | Field → .field
   - DO NOT use any data from the "General Context" section below
   - DO NOT invent companies, titles, or dates
   - DO NOT copy example dates from these instructions — only use values from the JSON arrays

2. **ROLE DESCRIPTION / JOB DESCRIPTION / RESPONSIBILITIES**:
   - For "Role Description [Entry: N]", "Job Description", "Responsibilities", or similar:
   - Take experience_details[N-1].highlights and join ALL items as bullet points (one per line)
   - NEVER return only the first highlight
   - NEVER return the job title or company name as the description

3. **DATE FIELDS**: For "Start Date" / "From" or "End Date" / "To" questions:
   - Extract from the matching entry's .from or .to field in the JSON array
   - Normalize to MM/YYYY (e.g. "02-2022" or "2022-02" → "02/2022")
   - If .to is "Present"/"Current"/"Ongoing": return "N/A" for End Date (the "currently work here" checkbox handles it). Do NOT invent ${presentDateStr} or any calendar end date.
   - [Position Entry: N] dates come from experience_details; [Education Entry: N] from education_details
   - NEVER reuse another entry's dates
   - NEVER swap From and To

4. **YEAR FIELDS**: For "Start Year" or "End Year" questions:
   - Extract from the .from or .to field in the JSON array
   - Return only the year portion (e.g., "2021-10" → "2021")

5. **LOCATION FIELDS**: 
   - **IF AND ONLY IF** the question asks for "Location", "City", "Place", or "Address" (specifically for Work/Education):
   - **THEN** return the location from user profile (e.g. "San Francisco, USA").
   - **CRITICAL EXCEPTION**: If the question asks for "Salary", "CTC", "Compensation", or "Pay", SKIP this rule and see Rule 6.
   
6. **SALARY / CTC / COMPENSATION FIELDS**:
   - Look for keywords: "CTC", "Salary", "Compensation", "Remuneration", "Pay".
   - Answer with the **numeric value only** from the user data (e.g. 80000).
   - Do NOT add currency symbols unless asked.
   - Do NOT answer with a city/location.
   
   **EXAMPLES**:
   - "Current CTC?" → "80000"
   - "Expected Salary?" → "85000"
   - "What is your current Location?" → "San Francisco, USA"

7. **NOTICE PERIOD**:
    - "Notice Period" -> Extract from "Notice Period" or "soon_join_us" (e.g. "60 days")

8. **EMPLOYER/UNIVERSITY FIELDS**: Use companyKey or institution from the JSON

9. **VISA / SPONSORSHIP FIELDS**:
   - If question asks about requiring Visa Sponsorship now or in future -> Answer based on user info (e.g., "No" if sponsorship_required is false)
   - If question asks about Work Authorization -> Answer "Yes" if authorized

10. **DEMOGRAPHIC FIELDS (RACE, GENDER, VETERAN, DISABILITY)**:
   - Extract explicitly from user info (e.g. "gender", "veteran_status").
   - If the exact race is not in the JSON but nationality is (e.g. "citizen_of_india": true), you can infer race (e.g., "Asian").
   - If disability status is false, select the option indicating no disability.
   - If information is completely missing and cannot be inferred, answer "Decline To Self Identify" or "I do not wish to answer" instead of "N/A".

11. **IF [Entry: X] is missing**: Return "N/A"

12. **SIGNATURE / PRINTED NAME**:
   - For "Signature", "Signature and Date", "Printed Name", or "Full Legal Name": return the applicant's full name from user info.
   - If the field also asks for a date, append today's date as MM/DD/YYYY.
   - NEVER echo the legal/certification paragraph or question text as the answer.

**CRITICAL INDEXING REMINDER:**
- Array indices are 0-based. [Entry: N] maps to array index (N - 1).
- DO NOT return the entry number literally — look up the actual value in the array.

=== General Context (use only for non-[Entry: X] questions) ===
${userInfo}
`;

    batchPrompt += `

===================================================================

Please answer ALL of the following questions. Format your response as:
Q1: [your answer]
Q2: [your answer]
...and so on.

Questions:
`;

    questionsList.forEach((q, idx) => {
      batchPrompt += `\nQ${idx + 1}: ${q.question}`;
      if (q.options && q.options.length > 0) {
        batchPrompt += ` (Options: ${q.options.join(', ')})`;
      }
    });

    batchPrompt += `\n\nProvide ONLY the answers. You may use multiple lines for an answer if needed (e.g., for descriptions or cover letters). Start each new answer exactly with the Q number (e.g., "Q1: ").`;

    // Helper function to parse LLM response
    const parseResponse = (content: string): void => {
      const lines = content.split('\n');
      const matchedIndices = new Set<number>();
      
      let currentIdx = -1;
      let currentAnswer: string[] = [];

      lines.forEach((line: string) => {
        // Only treat "QN:" as a question boundary.
        // Do NOT match "1. bullet point" — that truncates multi-line role descriptions.
        let match = line.match(/^Q(\d+):\s*(.*)/i);
        if (!match) {
          // Allow "N:" only when N is in range and not already answered (never "N.")
          const alt = line.match(/^(\d+):\s*(.*)/);
          if (alt) {
            const n = parseInt(alt[1], 10);
            if (n >= 1 && n <= questionsList.length && !matchedIndices.has(n - 1) && n - 1 !== currentIdx) {
              match = alt;
            }
          }
        }
        
        if (match) {
          // Save previous answer
          if (currentIdx !== -1 && currentAnswer.length > 0) {
            results.set(currentIdx, currentAnswer.join('\n').trim());
            matchedIndices.add(currentIdx);
          }
          
          currentIdx = parseInt(match[1]) - 1;
          const answerText = match[2].trim();
          currentAnswer = answerText.length > 0 ? [answerText] : [];
        } else if (currentIdx !== -1) {
          // Accumulate multi-line answer for the current question
          currentAnswer.push(line);
        }
      });
      
      // Save the last answer
      if (currentIdx !== -1 && currentAnswer.length > 0) {
        results.set(currentIdx, currentAnswer.join('\n').trim());
        matchedIndices.add(currentIdx);
      }

      // Log unmatched questions for debugging
      const unmatchedQuestions: string[] = [];
      questionsList.forEach((q, idx) => {
        if (!matchedIndices.has(idx)) {
          unmatchedQuestions.push(`Q${idx + 1}: ${q.question.substring(0, 50)}...`);
        }
      });

      if (unmatchedQuestions.length > 0) {
        printLog(`⚠️ Batch parse: ${unmatchedQuestions.length} questions unmatched: ${unmatchedQuestions.slice(0, 3).join('; ')}${unmatchedQuestions.length > 3 ? '...' : ''}`);
      }
    };

    // Try providers in order (Groq first, then HuggingFace)
    for (const provider of this.providerPriority) {
      try {
        const client = this.clients[provider as keyof LLMClients];
        if (!client) continue;


        if (provider === "groq") {
          const response = await proxyFetch((client as GroqClient).api_url, {
            method: 'POST',
            headers: {
              "Authorization": `Bearer ${(client as GroqClient).token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: (client as GroqClient).model,
              messages: [{ role: "user", content: batchPrompt }],
              max_tokens: 2048,
              temperature: 0.1
            })
          });

          if (response.ok) {
            const result = await response.json();
            if (result.choices && result.choices.length > 0) {
              const content = result.choices[0]?.message?.content;
              if (typeof content === 'string' && content.length > 0) {
                parseResponse(content);

                if (results.size > 0) {
                  printLog(`✅ Batch answered ${results.size}/${questionsList.length} questions via ${provider}`);
                  return results;
                }
              }
            }
          } else {
            printLog(`Batch ${provider} failed with status ${response.status}`);
          }
        } else if (provider === "huggingface") {
          const hfClient = client as HuggingFaceClient;
          const response = await proxyFetch(hfClient.api_url, {
            method: 'POST',
            headers: {
              "Authorization": `Bearer ${hfClient.token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: hfClient.model,
              messages: [{ role: "user", content: batchPrompt }],
              max_tokens: 2048,
              temperature: 0.1
            })
          });

          if (response.ok) {
            const result = await response.json();
            if (result.choices && result.choices.length > 0) {
              const content = result.choices[0]?.message?.content;
              if (typeof content === 'string' && content.length > 0) {
                parseResponse(content);

                if (results.size > 0) {
                  printLog(`✅ Batch answered ${results.size}/${questionsList.length} questions via ${provider}`);
                  return results;
                }
              }
            }
          } else {
            printLog(`Batch ${provider} failed with status ${response.status}`);
          }
        }
      } catch (e) {
        printLog(`Batch ${provider} error: ${e}`);
        continue;
      }
    }

    printLog(`⚠️ All batch providers failed. Will fall back to individual LLM calls.`);
    return results;
  }

  async extractSkills(description: string): Promise<any> {
    const secrets = await loadSecrets();

    // Similar fallback logic for skills
    for (const provider of this.providerPriority) {
      const client = this.clients[provider as keyof LLMClients];
      if (!client) continue;

      try {
        if (provider === "groq") {
          return await groqExtractSkills(client as GroqClient, description);
        } else if (provider === "huggingface") {
          return await huggingfaceExtractSkills(client as HuggingFaceClient, description);
        }
      } catch (e) {
        printLog(`Skill extraction with ${provider} failed: ${e}`);
        continue;
      }
    }

    printLog("All LLMs failed for skill extraction. Using Fuzzy extraction.");
    return fuzzyExtractSkills(description);
  }

  private fuzzyAnswer(question: string, options?: string[], jobDescription?: string): string | null {
    return fuzzyAnswerQuestion(question, options, "text", jobDescription || "");
  }
}

// Global Instance
export const llmManager = new LLMManager();

