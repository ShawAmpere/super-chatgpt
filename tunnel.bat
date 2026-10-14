@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0local-mcp-gateway\scripts\tunnel.bat" %*
exit /b %ERRORLEVEL%
