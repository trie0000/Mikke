@echo off
REM ============================================================================
REM mikke-launch.bat - one-click: start relay + open the SharePoint site
REM ----------------------------------------------------------------------------
REM Keep this file ASCII-only (cmd.exe parses .bat as ANSI / CP932). All
REM Japanese messages live in mikke-launch.ps1.
REM The final "pause" keeps this window open so messages / errors stay readable.
REM ============================================================================
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mikke-launch.ps1" %*
echo.
echo [mikke-launch] done (exit code %ERRORLEVEL%). Press any key to close.
pause >nul
