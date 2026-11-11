@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
echo Menjalankan dev server (Vite) + Electron...
REM --no-sandbox wajib di build Windows ini agar Chromium mau start.
call npx concurrently "npx vite" "npx wait-on tcp:5173 && npx electron . --no-sandbox"
