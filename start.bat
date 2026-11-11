@echo off
setlocal
cd /d "%~dp0"

REM Electron gagal start jika ELECTRON_RUN_AS_NODE di-set oleh environment induk.
set "ELECTRON_RUN_AS_NODE="

REM 1) Pakai hasil build terpaket kalau ada (paling cepat, tanpa butuh node_modules).
if exist "release\win-unpacked\OflaBot.exe" (
  start "" "release\win-unpacked\OflaBot.exe" --no-sandbox
  exit /b 0
)

REM 2) Fallback: jalankan lewat Electron di node_modules.
if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] Install dependency...
  call npm install
  call node node_modules\electron\install.js
)

if not exist "dist\index.html" goto build
if not exist "dist-electron\main.js" goto build
goto run

:build
echo [2/2] Build renderer + main process...
call npx vite build
if errorlevel 1 (
  echo Build gagal.
  pause
  exit /b 1
)

:run
echo Menjalankan OflaBot (mode development)...
start "" ".\node_modules\electron\dist\electron.exe" "%~dp0" --no-sandbox
exit /b 0
