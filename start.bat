@echo off
REM PARAS HEALTH - SUPPLY CHAIN COMMAND CENTRE (Windows launcher)
cd /d "%~dp0"
where py >nul 2>&1 && (py serve.py %* & goto :eof)
where python >nul 2>&1 && (python serve.py %* & goto :eof)
echo Python was not found. Double-click index.html instead,
echo or install Python from https://www.python.org/downloads/
pause
