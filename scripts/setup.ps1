<#
.SYNOPSIS
  Full Kweeto setup on Windows: Python venv, backend deps, frontend deps, .env.local.
.PARAMETER Light
  Skip torch/transformers (fake "pixels" embedder only): much faster install.
.EXAMPLE
  .\scripts\setup.ps1
  .\scripts\setup.ps1 -Light
#>
param([switch]$Light)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Invoke-Pip([string[]]$PipArgs) {
  # truststore = use the OS certificate store (needed behind TLS-intercepting proxies/antivirus)
  & .\.venv\Scripts\python.exe -m pip install --disable-pip-version-check --use-feature=truststore @PipArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Retrying without --use-feature=truststore..." -ForegroundColor Yellow
    & .\.venv\Scripts\python.exe -m pip install --disable-pip-version-check @PipArgs
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
  }
}

# ---------- Python / backend ----------
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python not found. Install Python 3.11 from https://www.python.org/downloads/ (tick 'Add to PATH')."
}
Write-Host "==> Backend" -ForegroundColor Cyan
Push-Location (Join-Path $root "backend")
try {
  if (-not (Test-Path ".venv")) { python -m venv .venv }
  if ($Light) {
    Invoke-Pip @("fastapi", "uvicorn[standard]", "sqlalchemy", "pillow", "numpy", "python-multipart", "faiss-cpu")
  } else {
    Invoke-Pip @("-r", "requirements.txt")
  }
  Invoke-Pip @("-r", "requirements-dev.txt")
} finally { Pop-Location }

# ---------- Node / frontend ----------
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "Node.js not found. Install Node 22 LTS from https://nodejs.org (see .nvmrc)."
}
Write-Host "==> Frontend (node $(node --version))" -ForegroundColor Cyan
Push-Location (Join-Path $root "frontend")
try {
  if (-not (Test-Path ".env.local")) { Copy-Item ".env.local.example" ".env.local" }
  npm install --no-fund --no-audit --maxsockets=3 --fetch-retries=6 --fetch-retry-mintimeout=2000
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} finally { Pop-Location }

Write-Host ""
Write-Host "Done. Start with:  .\scripts\dev.ps1$(if ($Light) { ' -Fake' })" -ForegroundColor Green
