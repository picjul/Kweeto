@echo off
rem Kweeto: starts the backend (http://127.0.0.1:8000) and the frontend (http://localhost:3000)
rem in two windows, then opens the browser. Double-click it, or run:  scripts\dev.bat [fake]
rem   fake = fake "pixels" embedder (no torch), data in backend\data-fake
rem Set KWEETO_NO_BROWSER=1 to skip opening the browser. Close the two windows (or press Ctrl+C in them) to stop Kweeto.
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%" >nul
set "ROOT=%CD%"
popd >nul

if not exist "%ROOT%\backend\.venv\Scripts\python.exe" (
  echo Backend not set up: run  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1  first.
  pause
  exit /b 1
)
if not exist "%ROOT%\frontend\node_modules" (
  echo Frontend not set up: run  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1  first.
  pause
  exit /b 1
)

set "BACKEND_ENV="
if /i "%~1"=="fake" set "BACKEND_ENV=set KWEETO_EMBEDDER=pixels&& set KWEETO_DATA_DIR=%ROOT%\backend\data-fake&& "

start "Kweeto backend" cmd /k "cd /d "%ROOT%\backend" && %BACKEND_ENV%.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000"
start "Kweeto frontend" cmd /k "cd /d "%ROOT%\frontend" && npm run dev"

echo Starting Kweeto (backend + frontend)...
set /a TRIES=0
:wait_backend
set /a TRIES+=1
curl -s -o nul http://127.0.0.1:8000/ && goto backend_up
if %TRIES% geq 60 goto open
timeout /t 1 /nobreak >nul
goto wait_backend
:backend_up
echo Backend is up. Waiting for the frontend...
set /a TRIES=0
:wait_frontend
set /a TRIES+=1
curl -s -o nul http://localhost:3000/ && goto open
if %TRIES% geq 60 goto open
timeout /t 1 /nobreak >nul
goto wait_frontend
:open
if not defined KWEETO_NO_BROWSER start "" http://localhost:3000
echo Kweeto is running at http://localhost:3000  (models load in the background on first start).
endlocal
