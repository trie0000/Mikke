@echo off
REM ============================================================================
REM mikke-relay.bat - Mikke relay launcher (PowerShell HttpListener)
REM ----------------------------------------------------------------------------
REM Keep this file ASCII-only. cmd.exe parses .bat using the system ANSI code
REM page (CP932 on JP Windows), not UTF-8; Japanese here can split lines and run
REM as bogus commands. All Japanese messages live in mikke-relay.ps1.
REM The final "pause" keeps this window open so startup errors (port in use,
REM PowerShell parse errors, etc.) stay readable instead of vanishing instantly.
REM ============================================================================
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mikke-relay.ps1" %*
echo.
echo [mikke-relay] stopped (exit code %ERRORLEVEL%). Press any key to close.
pause >nul
