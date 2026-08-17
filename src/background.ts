// Background service worker
import { loadSecrets, Secrets } from './modules/config_loader.js';
import { MAX_LLM_REQUESTS_PER_FILL, SCHEMA_VERSION } from './modules/fill_policy.js';
import { isAllowedProviderUrl, sanitizeLlmRequestBody } from './modules/provider_guard.js';

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
  const local = await chrome.storage.local.get(['personals', 'questions', 'secrets', 'schema_version']);

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

  const storedVersion = Number(local.schema_version) || 0;
  if (storedVersion < SCHEMA_VERSION) {
    const sync = await chrome.storage.sync.get(['secrets']);
    const syncSecrets = (sync.secrets || {}) as Record<string, unknown>;
    const localSecrets = (local.secrets || {}) as Record<string, unknown>;
    const mergedSecrets = { ...syncSecrets, ...localSecrets };
    if (Object.keys(mergedSecrets).length > 0) {
      updatesLocal.secrets = mergedSecrets;
    }
    updatesLocal.schema_version = SCHEMA_VERSION;
    const stripped = { ...syncSecrets };
    delete stripped.groq_api_key;
    delete stripped.huggingface_api_key;
    await chrome.storage.sync.set({ secrets: stripped });
  }

  if (Object.keys(updatesLocal).length > 0) {
    await chrome.storage.local.set(updatesLocal);
  }
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

const fillingTabs = new Map<number, number>();
const llmRequestCounts = new Map<number, number>();
const fillingStartedAt = new Map<number, number>();
let fillGeneration = 0;
const FILL_SESSION_TTL_MS = 10 * 60 * 1000;
const LLM_FETCH_ATTEMPTS = 3;

function fillSessionStorageKey(tabId: number): string {
  return `fill_session_${tabId}`;
}

async function persistFillSession(tabId: number, token: number, count: number): Promise<void> {
  try {
    if (!chrome.storage?.session) return;
    const startedAt = fillingStartedAt.get(tabId) ?? Date.now();
    fillingStartedAt.set(tabId, startedAt);
    await chrome.storage.session.set({
      [fillSessionStorageKey(tabId)]: { token, count, startedAt },
    });
  } catch {
    // session storage is unavailable in some test stubs
  }
}

async function clearPersistedFillSession(tabId: number): Promise<void> {
  fillingStartedAt.delete(tabId);
  try {
    if (!chrome.storage?.session) return;
    await chrome.storage.session.remove(fillSessionStorageKey(tabId));
  } catch {
    // ignore
  }
}

async function restoreFillSession(tabId: number): Promise<boolean> {
  if (fillingTabs.has(tabId)) return true;
  try {
    if (!chrome.storage?.session) return false;
    const key = fillSessionStorageKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const rec = stored[key] as { token?: number; count?: number; startedAt?: number } | undefined;
    if (!rec || typeof rec.token !== 'number' || typeof rec.startedAt !== 'number') return false;
    if (Date.now() - rec.startedAt > FILL_SESSION_TTL_MS) {
      await chrome.storage.session.remove(key);
      return false;
    }
    fillingTabs.set(tabId, rec.token);
    llmRequestCounts.set(tabId, rec.count || 0);
    fillingStartedAt.set(tabId, rec.startedAt);
    return true;
  } catch {
    return false;
  }
}

async function fetchProviderOnce(
  url: string,
  key: string,
  body: unknown
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < LLM_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((val, headerKey) => { responseHeaders[headerKey] = val; });
      return {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        body: text,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < LLM_FETCH_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Inject into frames that need it, then start filling in every frame that has
 * forms. Aggregate filledCount across frames so a top-frame "0 fields" reply
 * can never erase a successful iframe fill.
 */
async function startFillingInTab(tabId: number): Promise<{ success: boolean; filledCount: number; error?: string }> {
  if (fillingTabs.has(tabId)) {
    return { success: false, filledCount: 0, error: 'Fill already in progress on this tab' };
  }
  const token = ++fillGeneration;
  fillingTabs.set(tabId, token);
  llmRequestCounts.set(tabId, 0);
  await persistFillSession(tabId, token, 0);
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
  } finally {
    if (fillingTabs.get(tabId) === token) {
      fillingTabs.delete(tabId);
      llmRequestCounts.delete(tabId);
      void clearPersistedFillSession(tabId);
    }
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'blocked: unknown sender' });
    return false;
  }

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
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ error: 'llmRequest blocked: no active fill session' });
      return false;
    }

    void (async () => {
      if (!(await restoreFillSession(tabId))) {
        sendResponse({ error: 'llmRequest blocked: no active fill session' });
        return;
      }
      const used = (llmRequestCounts.get(tabId) || 0) + 1;
      llmRequestCounts.set(tabId, used);
      const token = fillingTabs.get(tabId);
      if (typeof token === 'number') {
        void persistFillSession(tabId, token, used);
      }
      if (used > MAX_LLM_REQUESTS_PER_FILL) {
        sendResponse({ error: 'llmRequest blocked: per-fill request cap reached' });
        return;
      }

      const secrets = await loadSecrets();
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
      const allowedModel = message.provider === 'huggingface' ? secrets.huggingface_model : secrets.groq_model;
      const body = sanitizeLlmRequestBody(message.body, allowedModel);
      if (!body) {
        sendResponse({ error: 'llmRequest blocked: invalid request body' });
        return;
      }
      try {
        const result = await fetchProviderOnce(cfg.url, cfg.key, body);
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  return false;
});
