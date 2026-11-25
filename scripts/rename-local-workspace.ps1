<#
.SYNOPSIS
  Safely rename local Windows workspace and runtime directories from 1.0 legacy names to Kyndryl Delivery Studio 2.0 names:
    middleware-deployer -> delivery-studio
    middleware-hub-run  -> delivery-studio-run
.DESCRIPTION
  Close IDE windows / terminals opened inside middleware-deployer first, then copy this script to %TEMP% and run it from D:\DevProject\dazhong-vdi:

    cd D:\DevProject\dazhong-vdi
    Copy-Item .\middleware-deployer\scripts\rename-local-workspace.ps1 "$env:TEMP\rename-local-workspace.ps1" -Force
    & "$env:TEMP\rename-local-workspace.ps1" -DryRun
    & "$env:TEMP\rename-local-workspace.ps1"

  Optional: pass -RemoteUrl "https://github.com/<owner>/delivery-studio.git" if you also renamed the GitHub repository.
#>
param(
    [string]$BaseDir = "D:\DevProject\dazhong-vdi",
    [string]$OldRepoName = "middleware-deployer",
    [string]$NewRepoName = "delivery-studio",
    [string]$OldRunName = "middleware-hub-run",
    [string]$NewRunName = "delivery-studio-run",
    [switch]$SkipRuntimeDir,
    [switch]$NoStartGateway,
    [string]$RemoteUrl = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$OldRepo = Join-Path $BaseDir $OldRepoName
$NewRepo = Join-Path $BaseDir $NewRepoName
$OldRun  = Join-Path $BaseDir $OldRunName
$NewRun  = Join-Path $BaseDir $NewRunName

$cwd = (Get-Location).Path
if ($cwd.StartsWith($OldRepo, [System.StringComparison]::OrdinalIgnoreCase) -or
    $cwd.StartsWith($OldRun, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "请先切换到父目录（cd $BaseDir）并关闭打开在 $OldRepo 里的 IDE 窗口后再执行本脚本。"
}

Write-Host "=== Kyndryl Delivery Studio 2.0 本地目录迁移 ===" -ForegroundColor Cyan
Write-Host "代码目录: $OldRepo  ->  $NewRepo"
if (-not $SkipRuntimeDir) {
    Write-Host "运行目录: $OldRun  ->  $NewRun"
}
if ($RemoteUrl) {
    Write-Host "Git 远程: origin -> $RemoteUrl"
}

if ($DryRun) {
    Write-Host "[DryRun] 仅预览，未执行任何修改。" -ForegroundColor Yellow
    exit 0
}

# 1. Rename repository directory
if ((Test-Path $OldRepo) -and -not (Test-Path $NewRepo)) {
    Write-Host "==> 正在重命名代码目录..." -ForegroundColor Cyan
    Rename-Item -Path $OldRepo -NewName $NewRepoName
    Write-Host "    完成: $NewRepo" -ForegroundColor Green
} elseif (Test-Path $NewRepo) {
    Write-Host "==> 目标代码目录已存在，跳过重命名: $NewRepo" -ForegroundColor Yellow
} else {
    throw "未找到源代码目录: $OldRepo"
}

# 2. Optional git remote update
if ($RemoteUrl) {
    Write-Host "==> 更新 Git origin URL..." -ForegroundColor Cyan
    & git -C $NewRepo remote set-url origin $RemoteUrl
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# 3. Rename local Hub runtime directory & rewrite local paths
if (-not $SkipRuntimeDir) {
    if ((Test-Path $OldRun) -and -not (Test-Path $NewRun)) {
        Write-Host "==> 正在平稳停止本地热更新网关进程以释放目录占用..." -ForegroundColor Cyan
        Get-Process middleware-store, middleware-store-gateway, delivery-studio, delivery-studio-gateway -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800

        Write-Host "==> 正在重命名运行目录..." -ForegroundColor Cyan
        Rename-Item -Path $OldRun -NewName $NewRunName
        Write-Host "    完成: $NewRun" -ForegroundColor Green
    } elseif (Test-Path $NewRun) {
        Write-Host "==> 目标运行目录已存在，跳过重命名: $NewRun" -ForegroundColor Yellow
    }

    if (Test-Path $NewRun) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $oldRunSlash = $OldRun.Replace('\', '/')
        $newRunSlash = $NewRun.Replace('\', '/')

        foreach ($rel in @("config.windows.json", "start-windows.ps1", "reload-windows.ps1")) {
            $fp = Join-Path $NewRun $rel
            if (-not (Test-Path $fp)) { continue }
            Copy-Item -Force $fp "$fp.bak"
            $txt = [System.IO.File]::ReadAllText($fp, [System.Text.Encoding]::UTF8)
            $txt = $txt.Replace($OldRun, $NewRun)
            $txt = $txt.Replace($oldRunSlash, $newRunSlash)
            $txt = $txt.Replace($OldRepo, $NewRepo)
            $txt = $txt.Replace($OldRepo.Replace('\', '/'), $NewRepo.Replace('\', '/'))
            $txt = $txt.Replace("middleware-store-gateway.exe", "delivery-studio-gateway.exe")
            $txt = $txt.Replace("middleware-store.exe", "delivery-studio.exe")
            $txt = $txt.Replace("middleware-store, middleware-store-gateway", "delivery-studio, delivery-studio-gateway, middleware-store, middleware-store-gateway")
            [System.IO.File]::WriteAllText($fp, $txt, $utf8NoBom)
            Write-Host "    已更新运行脚本/配置: $fp (原文件已备份为 .bak)" -ForegroundColor Green
        }

        if (-not $NoStartGateway -and (Test-Path (Join-Path $NewRun "start-windows.ps1"))) {
            Write-Host "==> 正在拉起新的 Delivery Studio 本地热更新网关..." -ForegroundColor Cyan
            Start-Process -FilePath "powershell.exe" `
                -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $NewRun "start-windows.ps1")) `
                -WorkingDirectory $NewRun `
                -WindowStyle Minimized
            Start-Sleep -Seconds 2
            try {
                $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8443/api/version" -TimeoutSec 5
                Write-Host "    本地网关已就绪: http://127.0.0.1:8443/ (version=$($resp.version), build=$($resp.build))" -ForegroundColor Green
            } catch {
                Write-Warning "网关已触发后台启动，请稍等 2 秒后访问 http://127.0.0.1:8443/ 确认。"
            }
        }
    }
}

Write-Host ""
Write-Host "迁移完成！请在 IDE 中重新打开新工作区目录：$NewRepo" -ForegroundColor Green
