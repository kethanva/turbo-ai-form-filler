# FormAutoPilot

![FormAutoPilot Banner](docs/banner.png)

> **AI-powered Chrome extension that automatically fills job application forms — press one shortcut and watch it go.**

[![CI](https://github.com/YOUR_USERNAME/form-autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/form-autopilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](manifest.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## ✨ Features

- **🚀 One-Click Fill**: Fill entire complex job applications in seconds.
- **🧠 AI-Powered**: Uses advanced LLMs (Groq, HuggingFace etc) to understand context and map your profile to questions.
- **🛡️ Privacy First**: Your data stays in your browser. API keys are stored locally. No tracking.
- **🌍 Universal Support**: Works on LinkedIn, Workday, Greenhouse, Lever, Ashby, iCIMS, and generic HTML forms.
- **💰 Cost Effective**: Optimized for Groq's generous free tier — fill thousands of forms without spending a dime.

---

## 📺 How it works

1. Open any job application page.
2. Press **⌘⇧F** (Mac) / **Ctrl+Shift+F** (Windows).
3. The extension scans the DOM, extracts labels, and batches them to your chosen LLM.
4. Fields are filled, events are dispatched, and you're ready to submit.

---

## 🏗️ Supported Platforms

| Platform | Status |
|---|---|
| **LinkedIn Easy Apply** | ✅ Perfect |
| **Workday** | ✅ Stable |
| **Greenhouse / Lever / Ashby** | ✅ Stable |
| **iCIMS / SuccessFactors** | ✅ Stable |
| **Generic HTML Forms** | ✅ Experimental |

---

## 🚀 Installation

### Option 1: Download Release (Recommended)

1. Go to [Releases](../../releases) and download `release.zip`.
2. Unzip the archive.
3. Open `chrome://extensions` in your browser.
4. Enable **Developer mode** (top-right).
5. Click **Load unpacked** and select the unzipped folder.

### Option 2: Build from Source

```bash
git clone https://github.com/YOUR_USERNAME/form-autopilot.git
cd form-autopilot
npm install
npm run build
```

---

## ⚙️ Setup

### 1. Configure API Keys
Click the extension icon → **Settings** → **API Keys**.
- **Groq** (Recommended): [Get a free key here](https://console.groq.com/keys). **Extremely fast and currently offers a generous free tier.**
- **HuggingFace**: [Get a key here](https://huggingface.co/settings/tokens). Also free for most inference tasks.

### 2. Personalize Your Profile
Settings → **Profile**. Paste your details as JSON. You can find a template in `config/personals.example.json`.

---

## 🛠️ Tech Stack

- **Core**: TypeScript, Manifest V3
- **Bundler**: esbuild
- **AI**: Groq SDK, HuggingFace API etc
- **Logic**: Intelligent DOM traversal & fuzzy matching fallback

---

## 🤝 Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

---

## 🔒 Security & Privacy

We value your privacy. This extension:
- Stores all profile data and API keys locally via `chrome.storage.sync`.
- Sends only the necessary context (labels + profile) to the LLM.
- No analytics, no telemetry, no remote tracking.
- See [SECURITY.md](SECURITY.md) for more details.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
