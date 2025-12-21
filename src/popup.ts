// Popup script for extension UI
document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('startButton') as HTMLButtonElement;
  const statusDiv = document.getElementById('status') as HTMLDivElement;
  const settingsButton = document.getElementById('settingsButton') as HTMLButtonElement;
  const filledCountSpan = document.getElementById('filledCount') as HTMLSpanElement;

  // Update status - silently handles errors when content script isn't available
  function updateStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        // Check if this is a valid page (not chrome://, about:, etc.)
        const url = tabs[0].url || '';
        if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
          statusDiv.textContent = 'Not available on this page';
          statusDiv.className = 'status ready';
          startButton.disabled = true;
          return;
        }

        chrome.tabs.sendMessage(tabs[0].id, { action: 'getStatus' }, (response) => {
          // Silently ignore errors - content script may not be loaded yet
          if (chrome.runtime.lastError) {
            // Don't log to console to avoid spam
            statusDiv.textContent = 'Ready (refresh page if needed)';
            statusDiv.className = 'status ready';
            startButton.disabled = false;
            return;
          }

          if (response) {
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
        });
      }
    });
  }

  // Start button click
  startButton.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        const url = tabs[0].url || '';
        if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
          statusDiv.textContent = 'Cannot fill forms on this page';
          statusDiv.className = 'status error';
          return;
        }

        statusDiv.textContent = 'Starting...';
        statusDiv.className = 'status running';
        startButton.disabled = true;

        chrome.tabs.sendMessage(tabs[0].id, { action: 'startFilling' }, (response) => {
          // Check for runtime errors first
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message || 'Connection failed';
            // Provide helpful message
            if (errorMsg.includes('Receiving end does not exist')) {
              statusDiv.textContent = 'Please refresh the page first';
            } else {
              statusDiv.textContent = `Error: ${errorMsg}`;
            }
            statusDiv.className = 'status error';
            startButton.disabled = false;
            return;
          }

          if (response && response.success) {
            statusDiv.textContent = 'Form filling complete!';
            statusDiv.className = 'status ready';
            setTimeout(updateStatus, 1000);
          } else {
            statusDiv.textContent = `Error: ${response?.error || 'Unknown error'}`;
            statusDiv.className = 'status error';
            startButton.disabled = false;
          }
        });
      } else {
        statusDiv.textContent = 'Error: No active tab found';
        statusDiv.className = 'status error';
      }
    });
  });

  // Settings button click
  settingsButton.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Initial status update
  updateStatus();
  // Update status less frequently to reduce message spam
  setInterval(updateStatus, 5000);
});
