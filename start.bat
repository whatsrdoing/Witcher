@echo off
REM PARAS HEALTH - SUPPLY CHAIN COMMAND CENTRE
REM Opens in an app window with no address bar. Close this window to stop it.
title Paras Health - Supply Chain Command Centre
cd /d "%~dp0"

where py >nul 2>&1 && (py serve.py --app %* & goto :eof)
where python >nul 2>&1 && (python serve.py --app %* & goto :eof)

echo.
echo   Python was not found on this computer.
echo.
echo   Either install it from https://www.python.org/downloads/
echo   (tick "Add python.exe to PATH" during setup),
echo   or just double-click index.html to open the Command Centre directly.
echo.
pause
