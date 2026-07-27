# ============================================================
# Safe build for PromptIQ (PowerShell)
# ============================================================
# Use: powershell -ExecutionPolicy Bypass -File build-safe.ps1

param(
  [switch]$SkipVersion = $false,
  [switch]$TestOnly = $false
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "SAFE BUILD - PromptIQ Teleprompter" -ForegroundColor Cyan
Write-Host "Increment version + Clean + Compile bytecode" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Validate environment
Write-Host "[PRE-CHECK] Validating environment..." -ForegroundColor Yellow
Write-Host ""

$npmVersion = npm -v 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: npm not found. Install Node.js." -ForegroundColor Red
  exit 1
}
Write-Host "  OK: npm version $npmVersion"

$electronList = npm list electron --depth=0 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: Electron is not installed." -ForegroundColor Red
  exit 1
}
$electronVersion = ($electronList | Select-String "electron@").ToString() -replace '.*electron@', '' -replace ' .*', ''
Write-Host "  OK: Electron version $electronVersion"
Write-Host ""

# 2. Clean old artifacts
Write-Host "[STEP 1/4] Removing previous build artifacts..." -ForegroundColor Yellow
Write-Host ""

$artifacts = @(
  "src\main\main.jsc",
  "src\main\main.cjs",
  "src\renderer\app.jsc",
  "src\renderer\app.cjs",
  "src\main\license-dist\gate.jsc",
  "src\main\license-dist\gate.cjs",
  "dist",
  "node_modules\.cache"
)

foreach ($artifact in $artifacts) {
  if (Test-Path $artifact) {
    Remove-Item $artifact -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  OK: removed $artifact"
  }
}

Write-Host ""

# 3. Show and optionally increment version
Write-Host "[STEP 2/4] Current version:" -ForegroundColor Yellow
Write-Host ""

$packageJson = Get-Content "package.json" | ConvertFrom-Json
$currentVersion = $packageJson.version
Write-Host "  $currentVersion"
Write-Host ""

if (-not $SkipVersion) {
  Write-Host "[STEP 3/4] Incrementing patch version..." -ForegroundColor Yellow
  Write-Host ""

  try {
    npm version patch --no-git-tag-version | Out-Null
    $packageJson = Get-Content "package.json" | ConvertFrom-Json
    $newVersion = $packageJson.version
    Write-Host "  OK: $currentVersion -> $newVersion" -ForegroundColor Green
  }
  catch {
    Write-Host "ERROR: failed to increment version." -ForegroundColor Red
    exit 1
  }
}
else {
  Write-Host "[STEP 3/4] Skipping version increment (--SkipVersion)" -ForegroundColor Yellow
}

Write-Host ""

# 4. Build bytecode only
Write-Host "[STEP 4/4] Building bytecode bundle..." -ForegroundColor Yellow
Write-Host ""

try {
  npm run bundle:license
  if ($LASTEXITCODE -ne 0) {
    throw "npm run bundle:license failed"
  }
  Write-Host "  OK: generated src\main\license-dist\gate.jsc" -ForegroundColor Green
}
catch {
  Write-Host "ERROR: bytecode bundle failed." -ForegroundColor Red
  Write-Host "  $_" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "BUILD COMPLETE" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Generated file: src\main\license-dist\gate.jsc"
if ($TestOnly) {
  Write-Host "Mode: test-only confirmation requested." -ForegroundColor Yellow
}
Write-Host "This script does not generate an installer." -ForegroundColor Gray
Write-Host ""
