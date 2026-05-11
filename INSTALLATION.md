# Installation Guide

## ⚡ Quick Setup (Recommended — works on macOS/Linux/Windows)

A one-shot setup script handles everything: creates required config files, installs dependencies, and builds the extension.

**macOS / Linux:**
```bash
git clone https://github.com/kethanva/form-autopilot.git
cd form-autopilot
./setup.sh
```

**Windows:**
```cmd
git clone https://github.com/kethanva/form-autopilot.git
cd form-autopilot
setup.bat
```

The script will:
1. ✅ Copy `personals.example.json` → `personals.json` (your profile template)
2. ✅ Copy `secrets.example.json` → `secrets.json` (API key config)
3. ✅ Run `npm install`
4. ✅ Run `npm run build`
5. ✅ Print clear next steps

Then load the extension in Chrome:
- Open `chrome://extensions`
- Enable **Developer mode** (top-right toggle)
- Click **Load unpacked** and select the cloned folder

---

## 🔑 Getting API Keys

### Groq API Key (Primary — Recommended)
1. Go to https://console.groq.com/
2. Sign up or log in (free)
3. Navigate to **API Keys** section
4. Create a new API key (starts with `gsk_`)
5. In Chrome: click the extension icon → **Settings** → **API Keys** → paste and save

> [!TIP]
> **Extremely Economical:** Groq is ultra-cheap, typically costing only **$0.1 / 10¢ / ~9₹ per month** even for heavy usage. This is far more convenient and cost-effective than managing local LLMs or paying for expensive enterprise API keys.

### HuggingFace Token (Fallback — FREE)
1. Go to https://huggingface.co/
2. Sign up or log in
3. Go to **Settings** → **Access Tokens**
4. Create a new token (starts with `hf_`)
5. Paste it in the extension **Settings** → **API Keys**

---

## 👤 Customizing Personal Information

You do **not** need to edit the source code to update your profile.

1. Click the extension icon → **Settings** → **Profile** tab.
2. Paste your profile as JSON (use `config/personals.example.json` as a template).
3. Click **Save Settings**.

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

