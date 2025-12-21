/**
 * Content Script Loader
 * 
 * This script is injected as a standard script and dynamically loads
 * the actual content script as an ES module. This works around the
 * limitation where Chrome Manifest V3 content scripts cannot be
 * strictly ES modules (no "type": "module" support).
 */
(async () => {
    try {
        // dynamic import of the main module
        const contentScriptSrc = chrome.runtime.getURL('dist/content.js');
        await import(contentScriptSrc);
    } catch (e) {
        console.error("Auto Form Filler: Failed to load content script module", e);
    }
})();
