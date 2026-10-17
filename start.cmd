@echo off
cd /d "%~dp0"
call npm run batch:serve
if errorlevel 1 pause
