@echo off
REM mikke-launch.bat - relay start + open SP site (one-click)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mikke-launch.ps1" %*
