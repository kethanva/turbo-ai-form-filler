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

export async function proxyFetch(url: string, options: any = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'proxyFetch', url, options }, (response) => {
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

      // Reconstruct Response object
      resolve(new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }));
    });
  });
}
