@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0release\v0.3.2\Data\acgn-hub.db" (
  echo Existing library was not found. Keep the original Data folder in place.
  pause
  exit /b 1
)
if not exist "%~dp0release\v0.5.0\ACGN-Hub-0.5.0.exe" (
  echo ACGN Hub 0.5.0 is missing. Extract the release before starting.
  pause
  exit /b 1
)
set "ACGN_HUB_DATA_DIR=%~dp0release\v0.3.2\Data"
start "" "%~dp0release\v0.5.0\ACGN-Hub-0.5.0.exe"
endlocal
