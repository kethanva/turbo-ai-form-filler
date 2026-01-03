// Storage utilities for secrets management
import { Secrets, defaultSecrets } from '../config/secrets.js';

// Load secrets from Chrome storage or use defaults
export async function loadSecrets(): Promise<Secrets> {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['secrets'], (result) => {
            if (result.secrets) {
                // Merge while preserving defaults if stored values are empty/invalid
                const stored = result.secrets;
                const merged = { ...defaultSecrets };

                // Only overwrite string fields if stored value is valid and non-empty
                if (stored.groq_api_key && stored.groq_api_key.trim().length > 8) {
                    merged.groq_api_key = stored.groq_api_key;
                }
                if (stored.huggingface_api_key && stored.huggingface_api_key.trim().length > 8) {
                    merged.huggingface_api_key = stored.huggingface_api_key;
                }

                // Update other fields
                if (stored.use_AI !== undefined) merged.use_AI = stored.use_AI;
                if (stored.groq_model) merged.groq_model = stored.groq_model;
                if (stored.groq_api_url) merged.groq_api_url = stored.groq_api_url;
                if (stored.huggingface_model) merged.huggingface_model = stored.huggingface_model;
                if (stored.huggingface_api_url) merged.huggingface_api_url = stored.huggingface_api_url;

                resolve(merged);
            } else {
                resolve(defaultSecrets);
            }
        });
    });
}

export async function saveSecrets(secrets: Partial<Secrets>): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['secrets'], (result) => {
            const currentSecrets = result.secrets || defaultSecrets;
            chrome.storage.sync.set({ secrets: { ...currentSecrets, ...secrets } }, () => {
                resolve();
            });
        });
    });
}
