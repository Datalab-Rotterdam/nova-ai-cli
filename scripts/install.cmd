@echo off
rem Installs or updates nova-ai from cmd.exe by handing over to install.ps1:
rem   curl -fsSL https://datalabrotterdam.nl/nova-ai/install.cmd -o install.cmd && install.cmd && del install.cmd
rem Options pass through, e.g.  install.cmd -Channel alpha
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://datalabrotterdam.nl/nova-ai/install.ps1))) %*"
exit /b %errorlevel%
