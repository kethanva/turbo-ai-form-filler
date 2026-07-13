// Options page for settings - handles tabs, JSON editors, and Chrome storage

// ============ DEFAULTS (loaded from bundled JSON files) ============
type JsonRecord = Record<string, unknown>;
let defaultPersonals: JsonRecord | null = null;
let defaultQuestions: JsonRecord | null = null;

async function loadDefaults(): Promise<void> {
  try {
    const questionsUrl = chrome.runtime.getURL('config/questions.json');
    const personalsCandidates = [
      chrome.runtime.getURL('config/personals.json'),
      chrome.runtime.getURL('config/personals.example.json'),
    ];

    const questionsRes = await fetch(questionsUrl);
    defaultQuestions = await questionsRes.json();

    for (const url of personalsCandidates) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          defaultPersonals = await res.json();
          break;
        }
      } catch {
        // try next candidate
      }
    }
  } catch (e) {
    console.error('Failed to load default configs:', e);
  }
}

// ============ TAB SWITCHING ============
function initTabs(): void {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');

      // Update button states
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update content visibility
      tabContents.forEach(content => {
        content.classList.remove('active');
        if (content.id === `tab-${tabId}`) {
          content.classList.add('active');
        }
      });
    });
  });
}

// ============ JSON VALIDATION ============
function validateJSON(text: string): { valid: boolean; error?: string; parsed?: unknown } {
  try {
    const parsed = JSON.parse(text);
    return { valid: true, parsed };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { valid: false, error: message };
  }
}

function formatJSON(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

// ============ STATUS MESSAGES ============
function showStatus(elementId: string, message: string, isError: boolean = false): void {
  const statusEl = document.getElementById(elementId);
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = `status ${isError ? 'error' : 'success'}`;

    if (!isError) {
      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'status';
      }, 3000);
    }
  }
}

// ============ CHARACTER COUNT ============
function updateCharCount(textareaId: string, counterId: string): void {
  const textarea = document.getElementById(textareaId) as HTMLTextAreaElement;
  const counter = document.getElementById(counterId);
  if (textarea && counter) {
    const chars = textarea.value.length;
    counter.textContent = `${chars.toLocaleString()} characters`;
  }
}

// ============ LOAD SETTINGS ============
async function loadSettings(): Promise<void> {
  await loadDefaults();

  // Load API settings from sync storage (small)
  chrome.storage.sync.get(['secrets', 'settings'], (syncResult) => {
    const secrets = syncResult.secrets || {};
    const settings = syncResult.settings || {};

    // API Keys tab
    (document.getElementById('useAI') as HTMLInputElement).checked = secrets.use_AI !== false;
    (document.getElementById('batchMode') as HTMLInputElement).checked = settings.batch_mode !== false;
    (document.getElementById('chunkMode') as HTMLInputElement).checked = settings.chunk_mode !== false;

    const chunkModeContainer = document.getElementById('chunkModeContainer');
    if (chunkModeContainer) {
      chunkModeContainer.style.display = (settings.batch_mode !== false) ? 'block' : 'none';
    }

    (document.getElementById('groqApiKey') as HTMLInputElement).value = secrets.groq_api_key || '';
    (document.getElementById('groqModel') as HTMLInputElement).value = secrets.groq_model || 'llama-3.1-8b-instant';
    (document.getElementById('groqApiUrl') as HTMLInputElement).value = secrets.groq_api_url || 'https://api.groq.com/openai/v1/chat/completions';
    (document.getElementById('hfApiKey') as HTMLInputElement).value = secrets.huggingface_api_key || '';
    (document.getElementById('hfModel') as HTMLInputElement).value = secrets.huggingface_model || 'meta-llama/Llama-3.2-3B-Instruct';
    (document.getElementById('hfApiUrl') as HTMLInputElement).value = secrets.huggingface_api_url || 'https://router.huggingface.co/v1/chat/completions';
  });

  // Load large configs from local storage (no size limit)
  chrome.storage.local.get(['personals', 'questions'], (localResult) => {
    // Profile tab - use stored or defaults
    const personalsData = localResult.personals || defaultPersonals || {};
    const personalsEditor = document.getElementById('personalsEditor') as HTMLTextAreaElement;
    personalsEditor.value = JSON.stringify(personalsData, null, 2);
    updateCharCount('personalsEditor', 'profileCharCount');

    // Prompts tab - use stored or defaults
    const questionsData = localResult.questions || defaultQuestions || {};
    const questionsEditor = document.getElementById('questionsEditor') as HTMLTextAreaElement;
    questionsEditor.value = JSON.stringify(questionsData, null, 2);
    updateCharCount('questionsEditor', 'promptsCharCount');
  });
}

// ============ SAVE FUNCTIONS ============
function saveSecrets(): void {
  const groqKey = (document.getElementById('groqApiKey') as HTMLInputElement).value.trim();
  const hfKey = (document.getElementById('hfApiKey') as HTMLInputElement).value.trim();

  // Validation — require known vendor prefixes when a key is provided
  const groqKeyPattern = /^gsk_[A-Za-z0-9]{20,}$/;
  const hfKeyPattern = /^hf_[A-Za-z0-9]{20,}$/;

  if (groqKey && !groqKeyPattern.test(groqKey)) {
    showStatus('secretsStatus', 'Groq API Key must start with gsk_ and be a valid key length.', true);
    return;
  }
  if (hfKey && !hfKeyPattern.test(hfKey)) {
    showStatus('secretsStatus', 'HuggingFace API Key must start with hf_ and be a valid key length.', true);
    return;
  }

  chrome.storage.sync.get(['secrets'], (result) => {
    const existingSecrets = result.secrets || {};
    const updatedSecrets = { ...existingSecrets };

    updatedSecrets.use_AI = (document.getElementById('useAI') as HTMLInputElement).checked;
    updatedSecrets.groq_model = (document.getElementById('groqModel') as HTMLInputElement).value.trim();
    updatedSecrets.groq_api_url = (document.getElementById('groqApiUrl') as HTMLInputElement).value.trim();
    updatedSecrets.huggingface_model = (document.getElementById('hfModel') as HTMLInputElement).value.trim();
    updatedSecrets.huggingface_api_url = (document.getElementById('hfApiUrl') as HTMLInputElement).value.trim();

    if (groqKey) {
      updatedSecrets.groq_api_key = groqKey;
    }
    if (hfKey) {
      updatedSecrets.huggingface_api_key = hfKey;
    }

    const settings = {
      batch_mode: (document.getElementById('batchMode') as HTMLInputElement).checked,
      chunk_mode: (document.getElementById('chunkMode') as HTMLInputElement).checked
    };

    chrome.storage.sync.set({ secrets: updatedSecrets, settings }, () => {
      showStatus('secretsStatus', '✓ API settings saved!');
    });
  });
}

function saveProfile(): void {
  const editor = document.getElementById('personalsEditor') as HTMLTextAreaElement;
  const result = validateJSON(editor.value);

  if (!result.valid) {
    editor.classList.add('error');
    showStatus('profileStatus', `Invalid JSON: ${result.error}`, true);
    return;
  }

  editor.classList.remove('error');
  // Use local storage for large data (no 8KB limit)
  chrome.storage.local.set({ personals: result.parsed }, () => {
    if (chrome.runtime.lastError) {
      showStatus('profileStatus', `Error: ${chrome.runtime.lastError.message}`, true);
    } else {
      showStatus('profileStatus', '✓ Profile saved! Reload extension to apply.');
    }
  });
}

function savePrompts(): void {
  const editor = document.getElementById('questionsEditor') as HTMLTextAreaElement;
  const result = validateJSON(editor.value);

  if (!result.valid) {
    editor.classList.add('error');
    showStatus('promptsStatus', `Invalid JSON: ${result.error}`, true);
    return;
  }

  editor.classList.remove('error');
  // Use local storage for large data
  chrome.storage.local.set({ questions: result.parsed }, () => {
    if (chrome.runtime.lastError) {
      showStatus('promptsStatus', `Error: ${chrome.runtime.lastError.message}`, true);
    } else {
      showStatus('promptsStatus', '✓ Prompts saved! Reload extension to apply.');
    }
  });
}

// ============ RESET FUNCTIONS ============
function resetProfile(): void {
  if (confirm('Reset profile to defaults? Your changes will be lost.')) {
    chrome.storage.local.remove('personals', () => {
      const editor = document.getElementById('personalsEditor') as HTMLTextAreaElement;
      editor.value = JSON.stringify(defaultPersonals, null, 2);
      editor.classList.remove('error');
      updateCharCount('personalsEditor', 'profileCharCount');
      showStatus('profileStatus', '✓ Profile reset to defaults');
    });
  }
}

function resetPrompts(): void {
  if (confirm('Reset prompts to defaults? Your changes will be lost.')) {
    chrome.storage.local.remove('questions', () => {
      const editor = document.getElementById('questionsEditor') as HTMLTextAreaElement;
      editor.value = JSON.stringify(defaultQuestions, null, 2);
      editor.classList.remove('error');
      updateCharCount('questionsEditor', 'promptsCharCount');
      showStatus('promptsStatus', '✓ Prompts reset to defaults');
    });
  }
}

// ============ INITIALIZATION ============
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  loadSettings();

  // Batch mode toggle
  const batchModeCheckbox = document.getElementById('batchMode');
  if (batchModeCheckbox) {
    batchModeCheckbox.addEventListener('change', (e) => {
      const chunkModeContainer = document.getElementById('chunkModeContainer');
      if (chunkModeContainer) {
        chunkModeContainer.style.display = (e.target as HTMLInputElement).checked ? 'block' : 'none';
      }
    });
  }

  // Save buttons
  document.getElementById('saveSecrets')?.addEventListener('click', saveSecrets);
  document.getElementById('saveProfile')?.addEventListener('click', saveProfile);
  document.getElementById('savePrompts')?.addEventListener('click', savePrompts);

  // Format buttons
  document.getElementById('formatProfile')?.addEventListener('click', () => {
    const editor = document.getElementById('personalsEditor') as HTMLTextAreaElement;
    editor.value = formatJSON(editor.value);
    updateCharCount('personalsEditor', 'profileCharCount');
  });
  document.getElementById('formatPrompts')?.addEventListener('click', () => {
    const editor = document.getElementById('questionsEditor') as HTMLTextAreaElement;
    editor.value = formatJSON(editor.value);
    updateCharCount('questionsEditor', 'promptsCharCount');
  });

  // Reset buttons
  document.getElementById('resetProfile')?.addEventListener('click', resetProfile);
  document.getElementById('resetPrompts')?.addEventListener('click', resetPrompts);

  // Character count updates
  document.getElementById('personalsEditor')?.addEventListener('input', () => {
    updateCharCount('personalsEditor', 'profileCharCount');
    (document.getElementById('personalsEditor') as HTMLTextAreaElement).classList.remove('error');
  });
  document.getElementById('questionsEditor')?.addEventListener('input', () => {
    updateCharCount('questionsEditor', 'promptsCharCount');
    (document.getElementById('questionsEditor') as HTMLTextAreaElement).classList.remove('error');
  });
});
