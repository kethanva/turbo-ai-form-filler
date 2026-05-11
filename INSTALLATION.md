# Installation Guide

## Quick Start

1. **Build the extension:**
   ```bash
   cd extension
   npm install
   npm run build
   ```

2. **Load in Chrome:**
   - Open Chrome
   - Go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `extension` folder

3. **Configure API Keys:**
   - Click the extension icon
   - Click "Settings"
   - Enter your API keys (see below for how to get them)
   - Click "Save Settings"

4. **Start using:**
   - Navigate to any webpage with forms
   - Click the extension icon
   - Click "Start Filling Forms"

## Getting API Keys

### Groq API Key (Primary - Recommended)

1. Go to https://console.groq.com/
2. Sign up or log in
3. Navigate to API Keys section
4. Create a new API key
5. Copy the key (starts with `gsk_`)
6. Paste it in the extension settings

### HuggingFace Token (Fallback - FREE)

1. Go to https://huggingface.co/
2. Sign up or log in (it's free!)
3. Go to Settings → Access Tokens
4. Create a new token
5. Copy the token (starts with `hf_`)
6. Paste it in the extension settings

## Customizing Personal Information

You do **not** need to edit the source code to update your profile. 

1. Click the extension icon.
2. Click **Settings** → **Profile** tab.
3. Paste your profile as JSON (use `config/personals.example.json` as a template).
4. Click **Save Settings**.

## Troubleshooting

### Extension doesn't appear
- Make sure you built the extension (`npm run build`)
- Check that the `dist/` folder exists with JavaScript files

### Forms not filling
- Check browser console (F12) for errors
- Verify API keys are set correctly
- Make sure the page has standard HTML form elements

### API errors
- Verify your API keys are correct
- Check your API quota/limits
- Try the fallback provider (HuggingFace is free)

## Development

For development with auto-rebuild:

```bash
npm run watch
```

This will automatically rebuild when you make changes to TypeScript files.

