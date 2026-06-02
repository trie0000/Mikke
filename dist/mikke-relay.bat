@echo off
REM mikke-relay.bat - Mikke relay launcher (PowerShell HttpListener)
REM cmd は ANSI で解釈するため日本語は ps1 側に置く (ASCII のみ)。
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mikke-relay.ps1" %*
