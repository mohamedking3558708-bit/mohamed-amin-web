@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 apply_performance_fixes.py
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    python apply_performance_fixes.py
  ) else (
    echo Python 3 is not installed. Install Python 3 from python.org, then run this file again.
    pause
    exit /b 1
  )
)
if errorlevel 1 (
  echo The patch did not complete. Read the error above; originals were not overwritten before validation.
  pause
  exit /b 1
)
pause
