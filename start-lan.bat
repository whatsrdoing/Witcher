@echo off
REM ===================================================================
REM  PARAS HEALTH - SUPPLY CHAIN COMMAND CENTRE  (shared on this network)
REM
REM  Same as start.bat, but also reachable by other computers on the
REM  same office/WiFi network -- see the console window after it opens
REM  for the address to give them.
REM
REM  Keep this window open while anyone is using it; closing it stops
REM  the server for every computer, not just this one.
REM ===================================================================
title Paras Health - Supply Chain Command Centre (shared on this network)
cd /d "%~dp0"

set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY goto :nopython

REM One-time: make parashealth.internal point at this computer. Needs
REM Administrator, so Windows will ask. Say no and everything still works,
REM just on the 127.0.0.1 address instead. This name only ever resolves
REM on THIS PC either way -- other computers always use the LAN address
REM printed below, never this name.
%PY% -c "import socket,sys;sys.exit(0 if socket.gethostbyname('parashealth.internal').startswith('127.') else 1)" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   First run: setting up the parashealth.internal address.
  echo   Windows will ask for Administrator - this only happens once.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { Start-Process -FilePath '%PY%' -ArgumentList 'setup_hostname.py' -WorkingDirectory '%CD%' -Verb RunAs -Wait } catch { Write-Host '  Skipped - using the 127.0.0.1 address instead.' }"
)

%PY% serve.py --app --lan
goto :eof

:nopython
echo.
echo   Python was not found on this computer.
echo.
echo   Install it from https://www.python.org/downloads/
echo   and tick "Add python.exe to PATH" during setup.
echo.
pause
