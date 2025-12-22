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
    const userInfo = userInformationAll || configContext || JSON.stringify(personals);

    // Explicitly add structured data for repeaters
    const experienceData = JSON.stringify(personals.experience_details || [], null, 2);
    const educationData = JSON.stringify(personals.education_details || [], null, 2);

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
   - "Start Date [Entry: 6]" → experience_details[5].from → "2008-12" → "12/01/2008"
   - "Employer [Entry: 6]" → experience_details[5].companyKey → "mphasis" (NOT "tavant"!)
   - "End Year [Entry: 1]" → education_details[0].to → "2021-10" → "2021"
   - DO NOT use any data from the "General Context" section below
   - DO NOT use highlights, industry, description, or any text data

2. **DATE FIELDS**: For "Start Date" or "End Date" questions:
   - Extract from the .from or .to field in the JSON array
   - **CRITICAL**: Convert YYYY-MM format to MM/01/YYYY
   - **CRITICAL**: If the value is "Present", you MUST return "12/31/2025" NOT the from date
   
   **EXAMPLES**:
   - "From [Entry: 1]" → experience_details[0].from → "2022-02" → return "02/01/2022"
   - "To [Entry: 1]" → experience_details[0].to → "Present" → return "12/31/2025" (NOT "02/01/2022"!)
   - "From [Entry: 2]" → experience_details[1].from → "2019-03" → return "03/01/2019"
   - "To [Entry: 2]" → experience_details[1].to → "2022-02" → return "02/01/2022"
   - "From [Entry: 3]" → experience_details[2].from → "2013-11" → return "11/01/2013"
   - "To [Entry: 3]" → experience_details[2].to → "2019-03" → return "03/01/2019" (NOT "11/01/2013"!)

3. **YEAR FIELDS**: For "Start Year" or "End Year" questions:
   - Extract from the .from or .to field in the JSON array
   - Return only the year portion (e.g., "2021-10" → "2021")

4. **LOCATION FIELDS**: For "Location" questions in Work Experience:
   - Extract from the .location field in experience_details
   - **CRITICAL**: ALWAYS return "Bangalore, Karnataka, India" from the location field
   
   **EXAMPLES**:
   - "Location [Entry: 1]" → experience_details[0].location → "Bangalore, Karnataka, India"
   - "Location [Entry: 2]" → experience_details[1].location → "Bangalore, Karnataka, India"
   - "Work Location [Entry: 3]" → experience_details[2].location → "Bangalore, Karnataka, India"

5. **EMPLOYER/UNIVERSITY FIELDS**: Use companyKey or institution from the JSON

6. **IF [Entry: X] is missing**: Return "N/A"

=== General Context (use only for non-[Entry: X] questions) ===
${userInfo}
`;

    // If we have Entry-based questions, inject structured arrays
    // This block is now always included as per the HEAD version logic
    batchPrompt += `

=== STRUCTURED DATA FOR REPEATING SECTIONS ===

**EXPERIENCE_DETAILS** (use for Work Experience questions):
[
  {"entry": 1, "company": "UHG Optum Labs", "title": "Principal Engineer", "location": "Bangalore, Karnataka, India", "start_date": "02/2022", "end_date": "Present", "currently_work_here": true},
  {"entry": 2, "company": "BMC Netreo", "title": "Cloud Lead", "location": "Remote, USA", "start_date": "06/2019", "end_date": "01/2022", "currently_work_here": false},
  {"entry": 3, "company": "VMware", "title": "Senior Member of Technical Staff", "location": "Bangalore, Karnataka, India", "start_date": "06/2013", "end_date": "05/2019", "currently_work_here": false},
  {"entry": 4, "company": "CGI", "title": "Senior Software Engineer", "location": "Bangalore, Karnataka, India", "start_date": "08/2012", "end_date": "05/2013", "currently_work_here": false},
  {"entry": 5, "company": "Tavant", "title": "Software Engineer", "location": "Bangalore, Karnataka, India", "start_date": "06/2011", "end_date": "07/2012", "currently_work_here": false},
  {"entry": 6, "company": "Mphasis", "title": "Software Engineer", "location": "Bangalore, Karnataka, India", "start_date": "04/2008", "end_date": "05/2011", "currently_work_here": false}
]

**EDUCATION_DETAILS** (use for Education questions):
[
  {"entry": 1, "school": "Liverpool John Moores University, UK", "degree": "Master of Science (M.S.)", "field": "Computer Science", "graduation_year": "2021", "gpa": "3.5"},
  {"entry": 2, "school": "K.S.I.T (V.T.U), Bangalore", "degree": "Bachelor of Engineering (B.E.)", "field": "Computer Science", "graduation_year": "2008", "gpa": "3.2"}
]

**CRITICAL INDEXING INSTRUCTIONS:**
- When you see [Entry: 1] -> use experience_details[0] or education_details[0] (ARRAY INDEX = Entry Number - 1)
- When you see [Entry: 2] -> use experience_details[1] or education_details[1]
- When you see [Entry: 3] -> use experience_details[2] or education_details[2]
- When you see [Entry: 6] -> use experience_details[5] or education_details[5]
- EXAMPLE: "Company [Entry: 2]" = experience_details[1].company = "BMC Netreo"
- EXAMPLE: "School [Entry: 1]" = education_details[0].school = "Liverpool John Moores University, UK"

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

    try {
      const secrets = await loadSecrets();
      const client = this.clients.groq;

      if (client) {
        const response = await fetch(client.api_url, {
          method: 'POST',
          headers: {
            "Authorization": `Bearer ${client.token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: client.model,
            messages: [{ role: "user", content: batchPrompt }],
            max_tokens: 2048,
            temperature: 0.1
          })
        });

        if (response.ok) {
          const result = await response.json();
          if (result.choices && result.choices.length > 0) {
            const content = result.choices[0].message.content;

            // Parse the batch response
            const lines = content.split('\n');
            lines.forEach((line: string) => {
              const match = line.match(/^Q(\d+):\s*(.+)/i);
              if (match) {
                const idx = parseInt(match[1]) - 1;
                const answer = match[2].trim();
                if (idx >= 0 && idx < questionsList.length) {
                  results.set(questionsList[idx].question, answer);
                }
              }
            });

            printLog(`Batch answered ${results.size}/${questionsList.length} questions in single call`);
          }
        }
      }
    } catch (e) {
      printLog(`Batch answer failed, falling back to individual: ${e}`);
    }

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

