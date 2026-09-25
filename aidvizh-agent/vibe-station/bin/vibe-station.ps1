# vibe-station (PowerShell): ставит server plugin и TUI footer для /vibe в opencode2 ссылками в каталог плагинов.
#
#   pwsh -File bin/vibe-station.ps1 install
#   pwsh -File bin/vibe-station.ps1 status
#   pwsh -File bin/vibe-station.ps1 remove
#
# Конфиг OpenCode2: $env:XDG_CONFIG_HOME/opencode, иначе ~/.config/opencode.
# $env:VIBE_CONFIG_DIR допускается только для изолированных тестов с VIBE_ALLOW_UNSCANNED_CONFIG=1.
# Симлинк требует прав; без прав установщик отказывается, чтобы не оставить неуправляемую копию.
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'status', 'remove')]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Source = Join-Path $Here 'plugin/opencode/vibe.ts'
$TuiSource = Join-Path $Here 'plugin/opencode-tui'
if ($env:VIBE_CONFIG_DIR) {
    if ($env:VIBE_ALLOW_UNSCANNED_CONFIG -ne '1') {
        throw 'VIBE_CONFIG_DIR не читается OpenCode2; используй XDG_CONFIG_HOME/opencode (для изолированных тестов: VIBE_ALLOW_UNSCANNED_CONFIG=1)'
    }
    $ConfigDir = $env:VIBE_CONFIG_DIR
} elseif ($env:XDG_CONFIG_HOME) {
    $ConfigDir = Join-Path $env:XDG_CONFIG_HOME 'opencode'
} else {
    $ConfigDir = Join-Path $HOME '.config/opencode'
}
$PluginsDir = Join-Path $ConfigDir 'plugins'
$Link = Join-Path $PluginsDir 'vibe-station.ts'
$TuiLink = Join-Path $PluginsDir 'vibe-station-tui'
# Агенты режима — нативные файлы конфига opencode2 (каталог agent/ сканируется клиентом):
# в них mode, hidden, permissions и системный промпт. Плагин только проверяет, что они стоят.
$AgentDir = Join-Path $ConfigDir 'agent'
$Agents = @('vibe-director', 'vibe-fast', 'vibe-good', 'vibe-audit-fast', 'vibe-audit-good')
# Скилл режима — в общий слой скиллов (как spec-mode у spec-station): его читают все три клиента.
$SkillSource = Join-Path $Here 'skill'
$SkillName = 'vibe-mode'
# Канонический слой плюс зеркала клиентов: opencode2 (и остальные) сканируют свой слой отдельно.
$DefaultSkillsDir = if ($env:VIBE_SKILLS_DIR) { $env:VIBE_SKILLS_DIR } else { Join-Path $HOME '.agents/skills' }
$SkillLayers = @(
    $DefaultSkillsDir,
    (Join-Path $ConfigDir 'skills'),
    (Join-Path $HOME '.claude/skills'),
    (Join-Path $HOME '.omp/agent/skills'),
    (Join-Path $HOME '.pi/agent/skills')
)

function Preserve-Foreign {
    param([string]$Path, [string]$SourcePath, [string]$Kind)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path
    $owned = $false
    if ($item.LinkType) {
        $target = @($item.Target) | Select-Object -First 1
        if ($target) {
            if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $Path) $target }
            $owned = [IO.Path]::GetFullPath($target) -eq [IO.Path]::GetFullPath($SourcePath)
        }
    }
    if ($owned) { return }
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    Move-Item -LiteralPath $Path -Destination "$Path.bak-$stamp"
    Write-Host "чужой $Kind отложен: $Path.bak-$stamp"
}

function Install-One {
    param([string]$Src, [string]$Dst, [string]$Label)
    if (-not (Test-Path -LiteralPath $Src)) { throw "нет файла: $Src" }
    Preserve-Foreign -Path $Dst -SourcePath $Src -Kind "файл"
    Remove-Item -LiteralPath $Dst -Force -ErrorAction SilentlyContinue
    try {
        New-Item -ItemType SymbolicLink -Path $Dst -Target $Src | Out-Null
        Write-Host "${Label}: $Dst -> $Src"
    } catch {
        throw "не удалось создать ссылку на $Label; включи symlink support или установи с правами администратора"
    }
}

function Install-Directory {
    param([string]$Src, [string]$Dst, [string]$Label)
    if (-not (Test-Path -LiteralPath $Src -PathType Container)) { throw "нет каталога: $Src" }
    Preserve-Foreign -Path $Dst -SourcePath $Src -Kind "каталог"
    Remove-Item -LiteralPath $Dst -Recurse -Force -ErrorAction SilentlyContinue
    try {
        New-Item -ItemType SymbolicLink -Path $Dst -Target $Src | Out-Null
        Write-Host "${Label}: $Dst -> $Src"
    } catch {
        throw "не удалось создать ссылку на $Label; включи symlink support или установи с правами администратора"
    }
}

function Show-Install {
    if (-not (Test-Path -LiteralPath $Source)) { throw "нет плагина: $Source" }
    if (-not (Test-Path -LiteralPath $TuiSource -PathType Container)) { throw "нет TUI-плагина: $TuiSource" }
    New-Item -ItemType Directory -Force -Path $PluginsDir, $AgentDir | Out-Null
    Install-Directory -Src $TuiSource -Dst $TuiLink -Label "TUI"
    foreach ($name in $Agents) {
        Install-One -Src (Join-Path $Here "agent/$name.md") -Dst (Join-Path $AgentDir "$name.md") -Label "агент $name"
    }
    foreach ($layer in $SkillLayers) {
        $parent = Split-Path -Parent $layer
        if (-not (Test-Path -LiteralPath $parent)) {
            Write-Host "скилл:  слой $layer пропущен (клиента нет)"
            continue
        }
        New-Item -ItemType Directory -Force -Path $layer | Out-Null
        $skillLink = Join-Path $layer $SkillName
        Preserve-Foreign -Path $skillLink -SourcePath $SkillSource -Kind "каталог"
        Remove-Item -LiteralPath $skillLink -Force -ErrorAction SilentlyContinue
        try {
            New-Item -ItemType SymbolicLink -Path $skillLink -Target $SkillSource | Out-Null
            Write-Host "скилл ${SkillName}: $skillLink -> $SkillSource"
        } catch {
            throw "не удалось создать ссылку на скилл ${SkillName}; включи symlink support или установи с правами администратора"
        }
    }
    Preserve-Foreign -Path $Link -SourcePath $Source -Kind "файл"
    Remove-Item -LiteralPath $Link -Force -ErrorAction SilentlyContinue
    try {
        New-Item -ItemType SymbolicLink -Path $Link -Target $Source | Out-Null
        Write-Host "готово: $Link -> $Source"
    } catch {
        try {
            New-Item -ItemType HardLink -Path $Link -Target $Source | Out-Null
            Write-Host "готово: $Link = $Source (жёсткая ссылка)"
        } catch {
            throw "не удалось создать ссылку на server plugin; включи symlink support или установи с правами администратора"
        }
    }
    Write-Host "новые сессии opencode2 подхватят плагин сразу; если нет — opencode2 service restart"
}

function Show-Status {
    foreach ($layer in $SkillLayers) {
        $link = Join-Path $layer $SkillName
        $state = if (Test-Path -LiteralPath (Join-Path $link 'SKILL.md')) { "стоит" } else { "не стоит (install)" }
        Write-Host "скилл $SkillName`: $link — $state"
    }
    foreach ($name in $Agents) {
        $src = Join-Path $Here "agent/$name.md"
        $dst = Join-Path $AgentDir "$name.md"
        $state = if (Test-Path -LiteralPath $dst) { "стоит" } else { "не стоит (install)" }
        Write-Host "агент ${name}: $dst — $state"
    }
    Write-Host "плагин: $Source"
    Write-Host ("  на диске: {0}" -f ($(if (Test-Path -LiteralPath $Source) { "$((Get-Item -LiteralPath $Source).Length) байт" } else { 'НЕТ' })))
    Write-Host "ссылка: $Link"
    if (Test-Path -LiteralPath $Link) {
        $item = Get-Item -LiteralPath $Link
        if ($item.LinkType) {
            $target = @($item.Target) | Select-Object -First 1
            if ($target -and ([IO.Path]::GetFullPath($target) -eq [IO.Path]::GetFullPath($Source))) {
                Write-Host "  состояние: стоит, указывает на плагин"
            } else {
                Write-Host "  состояние: ссылка на другое место — $target"
            }
        } else {
            Write-Host "  состояние: не ссылка; copy fallback отключён, снеси вручную"
        }
    } else {
        Write-Host "  состояние: не стоит (install)"
    }
    Write-Host "TUI: $TuiLink"
    if (Test-Path -LiteralPath $TuiLink) {
        $item = Get-Item -LiteralPath $TuiLink
        if ($item.LinkType) {
            $target = @($item.Target) | Select-Object -First 1
            if ($target -and ([IO.Path]::GetFullPath($target) -eq [IO.Path]::GetFullPath($TuiSource))) {
                Write-Host "  состояние: стоит, указывает на TUI"
            } else {
                Write-Host "  состояние: ссылка на другое место — $target"
            }
        } else {
            Write-Host "  состояние: не ссылка; copy fallback отключён, снеси вручную"
        }
    } else {
        Write-Host "  состояние: не стоит (install)"
    }
}

function Remove-Link {
    param([string]$Path, [string]$SourcePath)
    if (-not (Test-Path -LiteralPath $Path)) { Write-Host "нечего снимать: $Path нет"; return }
    $item = Get-Item -LiteralPath $Path
    if ($item.LinkType) {
        $target = @($item.Target) | Select-Object -First 1
        if (-not $target -or ([IO.Path]::GetFullPath($target) -eq [IO.Path]::GetFullPath($SourcePath))) {
            Remove-Item -LiteralPath $Path -Force -Recurse
            Write-Host "снято: $Path"
            return
        }
        throw "ссылка ведёт не в станцию ($target) — не трогаю"
    }
    throw "$Path — не ссылка станции; copy fallback отключён, снеси вручную только после проверки"
}

function Show-Remove {
    Remove-Link -Path $Link -SourcePath $Source
    Remove-Link -Path $TuiLink -SourcePath $TuiSource
    foreach ($name in $Agents) {
        Remove-Link -Path (Join-Path $AgentDir "$name.md") -SourcePath (Join-Path $Here "agent/$name.md")
    }
    foreach ($layer in $SkillLayers) {
        $skillPath = Join-Path $layer $SkillName
        Remove-Link -Path $skillPath -SourcePath $SkillSource
    }
}

switch ($Command) {
    'install' { Show-Install }
    'status' { Show-Status }
    'remove' { Show-Remove }
}
