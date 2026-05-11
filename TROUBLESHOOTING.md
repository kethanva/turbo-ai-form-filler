# Troubleshooting: Extension Not Showing in chrome://extensions/

## Common Issues and Solutions

### 1. Extension Not Visible in chrome://extensions/

**Problem:** The extension doesn't appear in the extensions page.

**Solutions:**

1. **Enable Developer Mode:**
   - Go to `chrome://extensions/`
   - Toggle "Developer mode" switch in the top-right corner
   - The extension should now appear

2. **Check if Extension is Loaded:**
   - Look for "Auto Form Filler" in the extensions list
   - It might appear as "Unpacked" - this is normal
   - Click the toggle switch to enable it

3. **Verify Extension Files:**
   ```bash
   cd extension
   ls -la dist/
   ```
   You should see:
   - `background.js`
   - `content.js`
   - `popup.js`
   - `options.js`
   - `config/` folder
   - `modules/` folder

4. **Rebuild the Extension:**
   ```bash
   cd extension
   npm run build
   ```

### 2. Extension Shows But Is Disabled

**Problem:** Extension appears but is grayed out or disabled.

**Solutions:**

1. **Enable the Extension:**
   - Go to `chrome://extensions/`
   - Find "Auto Form Filler"
   - Toggle the switch to enable it

2. **Check for Errors:**
   - Click "Errors" button if visible
   - Check browser console (F12) for error messages
   - Fix any issues shown

### 3. Extension Loads But Doesn't Work

**Problem:** Extension is enabled but form filling doesn't work.

**Solutions:**

1. **Check API Keys:**
   - Click extension icon
   - Click "Settings"
   - Verify API keys are configured
   - Save settings

2. **Check Browser Console:**
   - Press F12 to open DevTools
   - Check Console tab for errors
   - Look for messages from the extension

3. **Verify Content Script:**
   - Go to `chrome://extensions/`
   - Find "Auto Form Filler"
   - Click "Details"
   - Verify "Injected scripts" shows the content script

### 4. Chrome Profile Issues

**Problem:** Extension doesn't persist between Chrome sessions.

**Solutions:**

1. **Verify Chrome Data Directory:**
   - The script uses `/Volumes/SSD/projects/AI_JOBS/CHROME_DATA`
   - Make sure this directory exists and is writable
   - Check permissions: `ls -la /Volumes/SSD/projects/AI_JOBS/CHROME_DATA`

2. **Clear and Reload:**
   - Close all Chrome windows
   - Delete the CHROME_DATA folder (optional, will reset profile)
   - Run `./run.sh` again

### 5. Build Errors

**Problem:** `npm run build` fails.

**Solutions:**

1. **Check Node.js Version:**
   ```bash
   node --version  # Should be 14+ or 16+
   npm --version
   ```

2. **Reinstall Dependencies:**
   ```bash
   cd extension
   rm -rf node_modules package-lock.json
   npm install
   npm run build
   ```

3. **Check TypeScript Errors:**
   ```bash
   npm run build
   # Look for TypeScript compilation errors
   ```

### 6. Extension Icon Not Showing

**Problem:** Extension icon doesn't appear in Chrome toolbar.

**Solutions:**

1. **Verify Icon Files:**
   ```bash
   ls -la extension/icons/
   ```
   Should show: `icon16.png`, `icon48.png`, `icon128.png`

2. **Check manifest.json:**
   - Verify icon paths in manifest.json
   - Icons should be in `icons/` folder

3. **Pin the Extension:**
   - Go to `chrome://extensions/`
   - Click the puzzle piece icon in Chrome toolbar
   - Find "Auto Form Filler"
   - Click the pin icon to pin it to toolbar

## Manual Loading (Alternative Method)

If the script doesn't work, you can manually load the extension:

1. **Build the extension:**
   ```bash
   cd extension
   npm run build
   ```

2. **Open Chrome:**
   - Open Chrome normally (not via script)
   - Go to `chrome://extensions/`

3. **Enable Developer Mode:**
   - Toggle "Developer mode" in top-right

4. **Load Extension:**
   - Click "Load unpacked"
   - Navigate to `/Volumes/SSD/projects/AI_JOBS/chrome_forms_auto_update/extension`
   - Click "Select"

5. **Enable Extension:**
   - Toggle the switch to enable "Auto Form Filler"

## Verification Checklist

- [ ] Extension is built (`dist/` folder exists)
- [ ] `manifest.json` exists in extension folder
- [ ] `dist/background.js` exists
- [ ] `dist/content.js` exists
- [ ] Developer mode is enabled in Chrome
- [ ] Extension appears in `chrome://extensions/`
- [ ] Extension toggle is ON (enabled)
- [ ] API keys are configured in settings
- [ ] No errors in browser console

## Getting Help

If none of these solutions work:

1. Check browser console for errors (F12)
2. Check Chrome's extension error page (`chrome://extensions/` → click "Errors")
3. Verify all files are present and built correctly
4. Try loading the extension manually (see above)

