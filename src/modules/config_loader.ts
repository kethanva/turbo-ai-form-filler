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

/**
 * Invalidate config caches - call this when storage is updated
 */
export function invalidateConfigCache(which?: 'personals' | 'questions' | 'secrets' | 'all'): void {
    if (!which || which === 'all') {
        personalsCache = null;
        questionsCache = null;
        secretsCache = null;
    } else if (which === 'personals') {
        personalsCache = null;
    } else if (which === 'questions') {
        questionsCache = null;
    } else if (which === 'secrets') {
        secretsCache = null;
    }
}

// Listen for storage changes and invalidate caches automatically
if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
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
    });
}

/**
 * Load a JSON config file from the extension's config directory (extension context only).
 * Not exposed to web pages — web_accessible_resources must remain unset for these files.
 */
async function loadJsonConfig<T>(filename: string): Promise<T> {
    const url = chrome.runtime.getURL(`config/${filename}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load config: ${filename}`);
    }
    return response.json();
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
 * Load secrets — chrome.storage.sync first, then bundled defaults (keys never trusted from disk).
 */
export async function loadSecrets(): Promise<Secrets> {
    if (secretsCache) {
        return secretsCache;
    }

    let bundled: Secrets | null = null;
    try {
        bundled = await loadJsonConfig<Secrets>('secrets.json');
    } catch {
        try {
            bundled = await loadJsonConfig<Secrets>('secrets.example.json');
        } catch {
            bundled = null;
        }
    }

    const defaults: Secrets = bundled || {
        use_AI: true,
        groq_api_key: '',
        groq_model: 'llama-3.1-8b-instant',
        groq_api_url: 'https://api.groq.com/openai/v1/chat/completions',
        huggingface_api_key: '',
        huggingface_model: 'meta-llama/Llama-3.2-3B-Instruct',
        huggingface_api_url: 'https://router.huggingface.co/v1/chat/completions',
    };

    // Never keep API keys from bundled files — only models/URLs/flags.
    const base: Secrets = {
        ...defaults,
        groq_api_key: '',
        huggingface_api_key: '',
    };

    const result = await new Promise<Secrets>((resolve) => {
        chrome.storage.sync.get(['secrets'], (storedResult) => {
            if (storedResult.secrets) {
                const stored = storedResult.secrets;
                const merged = { ...base };

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
    });

    secretsCache = result;
    return result;
}

/**
 * Save secrets to Chrome storage
 */
export async function saveSecrets(secrets: Partial<Secrets>): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['secrets'], (result) => {
            const currentSecrets = result.secrets || secretsCache || {};
            chrome.storage.sync.set({ secrets: { ...currentSecrets, ...secrets } }, () => {
                secretsCache = null;
                resolve();
            });
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

/**
 * Preload all configs (call this at extension init)
 */
export async function preloadAllConfigs(): Promise<void> {
    await Promise.all([
        loadSecrets(),
        loadQuestions(),
        loadPersonals(),
    ]);
}
