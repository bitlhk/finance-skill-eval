@echo off
setlocal EnableExtensions

rem Windows launcher for the local OpenJiuwen integration.
rem The service is deliberately bound to loopback for enterprise workstation use.

for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "VENV_DIR=%PROJECT_ROOT%\.venv-openjiuwen"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "RUNTIME_PROJECT=%PROJECT_ROOT%\integrations\openjiuwen"
set "RUNTIME_LOCK=%RUNTIME_PROJECT%\uv.lock"
set "FORCE_SETUP=0"

rem uv target environment. Override with UV_PROJECT_ENVIRONMENT; defaults to the venv below.
if not defined UV_PROJECT_ENVIRONMENT set "UV_PROJECT_ENVIRONMENT=%VENV_DIR%"

rem Load local machine config from .env.local (written by scripts/bootstrap-local.mjs).
rem cmd does not read it on its own. Existing environment variables win over the file.
set "LOCAL_ENV=%PROJECT_ROOT%\.env.local"
if exist "%LOCAL_ENV%" for /f "usebackq eol=# tokens=1* delims==" %%A in ("%LOCAL_ENV%") do if not "%%A"=="" if not defined %%A set "%%A=%%B"

if /I "%~1"=="--setup" set "FORCE_SETUP=1"
if not "%~1"=="" if /I not "%~1"=="--setup" goto :usage

if not defined FINANCE_RUNTIME_CONFIG set "FINANCE_RUNTIME_CONFIG=%PROJECT_ROOT%\.runtime.local.json"

if not exist "%RUNTIME_LOCK%" (
  echo [ERROR] Dependency lock not found: "%RUNTIME_LOCK%"
  echo The runtime version and its transitive dependencies are pinned there.
  exit /b 1
)

if not exist "%FINANCE_RUNTIME_CONFIG%" (
  echo [ERROR] Runtime configuration not found: "%FINANCE_RUNTIME_CONFIG%"
  echo Create it from the committed template:
  echo   copy /Y ".runtime.local.example.json" ".runtime.local.json"
  echo Then fill in the model service fields, or set FINANCE_RUNTIME_CONFIG to another full path.
  exit /b 1
)

if exist "%VENV_PYTHON%" goto :environment_ready

echo [INFO] Creating the local OpenJiuwen Python environment...
if defined FINANCE_OPENJIUWEN_PYTHON (
  if not exist "%FINANCE_OPENJIUWEN_PYTHON%" (
    echo [ERROR] FINANCE_OPENJIUWEN_PYTHON does not exist: "%FINANCE_OPENJIUWEN_PYTHON%"
    exit /b 1
  )
  "%FINANCE_OPENJIUWEN_PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info[:2] in ((3, 11), (3, 12), (3, 13)) else 1)"
  if errorlevel 1 goto :unsupported_python
  "%FINANCE_OPENJIUWEN_PYTHON%" -m venv "%VENV_DIR%"
  if errorlevel 1 goto :venv_failed
  set "FORCE_SETUP=1"
  goto :environment_ready
)

where py.exe >nul 2>nul
if not errorlevel 1 (
  py.exe -3 -c "import sys; raise SystemExit(0 if sys.version_info[:2] in ((3, 11), (3, 12), (3, 13)) else 1)"
  if errorlevel 1 goto :unsupported_python
  py.exe -3 -m venv "%VENV_DIR%"
  if errorlevel 1 goto :venv_failed
  set "FORCE_SETUP=1"
  goto :environment_ready
)

where python.exe >nul 2>nul
if errorlevel 1 goto :python_missing
python.exe -c "import sys; raise SystemExit(0 if sys.version_info[:2] in ((3, 11), (3, 12), (3, 13)) else 1)"
if errorlevel 1 goto :unsupported_python
python.exe -m venv "%VENV_DIR%"
if errorlevel 1 goto :venv_failed
set "FORCE_SETUP=1"

:environment_ready
if "%FORCE_SETUP%"=="1" goto :install_dependencies
"%VENV_PYTHON%" -c "import fastapi, openjiuwen, uvicorn" >nul 2>nul
if errorlevel 1 goto :install_dependencies
if not exist "%VENV_DIR%\Scripts\uv.exe" goto :install_dependencies
goto :validate_config

:install_dependencies
rem The environment comes from uv.lock: single source of runtime version and transitive deps.
where uv.exe >nul 2>nul
if errorlevel 1 goto :uv_missing
echo [INFO] Installing the locked OpenJiuwen dependencies...
uv sync --locked --project "%RUNTIME_PROJECT%"
if errorlevel 1 (
  echo [ERROR] Dependency installation failed. Check the Python package source and network policy.
  echo If uv reports that the lock is out of date, re-lock with:
  echo   uv lock --project "%RUNTIME_PROJECT%"
  exit /b 1
)

:validate_config
"%VENV_PYTHON%" -c "import json,os; c=json.load(open(os.environ['FINANCE_RUNTIME_CONFIG'], encoding='utf-8')); models=c.get('models'); assert isinstance(models,dict) and models,'models must contain at least one configured model'; required=('baseUrl','apiKey','upstreamModelId'); assert all(all(isinstance(m.get(k),str) and m[k] and not m[k].startswith('REPLACE_WITH_') for k in required) for m in models.values()),'model fields are incomplete'"
if errorlevel 1 (
  echo [ERROR] Runtime configuration is invalid or contains no model binding.
  exit /b 1
)

set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"
cd /d "%PROJECT_ROOT%"

echo [INFO] Starting OpenJiuwen on http://127.0.0.1:56362
echo [INFO] Health endpoint: http://127.0.0.1:56362/health
echo [INFO] Press Ctrl+C to stop the service.
"%VENV_PYTHON%" -m uvicorn integrations.openjiuwen.worker:app --host 127.0.0.1 --port 56362
exit /b %ERRORLEVEL%

:usage
echo Usage: scripts\start-openjiuwen.cmd [--setup]
echo   --setup  Reinstall the pinned dependencies before starting.
exit /b 2

:python_missing
echo [ERROR] Python was not found. Install Python 3.11, 3.12, or 3.13 and try again.
echo You may also set FINANCE_OPENJIUWEN_PYTHON to an approved python.exe path.
exit /b 1

:unsupported_python
echo [ERROR] OpenJiuwen requires Python 3.11 through 3.13.
exit /b 1

:venv_failed
echo [ERROR] Could not create "%VENV_DIR%".
exit /b 1

:uv_missing
echo [ERROR] uv was not found on PATH.
echo The runtime environment is installed from integrations\openjiuwen\uv.lock,
echo so uv is required (the static scanner uses it too).
exit /b 1
