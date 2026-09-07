@echo off
REM Points parashealth.local at this computer so the Command Centre's address
REM bar reads http://parashealth.local/supply-chain/command-centre/
REM This edits the Windows hosts file, so it must run as Administrator.
title Paras Health - friendly address setup
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   This needs to run as Administrator.
  echo   Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

where py >nul 2>&1 && (py setup_hostname.py %* & pause & goto :eof)
where python >nul 2>&1 && (python setup_hostname.py %* & pause & goto :eof)
echo Python was not found. Install it from https://www.python.org/downloads/
pause
