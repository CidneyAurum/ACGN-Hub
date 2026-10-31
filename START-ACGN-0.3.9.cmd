@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0release\v0.3.2\Data\acgn-hub.db" exit /b 1
if not exist "%~dp0release\v0.3.9\ACGN-Hub-0.3.9.exe" exit /b 1
set "ACGN_HUB_DATA_DIR=%~dp0release\v0.3.2\Data"
start "" "%~dp0release\v0.3.9\ACGN-Hub-0.3.9.exe"
endlocal
