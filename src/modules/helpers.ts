// Converted from modules/helpers.py
export function printLog(message: string, ...args: any[]): void {
  const formattedMessage = args.length > 0 
    ? `${message} ${args.map(String).join(' ')}`
    : message;
  console.log(formattedMessage);
}

export function criticalErrorLog(message: string, error: Error | unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`CRITICAL ERROR - ${message}: ${errorMessage}`, error);
}

export function convertToJson(text: string): any {
  if (!text) return null;
  
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from markdown code blocks
    if (text.includes('```')) {
      const parts = text.split('```');
      for (const part of parts) {
        let cleaned = part.trim();
        if (cleaned.startsWith('json')) {
          cleaned = cleaned.substring(4).trim();
        }
        try {
          return JSON.parse(cleaned);
        } catch {
          continue;
        }
      }
    }
    
    // Try to find JSON-like content between braces
    const startBrace = text.indexOf('{');
    const endBrace = text.lastIndexOf('}');
    if (startBrace !== -1 && endBrace !== -1 && startBrace < endBrace) {
      try {
        return JSON.parse(text.substring(startBrace, endBrace + 1));
      } catch {
        // Ignore
      }
    }
    
    const startBracket = text.indexOf('[');
    const endBracket = text.lastIndexOf(']');
    if (startBracket !== -1 && endBracket !== -1 && startBracket < endBracket) {
      try {
        return JSON.parse(text.substring(startBracket, endBracket + 1));
      } catch {
        // Ignore
      }
    }
  }
  
  return null;
}

/**
 * Fill a `{}`-placeholder template positionally, left to right.
 * Unlike chained String#replace('{}', ...), each call only ever fills the
 * next literal `{}` in the ORIGINAL template — an injected value that itself
 * contains "{}" (e.g. an empty-object field in a JSON-stringified profile)
 * can never be mistaken for the next slot.
 */
export function fillTemplate(template: string, ...values: string[]): string {
  let i = 0;
  return template.replace(/\{\}/g, () => (i < values.length ? values[i++] : '{}'));
}

/**
 * Whole-word, order-independent containment match: "yes" matches inside
 * "Yes, I am authorized to work", but "male" does NOT match inside "female"
 * (plain bidirectional String#includes gets this backwards and has caused
 * wrong-option selections on real forms — see H1).
 */
export function textualMatch(value: unknown, candidate: unknown): boolean {
  const v = String(value ?? '').toLowerCase().trim();
  const c = String(candidate ?? '').toLowerCase().trim();
  if (!v || !c) return false;
  if (v === c) return true;
  if (v.length < 3 || c.length < 3) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc(v)}\\b`, 'i').test(c) || new RegExp(`\\b${esc(c)}\\b`, 'i').test(v);
}

/**
 * Ask the background service worker to call an LLM provider. Background owns
 * the API key and endpoint URL — content scripts only ever pass a provider
 * name and a request body, so no key material is ever loaded into a
 * content-script (page-adjacent) JS heap.
 */
export async function callLLM(provider: 'groq' | 'huggingface', body: Record<string, unknown>): Promise<Response> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'llmRequest', provider, body }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.error) {
        reject(new Error(response.error));
        return;
      }
      if (!response) {
        reject(new Error('No response from background script'));
        return;
      }

      // Reconstruct Response object. Null-body statuses (204/205/304) reject a
      // body in the Response constructor, so pass null for those.
      const isNullBodyStatus = [204, 205, 304].includes(response.status);
      resolve(new Response(isNullBodyStatus ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }));
    });
  });
}
