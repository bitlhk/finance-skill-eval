@echo off
setlocal EnableExtensions
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
rem Setup, checks and execution use the same project interpreter.
rem --setup installs locked dependencies before starting; no system SDK fallback.
node --env-file-if-exists="%PROJECT_ROOT%\.env.local" "%PROJECT_ROOT%\scripts\openjiuwen.mjs" --serve %*
exit /b %ERRORLEVEL%
