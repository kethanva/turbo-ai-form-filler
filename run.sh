#!/bin/bash

# Script to launch Chrome with the Auto Form Filler extension
# Creates a separate Chrome instance with its own data directory (CHROME_DATA/ sibling of this script)
# macOS only

# IMPORTANT: Google Chrome stable does NOT support --load-extension flag.
# This script will launch Chrome and open the extensions page for manual loading.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
EXTENSION_DIR="$SCRIPT_DIR"
CHROME_DATA_DIR="$SCRIPT_DIR/../CHROME_DATA"

echo -e "${GREEN}🚀 Auto Form Filler - Chrome Launcher${NC}"
echo ""

# Check if extension is built
if [ ! -d "$EXTENSION_DIR/dist" ]; then
    echo -e "${YELLOW}⚠️  Extension not built. Building now...${NC}"
    cd "$EXTENSION_DIR"
    npm install
    npm run build
    echo -e "${GREEN}✅ Build complete!${NC}"
    echo ""
fi

# Create Chrome data directory if it doesn't exist
mkdir -p "$CHROME_DATA_DIR"
echo -e "${GREEN}📁 Chrome data directory: $CHROME_DATA_DIR${NC}"

# Find Chrome executable on macOS
CHROME_PATHS=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
)

CHROME_EXEC=""
CHROME_TYPE="stable"
for i in "${!CHROME_PATHS[@]}"; do
    if [ -f "${CHROME_PATHS[$i]}" ]; then
        CHROME_EXEC="${CHROME_PATHS[$i]}"
        if [[ "$CHROME_EXEC" == *"Canary"* ]]; then
            CHROME_TYPE="canary"
        elif [[ "$CHROME_EXEC" == *"Chromium"* ]]; then
            CHROME_TYPE="chromium"
        fi
        break
    fi
done

if [ -z "$CHROME_EXEC" ]; then
    echo -e "${RED}❌ Chrome not found. Please install Google Chrome.${NC}"
    echo "   Download from: https://www.google.com/chrome/"
    exit 1
fi

echo -e "${GREEN}✅ Found Chrome: $CHROME_EXEC${NC}"
echo -e "${GREEN}   Chrome type: $CHROME_TYPE${NC}"
echo ""

# Check if extension directory exists
if [ ! -d "$EXTENSION_DIR" ]; then
    echo -e "${RED}❌ Extension directory not found: $EXTENSION_DIR${NC}"
    exit 1
fi

# Check if manifest.json exists
if [ ! -f "$EXTENSION_DIR/manifest.json" ]; then
    echo -e "${RED}❌ manifest.json not found in extension directory${NC}"
    exit 1
fi

# Verify dist folder exists
if [ ! -d "$EXTENSION_DIR/dist" ]; then
    echo -e "${RED}❌ dist folder not found. Extension needs to be built.${NC}"
    echo -e "${YELLOW}   Building extension now...${NC}"
    cd "$EXTENSION_DIR"
    npm install
    npm run build
    if [ ! -d "$EXTENSION_DIR/dist" ]; then
        echo -e "${RED}❌ Build failed. Please check for errors.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ Build complete!${NC}"
    echo ""
fi

# Verify key files exist
if [ ! -f "$EXTENSION_DIR/dist/background.js" ]; then
    echo -e "${RED}❌ dist/background.js not found. Extension may not be built correctly.${NC}"
    exit 1
fi

if [ ! -f "$EXTENSION_DIR/dist/content.js" ]; then
    echo -e "${RED}❌ dist/content.js not found. Extension may not be built correctly.${NC}"
    exit 1
fi

echo -e "${GREEN}📦 Extension directory: $EXTENSION_DIR${NC}"
echo -e "${GREEN}✅ Extension files verified${NC}"
echo ""

# Enable Developer mode in Chrome preferences
PREFERENCES_DIR="$CHROME_DATA_DIR/Default"
mkdir -p "$PREFERENCES_DIR"
PREFERENCES_FILE="$PREFERENCES_DIR/Preferences"

echo -e "${YELLOW}⚙️  Configuring Chrome preferences...${NC}"

python3 << EOF
import json
import os

prefs_file = "$PREFERENCES_FILE"

# Read existing preferences or create new
if os.path.exists(prefs_file):
    try:
        with open(prefs_file, 'r', encoding='utf-8') as f:
            prefs = json.load(f)
    except Exception as e:
        print(f"⚠️  Error reading preferences: {e}")
        prefs = {}
else:
    prefs = {}

# Enable Developer mode (critical for unpacked extensions)
if 'extensions' not in prefs:
    prefs['extensions'] = {}
if 'ui' not in prefs['extensions']:
    prefs['extensions']['ui'] = {}
prefs['extensions']['ui']['developer_mode'] = True

# Also set in top-level ui if it exists
if 'ui' not in prefs:
    prefs['ui'] = {}
prefs['ui']['developer_mode'] = True

# Write back
try:
    with open(prefs_file, 'w', encoding='utf-8') as f:
        json.dump(prefs, f, indent=2)
    print("✅ Developer mode enabled in preferences")
except Exception as e:
    print(f"❌ Could not update preferences: {e}")
    exit(1)
EOF

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to configure preferences${NC}"
    exit 1
fi

echo ""

# Find an available port for remote debugging
DEBUG_PORT=9222
while lsof -Pi :$DEBUG_PORT -sTCP:LISTEN -t >/dev/null 2>&1; do
    DEBUG_PORT=$((DEBUG_PORT + 1))
done

# Check if --load-extension is supported (only in Chromium/Canary)
if [ "$CHROME_TYPE" = "stable" ]; then
    echo -e "${YELLOW}⚠️  IMPORTANT: Google Chrome stable does NOT support --load-extension${NC}"
    echo -e "${YELLOW}   The extension must be loaded manually.${NC}"
    echo ""
    
    # Launch Chrome with just the user data dir and open extensions page
    echo -e "${CYAN}🚀 Launching Chrome...${NC}"
    
    "$CHROME_EXEC" \
        --user-data-dir="$CHROME_DATA_DIR" \
        --remote-debugging-port=$DEBUG_PORT \
        --new-window \
        "chrome://extensions" 2>&1 | grep -v "ERROR:net/cert" | grep -v "Created TensorFlow" &
    
    CHROME_PID=$!
    
    echo -e "${GREEN}✅ Chrome launched with PID: $CHROME_PID${NC}"
    echo ""
    
    # Wait a moment for Chrome to start
    sleep 3
    
    # Display manual loading instructions
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}📋 MANUAL EXTENSION LOADING INSTRUCTIONS${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}The chrome://extensions page should now be open.${NC}"
    echo ""
    echo -e "${CYAN}Step 1:${NC} Enable 'Developer mode' toggle (top-right corner)"
    echo ""
    echo -e "${CYAN}Step 2:${NC} Click 'Load unpacked' button"
    echo ""
    echo -e "${CYAN}Step 3:${NC} Navigate to and select this folder:"
    echo -e "        ${GREEN}$EXTENSION_DIR${NC}"
    echo ""
    echo -e "${CYAN}Step 4:${NC} The 'Auto Form Filler' extension should now appear!"
    echo ""
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}💡 TIP: Copy the path above for easy pasting:${NC}"
    echo "$EXTENSION_DIR" | pbcopy 2>/dev/null && echo -e "${GREEN}   ✅ Path copied to clipboard!${NC}" || echo -e "${YELLOW}   (Path shown above)${NC}"
    echo ""
    echo -e "${GREEN}🔌 Remote debugging port: $DEBUG_PORT${NC}"
    echo -e "${GREEN}📁 Chrome data directory: $CHROME_DATA_DIR${NC}"
    
else
    # Chromium or Canary - --load-extension should work
    echo -e "${GREEN}🎉 Using $CHROME_TYPE - --load-extension is supported!${NC}"
    echo ""
    echo -e "${YELLOW}🚀 Launching Chrome with Auto Form Filler extension...${NC}"
    
    "$CHROME_EXEC" \
        --user-data-dir="$CHROME_DATA_DIR" \
        --load-extension="$EXTENSION_DIR" \
        --enable-extensions \
        --remote-debugging-port=$DEBUG_PORT \
        --new-window \
        "chrome://extensions" 2>&1 | grep -v "ERROR:net/cert" | grep -v "Created TensorFlow" &
    
    CHROME_PID=$!
    
    echo -e "${GREEN}✅ Chrome launched with PID: $CHROME_PID${NC}"
    echo -e "${GREEN}🔌 Remote debugging port: $DEBUG_PORT${NC}"
    echo ""
    
    # Wait for Chrome to start
    echo -e "${YELLOW}⏳ Waiting for Chrome to initialize (5 seconds)...${NC}"
    sleep 5
    
    echo -e "${GREEN}🎉 Extension should be automatically loaded!${NC}"
    echo ""
    echo -e "${YELLOW}📋 If extension doesn't appear:${NC}"
    echo "   1. Go to chrome://extensions/"
    echo "   2. Make sure 'Developer mode' toggle is ON"
    echo "   3. Look for 'Auto Form Filler' in the list"
fi

echo ""
echo -e "${GREEN}Done!${NC}"
