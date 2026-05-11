@echo off
REM Windows batch script to launch Chrome with the form-autopilot extension

setlocal enabledelayedexpansion

echo 🚀 form-autopilot - Chrome Launcher
echo.

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
set "EXTENSION_DIR=%SCRIPT_DIR%"
set "CHROME_DATA_DIR=%SCRIPT_DIR%CHROME_DATA"

REM Check if extension is built
if not exist "%EXTENSION_DIR%\dist" (
    echo ⚠️  Extension not built. Building now...
    cd /d "%EXTENSION_DIR%"
    call npm install
    call npm run build
    echo ✅ Build complete!
    echo.
)

REM Create Chrome data directory if it doesn't exist
if not exist "%CHROME_DATA_DIR%" mkdir "%CHROME_DATA_DIR%"
echo 📁 Chrome data directory: %CHROME_DATA_DIR%

REM Find Chrome executable
set "CHROME_EXEC="

REM Check common Chrome locations
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXEC=C:\Program Files\Google\Chrome\Application\chrome.exe"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXEC=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXEC=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if "!CHROME_EXEC!"=="" (
    echo ❌ Chrome not found. Please install Google Chrome.
    echo    Download from: https://www.google.com/chrome/
    pause
    exit /b 1
)

echo ✅ Found Chrome: !CHROME_EXEC!
echo.

REM Check if extension directory exists
if not exist "%EXTENSION_DIR%" (
    echo ❌ Extension directory not found: %EXTENSION_DIR%
    pause
    exit /b 1
)

REM Check if manifest.json exists
if not exist "%EXTENSION_DIR%\manifest.json" (
    echo ❌ manifest.json not found in extension directory
    pause
    exit /b 1
)

echo 📦 Extension directory: %EXTENSION_DIR%
echo.

REM Launch Chrome with extension
echo 🚀 Launching Chrome with form-autopilot extension...
echo.

start "" "!CHROME_EXEC!" ^
    --user-data-dir="%CHROME_DATA_DIR%" ^
    --load-extension="%EXTENSION_DIR%" ^
    --enable-extensions ^
    --new-window ^
    chrome://extensions

echo ✅ Chrome launched!
echo.
echo 📝 Note:
echo    - Chrome is using a separate profile in: %CHROME_DATA_DIR%
echo    - The extension should be automatically loaded
echo    - You can verify it's enabled at chrome://extensions/
echo.
echo 🎉 Done! Chrome should open with the extension loaded.
echo.
echo 💡 Tip: Go to chrome://extensions/ to verify the extension is loaded and enabled.

timeout /t 2 /nobreak >nul

pause

