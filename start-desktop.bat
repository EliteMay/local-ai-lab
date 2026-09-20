@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Local AI Lab Desktop requires dependencies first.
  echo Run: npm install
  echo.
  pause
  exit /b 1
)

call npm run desktop
if errorlevel 1 (
  echo.
  echo Local AI Lab Desktop exited with an error.
  pause
  exit /b 1
)
