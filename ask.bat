@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
title YouTube Archive - Ask
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run START.bat first.
  pause
  exit /b
)
".venv\Scripts\python.exe" app.py ask
pause
