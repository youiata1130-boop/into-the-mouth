@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please install Node.js and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting Into the Mouth.
echo If the browser does not open, visit http://localhost:5173/
start "Into the Mouth Server" cmd /k "npm run dev"
timeout /t 3 /nobreak >nul
start "" "http://localhost:5173/"
