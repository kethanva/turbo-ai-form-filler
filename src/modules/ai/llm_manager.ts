// Converted from modules/ai/llm_manager.py
import { Secrets, loadSecrets } from '../../config/secrets.js';
import { groqCreateClient, groqAnswerQuestion, groqExtractSkills, GroqClient } from './groqConnections.js';
import { huggingfaceCreateClient, huggingfaceAnswerQuestion, huggingfaceExtractSkills, HuggingFaceClient } from './huggingfaceConnections.js';
import { fuzzyAnswerQuestion, fuzzyExtractSkills } from '../fuzzy_matcher.js';
import { printLog } from '../helpers.js';
import { personals } from '../../config/personals.js';

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
    const userInfo = userInformationAll || configContext || JSON.stringify(personals);

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
            userInfo,
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
            userInfo,
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
          //printLog(`✅ LLM Successfully answered with ${provider}: ${answer.substring(0, 100)}...`);
          return answer;
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

