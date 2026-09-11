@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js not found. Please install Node.js first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node "%~dp0install-scene-editor.mjs"
echo.
pause
