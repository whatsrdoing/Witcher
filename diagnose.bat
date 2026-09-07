@echo off
REM Explains why the parashealth.internal address is not working.
title Paras Health - address check
cd /d "%~dp0"
where py >nul 2>&1 && (py setup_hostname.py --doctor & pause & goto :eof)
where python >nul 2>&1 && (python setup_hostname.py --doctor & pause & goto :eof)
echo Python was not found. Install it from https://www.python.org/downloads/
pause
