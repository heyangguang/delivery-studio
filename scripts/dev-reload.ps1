<#
.SYNOPSIS
  Build Middleware Hub (frontend + Windows & Linux binaries) and zero-downtime hot-reload the running local Hub.
.EXAMPLE
  .\scripts\dev-reload.ps1
  .\scripts\dev-reload.ps1 -SkipFrontend
  .\scripts\dev-reload.ps1 -SkipLinux
#>
param(
    [switch]$SkipFrontend,
    [switch]$SkipLinux,
    [switch]$NoReload,
    [string]$HubRunDir = "D:\DevProject\dazhong-vdi\middleware-hub-run",
    [string]$GoExe = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $GoExe) {
    if (Test-Path "D:\BMW\_go_runtime\go\bin\go.exe") {
        $GoExe = "D:\BMW\_go_runtime\go\bin\go.exe"
    } else {
        $GoExe = "go"
    }
}

$gitSha = ""
try {
    $gitSha = (& git -C $RepoRoot rev-parse --short HEAD 2>$null).Trim()
} catch {}
if (-not $gitSha) { $gitSha = "dev" }
$buildStamp = Get-Date -Format "yyyyMMddHHmmss"
$buildID = "$gitSha-$buildStamp"
$ldFlags = "-X main.buildID=$buildID"

Write-Host "==> Build ID: $buildID" -ForegroundColor Cyan

if (-not $SkipFrontend) {
    Write-Host "==> Building frontend..." -ForegroundColor Cyan
    Push-Location "$RepoRoot\frontend"
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
}

New-Item -ItemType Directory -Force -Path "$RepoRoot\dist" | Out-Null

Push-Location $RepoRoot
try {
    $env:CGO_ENABLED = "0"
    Write-Host "==> Building Windows binary (dist\middleware-store.exe)..." -ForegroundColor Cyan
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    & $GoExe build -ldflags $ldFlags -o "dist\middleware-store.exe" .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $SkipLinux) {
        Write-Host "==> Building Linux binary (dist\middleware-store)..." -ForegroundColor Cyan
        $env:GOOS = "linux"
        $env:GOARCH = "amd64"
        & $GoExe build -ldflags $ldFlags -o "dist\middleware-store" .
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally {
    Pop-Location
}

if ($NoReload) {
    Write-Host "==> Build complete (reload skipped)." -ForegroundColor Green
    exit 0
}

$ConfigFile = Join-Path $HubRunDir "config.windows.json"
if (-not (Test-Path $ConfigFile)) {
    Write-Warning "未找到 $ConfigFile，跳过本地热更新。"
    exit 0
}

Write-Host "==> Triggering zero-downtime hot reload..." -ForegroundColor Cyan
& "$RepoRoot\dist\middleware-store.exe" store reload --config $ConfigFile --binary "$RepoRoot\dist\middleware-store.exe"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
