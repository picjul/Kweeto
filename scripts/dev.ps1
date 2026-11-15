<#
.SYNOPSIS
  Starts the backend (http://localhost:8000) and the frontend (http://localhost:3000) in two windows.
.PARAMETER Fake
  Use the fake "pixels" embedder (no torch) and a separate data folder (backend/data-fake).
#>
param([switch]$Fake)

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root "backend\.venv"))) { throw "Run .\scripts\setup.ps1 first" }

$backendEnv = if ($Fake) { "`$env:KWEETO_EMBEDDER='pixels'; `$env:KWEETO_DATA_DIR='$root\backend\data-fake'; " } else { "" }
$backendCmd = "cd '$root\backend'; $backendEnv.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000"
$frontendCmd = "cd '$root\frontend'; npm run dev"

Start-Process powershell -ArgumentList @("-NoExit", "-Command", $backendCmd)
Start-Process powershell -ArgumentList @("-NoExit", "-Command", $frontendCmd)

Write-Host "Starting backend and frontend in two separate windows..." -ForegroundColor Cyan
Start-Sleep -Seconds 8
Start-Process "http://localhost:3000"
