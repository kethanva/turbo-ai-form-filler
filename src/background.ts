// Background service worker
export { };  // Force ES module output

chrome.runtime.onInstalled.addListener(() => {
  console.log('Auto Form Filler extension installed');
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'startFilling' });
  }
});

