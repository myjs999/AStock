@echo off
cd /d "%~dp0"
if not exist node_modules (
    echo Installing dependencies...
    npm install
)
"%~dp0..\notes-app\node_modules\electron\dist\electron.exe" .
