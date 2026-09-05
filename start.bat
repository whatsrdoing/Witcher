@echo off
REM ===================================================================
REM  PARAS HEALTH - SUPPLY CHAIN COMMAND CENTRE
REM
REM  DOUBLE-CLICK THIS FILE, not index.html.
REM
REM  index.html opened directly can only ever show a C:\Users\... path
REM  in the address bar - that is what the browser is looking at. This
REM  launcher starts the local server and opens the real address:
REM      http://parashealth.internal/supply-chain/command-centre/
REM  Keep this window open while you work; closing it stops the server.
REM ===================================================================
title Paras Health - Supply Chain Command Centre
cd /d "%~dp0"

set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY goto :nopython

REM One-time: make parashealth.internal point at this computer. Needs
REM Administrator, so Windows will ask. Say no and everything still works,
REM just on the 127.0.0.1 address instead.
%PY% -c "import socket,sys;sys.exit(0 if socket.gethostbyname('parashealth.internal').startswith('127.') else 1)" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   First run: setting up the parashealth.internal address.
  echo   Windows will ask for Administrator - this only happens once.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { Start-Process -FilePath '%PY%' -ArgumentList 'setup_hostname.py' -WorkingDirectory '%CD%' -Verb RunAs -Wait } catch { Write-Host '  Skipped - using the 127.0.0.1 address instead.' }"
)

%PY% serve.py --app
goto :eof

:nopython
echo.
echo   Python was not found on this computer.
echo.
echo   Install it from https://www.python.org/downloads/
echo   and tick "Add python.exe to PATH" during setup.
echo.
echo   Without Python you can still double-click index.html - everything
echo   works, but the address bar will show the file path.
echo.
pause
