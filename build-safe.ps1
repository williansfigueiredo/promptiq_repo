# ============================================================
# Build SEGURO para PromptIQ (PowerShell)
# ============================================================
# Use: powershell -ExecutionPolicy Bypass -File build-safe.ps1

param(
    [switch]$SkipVersion = $false,
    [switch]$TestOnly = $false
)

$ErrorActionPreference = "Stop"

Write-Host "`n" -ForegroundColor Cyan
Write-Host "╔════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  BUILD SEGURO - PromptIQ Teleprompter                  ║" -ForegroundColor Cyan
Write-Host "║  Incrementa versão + Limpa + Compila + Empacota       ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host "`n"

# ============================================================
# 1. VALIDAR AMBIENTE
# ============================================================
Write-Host "[PRÉ-VERIFICAÇÃO] 🔍 Validando ambiente..." -ForegroundColor Yellow
Write-Host ""

# Verificar Node.js
$node = npm -v 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ npm não encontrado! Instale Node.js." -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ npm versão: $(npm -v)"

# Verificar Electron
$electron = npm list electron --depth=0 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Electron não instalado!" -ForegroundColor Red
    exit 1
}
$electronVersion = npm list electron --depth=0 | Select-String "promptiq@" -Context 1 | ForEach-Object { $_.Context.PostContext } | Select-String "electron@" | ForEach-Object { $_ -replace '.*electron@', '' -replace ' .*', '' }
Write-Host "  ✓ Electron versão: $electronVersion"

Write-Host ""

# ============================================================
# 2. LIMPAR ARTIFACTS ANTIGOS
# ============================================================
Write-Host "[PASSO 1/5] 🧹 Removendo artifacts do build anterior..." -ForegroundColor Yellow
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
        Write-Host "  ✓ Removido: $artifact"
    }
}

Write-Host ""

# ============================================================
# 3. VERIFICAR E INCREMENTAR VERSÃO
# ============================================================
Write-Host "[PASSO 2/5] 📌 Versão Atual:" -ForegroundColor Yellow
Write-Host ""

$packageJson = Get-Content "package.json" | ConvertFrom-Json
$currentVersion = $packageJson.version
Write-Host "  Versão: $currentVersion"
Write-Host ""

if (-not $SkipVersion) {
    Write-Host "[PASSO 3/5] 📈 Incrementando versão (patch)..." -ForegroundColor Yellow
    Write-Host ""
    
    try {
        npm version patch --no-git-tag-version
        $packageJson = Get-Content "package.json" | ConvertFrom-Json
        $newVersion = $packageJson.version
        Write-Host "  ✓ Versão atualizada: $currentVersion → $newVersion" -ForegroundColor Green
    } catch {
        Write-Host "❌ Erro ao incrementar versão!" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[PASSO 3/5] ⏭️  Pulando incremento de versão (--SkipVersion)" -ForegroundColor Yellow
}

Write-Host ""

# ============================================================
# 4. BUNDLE LICENSE GATE
# ============================================================
Write-Host "[PASSO 4/5] 🔨 Compilando bytecode (esbuild + bytenode)..." -ForegroundColor Yellow
Write-Host ""

try {
    npm run bundle:license
    if ($LASTEXITCODE -ne 0) {
        throw "npm run bundle:license falhou"
    }
    Write-Host "  ✓ Bytecode gerado: src\main\license-dist\gate.jsc" -ForegroundColor Green
} catch {
    Write-Host "❌ Erro ao fazer bundle do license gate!" -ForegroundColor Red
    Write-Host "   Erro: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""

# ============================================================
# 5. TESTE RÁPIDO (Opcional)
# ============================================================
if ($TestOnly) {
    Write-Host "[PASSO 5/5] 🧪 Teste RÁPIDO (sem gerar EXE)..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  ⚠️  Modo teste ativado"
    Write-Host "  Para gerar EXE completo, remova -TestOnly"
    Write-Host ""
    Write-Host "✅ Verificações completas - bytecode gerado com sucesso!"
    exit 0
}

# ============================================================
# 6. ELECTRON-BUILDER
# ============================================================
Write-Host "[PASSO 5/5] 🏗️  Gerando instalador com electron-builder..." -ForegroundColor Yellow
Write-Host ""

try {
    npm run dist:publish
    if ($LASTEXITCODE -ne 0) {
        throw "npm run dist:publish falhou"
    }
} catch {
    Write-Host "❌ Erro ao gerar instalador!" -ForegroundColor Red
    Write-Host "   Erro: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""

# ============================================================
# 7. VERIFICAÇÃO FINAL
# ============================================================
Write-Host "`n" -ForegroundColor Cyan
Write-Host "╔════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✅ BUILD COMPLETO E SEGURO!                           ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host "`n"

$distFiles = Get-ChildItem "dist\" -Recurse
$exeFile = Get-ChildItem "dist\" -Filter "*.exe" -ErrorAction SilentlyContinue

Write-Host "📦 Arquivos gerados em: dist\"
if ($exeFile) {
    Write-Host "   EXE: $($exeFile.Name) ($([math]::Round($exeFile.Length / 1MB, 2)) MB)"
} else {
    Write-Host "   ⚠️  Nenhum EXE encontrado"
}

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✅ BUILD COMPLETO E SEGURO!                           ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

Write-Host "📦 Arquivos gerados em: dist\"
if ($exeFile) {
    Write-Host "   EXE: $($exeFile.Name) ($([math]::Round($exeFile.Length / 1MB, 2)) MB)"
} else {
    Write-Host "   ⚠️  Nenhum EXE encontrado"
}

Write-Host ""
Write-Host "📋 Próximos passos:"
Write-Host "   1. Teste o EXE localmente para validar a correção"
Write-Host "   2. Verifique no DevTools que as mudanças funcionam"
Write-Host "   3. Envie para cliente com confiança!"
Write-Host ""

Write-Host "Dica: Use " -NoNewline
Write-Host "-TestOnly" -ForegroundColor Yellow -NoNewline
Write-Host " para apenas verificar bytecode sem gerar EXE" -ForegroundColor Gray
Write-Host ""
