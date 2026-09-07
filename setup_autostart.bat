@echo off
REM ===================================================================
REM  PARAS HEALTH - SUPPLY CHAIN COMMAND CENTRE - autostart setup
REM
REM  Run this ONCE, as Administrator, on the laptop that will be left
REM  running permanently. It registers a Windows scheduled task that
REM  starts serve.py --lan the moment this computer boots -- before
REM  anyone logs in, and it keeps running even if nobody ever does.
REM  Nothing about Windows login/passwords is touched; this only adds
REM  one background task.
REM
REM  There is no window to watch on this machine afterwards -- it runs
REM  silently in the background. Reach the dashboard from any other
REM  computer on the same network at the LAN address serve.py prints;
REM  run "python serve.py --lan --no-open" here manually once beforehand
REM  if you need to see that address again.
REM
REM  To undo: setup_autostart.bat --remove
REM ===================================================================
title Paras Health - autostart setup
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

if "%~1"=="--remove" (
  schtasks /delete /tn "Paras Health SCM Autostart" /f >nul 2>&1
  echo.
  echo   Autostart removed. This computer will no longer start the
  echo   Command Centre on its own -- use start-lan.bat as usual.
  echo.
  pause
  exit /b 0
)

set "PYEXE="
for /f "delims=" %%P in ('where python 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if not defined PYEXE for /f "delims=" %%P in ('where py 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if not defined PYEXE (
  echo.
  echo   Python was not found. Install it from https://www.python.org/downloads/
  echo   and tick "Add python.exe to PATH", then run this again.
  echo.
  pause
  exit /b 1
)

REM SYSTEM so this runs with no one logged in and needs no password on
REM file; the full PYEXE path (not just "python") is used on purpose so
REM the task does not depend on SYSTEM's own PATH, which usually does not
REM include a per-user Python install.
schtasks /create /tn "Paras Health SCM Autostart" ^
  /tr "\"%PYEXE%\" \"%~dp0serve.py\" --lan --no-open" ^
  /sc onstart /delay 0000:30 /ru SYSTEM /rl highest /f

if errorlevel 1 (
  echo.
  echo   Something went wrong creating the scheduled task - see the
  echo   message above.
  echo.
) else (
  echo.
  echo   Done. This computer will now start the Command Centre
  echo   automatically every time it boots, with no one logged in.
  echo   Starting it now as well, so you can test it without rebooting...
  schtasks /run /tn "Paras Health SCM Autostart" >nul 2>&1
  echo   Give it about 10 seconds, then try the LAN address from another
  echo   computer on this network.
  echo.
)
pause
