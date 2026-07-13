// Converted from modules/ai/connections/groqConnections.py
import { loadQuestions, getQuestionsSync } from '../config_loader.js';
import { printLog, criticalErrorLog, callLLM, fillTemplate } from '../helpers.js';

// Only the model name lives in content-script memory. The API key and
// endpoint URL stay in the background service worker (see background.ts
// llmRequest handler) — content never sees key material.
export interface GroqClient {
  model: string;
}

export async function groqAnswerQuestion(
  client: GroqClient | null,
  question: string,
  options?: string[],
  questionType: string = 'text',
  jobDescription?: string,
  aboutCompany?: string,
  userInformationAll?: string,
  configFilesContent?: string
): Promise<string | null> {
  try {
    if (!client) {
      throw new Error("Groq client is not available!");
    }

    // Build prompt using shared template
    const questions = getQuestionsSync() || await loadQuestions();
    const userInfo = userInformationAll || configFilesContent || "N/A";
    let prompt = fillTemplate(questions.ai_answer_prompt, userInfo, question);

    // Add optional context
    if (jobDescription && jobDescription !== "Unknown") {
      prompt += `\n\nJob Description:\n${jobDescription}`;
    }
    if (aboutCompany && aboutCompany !== "Unknown") {
      prompt += `\n\nAbout the Company:\n${aboutCompany}`;
    }

    // Add options if provided
    if (options && options.length > 0) {
      const optionsText = options.map(opt => `- ${opt}`).join('\n');
      prompt += `\n\nAvailable Options:\n${optionsText}`;
      if (questionType === "single_select" || questionType === "select" || questionType === "radio") {
        prompt += "\n\nIMPORTANT: Select EXACTLY ONE option from the list above. Return ONLY the exact text of the chosen option, nothing else.";
      } else if (questionType === "multiple_select") {
        prompt += "\n\nIMPORTANT: You may select MULTIPLE options from the list above if appropriate. Return the selected options separated by commas, using the exact option text.";
      } else {
        prompt += "\n\nPlease select the most appropriate option from the list above. Return ONLY the exact option text.";
      }
    }

    prompt += "\n\nYour answer (be concise):";

    const payload = {
      model: client.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: 1024,
      temperature: 0.1
    };

    // Make API request via background (background injects the API key)
    const response = await callLLM('groq', payload);

    if (!response.ok) {
      const errorText = await response.text();
      printLog(`Groq API HTTP Error ${response.status}: ${errorText.substring(0, 200)}`);
      if (response.status === 401) {
        printLog("Authentication failed - check your Groq API key");
      } else if (response.status === 429) {
        printLog("Rate limit exceeded");
      } else if (response.status >= 500) {
        printLog("Server error - try again later");
      }
      return null;
    }

    const result = await response.json();

    // Validate response structure
    if (result.choices && result.choices.length > 0) {
      const rawContent = result.choices[0]?.message?.content;
      const answer = typeof rawContent === 'string' ? rawContent.trim() : '';
      if (answer) {
        return answer;
      }
      printLog("Warning: Groq returned empty response");
      return null;
    } else {
      printLog(`Groq API returned unexpected response: ${JSON.stringify(result)}`);
      return null;
    }
  } catch (e) {
    criticalErrorLog("Error occurred while answering question with Groq.", e);
    return null;
  }
}
