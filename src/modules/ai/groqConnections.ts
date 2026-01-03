// Converted from modules/ai/connections/groqConnections.py
import { Secrets, loadQuestions, getQuestionsSync } from '../config_loader.js';
import { printLog, criticalErrorLog } from '../helpers.js';

export interface GroqClient {
  token: string;
  api_url: string;
  model: string;
}

export function groqCreateClient(secrets: Secrets): GroqClient | null {
  try {
    printLog("Creating Groq client...");

    if (!secrets.use_AI) {
      throw new Error("AI is not enabled! Please enable it by setting use_AI = true in secrets");
    }

    const groqToken = secrets.groq_api_key || '';
    const modelName = secrets.groq_model || 'llama-3.1-8b-instant';
    const apiUrl = secrets.groq_api_url || 'https://api.groq.com/openai/v1/chat/completions';

    if (!groqToken || groqToken === '') {
      throw new Error(
        "Groq API key is not configured!\n" +
        "Get your API key from: https://console.groq.com/keys\n" +
        "Then set it in extension settings"
      );
    }

    printLog("---- SUCCESSFULLY CREATED GROQ CLIENT! ----");
    // printLog(`Using API URL: ${apiUrl}`);
    // printLog(`Using Model: ${modelName}`);

    return {
      token: groqToken.trim(),
      api_url: apiUrl,
      model: modelName
    };
  } catch (e) {
    criticalErrorLog("Error occurred while creating Groq client.", e);
    return null;
  }
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
    let prompt = questions.ai_answer_prompt.replace('{}', userInfo).replace('{}', question);

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

    // Prepare request
    const headers = {
      "Authorization": `Bearer ${client.token}`,
      "Content-Type": "application/json"
    };

    const payload = {
      model: client.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: 1024,
      temperature: 0.1
    };

    // Make API request
    const response = await fetch(client.api_url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

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
      const answer = result.choices[0].message.content.trim();
      if (answer) {
        //printLog(`\nGroq Answer: ${answer}`);
        return answer;
      } else {
        printLog("Warning: Groq returned empty response");
        return null;
      }
    } else {
      printLog(`Groq API returned unexpected response: ${JSON.stringify(result)}`);
      return null;
    }
  } catch (e) {
    criticalErrorLog("Error occurred while answering question with Groq.", e);
    return null;
  }
}

export async function groqExtractSkills(
  client: GroqClient | null,
  jobDescription: string
): Promise<any> {
  if (!client) {
    printLog("Groq client is not available for skill extraction.");
    return {};
  }

  try {
    const questions = getQuestionsSync() || await loadQuestions();
    const prompt = questions.extract_skills_prompt.replace('{}', jobDescription);

    const headers = {
      "Authorization": `Bearer ${client.token}`,
      "Content-Type": "application/json"
    };

    const payload = {
      model: client.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: 1024,
      temperature: 0.1,
      response_format: { type: "json_object" }
    };

    const response = await fetch(client.api_url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const result = await response.json();
      if (result.choices && result.choices.length > 0) {
        const content = result.choices[0].message.content;
        try {
          return JSON.parse(content);
        } catch {
          return { skills: content };
        }
      }
      return {};
    } else {
      const errorText = await response.text();
      printLog(`Groq API Error ${response.status}: ${errorText.substring(0, 200)}`);
      return {};
    }
  } catch (e) {
    printLog(`Error extracting skills with Groq: ${e}`);
    return {};
  }
}

