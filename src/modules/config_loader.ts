// Unified config loader - chrome.storage is the source of truth.
// Bundled JSON files are only used as defaults (seeded by background on install).

export interface Secrets {
    use_AI: boolean;
    groq_api_key: string;
    groq_model: string;
    groq_api_url: string;
    huggingface_api_key: string;
    huggingface_model: string;
    huggingface_api_url: string;
}

export interface Questions {
    extract_skills_prompt: string;
    ai_answer_prompt: string;
}

export interface Experience {
    companyKey: string;
    title: string;
    from: string;
    to: string;
    location: string;
    highlights: string[];
}

export interface Education {
    degree: string;
    field: string;
    institution: string;
    from: string;
    to: string;
}

export interface Personals {
    experience_details: Experience[];
    education_details: Education[];
    user_information_all: string;
    [key: string]: any; // Allow additional fields
}

// Cache loaded configs to avoid repeated storage reads
let secretsCache: Secrets | null = null;
let questionsCache: Questions | null = null;
let personalsCache: Personals | null = null;

// Listen for storage changes and invalidate caches automatically.
// This module is bundled into content.bundle.js and re-evaluated on every
// content-script re-injection (see content.ts) — each re-evaluation gets its
// own fresh cache variables above, so the listener registered by a PREVIOUS
// injection must be removed first — otherwise it accumulates forever for the
// life of the tab, and this new injection's own caches would never get
// invalidated because its listener never took over.
//
// This module is ALSO imported directly by background.ts, which runs in a
// service worker — there is no `window` there, only `self` (in a page/content
// script realm `self === window`, so `self` works in both places; `window`
// alone would throw ReferenceError and take down the whole service worker).
if (typeof chrome !== 'undefined' && chrome.storage) {
    const globalScope = self as any;
    if (typeof globalScope.__formAutopilotUnbindStorageListener === 'function') {
        try {
            chrome.storage.onChanged.removeListener(globalScope.__formAutopilotUnbindStorageListener);
        } catch {
            // ignore — previous listener may already be gone
        }
    }

    const onStorageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
        if (areaName === 'local') {
            if (changes.personals) {
                personalsCache = null;
            }
            if (changes.questions) {
                questionsCache = null;
            }
        }
        if (areaName === 'sync' && changes.secrets) {
            secretsCache = null;
        }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    globalScope.__formAutopilotUnbindStorageListener = onStorageChanged;
}

/**
 * Load a JSON config file from the extension's config directory.
 *
 * Extension-origin contexts (options page, popup, service worker) fetch the
 * packaged file directly. Content scripts CANNOT: without
 * web_accessible_resources, MV3 treats their fetch as page-origin and Chrome
 * denies the load. For those we ask the background service worker, which is
 * extension-origin and always allowed to read packaged files.
 */
async function loadJsonConfig<T>(filename: string): Promise<T> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
        throw new Error('Extension context invalidated — refresh the page and try again');
    }

    const isExtensionOrigin =
        typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
    if (!isExtensionOrigin) {
        return loadJsonConfigViaBackground<T>(filename);
    }

    const url = chrome.runtime.getURL(`config/${filename}`);
    if (!url || url.startsWith('chrome-extension://invalid')) {
        throw new Error('Extension context invalidated — refresh the page and try again');
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load config: ${filename}`);
    }
    return response.json();
}

/** Content-script path: background reads the packaged config file for us. */
function loadJsonConfigViaBackground<T>(filename: string): Promise<T> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'loadBundledConfig', filename }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!response || response.error) {
                reject(new Error(response?.error || `Failed to load config: ${filename}`));
                return;
            }
            resolve(response.data as T);
        });
    });
}

function normalizeQuestions(raw: {
    extract_skills_prompt?: string | string[];
    ai_answer_prompt?: string | string[];
}): Questions {
    return {
        extract_skills_prompt: Array.isArray(raw.extract_skills_prompt)
            ? raw.extract_skills_prompt.join('\n')
            : raw.extract_skills_prompt || '',
        ai_answer_prompt: Array.isArray(raw.ai_answer_prompt)
            ? raw.ai_answer_prompt.join('\n')
            : raw.ai_answer_prompt || '',
    };
}

/**
 * Load secrets — chrome.storage.sync overlays bundled config/secrets.json.
 * Reading secrets.json via getURL is safe for extension contexts when WAR is unset.
 * Web pages cannot fetch it; only this extension can.
 */
export async function loadSecrets(): Promise<Secrets> {
    if (secretsCache) {
        return secretsCache;
    }

    let bundled: Secrets | null = null;
    try {
        bundled = await loadJsonConfig<Secrets>('secrets.json');
    } catch (e) {
        printQuietConfigError('secrets.json', e);
        try {
            bundled = await loadJsonConfig<Secrets>('secrets.example.json');
        } catch (e2) {
            printQuietConfigError('secrets.example.json', e2);
            bundled = null;
        }
    }

    const base: Secrets = bundled || {
        use_AI: true,
        groq_api_key: '',
        groq_model: 'llama-3.1-8b-instant',
        groq_api_url: 'https://api.groq.com/openai/v1/chat/completions',
        huggingface_api_key: '',
        huggingface_model: 'meta-llama/Llama-3.2-3B-Instruct',
        huggingface_api_url: 'https://router.huggingface.co/v1/chat/completions',
    };

    const result = await new Promise<Secrets>((resolve) => {
        try {
            chrome.storage.sync.get(['secrets'], (storedResult) => {
                if (chrome.runtime.lastError) {
                    resolve(base);
                    return;
                }
                if (storedResult.secrets) {
                    const stored = storedResult.secrets;
                    const merged = { ...base };

                    // Storage wins when a real key is present (Options page).
                    if (stored.groq_api_key && stored.groq_api_key.trim().length > 8) {
                        merged.groq_api_key = stored.groq_api_key;
                    }
                    if (stored.huggingface_api_key && stored.huggingface_api_key.trim().length > 8) {
                        merged.huggingface_api_key = stored.huggingface_api_key;
                    }
                    if (stored.use_AI !== undefined) merged.use_AI = stored.use_AI;
                    if (stored.groq_model) merged.groq_model = stored.groq_model;
                    if (stored.groq_api_url) merged.groq_api_url = stored.groq_api_url;
                    if (stored.huggingface_model) merged.huggingface_model = stored.huggingface_model;
                    if (stored.huggingface_api_url) merged.huggingface_api_url = stored.huggingface_api_url;

                    resolve(merged);
                } else {
                    resolve(base);
                }
            });
        } catch {
            resolve(base);
        }
    });

    secretsCache = result;
    return result;
}

function printQuietConfigError(name: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    // Avoid noisy stack traces for expected missing/invalid-context cases
    if (typeof console !== 'undefined') {
        console.warn(`[form-autopilot] Could not load config/${name}: ${msg}`);
    }
}

/** True when at least one LLM provider key is configured. */
export function hasConfiguredApiKeys(secrets: Secrets): boolean {
    const groq = (secrets.groq_api_key || '').trim();
    const hf = (secrets.huggingface_api_key || '').trim();
    return groq.length > 8 || hf.length > 8;
}

export interface ProviderAvailability {
    useAI: boolean;
    groqAvailable: boolean;
    groqModel: string;
    hfAvailable: boolean;
    hfModel: string;
}

/**
 * Content-script-safe substitute for loadSecrets(): asks the background
 * service worker whether each provider is configured WITHOUT ever returning
 * the actual API key value into content-script memory. Background is the
 * only context that ever holds real key material.
 */
export async function loadProviderAvailability(): Promise<ProviderAvailability> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
        throw new Error('Extension context invalidated — refresh the page and try again');
    }
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'getProviderAvailability' }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!response || response.error) {
                reject(new Error(response?.error || 'Failed to load provider availability'));
                return;
            }
            resolve(response as ProviderAvailability);
        });
    });
}

/**
 * Load questions/prompts - Chrome storage first, then bundled JSON
 */
export async function loadQuestions(): Promise<Questions> {
    if (!questionsCache) {
        const stored = await new Promise<any>((resolve) => {
            chrome.storage.local.get(['questions'], (result) => resolve(result.questions));
        });

        if (stored && Object.keys(stored).length > 0) {
            questionsCache = normalizeQuestions(stored);
        } else {
            const raw = await loadJsonConfig<{
                extract_skills_prompt: string | string[];
                ai_answer_prompt: string | string[];
            }>('questions.json');
            questionsCache = normalizeQuestions(raw);
        }
    }
    return questionsCache;
}

/**
 * Load personals/user info - Chrome storage first, then bundled JSON
 */
export async function loadPersonals(): Promise<Personals> {
    if (!personalsCache) {
        const stored = await new Promise<any>((resolve) => {
            chrome.storage.local.get(['personals'], (result) => resolve(result.personals));
        });

        if (stored && Object.keys(stored).length > 0) {
            personalsCache = stored;
        } else {
            try {
                personalsCache = await loadJsonConfig<Personals>('personals.json');
            } catch {
                personalsCache = await loadJsonConfig<Personals>('personals.example.json');
            }
        }
    }
    return personalsCache!;
}

export function getPersonalsSync(): Personals | null {
    return personalsCache;
}

export function getQuestionsSync(): Questions | null {
    return questionsCache;
}
