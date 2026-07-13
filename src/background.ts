// Background service worker
import { loadSecrets, Secrets } from './modules/config_loader.js';

const ALLOWED_FETCH_HOSTS = new Set([
  'api.groq.com',
  'router.huggingface.co',
]);

const CONTENT_SCRIPT_FILE = 'dist/content.bundle.js';

// Packaged config files content scripts may request via loadBundledConfig.
// secrets.json is deliberately NOT here: content scripts get provider
// availability (booleans + model names) via getProviderAvailability and make
// LLM calls via llmRequest — they never receive raw key material, so they
// have no legitimate reason to fetch the secrets file itself.
const BUNDLED_CONFIG_FILES = new Set([
  'personals.json',
  'personals.example.json',
  'questions.json',
]);

function isAllowedProviderUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_FETCH_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Resolve {url, key} for a provider name from secrets. Never exposed to content scripts. */
function resolveProviderConfig(provider: unknown, secrets: Secrets): { url: string; key: string } | null {
  if (provider === 'groq') {
    return { url: secrets.groq_api_url, key: (secrets.groq_api_key || '').trim() };
  }
  if (provider === 'huggingface') {
    return { url: secrets.huggingface_api_url, key: (secrets.huggingface_api_key || '').trim() };
  }
  return null;
}

async function loadBundledJson<T>(relativePath: string): Promise<T | null> {
  try {
    const response = await fetch(chrome.runtime.getURL(relativePath));
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

/**
 * Seed chrome.storage with bundled defaults on install/update when empty.
 * Content scripts then read from storage (single source of truth) instead of
 * repeatedly fetching package files from every frame.
 */
async function seedDefaultConfigs(): Promise<void> {
  const local = await chrome.storage.local.get(['personals', 'questions']);

  const updatesLocal: Record<string, unknown> = {};
  if (!local.personals) {
    const personals =
      (await loadBundledJson('config/personals.json')) ||
      (await loadBundledJson('config/personals.example.json'));
    if (personals) updatesLocal.personals = personals;
  }
  if (!local.questions) {
    const questions = await loadBundledJson('config/questions.json');
    if (questions) updatesLocal.questions = questions;
  }
  if (Object.keys(updatesLocal).length > 0) {
    await chrome.storage.local.set(updatesLocal);
  }

  // Do not seed secrets into sync here. Keys come from Options (sync) and/or
  // config/secrets.json via getURL. Seeding empty sync secrets caused "no key" failures
  // after we scrubbed the local secrets file.
}

async function injectContentScripts(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch {
    // Some iframes (about:blank, sandboxed) reject allFrames injection — fall back to top frame.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [CONTENT_SCRIPT_FILE],
    });
  }
}

/**
 * Inject (idempotent) into all frames, then broadcast startFilling.
 * Every frame with forms fills itself; the returned count comes from the
 * first frame that responds (Chrome keeps only the first sendResponse).
 */
async function startFillingInTab(tabId: number): Promise<{ success: boolean; filledCount: number; error?: string }> {
  try {
    await injectContentScripts(tabId);
    return await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'startFilling' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, filledCount: 0, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: true, filledCount: 0 });
        }
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, filledCount: 0, error: message };
  }
}

async function getStatusFromTab(tabId: number): Promise<{ isRunning: boolean; filledCount: number } | null> {
  try {
    return await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'getStatus' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response || { isRunning: false, filledCount: 0 });
        }
      });
    });
  } catch {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('form-autopilot extension installed');
  void seedDefaultConfigs();
});

// Also seed on service worker startup (MV3 SW can restart)
void seedDefaultConfigs();

// Handle keyboard shortcut (Ctrl+Shift+F / Cmd+Shift+F)
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'fill-form') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return;
    void startFillingInTab(tabId);
  });
});

// Note: chrome.action.onClicked does not fire when manifest declares `default_popup`.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Popup → background: start fill (injects into all frames on demand)
  if (message?.action === 'startFilling') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) {
        sendResponse({ success: false, error: 'No active tab found' });
        return;
      }
      void startFillingInTab(tabId).then(sendResponse);
    });
    return true;
  }

  if (message?.action === 'getStatus') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) {
        sendResponse({ isRunning: false, filledCount: 0 });
        return;
      }
      void getStatusFromTab(tabId).then((status) => {
        sendResponse(status || { isRunning: false, filledCount: 0 });
      });
    });
    return true;
  }

  // Relay fill progress from content → popup (and any other UI listeners)
  if (message?.action === 'fillStatus') {
    // Popup listens via chrome.runtime.onMessage; nothing else to do here.
    return false;
  }

  // Content script asks for a packaged config file it cannot fetch itself
  if (message?.action === 'loadBundledConfig') {
    const filename = message.filename;
    if (typeof filename !== 'string' || !BUNDLED_CONFIG_FILES.has(filename)) {
      sendResponse({ error: 'loadBundledConfig blocked: unknown config file' });
      return false;
    }
    loadBundledJson(`config/${filename}`).then((data) => {
      if (data === null) {
        sendResponse({ error: `Failed to load config: ${filename}` });
      } else {
        sendResponse({ data });
      }
    });
    return true;
  }

  // Content script asks which providers are usable — booleans + model names
  // only, never the actual key value.
  if (message?.action === 'getProviderAvailability') {
    loadSecrets().then((secrets) => {
      sendResponse({
        useAI: secrets.use_AI,
        groqAvailable: (secrets.groq_api_key || '').trim().length > 8,
        groqModel: secrets.groq_model,
        hfAvailable: (secrets.huggingface_api_key || '').trim().length > 8,
        hfModel: secrets.huggingface_model,
      });
    });
    return true;
  }

  // Content script asks background to perform an LLM chat-completion call.
  // Background resolves the endpoint URL and injects the Authorization
  // header itself from secrets — the API key never crosses into the content
  // script's (page-adjacent, isolated-world) JS heap.
  if (message?.action === 'llmRequest') {
    loadSecrets().then(async (secrets) => {
      if (!secrets.use_AI) {
        sendResponse({ error: 'llmRequest blocked: AI is disabled in settings' });
        return;
      }
      const cfg = resolveProviderConfig(message.provider, secrets);
      if (!cfg || !isAllowedProviderUrl(cfg.url)) {
        sendResponse({ error: 'llmRequest blocked: unknown or disallowed provider' });
        return;
      }
      if (!cfg.key) {
        sendResponse({ error: 'llmRequest blocked: no API key configured for this provider' });
        return;
      }
      const body = message.body && typeof message.body === 'object' ? message.body : {};
      try {
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((val, key) => { responseHeaders[key] = val; });
        sendResponse({
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
          body: text,
        });
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  return false;
});
