// Background service worker
export { };  // Force ES module output

chrome.runtime.onInstalled.addListener(() => {
  console.log('Auto Form Filler extension installed');
});

// Handle keyboard shortcut (Ctrl+Shift+F / Cmd+Shift+F)
// This bypasses Workday's detection of chrome.runtime.sendMessage
chrome.commands.onCommand.addListener((command) => {
  if (command === "fill-form") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        // Execute code directly in page context - no message passing!
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            // Call the global function exposed by content script
            if ((window as any).startFormFilling) {
              (window as any).startFormFilling();
            } else {
              console.error('Form filler not loaded. Refresh the page.');
            }
          }
        }).catch(err => {
          console.error('Failed to execute form filling:', err);
        });
      }
    });
  }
});

// Handle extension icon click (keep for backward compatibility, but may not work on Workday)
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'startFilling' });
  }
});
