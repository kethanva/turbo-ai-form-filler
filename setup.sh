#!/usr/bin/env bash
# setup.sh — First-time setup script for turbo-ai-form-filler
# Run this once after cloning the repository.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/config"

echo ""
echo "============================================"
echo "  turbo-ai-form-filler — First-Time Setup"
echo "============================================"
echo ""

# ---- 1. Create personals.json from example ----
if [ -f "$CONFIG_DIR/personals.json" ]; then
  echo "[SKIP] config/personals.json already exists."
else
  cp "$CONFIG_DIR/personals.example.json" "$CONFIG_DIR/personals.json"
  echo "[OK]   config/personals.json created from example."
  echo "       → Edit this file with your real details, or use the Settings UI."
fi

# ---- 2. Create secrets.json from example ----
if [ -f "$CONFIG_DIR/secrets.json" ]; then
  echo "[SKIP] config/secrets.json already exists."
else
  cp "$CONFIG_DIR/secrets.example.json" "$CONFIG_DIR/secrets.json"
  echo "[OK]   config/secrets.json created from example."
  echo "       → Add your Groq/HuggingFace API key here, or use the Settings UI."
fi

# ---- 3. Install npm dependencies ----
if [ -d "$SCRIPT_DIR/node_modules" ]; then
  echo "[SKIP] node_modules already installed."
else
  echo "[INFO] Installing npm dependencies..."
  npm install --prefix "$SCRIPT_DIR"
  echo "[OK]   npm install complete."
fi

# ---- 4. Build the extension ----
echo "[INFO] Building the extension..."
npm run build --prefix "$SCRIPT_DIR"
echo "[OK]   Build complete. dist/ folder is ready."

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Open Chrome and navigate to: chrome://extensions"
echo "  2. Enable 'Developer mode' (top-right toggle)"
echo "  3. Click 'Load unpacked' and select this folder:"
echo "     $SCRIPT_DIR"
echo "  4. Click the extension icon → Settings → API Keys"
echo "     and add your Groq API key (free at https://console.groq.com/keys)"
echo "  5. Click Settings → Profile and fill in your personal details."
echo ""
echo "You're ready to go! Press Cmd+Shift+F on any job application page."
echo ""
