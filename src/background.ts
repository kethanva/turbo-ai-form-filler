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

function sendToFrame<T>(
  tabId: number,
  frameId: number,
  message: Record<string, unknown>
): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve((response as T) ?? null);
    });
  });
}

/** True when a content-script listener is already present in the frame. */
async function frameHasListener(tabId: number, frameId: number): Promise<boolean> {
  const res = await sendToFrame<{ pong?: boolean }>(tabId, frameId, { action: 'ping' });
  return !!res?.pong;
}

/**
 * Inject the content bundle only into frames that do not already have a
 * listener — avoids re-parsing the large IIFE across every iframe on each Start.
 */
async function injectContentScripts(tabId: number): Promise<void> {
  let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null = null;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }

  const frameIds = (frames && frames.length > 0)
    ? frames.map((f) => f.frameId)
    : [0];

  const missing: number[] = [];
  for (const frameId of frameIds) {
    if (!(await frameHasListener(tabId, frameId))) {
      missing.push(frameId);
    }
  }

  if (missing.length === 0) return;

  // Batch inject where possible; fall back per-frame for sandboxed/about:blank.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: missing },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch {
    for (const frameId of missing) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          files: [CONTENT_SCRIPT_FILE],
        });
      } catch {
        // Sandboxed / opaque origin frames reject injection — ignore.
      }
    }
  }
}

/**
 * Inject into frames that need it, then start filling in every frame that has
 * forms. Aggregate filledCount across frames so a top-frame "0 fields" reply
 * can never erase a successful iframe fill.
 */
async function startFillingInTab(tabId: number): Promise<{ success: boolean; filledCount: number; error?: string }> {
  try {
    await injectContentScripts(tabId);

    let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null = null;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId });
    } catch {
      frames = null;
    }
    const frameIds = (frames && frames.length > 0)
      ? frames.map((f) => f.frameId)
      : [0];

    const results = await Promise.all(
      frameIds.map((frameId) =>
        sendToFrame<{ success?: boolean; filledCount?: number; skipped?: boolean; error?: string }>(
          tabId,
          frameId,
          { action: 'startFilling' }
        )
      )
    );

    let filledCount = 0;
    let anySuccess = false;
    let lastError: string | undefined;
    for (const res of results) {
      if (!res) continue;
      if (res.skipped) continue;
      if (typeof res.filledCount === 'number') filledCount += res.filledCount;
      if (res.success) anySuccess = true;
      if (res.error) lastError = res.error;
    }

    if (!anySuccess && lastError) {
      return { success: false, filledCount, error: lastError };
    }
    // No frame responded (restricted page) — surface a clear error.
    if (!results.some((r) => r != null)) {
      return { success: false, filledCount: 0, error: 'No frame accepted startFilling — refresh the page' };
    }
    return { success: true, filledCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, filledCount: 0, error: message };
  }
}

async function getStatusFromTab(tabId: number): Promise<{ isRunning: boolean; filledCount: number } | null> {
  try {
    let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null = null;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId });
    } catch {
      frames = null;
    }
    const frameIds = (frames && frames.length > 0)
      ? frames.map((f) => f.frameId)
      : [0];

    const results = await Promise.all(
      frameIds.map((frameId) =>
        sendToFrame<{ isRunning?: boolean; filledCount?: number }>(tabId, frameId, { action: 'getStatus' })
      )
    );

    let isRunning = false;
    let filledCount = 0;
    let any = false;
    for (const res of results) {
      if (!res) continue;
      any = true;
      if (res.isRunning) isRunning = true;
      if (typeof res.filledCount === 'number') filledCount += res.filledCount;
    }
    return any ? { isRunning, filledCount } : null;
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
