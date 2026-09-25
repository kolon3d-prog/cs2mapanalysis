#Requires -Version 7.0
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub
<#
.SYNOPSIS
    publish_report.ps1 — публикация отчёта на витрину (Windows/pwsh-двойник publish_report.sh).

.DESCRIPTION
    Публикация и пуш РАЗДЕЛЕНЫ (28.08), как в bash-версии:
      * по умолчанию — только локально: скан секретов → копия в research/public/ → пересборка
        витрины (git не тронут);
      * -Push — плюс git add/commit/push витрины;
      * -DryRun — план без действий (в т.ч. «уже на витрине?»).
    Отдельного -Public нет и не нужно: локальная копия — это и есть поведение по умолчанию
    (в bash-версии --public лишь помечает «без пуша»).

    Безопасность та же: публикуется ТОЛЬКО research/public/ (git-трекается), скан секретов —
    первый барьер, gitleaks в CI — второй (gitleaks.yml).

    Сообщения в консоль — ASCII. Префикс коммита здесь `publish(showcase)`: bash-версия пишет
    `publish(витрина)`, форма та же, но в .ps1 кириллица недопустима (кодировка консолей).

.EXAMPLE
    pwsh -NoProfile -File scripts/publish_report.ps1 2026-08-28-gta-6-report.md -DryRun
    pwsh -NoProfile -File scripts/publish_report.ps1 2026-08-28-gta-6-report.md
    pwsh -NoProfile -File scripts/publish_report.ps1 2026-08-28-gta-6-report.md -Push
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Report = '',
    [switch] $Push,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Step { param([string] $Text) Write-Host "=== $Text ===" }
function Write-Ok { param([string] $Text) Write-Host "[ok] $Text" -ForegroundColor Green }
function Write-Warn2 { param([string] $Text) Write-Host "[!] $Text" -ForegroundColor Yellow }
function Write-Fail { param([string] $Text) Write-Host "[X] $Text" -ForegroundColor Red }
function Write-Plan { param([string] $Text) Write-Host "   $Text" }

if (-not $Report) {
    Write-Host 'usage: publish_report.ps1 <report.md> [-Push] [-DryRun]' -ForegroundColor Red
    exit 2
}

$repo = Split-Path -Parent $PSScriptRoot
$public = Join-Path (Join-Path $repo 'research') 'public'

# Добыча с 28.08 живёт в кэше: если файл не по данному пути — ищем по имени в
# <кэш>/research и <кэш>/exports. Кэш из env, дефолт ~/.cache — не хардкод.
$cacheRoot = $env:CAMOUFOX_CACHE_DIR
if (-not $cacheRoot) { $cacheRoot = Join-Path (Join-Path $HOME '.cache') 'camoufox-research' }

$file = $Report
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    foreach ($dir in @((Join-Path $cacheRoot 'research'), (Join-Path $cacheRoot 'exports'))) {
        $candidate = Join-Path $dir (Split-Path -Leaf $Report)
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $file = $candidate; break }
    }
}
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    Write-Fail "file not found: $file (looked in the cache too)"
    exit 1
}
$file = (Resolve-Path -LiteralPath $file).Path
$reportName = Split-Path -Leaf $file

# --- 0. -DryRun: план без действий ---
if ($DryRun) {
    Write-Host 'DRY plan (nothing is done):'
    Write-Plan "file:    $file"
    Write-Plan "target:  $(Join-Path $public $reportName)"
    if ($Push) { Write-Plan 'push:    YES (-Push)' } else { Write-Plan 'push:    NO (local only)' }
    Write-Plan 'steps:   secret scan -> copy to public/ -> rebuild the showcase'
    if ($Push) { Write-Plan '         -> commit -> git push' } else { Write-Plan '         -> (git untouched)' }
    $already = Join-Path $public $reportName
    if (Test-Path -LiteralPath $already -PathType Leaf) {
        if ((Get-FileHash -LiteralPath $file).Hash -eq (Get-FileHash -LiteralPath $already).Hash) {
            Write-Warn2 'ALREADY on the showcase (identical copy) - a duplicate!'
        } else {
            Write-Warn2 'ALREADY on the showcase, but DIFFERENT - it will be overwritten'
        }
    } else {
        Write-Plan 'not on the showcase yet - it will be added'
    }
    exit 0
}

if ($reportName -notmatch '^20\d\d-\d\d-\d\d-.+\.md$') {
    Write-Fail "name does not follow the convention (expected YYYY-MM-DD-topic.md): $reportName"
    exit 1
}
if ($reportName -eq 'INDEX.md') {
    Write-Fail 'INDEX.md cannot be published on its own'
    exit 1
}

# --- 1. Скан секретов: личные ключи, токены, пути — публикация запрещена ---
Write-Step '1/4 secret scan'
$patterns = @(
    'BEGIN [A-Z ]*PRIVATE KEY'
    '(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}'
    'sk-[A-Za-z0-9]{20,}'
    'AKIA[0-9A-Z]{16}'
    'AIza[0-9A-Za-z_-]{30,}'
    'xox[baprs]-[A-Za-z0-9-]{10,}'
    '(api[_-]?key|apikey)([="'' :]+)[A-Za-z0-9_\-]{12,}'
    '(password|passwd|pwd)([="'' :]+)[^\s]{4,}'
    '(secret)([="'' :]+)[A-Za-z0-9_\-]{8,}'
    '(/home/|/Users/|/run/media/)'
)
$scan = [regex]::new($patterns -join '|')
$hits = [System.Collections.Generic.List[string]]::new()
$lineNo = 0
foreach ($line in [System.IO.File]::ReadAllLines($file)) {
    $lineNo++
    if ($scan.IsMatch($line)) { $hits.Add("${lineNo}:$line") }
}
if ($hits.Count -gt 0) {
    Write-Fail 'SECRET SCAN: publishing is forbidden - found:'
    $hits | Select-Object -First 20 | ForEach-Object { Write-Host "   $_" }
    Write-Host '   rule research/README.md: placeholders only, e.g. YOUR_API_KEY.'
    exit 1
}
Write-Ok 'secret scan: clean (0 suspicious)'

# --- 2. Копия в research/public/ (единственное место, что уходит в git) ---
Write-Step '2/4 copy to the showcase'
$target = Join-Path $public $reportName
if (Test-Path -LiteralPath $target -PathType Leaf) {
    if ((Get-FileHash -LiteralPath $file).Hash -eq (Get-FileHash -LiteralPath $target).Hash) {
        Write-Warn2 "DUPLICATE: $reportName is already on the showcase (identical) - the copy is the same"
    } else {
        Write-Warn2 "$reportName is already in public/ and differs - overwriting"
    }
}
New-Item -ItemType Directory -Path $public -Force | Out-Null
Copy-Item -LiteralPath $file -Destination $target -Force
Write-Ok "copied: $target"

# --- 3. Оглавление + локальная сборка (проверка до пуша) ---
# `python` есть НЕ везде: macOS оставляет только python3, на Windows — py/venv.
# Свой интерпретатор задаётся CAMOUFOX_PYTHON, как в прочих скриптах.
Write-Step '3/4 index and the showcase build'
$python = $env:CAMOUFOX_PYTHON
if (-not $python) {
    foreach ($program in @('python3', 'python', 'py')) {
        $found = Get-Command $program -ErrorAction SilentlyContinue
        if ($found) { $python = $found.Source; break }
    }
}
if (-not $python) {
    $venvPython = Join-Path (Join-Path (Join-Path $HOME '.venvs') 'camoufox-research') 'bin/python'
    if ($IsWindows) { $venvPython = Join-Path (Join-Path (Join-Path $HOME '.venvs') 'camoufox-research') 'Scripts/python.exe' }
    if (Test-Path -LiteralPath $venvPython) { $python = $venvPython }
}
if (-not $python) {
    $found = Get-Command camoufox-research -ErrorAction SilentlyContinue
    if ($found) { $python = $found.Source }
}
if (-not $python) {
    Write-Fail 'no python found - INDEX and the showcase are built with it (set CAMOUFOX_PYTHON)'
    exit 1
}
& $python (Join-Path $PSScriptRoot 'reports_index.py') --dir $public
if ($LASTEXITCODE -ne 0) { throw "reports_index.py failed (exit $LASTEXITCODE)" }
& $python (Join-Path $PSScriptRoot 'build_pages.py') --src $public --out (Join-Path $repo '_site')
if ($LASTEXITCODE -ne 0) { throw "build_pages.py failed (exit $LASTEXITCODE)" }

# --- 4. ТОЛЬКО -Push трогает git (--public — чисто локально) ---
Write-Step '4/4 git'
Push-Location $repo
try {
    if (-not $Push) {
        Write-Ok "prepared LOCALLY (git untouched): $target"
        Write-Host "   To push: pwsh -File $PSCommandPath $reportName -Push   (or git push yourself)"
        exit 0
    }
    $index = Join-Path $public 'INDEX.md'
    & git add -- $target $index
    if ($LASTEXITCODE -ne 0) { throw "git add failed (exit $LASTEXITCODE)" }
    & git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Host '[i] nothing to commit - the file was published earlier'
        exit 0
    }
    $topic = $reportName.Substring(0, $reportName.Length - 3)   # без .md
    $topic = $topic.Substring(11)                   # без YYYY-MM-DD-
    & git commit -m "publish(showcase): $topic" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
    & git push
    if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)" }
    Write-Ok "published: $reportName - the showcase is rebuilt by Pages automatically"
    Write-Host '   see: https://aidvizhhub.github.io/camoufox-research/'
    exit 0
} finally {
    Pop-Location
}
