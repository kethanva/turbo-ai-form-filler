# Auto Form Filler Chrome Extension

A Chrome extension that automatically fills HTML form elements using AI-powered responses. The extension supports all standard HTML form elements including text inputs, checkboxes, radio buttons, dropdowns, and HTML5 input types.

## Features

- 🤖 **AI-Powered Form Filling**: Uses LLM (Groq, HuggingFace) to intelligently answer form questions
- 🔄 **Multiple LLM Providers**: Supports Groq (primary) and HuggingFace (fallback) with automatic failover
- 🎯 **Fuzzy Logic Fallback**: Uses fuzzy matching when LLM APIs are unavailable
- 📝 **Comprehensive Form Support**: Handles all HTML form elements:
  - Text inputs (text, email, url, search, tel, number)
  - Date/time inputs (date, time, datetime-local, month, week)
  - Range sliders
  - Color pickers
  - Checkboxes and radio buttons
  - Dropdowns (single and multiple select)
  - Textareas
- ⚙️ **Configurable**: Easy-to-use settings page for API keys and preferences
- 🎨 **User-Friendly UI**: Simple popup interface with status indicators

## Installation

### Prerequisites

- Node.js and npm installed
- Chrome browser

### Quick Start (Automated)

**Option 1: Use the run script (Recommended)**

Simply run the provided script to automatically build and launch Chrome with the extension:

```bash
cd extension
./run.sh
```

This will:
- Build the extension if needed
- Create a Chrome profile in `./CHROME_DATA`
- Launch Chrome with the extension automatically loaded and enabled

**For Windows:**
```cmd
cd extension
run.bat
```

### Manual Installation

1. **Install dependencies:**
   ```bash
   cd extension
   npm install
   ```

2. **Build TypeScript:**
   ```bash
   npm run build
   ```

3. **Load extension in Chrome:**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `extension` folder

## Configuration

### Setting Up API Keys

1. Click the extension icon in Chrome
2. Click "Settings"
3. Configure your API keys:

   **Groq (Primary - Recommended):**
   - Get API key from: https://console.groq.com/keys
   - Enter your API key in the Groq API Key field
   - Default model: `llama-3.1-8b-instant`

   **HuggingFace (Fallback - FREE):**
   - Get FREE token from: https://huggingface.co/settings/tokens
   - Enter your token in the HuggingFace API Key field
   - Default model: `meta-llama/Llama-3.2-3B-Instruct`

4. Click "Save Settings"

### Personal Information Configuration

Edit `src/config/personals.ts` to customize your personal information, experience, skills, and other details that will be used to answer form questions.

## Usage

1. Navigate to any webpage with forms
2. Click the extension icon
3. Click "Start Filling Forms"
4. The extension will automatically:
   - Detect all form elements on the page
   - Extract questions from labels and placeholders
   - Use AI to generate appropriate answers
   - Fill in the form fields

## How It Works

1. **Form Detection**: Scans the page for all input, textarea, and select elements
2. **Question Extraction**: Identifies questions from:
   - Associated labels
   - Placeholder text
   - Aria labels
   - Nearby text
3. **Answer Generation**: 
   - Primary: Uses Groq LLM API
   - Fallback 1: Uses HuggingFace LLM API
   - Fallback 2: Uses fuzzy matching against personal config
4. **Form Filling**: Sets values and triggers appropriate events

## Development

### Project Structure

```
extension/
├── src/
│   ├── config/
│   │   ├── personals.ts      # Personal information config
│   │   ├── questions.ts      # AI prompts
│   │   └── secrets.ts        # API keys management
│   ├── modules/
│   │   ├── ai/
│   │   │   ├── groqConnections.ts
│   │   │   ├── huggingfaceConnections.ts
│   │   │   └── llm_manager.ts
│   │   ├── fuzzy_matcher.ts
│   │   └── helpers.ts
│   ├── content.ts            # Content script (form filling logic)
│   ├── popup.ts              # Popup UI script
│   ├── background.ts         # Background service worker
│   └── options.ts            # Settings page script
├── dist/                     # Compiled JavaScript (generated)
├── icons/                    # Extension icons
├── manifest.json
├── popup.html
├── options.html
├── tsconfig.json
└── package.json
```

### Build Commands

- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Watch mode for development
- `npm run clean` - Remove dist folder

### TypeScript Configuration

The project uses TypeScript with strict mode enabled. Source files are in `src/` and compiled to `dist/`.

## Troubleshooting

### Extension not filling forms

1. Check that API keys are configured in Settings
2. Open browser console (F12) to see error messages
3. Verify that the page has form elements
4. Check that the extension has permission to access the page

### API Errors

- **401 Unauthorized**: Check your API keys
- **429 Rate Limit**: Wait a few minutes and try again
- **503 Service Unavailable**: The LLM service is temporarily down, fuzzy logic will be used

### Forms not detected

Some websites use custom form implementations. The extension works best with standard HTML form elements. For custom implementations, you may need to modify the form detection logic in `content.ts`.

## License

MIT License

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions, please open an issue on the repository.

