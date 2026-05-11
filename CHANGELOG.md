# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.0] — 2025-02-23

### Added
- Initial public release
- AI-powered form filling via Groq (primary) and HuggingFace (fallback)
- Support for LinkedIn Easy Apply, Workday, Greenhouse, Lever, Ashby, iCIMS, Clinch Talent, SAP SuccessFactors, Freshteam, GEM, and generic HTML forms
- Batch LLM request mode for speed
- Fuzzy-match offline fallback when APIs are unavailable
- Options page with JSON editor for profile and API keys
- Keyboard shortcut: ⌘⇧F / Ctrl+Shift+F
- Phone number field with intl-tel-input combobox support
- Custom selectize.js listbox support (department/location pickers)
- Shadow DOM support for Web Component-based ATS forms

### Fixed
- Clinch Talent ATS (Roku Jobs etc.): labels contained `ada-unique-content` hex hashes that caused LLM to echo the hash as the answer — stripped before sending to LLM
