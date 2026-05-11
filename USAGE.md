# Usage Guide

## Quick Start

### Method 1: Using the Run Script (Easiest)

**macOS/Linux:**
```bash
cd extension
./run.sh
```

**Windows:**
```cmd
cd extension
run.bat
```

This script will:
1. ✅ Check if the extension is built (builds it if needed)
2. ✅ Create a Chrome profile in `./CHROME_DATA`
3. ✅ Launch Chrome with the extension automatically loaded
4. ✅ Open the extensions page so you can verify it's enabled

### Method 2: Manual Installation

1. Build the extension:
   ```bash
   cd extension
   npm install
   npm run build
   ```

2. Load in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `extension` folder

## First-Time Setup

### 1. Configure API Keys
Click the extension icon → **Settings** → **API Keys**.
- **Groq API Key**: [console.groq.com/keys](https://console.groq.com/keys) — Free tier, very fast.
- **HuggingFace Token**: [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) — Also free.

You only need one. Groq is recommended for its speed during an active job search.

### 2. Build Your Profile
Click the extension icon → **Settings** → **Profile**.
- Use [config/personals.example.json](config/personals.example.json) as a starting template.
- Fill in your contact info, work history (`experience_details`), education, skills, salary expectations, and notice period.
- The richer your profile, the more accurately the LLM can answer open-ended questions.
- Click **Save Settings** when done. Changes apply immediately on the next form fill.

## Using the Extension

1. **Navigate to a form:**
   - Go to any webpage with HTML forms
   - Examples: job applications, contact forms, registration forms

2. **Start filling:**
   - Click the extension icon
   - Click "Start Filling Forms"
   - Watch as forms are automatically filled!

3. **Monitor progress:**
   - The popup shows status and filled count
   - Check browser console (F12) for detailed logs

## Chrome Profile Management

The `run.sh` script creates a separate Chrome profile in `./CHROME_DATA`. This means:
- ✅ Your main Chrome profile remains untouched
- ✅ Extension settings are isolated
- ✅ You can have multiple Chrome instances

To use your regular Chrome profile instead:
- Manually load the extension via `chrome://extensions/`
- Or modify `run.sh` to remove the `--user-data-dir` flag

## Troubleshooting

### Extension not loading
- Make sure you ran `npm run build`
- Check that `dist/` folder exists with JavaScript files
- Verify `manifest.json` is in the extension folder

### Chrome not found
- Install Google Chrome from https://www.google.com/chrome/
- On Linux: `sudo apt-get install google-chrome-stable`
- The script will show an error if Chrome is not found

### Forms not filling
- Check browser console (F12) for errors
- Verify API keys are configured
- Make sure the page has standard HTML form elements
- Some websites use custom form implementations that may not be detected

### API errors
- Verify your API keys are correct
- Check your API quota/limits
- The extension will automatically fall back to fuzzy matching if APIs fail

## Advanced Usage

### Development Mode

For development with auto-rebuild:
```bash
npm run watch
```

This watches for TypeScript changes and rebuilds automatically.

### Custom Chrome Flags

You can modify `run.sh` to add custom Chrome flags:
```bash
"$CHROME_EXEC" \
    --user-data-dir="$CHROME_DATA_DIR" \
    --load-extension="$EXTENSION_DIR" \
    --enable-extensions \
    --new-window \
    --disable-web-security \  # Add custom flags here
    "chrome://extensions"
```

### Multiple Extensions

To load multiple extensions, modify the `--load-extension` flag:
```bash
--load-extension="$EXTENSION_DIR,/path/to/other/extension"
```

## Tips

- 💡 The extension works best with standard HTML form elements
- 💡 Check the browser console for detailed logging
- 💡 Use the settings page to switch between LLM providers
- 💡 Fuzzy matching works even without API keys (but less accurate)
- 💡 The extension respects form validation and triggers appropriate events

