<#
.SYNOPSIS
  Automate Kyndryl Delivery Studio version bump, release notes update, tests, Win+Linux build, optional Git commit/tag/push, and local zero-downtime reload.
.EXAMPLE
  # Preview next version without modifying files
  .\scripts\release.ps1 -DryRun

  # Bump to next version, run tests, build Win+Linux, commit, tag, push, and hot-reload locally
  .\scripts\release.ps1 -Title "零中断跨平台热重启与演练闭环增强" `
    -Highlights @("Windows 与 Linux 统一支持零中断热重启网关与 store reload","变更演练支持生产落地闭环与防误操作校验") `
    -Commit -Push -Reload
#>
param(
    [string]$Version = "",
    [string]$Title = "",
    [string]$TitleEn = "",
    [string[]]$Highlights = @(),
    [string[]]$HighlightsEn = @(),
    [switch]$SkipTests,
    [switch]$SkipFrontend,
    [switch]$Commit,
    [switch]$Push,
    [switch]$Reload,
    [switch]$DryRun,
    [string]$HubRunDir = "",
    [string]$GoExe = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendDir = Join-Path $RepoRoot "backend"
$MainGo = Join-Path $BackendDir "internal\server\main.go"

if (-not $GoExe) {
    if (Test-Path "D:\BMW\_go_runtime\go\bin\go.exe") {
        $GoExe = "D:\BMW\_go_runtime\go\bin\go.exe"
    } else {
        $GoExe = "go"
    }
}

$content = Get-Content $MainGo -Raw -Encoding UTF8
$verMatch = [regex]::Match($content, 'version\s*=\s*"([^"]+)"')
if (-not $verMatch.Success) {
    throw "Cannot find version constant in main.go"
}
$currentVer = $verMatch.Groups[1].Value

if (-not $Version) {
    $preMatch = [regex]::Match($currentVer, '^(\d+)\.(\d+)\.(\d+)-(alpha|beta|rc)\.(\d+)$')
    $relMatch = [regex]::Match($currentVer, '^(\d+)\.(\d+)\.(\d+)$')
    if ($preMatch.Success) {
        $nextPre = [int]$preMatch.Groups[5].Value + 1
        $Version = "$($preMatch.Groups[1].Value).$($preMatch.Groups[2].Value).$($preMatch.Groups[3].Value)-$($preMatch.Groups[4].Value).$nextPre"
    } elseif ($relMatch.Success) {
        $nextPatch = [int]$relMatch.Groups[3].Value + 1
        $Version = "$($relMatch.Groups[1].Value).$($relMatch.Groups[2].Value).$nextPatch"
    } else {
        throw "Unsupported version format: $currentVer (pass -Version explicitly, e.g. 2.0.3 or 2.1.0-rc.1)"
    }
}
if ($Version -notmatch '^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$') {
    throw "Invalid SemVer version '$Version'. Allowed formats: MAJOR.MINOR.PATCH (e.g. 2.0.3) or MAJOR.MINOR.PATCH-(alpha|beta|rc).N (e.g. 2.1.0-rc.1). Do not use X.Y.Z-dev tags; see docs/BRANCHING_AND_RELEASE_STANDARD.md."
}
$today = Get-Date -Format "yyyy-MM-dd"

Write-Host "Current version : $currentVer" -ForegroundColor Gray
Write-Host "Target version  : $Version ($today)" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DryRun] Would update main.go, build Win+Linux binaries, Commit=$Commit, Push=$Push, Reload=$Reload" -ForegroundColor Yellow
    exit 0
}

if (-not $Title) {
    throw "请传入 -Title 参数（简述本次发版主题），或使用 -DryRun 预览版本号。"
}
if (-not $TitleEn) { $TitleEn = $Title }
if ($Highlights.Count -eq 0) { $Highlights = @($Title) }
if ($HighlightsEn.Count -eq 0) { $HighlightsEn = $Highlights }

function Escape-GoString([string]$s) {
    return $s.Replace('\', '\\').Replace('"', '\"').Replace("`r", "").Replace("`n", '\n')
}

$hlLines = ($Highlights | ForEach-Object { "`t`t`t`"$(Escape-GoString $_)`"," }) -join "`r`n"
$hlEnLines = ($HighlightsEn | ForEach-Object { "`t`t`t`"$(Escape-GoString $_)`"," }) -join "`r`n"

$noteBlock = @"
	{
		Version: "$(Escape-GoString $Version)",
		Date:    "$today",
		Title:   "$(Escape-GoString $Title)",
		TitleEn: "$(Escape-GoString $TitleEn)",
		Highlights: []string{
$hlLines
		},
		HighlightsEn: []string{
$hlEnLines
		},
	},
"@

# Update version, currentReleaseDate, and prepend release note in main.go
$updated = [regex]::Replace($content, '(version\s*=\s*)"[^"]+"', "`$1`"$Version`"", 1)
$updated = [regex]::Replace($updated, '(currentReleaseDate\s*=\s*)"[^"]+"', "`$1`"$today`"", 1)
$anchor = "var platformReleaseNotes = []releaseNote{"
$idx = $updated.IndexOf($anchor)
if ($idx -lt 0) {
    throw "Cannot find platformReleaseNotes in main.go"
}
$insertPos = $idx + $anchor.Length
$updated = $updated.Insert($insertPos, "`r`n" + $noteBlock)

[System.IO.File]::WriteAllText($MainGo, $updated, [System.Text.UTF8Encoding]::new($false))
Write-Host "==> Updated main.go to v$Version ($today)" -ForegroundColor Green

if (-not $SkipTests) {
    Write-Host "==> Running Go release verification tests..." -ForegroundColor Cyan
    Push-Location $BackendDir
    try {
        & $GoExe test -count=1 ./mwpack/... ./pkglib/... ./catalog/...
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & $GoExe test -run "TestGateway|TestAPIVersion|TestDev|TestRehearsal|TestClusterImport|TestGlyphs|TestDocs" -count=1 ./internal/server
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
}

$devReloadArgs = @{
    GoExe = $GoExe
}
if ($HubRunDir) { $devReloadArgs["HubRunDir"] = $HubRunDir }
if ($SkipFrontend) { $devReloadArgs["SkipFrontend"] = $true }
if (-not $Reload)  { $devReloadArgs["NoReload"] = $true }

& "$RepoRoot\scripts\dev-reload.ps1" @devReloadArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Commit) {
    Push-Location $RepoRoot
    try {
        & git add -A
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & git commit -m "chore(release): v$Version - $Title"
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $tagName = "v$Version"
        & git tag -a $tagName -m "Release $tagName - $Title"
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Host "==> Created commit and tag $tagName" -ForegroundColor Green
        if ($Push) {
            $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
            & git push origin $branch
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            & git push origin $tagName
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            Write-Host "==> Pushed $branch and tag $tagName to origin" -ForegroundColor Green
        }
    } finally {
        Pop-Location
    }
}

Write-Host "==> Release v$Version complete!" -ForegroundColor Green
