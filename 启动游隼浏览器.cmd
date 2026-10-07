@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0release\win-unpacked\PeregrineBrowser.exe" (
    start "" "%~dp0release\win-unpacked\PeregrineBrowser.exe"
    exit /b 0
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo Packaged application was not found in release\win-unpacked.
    echo Use the complete packaged folder to run without Node.js or npm.
    echo Developers can install Node.js, then run npm install and npm run core:download.
    pause
    exit /b 1
)

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
    echo Development dependencies are missing.
    echo Run npm install and npm run core:download in this folder first.
    pause
    exit /b 1
)

call npm.cmd start
set "peregrine_exit=%errorlevel%"
if not "%peregrine_exit%"=="0" pause
exit /b %peregrine_exit%
