// Unified config loader - loads JSON files at runtime
// All config files are in extension/config/*.json

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

// Cache loaded configs to avoid repeated fetches
let secretsCache: Secrets | null = null;
let questionsCache: Questions | null = null;
let personalsCache: Personals | null = null;

/**
 * Invalidate config caches - call this when storage is updated
 */
export function invalidateConfigCache(which?: 'personals' | 'questions' | 'all'): void {
    if (!which || which === 'all') {
        personalsCache = null;
        questionsCache = null;
    } else if (which === 'personals') {
        personalsCache = null;
    } else if (which === 'questions') {
        questionsCache = null;
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
    });
}

/**
 * Load a JSON config file from the extension's config directory
 */
async function loadJsonConfig<T>(filename: string): Promise<T> {
    const url = chrome.runtime.getURL(`config/${filename}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load config: ${filename}`);
    }
    return response.json();
}

/**
 * Load secrets from JSON file, with Chrome storage overlay
 */
export async function loadSecrets(): Promise<Secrets> {
    // Load from JSON file first
    if (!secretsCache) {
        secretsCache = await loadJsonConfig<Secrets>('secrets.json');
    }

    // Overlay with Chrome storage if available
    return new Promise((resolve) => {
        chrome.storage.sync.get(['secrets'], (result) => {
            if (result.secrets) {
                const stored = result.secrets;
                const merged = { ...secretsCache! };

                // Only overwrite if stored values are valid
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
                resolve(secretsCache!);
            }
        });
    });
}

/**
 * Save secrets to Chrome storage
 */
export async function saveSecrets(secrets: Partial<Secrets>): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['secrets'], (result) => {
            const currentSecrets = result.secrets || secretsCache || {};
            chrome.storage.sync.set({ secrets: { ...currentSecrets, ...secrets } }, () => {
                resolve();
            });
        });
    });
}

/**
 * Load questions/prompts - Chrome storage first, then bundled JSON
 * Prompts are stored as arrays of strings for readability, joined here
 */
export async function loadQuestions(): Promise<Questions> {
    if (!questionsCache) {
        // Check Chrome local storage first (user edits)
        const stored = await new Promise<any>((resolve) => {
            chrome.storage.local.get(['questions'], (result) => resolve(result.questions));
        });

        if (stored && Object.keys(stored).length > 0) {
            // User has saved custom questions - process array format
            questionsCache = {
                extract_skills_prompt: Array.isArray(stored.extract_skills_prompt)
                    ? stored.extract_skills_prompt.join('\n')
                    : stored.extract_skills_prompt || '',
                ai_answer_prompt: Array.isArray(stored.ai_answer_prompt)
                    ? stored.ai_answer_prompt.join('\n')
                    : stored.ai_answer_prompt || ''
            };
        } else {
            // Fallback to bundled JSON
            const raw = await loadJsonConfig<{
                extract_skills_prompt: string | string[];
                ai_answer_prompt: string | string[]
            }>('questions.json');

            questionsCache = {
                extract_skills_prompt: Array.isArray(raw.extract_skills_prompt)
                    ? raw.extract_skills_prompt.join('\n')
                    : raw.extract_skills_prompt,
                ai_answer_prompt: Array.isArray(raw.ai_answer_prompt)
                    ? raw.ai_answer_prompt.join('\n')
                    : raw.ai_answer_prompt
            };
        }
    }
    return questionsCache;
}

/**
 * Load personals/user info - Chrome storage first, then bundled JSON
 */
export async function loadPersonals(): Promise<Personals> {
    if (!personalsCache) {
        // Check Chrome local storage first (user edits)
        const stored = await new Promise<any>((resolve) => {
            chrome.storage.local.get(['personals'], (result) => resolve(result.personals));
        });

        if (stored && Object.keys(stored).length > 0) {
            personalsCache = stored;
        } else {
            // Fallback to bundled JSON
            personalsCache = await loadJsonConfig<Personals>('personals.json');
        }
    }
    return personalsCache!;
}

// For synchronous access (after initial load)
export function getPersonalsSync(): Personals | null {
    return personalsCache;
}

export function getQuestionsSync(): Questions | null {
    return questionsCache;
}

export function getSecretsSync(): Secrets | null {
    return secretsCache;
}

/**
 * Preload all configs (call this at extension init)
 */
export async function preloadAllConfigs(): Promise<void> {
    await Promise.all([
        loadSecrets(),
        loadQuestions(),
        loadPersonals()
    ]);
}
