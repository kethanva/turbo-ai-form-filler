// Converted from modules/ai/connections/huggingfaceConnections.py
import { Secrets } from '../config_loader.js';
import { printLog, criticalErrorLog } from '../helpers.js';

export interface HuggingFaceClient {
  token: string;
  api_url: string;
  model: string;
}

export function huggingfaceCreateClient(secrets: Secrets): HuggingFaceClient | null {
  try {

    if (!secrets.use_AI) {
      throw new Error("AI is not enabled! Please enable it by setting use_AI = true in secrets");
    }

    const hfToken = secrets.huggingface_api_key || '';
    const modelName = secrets.huggingface_model || 'meta-llama/Llama-3.2-3B-Instruct';
    const apiUrl = secrets.huggingface_api_url || 'https://router.huggingface.co/v1/chat/completions';

    if (!hfToken || hfToken === '') {
      throw new Error(
        "HuggingFace token is not configured!\n" +
        "Then set it in extension settings"
      );
    }

    printLog(`✓ HuggingFace client ready (${modelName})`);

    return {
      token: hfToken.trim(),
      api_url: apiUrl,
      model: modelName
    };
  } catch (e) {
    criticalErrorLog("Error occurred while creating HuggingFace client.", e);
    return null;
  }
}

export async function huggingfaceAnswerQuestion(
  client: HuggingFaceClient | null,
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
      throw new Error("HuggingFace client is not available!");
    }

    // Build prompt — prefer userInformationAll; fall back to configFilesContent
    const userInfo = userInformationAll || configFilesContent || "N/A";
    let prompt = `You are an intelligent AI assistant filling out a job application form and answering like a human candidate.
Respond concisely based on the type of question:

1. If the question asks for **years of experience**, respond with a **number only** (e.g., "5" not "5 years").
2. If the question asks for **salary/CTC**, respond with a **number only** (e.g., "100000" not "$100,000" or "1 lakh").
3. If the question is **yes/no**, respond with **"Yes"** or **"No"** only.
4. If the question asks for a **date**, respond in **YYYY-MM-DD** format.
5. For **text questions**, keep answers brief and professional (1-2 sentences max).
6. For **multiple choice**, select the EXACT option text from the provided list.
7. If asked for "name of course" or "course name", respond with the COURSE ABBREVIATION (e.g., "B.E", "M.S"), NOT the person's name.

IMPORTANT:
- "Name of postgraduate course" = course abbreviation like "M.S", NOT person's name
- "Name of undergraduate course" = course abbreviation like "B.E", NOT person's name
- Person's name is different from course names (e.g. B.E, M.S)

User Information:
${userInfo}

Question: ${question}
`;

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

    printLog(`Prompt we are passing to HuggingFace: ${prompt.substring(0, 200)}...`);

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
      max_tokens: 200,
      temperature: 0.3
    };

    // Make API request
    const response = await fetch(client.api_url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      printLog(`HuggingFace API HTTP Error ${response.status}: ${errorText.substring(0, 200)}`);
      if (response.status === 401) {
        printLog("Authentication failed - check your HuggingFace token");
        printLog("Get your FREE token from: https://huggingface.co/settings/tokens");
      } else if (response.status === 503) {
        printLog("Model is loading - wait 20 seconds and try again");
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
      printLog("Warning: HuggingFace returned empty response");
      return null;
    } else {
      printLog(`HuggingFace API returned unexpected response: ${JSON.stringify(result)}`);
      return null;
    }
  } catch (e) {
    const errorStr = String(e).toLowerCase();
    if (errorStr.includes('503') || errorStr.includes('loading')) {
      printLog(`HuggingFace Model Loading: ${e}`);
      throw new Error("HuggingFace Model Loading");
    }
    criticalErrorLog("Error occurred while answering question with HuggingFace.", e);
    return null;
  }
}

export async function huggingfaceExtractSkills(
  client: HuggingFaceClient | null,
  jobDescription: string
): Promise<any> {
  if (!client) {
    printLog("HuggingFace client is not available for skill extraction.");
    return {};
  }

  try {
    const prompt = `Extract technical skills from the job description below.
        Return a JSON object with keys: 'tech_stack', 'technical_skills', 'other_skills', 'required_skills', 'nice_to_have'.
        Each key should have a list of strings as values.
        
        Job Description:
        ${jobDescription}
        `;

    const headers = {
      "Authorization": `Bearer ${client.token}`,
      "Content-Type": "application/json"
    };

    const payload = {
      model: client.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: 300,
      temperature: 0.3
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
      printLog(`HuggingFace API Error ${response.status}: ${errorText.substring(0, 200)}`);
      return {};
    }
  } catch (e) {
    const errorStr = String(e).toLowerCase();
    if (errorStr.includes('503') || errorStr.includes('loading')) {
      throw new Error("HuggingFace Model Loading");
    }
    printLog(`Error extracting skills: ${e}`);
    return {};
  }
}

