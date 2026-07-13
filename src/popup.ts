// Popup script for extension UI — event-driven status (no polling spam)
document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('startButton') as HTMLButtonElement;
  const statusDiv = document.getElementById('status') as HTMLDivElement;
  const settingsButton = document.getElementById('settingsButton') as HTMLButtonElement;
  const filledCountSpan = document.getElementById('filledCount') as HTMLSpanElement;

  function applyStatus(response: { isRunning?: boolean; filledCount?: number } | null | undefined, fallbackReady = true) {
    if (!response) {
      if (fallbackReady) {
        statusDiv.textContent = 'Ready (refresh page if needed)';
        statusDiv.className = 'status ready';
        startButton.disabled = false;
      }
      return;
    }

    if (response.isRunning) {
      statusDiv.textContent = 'Filling forms...';
      statusDiv.className = 'status running';
      startButton.disabled = true;
      if (filledCountSpan) {
        filledCountSpan.textContent = `Filled: ${response.filledCount || 0}`;
      }
    } else {
      statusDiv.textContent = 'Ready';
      statusDiv.className = 'status ready';
      startButton.disabled = false;
      if (filledCountSpan) {
        filledCountSpan.textContent = `Total: ${response.filledCount || 0}`;
      }
    }
  }

  function updateStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;

      const url = tabs[0].url || '';
      if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
        statusDiv.textContent = 'Not available on this page';
        statusDiv.className = 'status ready';
        startButton.disabled = true;
        return;
      }

      chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
        if (chrome.runtime.lastError) {
          applyStatus(null);
          return;
        }
        applyStatus(response);
      });
    });
  }

  // Live updates from content script while popup is open
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === 'fillStatus') {
      applyStatus({
        isRunning: !!message.isRunning,
        filledCount: message.filledCount || 0,
      });
    }
  });

  startButton.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) {
        statusDiv.textContent = 'Error: No active tab found';
        statusDiv.className = 'status error';
        return;
      }

      const url = tabs[0].url || '';
      if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
        statusDiv.textContent = 'Cannot fill forms on this page';
        statusDiv.className = 'status error';
        return;
      }

      statusDiv.textContent = 'Starting...';
      statusDiv.className = 'status running';
      startButton.disabled = true;

      // Background injects into all frames on demand, then runs fill
      chrome.runtime.sendMessage({ action: 'startFilling' }, (response) => {
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message || 'Connection failed';
          statusDiv.textContent = errorMsg.includes('Receiving end does not exist')
            ? 'Please refresh the page first'
            : `Error: ${errorMsg}`;
          statusDiv.className = 'status error';
          startButton.disabled = false;
          return;
        }

        if (response && response.success) {
          statusDiv.textContent = 'Form filling complete!';
          statusDiv.className = 'status ready';
          startButton.disabled = false;
          if (filledCountSpan && typeof response.filledCount === 'number') {
            filledCountSpan.textContent = `Total: ${response.filledCount}`;
          }
        } else {
          statusDiv.textContent = `Error: ${response?.error || 'Unknown error'}`;
          statusDiv.className = 'status error';
          startButton.disabled = false;
        }
      });
    });
  });

  settingsButton.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  updateStatus();
});
