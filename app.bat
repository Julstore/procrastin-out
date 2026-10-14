@echo off
cd /d "%~dp0"
if not exist node_modules\.bin\electron.cmd (
  echo Instalando dependencias por primera vez...
  call npm install --no-audit --no-fund
)
call npx electron .
