// Options page for settings
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('settingsForm') as HTMLFormElement;
  const saveButton = document.getElementById('saveButton') as HTMLButtonElement;
  const statusDiv = document.getElementById('status') as HTMLDivElement;

  // Load current settings
  chrome.storage.sync.get(['secrets'], (result) => {
    const secrets = result.secrets || {};
    
    (document.getElementById('useAI') as HTMLInputElement).checked = secrets.use_AI !== false;
    (document.getElementById('groqApiKey') as HTMLInputElement).value = secrets.groq_api_key || '';
    (document.getElementById('groqModel') as HTMLInputElement).value = secrets.groq_model || 'llama-3.1-8b-instant';
    (document.getElementById('groqApiUrl') as HTMLInputElement).value = secrets.groq_api_url || 'https://api.groq.com/openai/v1/chat/completions';
    (document.getElementById('hfApiKey') as HTMLInputElement).value = secrets.huggingface_api_key || '';
    (document.getElementById('hfModel') as HTMLInputElement).value = secrets.huggingface_model || 'meta-llama/Llama-3.2-3B-Instruct';
    (document.getElementById('hfApiUrl') as HTMLInputElement).value = secrets.huggingface_api_url || 'https://router.huggingface.co/v1/chat/completions';
  });

  // Save settings
  saveButton.addEventListener('click', () => {
    const secrets = {
      use_AI: (document.getElementById('useAI') as HTMLInputElement).checked,
      groq_api_key: (document.getElementById('groqApiKey') as HTMLInputElement).value.trim(),
      groq_model: (document.getElementById('groqModel') as HTMLInputElement).value.trim(),
      groq_api_url: (document.getElementById('groqApiUrl') as HTMLInputElement).value.trim(),
      huggingface_api_key: (document.getElementById('hfApiKey') as HTMLInputElement).value.trim(),
      huggingface_model: (document.getElementById('hfModel') as HTMLInputElement).value.trim(),
      huggingface_api_url: (document.getElementById('hfApiUrl') as HTMLInputElement).value.trim()
    };

    chrome.storage.sync.set({ secrets }, () => {
      statusDiv.textContent = 'Settings saved!';
      statusDiv.className = 'status success';
      setTimeout(() => {
        statusDiv.textContent = '';
        statusDiv.className = '';
      }, 2000);
    });
  });
});

