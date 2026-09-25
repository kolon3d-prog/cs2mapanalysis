# modes-station (PowerShell): ставит плагин /goal и /loop в opencode2 ссылкой в каталог плагинов.
#
#   pwsh -File bin/modes-station.ps1 install
#   pwsh -File bin/modes-station.ps1 status
#   pwsh -File bin/modes-station.ps1 remove
#
# Конфиг: $env:MODES_CONFIG_DIR, иначе $env:XDG_CONFIG_HOME/opencode, иначе ~/.config/opencode.
# Симлинк требует прав; без прав — жёсткая ссылка, в крайнем случае копия (с предупреждением).
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'status', 'remove')]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Source = Join-Path $Here 'plugin/opencode/modes.ts'
$ConfigDir = if ($env:MODES_CONFIG_DIR) {
    $env:MODES_CONFIG_DIR
} elseif ($env:XDG_CONFIG_HOME) {
    Join-Path $env:XDG_CONFIG_HOME 'opencode'
} else {
    Join-Path $HOME '.config/opencode'
}
$PluginsDir = Join-Path $ConfigDir 'plugins'
$Link = Join-Path $PluginsDir 'modes-station.ts'

function Show-Install {
    if (-not (Test-Path -LiteralPath $Source)) { throw "нет плагина: $Source" }
    New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
    if ((Test-Path -LiteralPath $Link) -and -not (Get-Item -LiteralPath $Link).LinkType) {
        $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        Move-Item -LiteralPath $Link -Destination "$Link.bak-$stamp"
        Write-Host "чужой файл отложен: $Link.bak-$stamp"
    }
    Remove-Item -LiteralPath $Link -Force -ErrorAction SilentlyContinue
    try {
        New-Item -ItemType SymbolicLink -Path $Link -Target $Source | Out-Null
        Write-Host "готово: $Link -> $Source"
    } catch {
        try {
            New-Item -ItemType HardLink -Path $Link -Target $Source | Out-Null
            Write-Host "готово: $Link = $Source (жёсткая ссылка)"
        } catch {
            Copy-Item -LiteralPath $Source -Destination $Link -Force
            Write-Host "ВНИМАНИЕ: поставлена копия, правки станции не подхватятся. Ссылку можно поставить с правами администратора."
        }
    }
    Write-Host "новые сессии opencode2 подхватят плагин сразу; если нет — opencode2 service restart"
}

function Show-Status {
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
            Write-Host "  состояние: файл (не ссылка) — станция его не ставила"
        }
    } else {
        Write-Host "  состояние: не стоит (install)"
    }
}

function Show-Remove {
    if (-not (Test-Path -LiteralPath $Link)) { Write-Host "нечего снимать: ссылки нет"; return }
    $item = Get-Item -LiteralPath $Link
    if ($item.LinkType) {
        $target = @($item.Target) | Select-Object -First 1
        if (-not $target -or ([IO.Path]::GetFullPath($target) -eq [IO.Path]::GetFullPath($Source))) {
            Remove-Item -LiteralPath $Link -Force
            Write-Host "снято: $Link"
            return
        }
        throw "ссылка ведёт не в станцию ($target) — не трогаю"
    }
    throw "$Link — файл, не ссылка станции; снеси вручную, если это точно он"
}

switch ($Command) {
    'install' { Show-Install }
    'status' { Show-Status }
    'remove' { Show-Remove }
}
