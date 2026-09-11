@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未检测到 Node.js，请先安装：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node "%~dp0uninstall-scene-editor.mjs"
echo.
pause
