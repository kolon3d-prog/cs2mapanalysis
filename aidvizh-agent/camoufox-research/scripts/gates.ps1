#Requires -Version 7.0
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub
<#
.SYNOPSIS
    gates.ps1 — все ПЕРЕНОСИМЫЕ гейты репозитория одной командой (Windows/pwsh-двойник gates.sh).

.DESCRIPTION
    Зачем отдельный скрипт: bash-гейт (`scripts/gates.sh`) на Windows не запускается вовсе,
    поэтому до сих пор у Windows-разработчика не было локальной петли проверок — оставался CI.
    Здесь прогоняется ровно та часть гейта, которая переносима: ruff, mypy, bandit, semgrep
    (если установлен) и тесты (pytest, а без него — unittest).

    Unix-only гейты НЕ подделываются и НЕ пропускаются молча: каждый печатает строку
    [skip] с причиной и с тем, чем он заменён на Windows (см. таблицу «скрипт × ОС» в
    scripts/README.md).

    Кэши инструментов уводятся в рантайм-каталог (MYPY_CACHE_DIR / RUFF_CACHE_DIR /
    PYTHONPYCACHEPREFIX), как в gates.sh: иначе mypy кладёт ~30 МБ ВНУТРЬ репозитория,
    а репозиторий лежит на диске данных (урок 21.09).

    Окружение (venv) — тоже в рантайме: ~/.venvs/camoufox-research, фолбэк <репо>/.venv.
    Раскладка venv по ОС: Windows — Scripts/python.exe, Linux/macOS — bin/python.

    Запуск:  pwsh -NoProfile -File scripts/gates.ps1
             pwsh -NoProfile -File scripts/gates.ps1 -Quick   # без semgrep
    Код возврата: 0 — зелёно, 1 — упал гейт, 2 — нет окружения.

.EXAMPLE
    pwsh -NoProfile -File scripts/gates.ps1
    pwsh -NoProfile -File scripts/gates.ps1 -Quick
    $env:CAMOUFOX_VENV = 'D:\venvs\camoufox-research'; pwsh -File scripts/gates.ps1
#>
[CmdletBinding()]
param(
    [switch] $Quick
)

# Нативные команды с ненулевым rc не должны бросать исключение: гейт обязан ЗАФИКСИРОВАТЬ
# провал и продолжить (как gates.sh), а не упасть на первой же красной строке.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Text) Write-Host ''; Write-Host "=== $Text ===" }
function Write-Skip { param([string] $Text) Write-Host "[skip] $Text" -ForegroundColor Yellow }

$root = Split-Path -Parent $PSScriptRoot

# --- окружение: venv в рантайме, фолбэк на <репо>/.venv (CI и разовые песочницы) ---
$binName = 'bin'
$pyName = 'python'
if ($IsWindows) {
    $binName = 'Scripts'
    $pyName = 'python.exe'
}
$venv = $env:CAMOUFOX_VENV
if (-not $venv) { $venv = Join-Path (Join-Path $HOME '.venvs') 'camoufox-research' }
$venvBin = Join-Path $venv $binName
$python = Join-Path $venvBin $pyName
if (-not (Test-Path -LiteralPath $python)) {
    $devVenv = Join-Path $root '.venv'
    $devPython = Join-Path (Join-Path $devVenv $binName) $pyName
    if (Test-Path -LiteralPath $devPython) {
        $venv = $devVenv
        $venvBin = Join-Path $venv $binName
        $python = $devPython
    } else {
        Write-Host "gates.ps1: no environment ($venv and $devVenv are empty). Install: pwsh -File scripts/install.ps1" -ForegroundColor Red
        exit 2
    }
}

$cacheBase = $env:XDG_CACHE_HOME
if (-not $cacheBase) { $cacheBase = Join-Path $HOME '.cache' }
$cache = $env:CAMOUFOX_GATES_CACHE
if (-not $cache) { $cache = Join-Path (Join-Path $cacheBase 'camoufox-research') 'gates' }
foreach ($sub in @('mypy', 'ruff', 'pycache')) {
    New-Item -ItemType Directory -Path (Join-Path $cache $sub) -Force | Out-Null
}
$env:CAMOUFOX_VENV = $venv
$env:MYPY_CACHE_DIR = Join-Path $cache 'mypy'
$env:RUFF_CACHE_DIR = Join-Path $cache 'ruff'
$env:PYTHONPYCACHEPREFIX = Join-Path $cache 'pycache'

function Get-Tool {
    # Сначала окружение (там пины из lock), потом PATH — как в gates.sh.
    param([string] $Name)

    $local = Join-Path $venvBin $Name
    if ($IsWindows) { $local = "$local.exe" }
    if (Test-Path -LiteralPath $local) { return $local }
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return ''
}

$failed = [System.Collections.Generic.List[string]]::new()

function Invoke-Gate {
    param([string] $Name, [string] $Command, [string[]] $Arguments)

    Write-Step $Name
    if (-not $Command) {
        Write-Host "[FAIL] $Name (binary not found - neither in $venvBin nor in PATH)" -ForegroundColor Red
        $failed.Add($Name)
        return
    }
    & $Command @Arguments
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[ok] $Name" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $Name (exit $LASTEXITCODE)" -ForegroundColor Red
        $failed.Add($Name)
    }
}

Push-Location $root
try {
    Invoke-Gate -Name 'ruff' -Command (Get-Tool 'ruff') -Arguments @('check', 'camoufox_research/', '--line-length', '100')
    Invoke-Gate -Name 'mypy' -Command (Get-Tool 'mypy') -Arguments @('--config-file', 'mypy.ini', 'camoufox_research/')
    Invoke-Gate -Name 'bandit' -Command (Get-Tool 'bandit') -Arguments @('-q', '-r', 'camoufox_research/', '-x', 'tests', '-lll')

    if ($Quick) {
        Write-Step 'semgrep'
        Write-Skip 'semgrep: skipped by -Quick (the same as --quick in gates.sh)'
    } else {
        $semgrep = Get-Tool 'semgrep'
        if ($semgrep) {
            Invoke-Gate -Name 'semgrep' -Command $semgrep -Arguments @(
                '--config', '.semgrep.yml', 'camoufox_research/', 'scripts/',
                '--metrics=off', '--disable-version-check', '--error'
            )
        } else {
            Write-Step 'semgrep'
            Write-Skip 'semgrep: not installed (pip install semgrep); gates.sh on Linux/macOS fails here'
        }
    }

    # Тесты: pytest, если он есть в окружении, иначе штатный unittest-дискаверер (как gates.sh).
    $hasPytest = $false
    & $python -c 'import pytest' 2>$null
    if ($LASTEXITCODE -eq 0) { $hasPytest = $true }
    if ($hasPytest) {
        Invoke-Gate -Name 'pytest' -Command $python -Arguments @('-m', 'pytest', '-q', 'tests')
    } else {
        Invoke-Gate -Name 'unittest' -Command $python -Arguments @('-m', 'unittest', 'discover', '-s', 'tests')
    }

    Write-Step 'Unix-only gates (skipped on purpose, with a reason - never silently)'
    Write-Skip 'bats: Unix-only (tests/bats/*.bats are bash, the runner is the bats binary). Linux/macOS: bash scripts/run_bats.sh'
    Write-Skip 'git-hooks: Unix-only (guard-all.sh / git-pre-*.sh / gitleaks-precommit.sh are installed into .git/hooks as sh). On Windows the secret scan is CI (gitleaks.yml)'
    Write-Skip 'docker: Unix-only (docker/entrypoint.sh is POSIX sh INSIDE the image). The docker path itself is portable: scripts/run_in_docker.sh, docs/CROSSPLATFORM.md'
    Write-Skip 'cron/timers: Unix-only (install_cron.sh, map_metric_cron.sh, install_timers.sh, sd-run.sh). On Windows the schedule is Task Scheduler (docs/install-windows.md)'

    Write-Step 'summary'
    if ($failed.Count -eq 0) {
        Write-Host "all portable gates are green (venv: $venv; caches: $cache)"
        Write-Host '[i] Unix-only gates were skipped on purpose - see the [skip] lines above'
        exit 0
    }
    Write-Host "failed: $($failed -join ', ')" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
