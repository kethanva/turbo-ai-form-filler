// Background service worker
export { };  // Force ES module output

chrome.runtime.onInstalled.addListener(() => {
  console.log('form-autopilot extension installed');
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

// Note: chrome.action.onClicked does not fire when manifest declares `default_popup`.
// The popup UI handles the icon click path; no listener is needed here.
