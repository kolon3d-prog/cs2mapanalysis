#Requires -Version 7.0
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub
<#
.SYNOPSIS
    update_mcp.ps1 — обновление кауфми ИЗ ГИТА одной командой (Windows/pwsh-двойник update_mcp.sh).

.DESCRIPTION
    Ритуал тот же, что в bash-версии: git pull → pip install (git+github) → переподключение MCP
    → проверка живости сервера. Идемпотентно: нет изменений — ничего не переустанавливает,
    только переподключает (MCP после апгрейда всегда требует reconnect).

    Раскладка venv по ОС: Windows — Scripts/python.exe + Scripts/pip.exe, Linux/macOS — bin/.
    Проверка процесса: на Windows — Win32_Process через CIM, на Linux/macOS — `ps -Ao pid=,command=`
    (в bash-версии это тот же ps; `pgrep -a` там не годится — в BSD он печатает только pid).

    -DryRun показывает план и НИЧЕГО не меняет (проверка ≠ подмена): git pull, pip install,
    disconnect/connect и скан процесса не выполняются.

    Сообщения в консоль — ASCII намеренно: так строку не ломает ни одна консоль.

.EXAMPLE
    pwsh -NoProfile -File scripts/update_mcp.ps1
    pwsh -NoProfile -File scripts/update_mcp.ps1 -DryRun
    $env:CAMOUFOX_VENV = 'D:\venvs\camoufox-research'; pwsh -File scripts/update_mcp.ps1
#>
[CmdletBinding()]
param(
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Нативные команды с ненулевым rc проверяются через $LASTEXITCODE, а не бросают исключение.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Step { param([string] $Text) Write-Host "=== $Text ===" }
function Write-Plan { param([string] $Text) Write-Host "  [dry-run] $Text" -ForegroundColor DarkGray }
function Write-Warn2 { param([string] $Text) Write-Host "  [!] $Text" -ForegroundColor Yellow }

# Ждём событие, а не время (No Blind Waiting): событие — статус в `opencode2 mcp list`.
# Возврат: $true — событие случилось, $false — не дождались за срок.
function Wait-Mcp {
    param([string] $Want, [int] $Seconds = 30)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $row = (& $cli.Source mcp list 2>$null | Select-String -SimpleMatch 'camoufox' | Select-Object -First 1)
        $connected = [bool]($row -and ($row.Line -match '(^|[^a-z])connected'))
        if ($Want -eq 'connected') {
            if ($connected) { return $true }
        } else {
            if (-not $connected) { return $true }
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

$repo = Split-Path -Parent $PSScriptRoot
$venv = $env:CAMOUFOX_VENV
if (-not $venv) { $venv = Join-Path (Join-Path $HOME '.venvs') 'camoufox-research' }
if ($IsWindows) {
    $python = Join-Path (Join-Path $venv 'Scripts') 'python.exe'
    $pip = Join-Path (Join-Path $venv 'Scripts') 'pip.exe'
} else {
    $python = Join-Path (Join-Path $venv 'bin') 'python'
    $pip = Join-Path (Join-Path $venv 'bin') 'pip'
}
$gitUrl = 'https://github.com/aidvizhhub/camoufox-research.git'

try {
    if (-not (Test-Path -LiteralPath $python)) {
        throw "no venv python at $python - install first: pwsh -File scripts/install.ps1"
    }

    Write-Step "1/5: git pull ($repo)"
    Push-Location $repo
    try {
        if ($DryRun) {
            & git fetch -q origin main 2>$null
            $behind = '?'
            if ($LASTEXITCODE -eq 0) { $behind = (& git rev-list --count HEAD..origin/main 2>$null) }
            Write-Plan 'git pull --ff-only origin main'
            Write-Host "  ($behind commits behind origin/main)"
        } else {
            & git pull --ff-only origin main
            if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }
        }
    } finally {
        Pop-Location
    }

    Write-Step '2/5: pip install from git (not editable: the "from git" scheme, 28.08)'
    if ($DryRun) {
        Write-Plan "`"$pip`" install --upgrade git+$gitUrl@main"
    } else {
        & $pip install --upgrade "git+$gitUrl@main"
        if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)" }
    }

    Write-Step '3/5: check the install'
    $probe = 'import camoufox_research.camoufox_research as s; print("tools:", len(s.mcp._tool_manager._tools))'
    if ($DryRun) {
        Write-Plan "`"$python`" -c '$probe'"
        Write-Plan "`"$pip`" show camoufox-research | Select-String '^Version'"
    } else {
        & $python -c $probe
        if ($LASTEXITCODE -ne 0) { throw "import check failed (exit $LASTEXITCODE)" }
        & $pip show camoufox-research 2>$null | Select-String -Pattern '^Version'
    }

    Write-Step '4/5: reconnect MCP (server restart)'
    $cli = Get-Command opencode2 -ErrorAction SilentlyContinue
    if ($DryRun) {
        Write-Plan 'opencode2 api post /api/mcp/camoufox/disconnect + connect'
    } elseif (-not $cli) {
        Write-Warn2 'opencode2 not found - reconnect MCP by hand (Settings -> MCP).'
    } else {
        & $cli.Source api post /api/mcp/camoufox/disconnect 2>$null | Out-Null
        if (-not (Wait-Mcp -Want 'gone' -Seconds 15)) {
            Write-Warn2 'camoufox still connected after disconnect - reconnecting as is'
        }
        & $cli.Source api post /api/mcp/camoufox/connect 2>$null | Out-Null
        if (Wait-Mcp -Want 'connected' -Seconds 60) {
            Write-Host '  camoufox: connected (event, not timer)'
        } else {
            Write-Warn2 'camoufox did not come up in 60s - check: opencode2 mcp list'
        }
        & $cli.Source mcp list 2>$null | Select-Object -First 3
    }

    Write-Step '5/5: check the server (is it alive?)'
    # Порт bash-версии: там `ps -Ao pid=,command= | grep -F 'bin/camoufox-research'`.
    # pgrep -a в BSD/macOS печатает только pid, поэтому ps -Ao одинаков в GNU и BSD;
    # на Windows ps нет — там процесс ищется в Win32_Process по командной строке.
    if ($DryRun) {
        if ($IsWindows) {
            Write-Plan "Get-CimInstance Win32_Process | Where CommandLine -like '*camoufox-research*'"
        } else {
            Write-Plan "ps -Ao pid=,command= | Select-String -SimpleMatch 'bin/camoufox-research'"
        }
    } else {
        $rows = @()
        if ($IsWindows) {
            $rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -like '*camoufox-research*' } |
                    Select-Object -First 2 |
                    ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" })
        } else {
            $rows = @(& ps -Ao pid=,command= 2>$null |
                    Select-String -SimpleMatch 'bin/camoufox-research' |
                    Select-Object -First 2 |
                    ForEach-Object { $_.Line.Trim() })
        }
        if ($rows.Count -gt 0) {
            $rows | ForEach-Object { Write-Host "  $_" }
        } else {
            Write-Warn2 'server is not running - call any tool, it starts automatically'
        }
    }

    Write-Host ''
    if ($DryRun) {
        Write-Host '[i] DRY-RUN: plan only, nothing was changed.'
        Write-Host "    Run it for real: pwsh -File $PSCommandPath"
    } else {
        Write-Host "[OK] $repo updated from git (tools above), MCP reconnected."
        Write-Host '     New tools are available in this session after a call.'
    }
    exit 0
} catch {
    Write-Warning "Error: $_"
    exit 1
}
