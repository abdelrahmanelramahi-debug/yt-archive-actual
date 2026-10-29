@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
title YouTube Archive
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Get it from python.org and tick "Add python.exe to PATH" during install.
  pause
  exit /b
)

if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up, this takes a few minutes...
  python -m venv .venv
)

rem reinstall only when requirements.txt changed
fc /b requirements.txt ".venv\installed.txt" >nul 2>nul
if errorlevel 1 (
  echo Installing / updating components...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip -q
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt -q
  if errorlevel 1 (
    echo Install failed. Screenshot this window and send it to Claude.
    pause
    exit /b
  )
  copy /y requirements.txt ".venv\installed.txt" >nul
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Paste your two keys into the file that just opened, save it, then run START.bat again.
  notepad ".env"
  pause
  exit /b
)

".venv\Scripts\python.exe" app.py %*
