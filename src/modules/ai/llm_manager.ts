// Converted from modules/ai/llm_manager.py
import { loadPersonals, getPersonalsSync, loadProviderAvailability, ProviderAvailability } from '../config_loader.js';
import { groqAnswerQuestion, GroqClient } from './groqConnections.js';
import { huggingfaceAnswerQuestion, HuggingFaceClient } from './huggingfaceConnections.js';
import { fuzzyAnswerQuestion } from '../fuzzy_matcher.js';
import { printLog, callLLM } from '../helpers.js';

interface LLMClients {
  groq: GroqClient | null;
  huggingface: HuggingFaceClient | null;
}

export class LLMManager {
  private clients: LLMClients;
  private providerPriority: string[];
  private fuzzyFallbackEnabled: boolean;
  private providerCooldownUntil: Record<string, number>;
  private currentFallbackIndex: number;

  constructor() {
    this.clients = {
      groq: null,
      huggingface: null
    };
    this.providerPriority = ["groq", "huggingface"];
    this.fuzzyFallbackEnabled = true;
    this.providerCooldownUntil = {};
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

  /**
   * Ask background which providers are configured (booleans + model names —
   * background never returns the actual key). No arguments: this used to
   * take a Secrets object built from the raw key value, which meant every
   * content-script caller had to hold the key in memory just to pass it
   * through here.
   */
  async initializeClients(): Promise<ProviderAvailability> {
    const avail = await loadProviderAvailability();

    this.clients.groq = (avail.useAI && avail.groqAvailable) ? { model: avail.groqModel } : null;
    this.clients.huggingface = (avail.useAI && avail.hfAvailable) ? { model: avail.hfModel } : null;

    if (!avail.useAI) {
      printLog('AI is disabled in settings — using offline fuzzy matching only.');
    } else if (!avail.groqAvailable && !avail.hfAvailable) {
      printLog('No LLM API keys configured — answers will come from offline fuzzy matching.');
    }
    return avail;
  }

  /** Public fuzzy fallback for batch-mode misses (no LLM). */
  getFuzzyAnswerPublic(question: string, options?: string[]): string | null {
    return this.fuzzyAnswer(question, options);
  }

  async getAnswer(
    question: string,
    options?: string[],
    questionType: string = "text",
    jobDescription?: string,
    userInformationAll?: string,
    configContext?: string
  ): Promise<string | null> {
    const now = Date.now();
    for (const [provider, until] of Object.entries(this.providerCooldownUntil)) {
      if (until <= now) delete this.providerCooldownUntil[provider];
    }

    if (!this.clients.groq && !this.clients.huggingface) {
      return this.fuzzyAnswer(question, options, questionType, jobDescription);
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
      const client = this.clients[provider as keyof LLMClients];

      // Availability is fixed for the run (set once in initializeClients) —
      // no configured provider is never going to become available mid-run,
      // so there is nothing to gain from re-initializing per field (that
      // used to re-log "client ready" / re-throw "no key" once per question).
      if (!client) continue;
      const coolUntil = this.providerCooldownUntil[provider];
      if (coolUntil && Date.now() < coolUntil) {
        printLog(`Skipping ${provider} — cooldown active`);
        continue;
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
          // Only treat as an error if the whole reply IS an error sentence
          // (requires a colon after the keyword). A legitimate answer like
          // "Error handling is my strength" must never be misread as a
          // provider failure — that previously triggered a 2-minute global
          // cooldown off one unlucky answer.
          const trimmed = answer.trim();
          const looksLikeApiError =
            trimmed.length < 200 &&
            /^(api\s+error|error|failed|exception)\s*:/i.test(trimmed);
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
          this.providerCooldownUntil[provider] = Date.now() + 2 * 60 * 1000;
        } else if (errorMsg.toLowerCase().includes('connection') || errorMsg.toLowerCase().includes('timeout')) {
          printLog(`LLM Provider ${provider} failed: Connection/timeout error`);
          this.providerCooldownUntil[provider] = Date.now() + 30 * 1000;
        } else {
          printLog(`LLM Provider ${provider} failed: ${errorMsg.substring(0, 200)}`);
        }
        continue;
      }
    }

    // If all providers failed
    printLog("All LLM providers failed. Trying Fuzzy Logic.");
    const fuzzyAns = this.fuzzyAnswer(question, options, questionType, jobDescription);
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

    if (!this.clients.groq && !this.clients.huggingface) {
      printLog('Batch skipped: no LLM clients — falling back to per-field matching.');
      return results;
    }

    // Lean prompt: entry arrays once; general context without duplicating those arrays
    const personalsData = getPersonalsSync() || await loadPersonals();
    const experienceData = JSON.stringify(personalsData.experience_details || [], null, 2);
    const educationData = JSON.stringify(personalsData.education_details || [], null, 2);
    const restPersonals: Record<string, unknown> = { ...(personalsData as Record<string, unknown>) };
    delete restPersonals.experience_details;
    delete restPersonals.education_details;
    delete restPersonals.user_information_all;
    const generalContext =
      userInformationAll ||
      configContext ||
      JSON.stringify(restPersonals);

    let batchPrompt = `You are filling a job application form. Use the data below. Do not invent facts.

EXPERIENCE_DETAILS (0-based; [Position Entry: N] => index N-1):
${experienceData}

EDUCATION_DETAILS (0-based; [Education Entry: N] => index N-1):
${educationData}

RULES:
- [Entry: N] / [Position Entry: N] / [Education Entry: N] => array index (N-1). Missing => N/A.
- Role Description/Responsibilities: join ALL highlights for that experience entry (not title/company).
- Dates: MM/YYYY from .from/.to. Present/Current/Ongoing end date => N/A (checkbox handles it).
- Years-only: return 4-digit year. Salary/CTC: numeric only. Visa/work auth: from profile.
- Demographics: use explicit profile fields only; if missing => "Decline To Self Identify". Never infer race from nationality.
- Signature/Printed Name: full name (+ today MM/DD/YYYY if date asked). Never paste legal text.

GENERAL PROFILE (non-entry questions):
${generalContext}
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
        const coolUntil = this.providerCooldownUntil[provider];
        if (coolUntil && Date.now() < coolUntil) {
          printLog(`Batch skipped ${provider} — cooldown active`);
          continue;
        }

        const response = await callLLM(provider as 'groq' | 'huggingface', {
          model: client.model,
          messages: [{ role: "user", content: batchPrompt }],
          max_tokens: 2048,
          temperature: 0.1
        });

        if (response.ok) {
          const result = await response.json();
          if (result.choices && result.choices.length > 0) {
            const content = result.choices[0]?.message?.content;
            if (typeof content === 'string' && content.length > 0) {
              parseResponse(content);

              const threshold = Math.ceil(questionsList.length * 0.5);
              if (results.size >= threshold) {
                printLog(`✅ Batch answered ${results.size}/${questionsList.length} questions via ${provider}`);
                return results;
              }
              printLog(`Batch ${provider} only parsed ${results.size}/${questionsList.length} — trying next provider`);
            }
          }
        } else {
          printLog(`Batch ${provider} failed with status ${response.status}`);
          if (response.status === 429) {
            this.providerCooldownUntil[provider] = Date.now() + 2 * 60 * 1000;
          }
        }
      } catch (e) {
        printLog(`Batch ${provider} error: ${e}`);
        continue;
      }
    }

    printLog(`⚠️ All batch providers failed. Caller will use fuzzy for misses (no per-field LLM in batch mode).`);
    return results;
  }

  private fuzzyAnswer(question: string, options?: string[], questionType: string = 'text', jobDescription?: string): string | null {
    return fuzzyAnswerQuestion(question, options, questionType, jobDescription || "");
  }
}

// Global Instance
export const llmManager = new LLMManager();
