// Background service worker
export { };  // Force ES module output

const ALLOWED_FETCH_HOSTS = new Set([
  'api.groq.com',
  'router.huggingface.co',
]);

const CONTENT_SCRIPT_FILE = 'dist/content.bundle.js';

// Packaged config files content scripts may request via loadBundledConfig.
// Content scripts cannot fetch packaged files themselves (no web_accessible_resources).
const BUNDLED_CONFIG_FILES = new Set([
  'secrets.json',
  'secrets.example.json',
  'personals.json',
  'personals.example.json',
  'questions.json',
]);

function isAllowedProxyUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_FETCH_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
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
 * Inject (idempotent) into all frames, then run fill and sum filled counts.
 */
async function startFillingInTab(tabId: number): Promise<{ success: boolean; filledCount: number; error?: string }> {
  try {
    await injectContentScripts(tabId);
    const runFill = (allFrames: boolean) => chrome.scripting.executeScript({
      target: { tabId, allFrames },
      func: () => {
        const w = window as unknown as {
          startFormFillingAsync?: () => Promise<number>;
        };
        if (typeof w.startFormFillingAsync === 'function') {
          return w.startFormFillingAsync();
        }
        return Promise.resolve(0);
      },
    });

    let results;
    try {
      results = await runFill(true);
    } catch {
      results = await runFill(false);
    }

    let filledCount = 0;
    for (const frame of results || []) {
      if (typeof frame.result === 'number') {
        filledCount += frame.result;
      }
    }
    return { success: true, filledCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, filledCount: 0, error: message };
  }
}

async function getStatusFromTab(tabId: number): Promise<{ isRunning: boolean; filledCount: number } | null> {
  try {
    // Aggregate across frames — iframe-only ATS forms never live in the top frame.
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const w = window as unknown as {
          getFormFillerStatus?: () => { isRunning: boolean; filledCount: number };
        };
        if (typeof w.getFormFillerStatus === 'function') {
          return w.getFormFillerStatus();
        }
        return null;
      },
    });

    let isRunning = false;
    let filledCount = 0;
    for (const frame of results || []) {
      const status = frame.result as { isRunning?: boolean; filledCount?: number } | null;
      if (status && typeof status === 'object') {
        if (status.isRunning) isRunning = true;
        if (typeof status.filledCount === 'number') filledCount += status.filledCount;
      }
    }
    return { isRunning, filledCount };
  } catch {
    // allFrames can fail on restricted child frames — try top frame only
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: () => {
          const w = window as unknown as {
            getFormFillerStatus?: () => { isRunning: boolean; filledCount: number };
          };
          if (typeof w.getFormFillerStatus === 'function') {
            return w.getFormFillerStatus();
          }
          return null;
        },
      });
      const status = results?.[0]?.result as { isRunning?: boolean; filledCount?: number } | null;
      if (status && typeof status === 'object') {
        return { isRunning: !!status.isRunning, filledCount: status.filledCount || 0 };
      }
      return { isRunning: false, filledCount: 0 };
    } catch {
      return null;
    }
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

  // Proxy fetch from content script to bypass page CSP — allowlisted hosts only
  if (message?.action === 'proxyFetch') {
    if (!isAllowedProxyUrl(message.url)) {
      sendResponse({ error: 'proxyFetch blocked: URL host is not allowlisted' });
      return false;
    }

    // Only forward a safe subset of fetch options
    const incoming = message.options && typeof message.options === 'object' ? message.options : {};
    const headers = incoming.headers && typeof incoming.headers === 'object' ? incoming.headers : {};
    const safeOptions: RequestInit = {
      method: typeof incoming.method === 'string' ? incoming.method : 'GET',
      headers,
      body: typeof incoming.body === 'string' ? incoming.body : undefined,
      redirect: 'error',
      credentials: 'omit',
    };

    fetch(message.url, safeOptions)
      .then(async (res) => {
        const text = await res.text();
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((val, key) => { responseHeaders[key] = val; });
        sendResponse({
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
          body: text,
        });
      })
      .catch((err) => {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      });
    return true;
  }

  return false;
});
