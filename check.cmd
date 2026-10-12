@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_EXE%" (
  echo.
  echo   Node.js not found. Install the LTS version from https://nodejs.org
  echo.
  pause >nul
  exit /b 1
)

set "FAILED="

echo.
echo [1/2] JavaScript syntax check
for %%F in (server.js lib\env.js lib\store.js lib\model.js lib\prompts.js public\app.js) do (
  "%NODE_EXE%" --check "%%F"
  if errorlevel 1 (
    echo   FAIL  %%F
    set "FAILED=1"
  ) else (
    echo   OK    %%F
  )
)

echo.
echo [2/2] JSON data check
"%NODE_EXE%" tools\check.js
if errorlevel 1 set "FAILED=1"

echo.
if defined FAILED (
  echo   Some checks FAILED, see above.
) else (
  echo   All checks passed. You can start now.
)
echo.
pause >nul
