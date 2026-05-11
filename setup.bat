@echo off
REM setup.bat — First-time setup script for turbo-ai-form-filler (Windows)
REM Run this once after cloning the repository.

echo.
echo ============================================
echo   turbo-ai-form-filler — First-Time Setup
echo ============================================
echo.

REM ---- 1. Create personals.json from example ----
if exist "config\personals.json" (
    echo [SKIP] config\personals.json already exists.
) else (
    copy "config\personals.example.json" "config\personals.json" >nul
    echo [OK]   config\personals.json created from example.
    echo        ^> Edit this file with your real details, or use the Settings UI.
)

REM ---- 2. Create secrets.json from example ----
if exist "config\secrets.json" (
    echo [SKIP] config\secrets.json already exists.
) else (
    copy "config\secrets.example.json" "config\secrets.json" >nul
    echo [OK]   config\secrets.json created from example.
    echo        ^> Add your Groq/HuggingFace API key, or use the Settings UI.
)

REM ---- 3. Install npm dependencies ----
if exist "node_modules" (
    echo [SKIP] node_modules already installed.
) else (
    echo [INFO] Installing npm dependencies...
    call npm install
    echo [OK]   npm install complete.
)

REM ---- 4. Build the extension ----
echo [INFO] Building the extension...
call npm run build
echo [OK]   Build complete. dist\ folder is ready.

echo.
echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo Next steps:
echo   1. Open Chrome and navigate to: chrome://extensions
echo   2. Enable 'Developer mode' (top-right toggle)
echo   3. Click 'Load unpacked' and select this folder
echo   4. Click the extension icon -> Settings -> API Keys
echo      and add your Groq API key (free at https://console.groq.com/keys)
echo   5. Click Settings -> Profile and fill in your personal details.
echo.
echo You're ready to go! Press Ctrl+Shift+F on any job application page.
echo.
pause
