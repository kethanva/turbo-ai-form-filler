# Auto Form Filler

> AI-powered Chrome extension that automatically fills job application forms — press one shortcut and watch it go.

[![CI](https://github.com/YOUR_USERNAME/auto-form-filler/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/auto-form-filler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](manifest.json)

---

## What it does

Open any job application page, press **⌘⇧F** (Mac) / **Ctrl+Shift+F** (Windows), and the extension:

1. Finds every form field on the page
2. Reads the label / question for each field
3. Asks an LLM to produce the best answer from your profile
4. Fills in the value and fires the right DOM events so the site accepts it

No copy-pasting. No re-typing the same things for every company.

---

## Supported platforms

| Platform | Status |
|---|---|
| LinkedIn Easy Apply | ✅ |
| Workday | ✅ |
| Greenhouse | ✅ |
| Lever | ✅ |
| Ashby | ✅ |
| iCIMS | ✅ |
| Clinch Talent (Roku Jobs, etc.) | ✅ |
| SAP SuccessFactors | ✅ |
| Freshteam / Freshworks | ✅ |
| GEM ATS | ✅ |
| Generic HTML forms | ✅ |

---

## Installation

### Option A — Download the latest release *(easiest)*

1. Go to [Releases](../../releases) and download **release.zip**.
2. Unzip it.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode** (toggle, top-right).
5. Click **Load unpacked** and select the unzipped folder.

### Option B — Build from source

```bash
git clone https://github.com/YOUR_USERNAME/auto-form-filler.git
cd auto-form-filler
npm install
npm run build
```

Then load the folder in Chrome (same steps 3–5 above).

---

## Setup (required after install)

### 1 — Add your API key

Click the extension icon → **Settings** → **API Keys** tab.

| Provider | Cost | Where to get it |
|---|---|---|
| **Groq** (recommended) | Free tier, very fast | https://console.groq.com/keys |
| HuggingFace | Free | https://huggingface.co/settings/tokens |

You only need one. Groq's free tier is generous enough for daily job searching.

### 2 — Fill in your profile

Settings → **Profile** tab. Paste your details as JSON — name, email, phone, experience, skills, education. Use the example below as a starting point (also available as `config/personals.example.json`):

```jsonc
{
  "first_name": "Jane",
  "last_name": "Doe",
  "email": "jane@example.com",
  "phone": "5551234567",
  "linkedin": "https://linkedin.com/in/janedoe",
  "github": "https://github.com/janedoe",
  "years_of_experience": 5,
  "skills": ["TypeScript", "React", "Node.js"],
  "require_visa_sponsorship": false,
  "experience_details": [
    {
      "title": "Senior Software Engineer",
      "companyKey": "acme",
      "from": "2021-03",
      "to": "Present",
      "highlights": ["Built X that improved Y by Z%"]
    }
  ]
}
```

Click **Save** and you're done.

---

## Usage

| Action | How |
|---|---|
| Fill current page | Click extension icon → **Start Filling Forms** |
| Keyboard shortcut | **⌘⇧F** on Mac, **Ctrl+Shift+F** on Windows/Linux |

The status indicator in the popup shows **Ready** → **Filling…** → count of filled fields.

---

## How it works

```
Page loaded
    │
    ▼
Scan DOM for inputs, selects, textareas, custom components
    │
    ▼
Extract label text (handles aria-labelledby, label[for], parent label,
                    fieldset legend, sibling text, placeholder, …)
    │
    ▼
Batch-send all questions + your profile to LLM (Groq / HuggingFace)
    │
    ├─ LLM returns answers
    │
    └─ Fallback: fuzzy-match against your profile if API is down
    │
    ▼
Fill each field + dispatch input/change events so frameworks detect the change
```

---

## Development

```
src/
├── content.ts           # Main form-filling logic (injected into every page)
├── background.ts        # Service worker (keyboard shortcut handler)
├── popup.ts             # Popup UI
├── options.ts           # Settings page
└── modules/
    ├── ai/
    │   ├── groqConnections.ts
    │   ├── huggingfaceConnections.ts
    │   └── llm_manager.ts       # Provider selection + retry logic
    ├── config_loader.ts         # Loads profile/secrets from Chrome storage
    ├── fuzzy_matcher.ts         # Offline fallback
    └── helpers.ts
```

### Commands

```bash
npm run build    # TypeScript compile + esbuild bundle
npm run watch    # Watch mode (recompiles on save)
npm run clean    # Delete dist/
npm run package  # Build → create release.zip for Chrome Web Store
```

### Creating a release

```bash
git tag v1.2.0
git push origin v1.2.0
# GitHub Actions builds and attaches release.zip automatically
```

---

## Contributing

Pull requests are welcome. For major changes please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add support for XYZ ATS'`
4. Push and open a PR

---

## Privacy

- Your profile data is stored locally in Chrome's `storage.sync`.
- API keys are stored locally in Chrome's `storage.sync`.
- Form field questions are sent to the Groq / HuggingFace API to generate answers. No other data leaves your browser.
- The extension does not collect analytics, crash reports, or any usage data.

---

## License

[MIT](LICENSE)
