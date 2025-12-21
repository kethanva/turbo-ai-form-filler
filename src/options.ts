// Options page for settings
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('settingsForm') as HTMLFormElement;
  const saveButton = document.getElementById('saveButton') as HTMLButtonElement;
  const statusDiv = document.getElementById('status') as HTMLDivElement;

  // Load current settings
  chrome.storage.sync.get(['secrets', 'settings'], (result) => {
    const secrets = result.secrets || {};
    const settings = result.settings || {};

    (document.getElementById('useAI') as HTMLInputElement).checked = secrets.use_AI !== false;
    (document.getElementById('batchMode') as HTMLInputElement).checked = settings.batch_mode !== false; // Default true
    (document.getElementById('groqApiKey') as HTMLInputElement).value = secrets.groq_api_key || '';
    (document.getElementById('groqModel') as HTMLInputElement).value = secrets.groq_model || 'llama-3.1-8b-instant';
    (document.getElementById('groqApiUrl') as HTMLInputElement).value = secrets.groq_api_url || 'https://api.groq.com/openai/v1/chat/completions';
    (document.getElementById('hfApiKey') as HTMLInputElement).value = secrets.huggingface_api_key || '';
    (document.getElementById('hfModel') as HTMLInputElement).value = secrets.huggingface_model || 'meta-llama/Llama-3.2-3B-Instruct';
    (document.getElementById('hfApiUrl') as HTMLInputElement).value = secrets.huggingface_api_url || 'https://router.huggingface.co/v1/chat/completions';
  });

  // Save settings
  // Save settings
  saveButton.addEventListener('click', () => {
    // Get current inputs
    const newGroqKey = (document.getElementById('groqApiKey') as HTMLInputElement).value.trim();
    const newHfKey = (document.getElementById('hfApiKey') as HTMLInputElement).value.trim();

    // Validation
    if (newGroqKey && newGroqKey.length > 0 && newGroqKey.length <= 8) {
      statusDiv.textContent = 'Groq API Key must be more than 8 characters!';
      statusDiv.className = 'status error';
      return;
    }

    if (newHfKey && newHfKey.length > 0 && newHfKey.length <= 8) {
      statusDiv.textContent = 'HuggingFace API Key must be more than 8 characters!';
      statusDiv.className = 'status error';
      return;
    }

    // Load existing secrets to preserve keys if not modified
    chrome.storage.sync.get(['secrets'], (result) => {
      const existingSecrets = result.secrets || {};

      // Create updated secrets object by merging
      const updatedSecrets = { ...existingSecrets };

      // Always update boolean/toggle settings
      updatedSecrets.use_AI = (document.getElementById('useAI') as HTMLInputElement).checked;
      updatedSecrets.groq_model = (document.getElementById('groqModel') as HTMLInputElement).value.trim();
      updatedSecrets.groq_api_url = (document.getElementById('groqApiUrl') as HTMLInputElement).value.trim();
      updatedSecrets.huggingface_model = (document.getElementById('hfModel') as HTMLInputElement).value.trim();
      updatedSecrets.huggingface_api_url = (document.getElementById('hfApiUrl') as HTMLInputElement).value.trim();

      // Only update sensitive keys if new value is provided and valid
      if (newGroqKey.length > 8) {
        updatedSecrets.groq_api_key = newGroqKey;
      }

      if (newHfKey.length > 8) {
        updatedSecrets.huggingface_api_key = newHfKey;
      }

      const settings = {
        batch_mode: (document.getElementById('batchMode') as HTMLInputElement).checked
      };

      chrome.storage.sync.set({ secrets: updatedSecrets, settings }, () => {
        statusDiv.textContent = 'Settings saved!';
        statusDiv.className = 'status success';
        setTimeout(() => {
          statusDiv.textContent = '';
          statusDiv.className = '';
        }, 2000);
      });
    });
  });
});

