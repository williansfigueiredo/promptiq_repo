# Build SEGURO para PromptIQ
# Comando: powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "BUILD SEGURO - PromptIQ Teleprompter" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# 1. LIMPEZA
Write-Host "[1/5] Removendo artifacts antigos..." -ForegroundColor Yellow
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
    Write-Host "  OK: $artifact"
  }
}
Write-Host ""

# 2. VERSAO ATUAL
Write-Host "[2/5] Versao Atual:" -ForegroundColor Yellow
$pkg = Get-Content "package.json" | ConvertFrom-Json
$currentVer = $pkg.version
Write-Host "  $currentVer"
Write-Host ""

# 3. INCREMENTAR VERSAO
Write-Host "[3/5] Incrementando versao..." -ForegroundColor Yellow
npm version patch --no-git-tag-version
$pkg = Get-Content "package.json" | ConvertFrom-Json
$newVer = $pkg.version
Write-Host "  OK: $currentVer -> $newVer" -ForegroundColor Green
Write-Host ""

# 4. BUNDLE LICENSE
Write-Host "[4/5] Compilando bytecode..." -ForegroundColor Yellow
npm run bundle:license
Write-Host "  OK: License gate compilado" -ForegroundColor Green
Write-Host ""

# 5. FINALIZAR SEM INSTALADOR
Write-Host "[5/5] Finalizando build sem instalador..." -ForegroundColor Yellow
Write-Host "  OK: Bytecode gerado sem empacotar instalador" -ForegroundColor Green
Write-Host ""

# RESULTADO
Write-Host "======================================================" -ForegroundColor Green
Write-Host "BUILD COMPLETO!" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Proximos passos:" -ForegroundColor Yellow
Write-Host "  1. Teste o app localmente"
Write-Host "  2. Verifique que a correcao funciona"
Write-Host "  3. Gere instalador por outro fluxo apenas se precisar"
Write-Host ""
