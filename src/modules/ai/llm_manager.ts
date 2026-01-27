// Converted from modules/ai/llm_manager.py
import { Secrets, loadSecrets, loadPersonals, getPersonalsSync } from '../config_loader.js';
import { groqCreateClient, groqAnswerQuestion, groqExtractSkills, GroqClient } from './groqConnections.js';
import { huggingfaceCreateClient, huggingfaceAnswerQuestion, huggingfaceExtractSkills, HuggingFaceClient } from './huggingfaceConnections.js';
import { fuzzyAnswerQuestion, fuzzyExtractSkills } from '../fuzzy_matcher.js';
import { printLog } from '../helpers.js';

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
   * Removes duplicate items from comma-separated responses (fixes LLM repetition loop)
   */
  private deduplicateResponse(answer: string): string {
    // Check if it looks like a comma-separated list
    if (answer.includes(',')) {
      const items = answer.split(',').map(s => s.trim()).filter(s => s.length > 0);

      // Only deduplicate if there are duplicates
      const uniqueItems = [...new Set(items)];
      if (uniqueItems.length < items.length) {
        printLog(`🔧 Deduplicated response: ${items.length} items → ${uniqueItems.length} unique items`);
        return uniqueItems.join(', ');
      }
    }
    return answer;
  }

  async initializeClients(secrets: Secrets): Promise<void> {
    printLog("Initializing LLM Clients...");

    try {
      this.clients.groq = groqCreateClient(secrets);
    } catch (e) {
      printLog(`Failed to init Groq: ${e}`);
    }

    try {
      this.clients.huggingface = huggingfaceCreateClient(secrets);
    } catch (e) {
      printLog(`Failed to init HuggingFace: ${e}`);
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
    const personalsData = getPersonalsSync() || await loadPersonals();

    // ENHANCEMENT: If question targets a specific Entry (e.g., "[Entry: 2]"), 
    // inject the structured data context to ensure correct indexing.
    // This fixes the issue where single re-asks (e.g. for dropdowns) lose context and default to Entry 1.
    let finalUserInfo = userInformationAll || configContext;

    if (!finalUserInfo && question.includes('[Entry:')) {
      const experienceData = JSON.stringify(personalsData.experience_details || [], null, 2);
      const educationData = JSON.stringify(personalsData.education_details || [], null, 2);

      finalUserInfo = `
=== STRUCTURED DATA FOR REPEATING SECTIONS ===

**EXPERIENCE_DETAILS** (use for Work Experience questions):
${experienceData}

**EDUCATION_DETAILS** (use for Education questions):
${educationData}

**CRITICAL INDEXING INSTRUCTIONS:**
- When you see [Entry: 1] -> use experience_details[0] or education_details[0] (ARRAY INDEX = Entry Number - 1)
- When you see [Entry: 2] -> use experience_details[1] or education_details[1]
- When you see [Entry: 3] -> use experience_details[2] or education_details[2]
- EXAMPLE: "Company [Entry: 2]" = experience_details[1].company = "BMC Netreo"
- EXAMPLE: "School [Entry: 2]" = education_details[1].school = "K.S.I.T (V.T.U), Bangalore"

DO NOT use the first entry if the question asks for Entry 2, 3, etc.
DO NOT return "N/A" if data exists in the array at that index.

=== General Context ===
${JSON.stringify(personalsData)}
`;
      printLog(`🔧 Injected structured context for Entry-based question: "${question}"`);
    } else if (!finalUserInfo) {
      finalUserInfo = JSON.stringify(personalsData);
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
          if (answer.toLowerCase().startsWith('error') || answer.includes('Error:')) {
            printLog(`LLM Provider ${provider} returned error message: ${answer}`);
            continue;
          }

          // Deduplicate comma-separated lists (fixes LLM repetition loop issue)
          let cleanedAnswer = this.deduplicateResponse(answer);

          //printLog(`✅ LLM Successfully answered with ${provider}: ${cleanedAnswer.substring(0, 100)}...`);
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
    printLog("All LLM providers failed. Trying Fuzzy Logic.");
    const fuzzyAns = this.fuzzyAnswer(question, options, jobDescription);

    // Activate Cooldown (2 minutes)
    printLog("Activating 2 minute cooldown for LLMs.");
    this.cooldownEndTime = new Date(Date.now() + 2 * 60 * 1000);
    this.currentFallbackIndex = 0;

    if (fuzzyAns && typeof fuzzyAns === 'string' && fuzzyAns.trim().length > 0) {
      return fuzzyAns;
    }

    printLog("Fuzzy Logic also failed to provide an answer.");
    return null;
  }

  // Batch answer multiple questions in a single LLM call for speed
  async getBatchAnswers(
    questionsList: { question: string; options?: string[]; questionType?: string }[],
    jobDescription?: string,
    userInformationAll?: string,
    configContext?: string
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (questionsList.length === 0) return results;

    // Build a combined prompt for all questions
    const personalsData = getPersonalsSync() || await loadPersonals();
    const userInfo = userInformationAll || configContext || JSON.stringify(personalsData);

    // Explicitly add structured data for repeaters
    const experienceData = JSON.stringify(personalsData.experience_details || [], null, 2);
    const educationData = JSON.stringify(personalsData.education_details || [], null, 2);

    let batchPrompt = `You are a helpful assistant filling out a form.

=== PRIMARY DATA SOURCE (USE THIS FOR [Entry: X] QUESTIONS) ===

WORK EXPERIENCE ARRAY (experience_details):
${experienceData}

EDUCATION ARRAY (education_details):
${educationData}

=== CRITICAL INSTRUCTIONS ===

**ARRAY INDEXING (READ THIS CAREFULLY)**:
JavaScript arrays start at index 0. To find the correct entry:
- [Entry: 1] = experience_details[0] or education_details[0]
- [Entry: 2] = experience_details[1] or education_details[1]
- [Entry: 3] = experience_details[2] or education_details[2]  
- [Entry: 4] = experience_details[3] or education_details[3]
- [Entry: 5] = experience_details[4] or education_details[4]
- [Entry: 6] = experience_details[5] or education_details[5]
**Formula: array[Entry_Number - 1]**

1. **FOR ANY QUESTION WITH [Entry: X]**: Extract ONLY from the arrays above.
   - "Start Date [Entry: 6]" → experience_details[5].start_date → "12/2008" → "12/2008"
   - "Employer [Entry: 6]" → experience_details[5].company → "Mphasis" (NOT "Tavant"!)
   - "End Year [Entry: 1]" → education_details[0].to → "10/2021" → "2021"
   - DO NOT use any data from the "General Context" section below
   - DO NOT use highlights, industry, description, or any text data

2. **DATE FIELDS**: For "Start Date" or "End Date" or "From" or "To" questions:
   - Extract from the .start_date or .end_date field (for experience) or .from/.to (for education)
   - **CRITICAL**: The data is ALREADY in MM/YYYY format - just use it directly!
   - **CRITICAL**: If the value is "Present", you MUST return "12/31/2025" NOT the start date
   - **CRITICAL**: For "To" questions, use .end_date NOT .start_date!
   
   **WORK EXPERIENCE DATES - ALL 6 ENTRIES**:
   - "From [Entry: 1]" = start_date[0] = "02/2022" → return "02/2022"
   - "To [Entry: 1]"   = end_date[0]   = "Present" → return "12/31/2025"
   - "From [Entry: 2]" = start_date[1] = "03/2019" → return "03/2019"
   - "To [Entry: 2]"   = end_date[1]   = "02/2022" → return "02/2022" (NOT 12/31/2025!)
   - "From [Entry: 3]" = start_date[2] = "11/2013" → return "11/2013"
   - "To [Entry: 3]"   = end_date[2]   = "03/2019" → return "03/2019"
   - "From [Entry: 4]" = start_date[3] = "01/2012" → return "01/2012"
   - "To [Entry: 4]"   = end_date[3]   = "11/2013" → return "11/2013" (NOT 03/2011!)
   - "From [Entry: 5]" = start_date[4] = "03/2011" → return "03/2011"
   - "To [Entry: 5]"   = end_date[4]   = "01/2012" → return "01/2012"
   - "From [Entry: 6]" = start_date[5] = "12/2008" → return "12/2008"
   - "To [Entry: 6]"   = end_date[5]   = "03/2011" → return "03/2011"

3. **YEAR FIELDS**: For "Start Year" or "End Year" questions:
   - Extract from the .from or .to field in the JSON array
   - Return only the year portion (e.g., "2021-10" → "2021")

4. **LOCATION FIELDS**: 
   - **IF AND ONLY IF** the question asks for "Location", "City", "Place", or "Address" (specifically for Work/Education):
   - **THEN** return "Bangalore, India".
   - **CRITICAL EXCEPTION**: If the question asks for "Salary", "CTC", "Compensation", or "Pay", SKIP this rule and see Rule 5.
   
5. **SALARY / CTC / COMPENSATION FIELDS**:
   - Look for keywords: "CTC", "Salary", "Compensation", "Remuneration", "Pay".
   - Answer with the **numeric value only** from the user data (e.g. 80000).
   - Do NOT add currency symbols unless asked.
   - Do NOT answer with "Bangalore" or any location.
   
   **EXAMPLES**:
   - "Current CTC?" → "80000"
   - "Expected Salary?" → "85000"
   - "What is your current Location?" → "Bangalore, India"

6. **NOTICE PERIOD**:
    - "Notice Period" -> Extract from "Notice Period" or "soon_join_us" (e.g. "60 days")

7. **EMPLOYER/UNIVERSITY FIELDS**: Use companyKey or institution from the JSON

8. **IF [Entry: X] is missing**: Return "N/A"

=== General Context (use only for non-[Entry: X] questions) ===
${userInfo}
`;

    // If we have Entry-based questions, inject structured arrays
    // DYNAMICALLY generate from personals.json data - NOT HARDCODED!
    const experienceEntries = personalsData.experience_details || [];
    const educationEntries = personalsData.education_details || [];

    // Format experience data for LLM
    const formattedExperience = experienceEntries.map((exp: any, idx: number) => {
      // Convert date format from MM-YYYY to MM/YYYY for consistency
      const fromDate = (exp.from || '').replace('-', '/');
      const toDate = (exp.to || 'Present').replace('-', '/');
      return {
        entry: idx + 1,
        company: exp.companyKey || exp.company || '',
        title: exp.title || '',
        location: exp.location || 'Bangalore, India',
        start_date: fromDate,
        end_date: toDate,
        currently_work_here: (exp.to || '').toLowerCase() === 'present'
      };
    });

    // Format education data for LLM
    const formattedEducation = educationEntries.map((edu: any, idx: number) => {
      const fromDate = (edu.from || '').replace('-', '/');
      const toDate = (edu.to || '').replace('-', '/');
      // Extract just the year for graduation_year
      const gradYear = toDate.split('/').pop() || '';
      return {
        entry: idx + 1,
        school: edu.institution || edu.school || '',
        degree: edu.degree || '',
        field: edu.field || 'Computer Science',
        start_year: fromDate.split('/').pop() || '',
        graduation_year: gradYear,
        from: fromDate,
        to: toDate,
        gpa: edu.gpa || personalsData.gpa || '3.5'
      };
    });

    batchPrompt += `

=== STRUCTURED DATA FOR REPEATING SECTIONS ===

**EXPERIENCE_DETAILS** (use for Work Experience questions):
${JSON.stringify(formattedExperience, null, 2)}

**EDUCATION_DETAILS** (use for Education questions):
${JSON.stringify(formattedEducation, null, 2)}

**CRITICAL INDEXING INSTRUCTIONS:**
- [Entry: 1] → use array index [0] (Entry Number - 1)
- [Entry: 2] → use array index [1]
- [Entry: 3] → use array index [2]
- [Entry: 4] → use array index [3]
- [Entry: 5] → use array index [4]
- [Entry: 6] → use array index [5]

**COMMON MISTAKES TO AVOID:**
- "To [Entry: 2]" should return "02/2022" NOT "12/31/2025" (Entry 2 is BMC Netreo which ended in 02/2022)
- "To [Entry: 4]" should return "11/2013" NOT "01/2012" or "03/2011" (Entry 4 is CGI which ended in 11/2013)
- ONLY Entry 1 (UHG Optum Labs) has "Present" as end_date, so ONLY Entry 1 should return "12/31/2025" for "To"

DO NOT just return the entry number! Look up the actual data from the arrays!
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

    batchPrompt += `\n\nProvide ONLY the answers, one per line, in the format Q1: answer, Q2: answer, etc. Be concise.`;

    // Helper function to parse LLM response
    const parseResponse = (content: string): void => {
      const lines = content.split('\n');
      const matchedIndices = new Set<number>();

      lines.forEach((line: string) => {
        // Try multiple patterns for parsing
        let match = line.match(/^Q(\d+):\s*(.+)/i);
        if (!match) {
          // Try alternate format: "1: answer" or "1. answer"
          match = line.match(/^(\d+)[.:]\s*(.+)/);
        }
        if (match) {
          const idx = parseInt(match[1]) - 1;
          const answer = match[2].trim();
          if (idx >= 0 && idx < questionsList.length && answer.length > 0) {
            results.set(questionsList[idx].question, answer);
            matchedIndices.add(idx);
          }
        }
      });

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

        printLog(`Batch request: trying ${provider} for ${questionsList.length} questions...`);

        if (provider === "groq") {
          const response = await fetch((client as GroqClient).api_url, {
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
              const content = result.choices[0].message.content;
              parseResponse(content);

              if (results.size > 0) {
                printLog(`✅ Batch answered ${results.size}/${questionsList.length} questions via ${provider}`);
                return results;
              }
            }
          } else {
            printLog(`Batch ${provider} failed with status ${response.status}`);
          }
        } else if (provider === "huggingface") {
          const hfClient = client as HuggingFaceClient;
          const response = await fetch(hfClient.api_url, {
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
              const content = result.choices[0].message.content;
              parseResponse(content);

              if (results.size > 0) {
                printLog(`✅ Batch answered ${results.size}/${questionsList.length} questions via ${provider}`);
                return results;
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

