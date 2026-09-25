#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    skills-hub links: the skills-manager command and the skills-ops skill.

.DESCRIPTION
    PowerShell twin of contrib/install-links.sh: the same two links, the same idempotence - plus
    status and remove. Windows cannot always create a symlink, so a directory falls back to a
    junction and a file to a copy; every fallback is reported, never hidden. The target is verified,
    not assumed: a link that points elsewhere, a broken link and a foreign file are told apart.
    The link targets are exactly the ones the bash installer creates, so both installers agree and
    re-running either one changes nothing.
    Output is ASCII on purpose: Windows PowerShell mangles non-ASCII .ps1 sources.

.EXAMPLE
    pwsh -File contrib/install-links.ps1
    pwsh -File contrib/install-links.ps1 status
    pwsh -File contrib/install-links.ps1 -DryRun
    pwsh -File contrib/install-links.ps1 remove
    pwsh -File contrib/install-links.ps1 status -AgentHome D:\tmp\home
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'status', 'remove')]
    [string] $Command = 'install',

    [string] $AgentHome = $HOME,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Rest,

    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Hub = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Hub) { $Hub = Split-Path -Parent $PSScriptRoot }

$dry = $DryRun -or $WhatIfPreference
$extra = @()
if ($Rest) { $extra = @($Rest) }
foreach ($argument in $extra) {
    switch ($argument) {
        'install' { $Command = 'install' }
        'status' { $Command = 'status' }
        'remove' { $Command = 'remove' }
        '--dry-run' { $dry = $true }
        default {
            [Console]::Error.WriteLine("install-links: unknown argument: $argument (install|status|remove|--dry-run)")
            exit 1
        }
    }
}

function Emit {
    param([string] $Text)
    [Console]::Out.WriteLine($Text)
}

function Write-Err {
    param([string] $Text)
    [Console]::Error.WriteLine($Text)
}

function Get-TargetText {
    param([string] $Path)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        $target = $item.Target
        if ($target -is [array]) { $target = $target[0] }
        if ($target) { return [string]$target }
    } catch { }
    return ''
}

function Get-FullPath {
    param([string] $Path)
    try { return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path.TrimEnd('\', '/') }
    catch { return $Path.TrimEnd('\', '/') }
}

# States: ok (link to the target), copy (verified copy, the documented fallback), missing, wrong
# (link to something else), broken (link whose target is gone), occupied (a real file/directory).
function Get-LinkState {
    param([string] $Path, [string] $Target)
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ State = 'missing'; Detail = "expected -> $Target" }
    }
    $item = Get-Item -LiteralPath $Path -Force
    $link = Get-TargetText $Path
    if ($link) {
        $resolved = $link
        if (-not [System.IO.Path]::IsPathRooted($resolved)) { $resolved = Join-Path (Split-Path -Parent $Path) $resolved }
        if (-not (Test-Path -LiteralPath $resolved)) { return [pscustomobject]@{ State = 'broken'; Detail = "-> $link (target is gone)" } }
        if ((Get-FullPath $resolved) -eq (Get-FullPath $Target)) { return [pscustomobject]@{ State = 'ok'; Detail = "-> $link" } }
        return [pscustomobject]@{ State = 'wrong'; Detail = "-> $link (expected $Target)" }
    }
    if ($item.PSIsContainer) {
        $probe = Join-Path $Path 'skills-manager.sh'
        $source = Join-Path $Target 'skills-manager.sh'
        if ((Test-Path -LiteralPath $probe -PathType Leaf) -and (Test-Path -LiteralPath $source -PathType Leaf) -and
            ((Get-FileHash -LiteralPath $probe).Hash -eq (Get-FileHash -LiteralPath $source).Hash)) {
            return [pscustomobject]@{ State = 'copy'; Detail = '-> a copy of the hub' }
        }
        return [pscustomobject]@{ State = 'occupied'; Detail = 'a real directory, not a link' }
    }
    if ((Test-Path -LiteralPath $Target -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $Path).Hash -eq (Get-FileHash -LiteralPath $Target).Hash)) {
        return [pscustomobject]@{ State = 'copy'; Detail = '-> a copy of the script' }
    }
    return [pscustomobject]@{ State = 'occupied'; Detail = 'a real file, not a link' }
}

function Copy-HubTree {
    param([string] $From, [string] $To)
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $From -Force | Where-Object { $_.Name -ne '.git' })) {
        Copy-Item -LiteralPath $item.FullName -Destination $To -Recurse -Force
    }
}

function New-HubLink {
    param([string] $Path, [string] $Target)
    if ($dry) {
        Emit "[+] would create $Path -> $Target"
        return
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    try {
        New-Item -ItemType SymbolicLink -Path $Path -Value $Target -ErrorAction Stop | Out-Null
        Emit "[OK] symlink  $Path -> $Target"
        return
    } catch { }
    $isDirectory = (Get-Item -LiteralPath $Target -Force).PSIsContainer
    if ($isDirectory) {
        try {
            New-Item -ItemType Junction -Path $Path -Value $Target -ErrorAction Stop | Out-Null
            Emit "[OK] junction $Path -> $Target (a symlink needs privileges or Developer Mode)"
            return
        } catch { }
        Copy-HubTree -From $Target -To $Path
    } else {
        Copy-Item -LiteralPath $Target -Destination $Path -Force
    }
    Emit "[!] copy     $Path (no link rights here: this is a copy, re-run after the hub moves)"
}

function Remove-HubLink {
    param([string] $Path)
    if ($dry) {
        Emit "[+] would remove $Path"
        return
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
    Emit "[OK] removed $Path"
}

function Invoke-Status {
    $problems = 0
    Emit "skills-hub links (hub: $Hub)"
    foreach ($link in $Links) {
        $state = Get-LinkState -Path $link.Path -Target $link.Target
        switch ($state.State) {
            'ok' { Emit "[OK] ok       $($link.Path) $($state.Detail)" }
            'copy' { Emit "[!] copy     $($link.Path) $($state.Detail)" }
            'missing' {
                Emit "[X]  missing  $($link.Path) ($($state.Detail))"
                $problems++
            }
            'wrong' {
                Emit "[X]  wrong    $($link.Path) $($state.Detail)"
                $problems++
            }
            'broken' {
                Emit "[X]  broken   $($link.Path) $($state.Detail)"
                $problems++
            }
            default {
                Emit "[X]  occupied $($link.Path) - $($state.Detail)"
                $problems++
            }
        }
    }
    Emit ''
    if ($problems -gt 0) {
        Emit "links: $problems to fix (run: pwsh -File contrib/install-links.ps1)"
        return 1
    }
    Emit 'links: ok'
    return 0
}

function Invoke-Install {
    $problems = 0
    Emit "skills-hub links (hub: $Hub)"
    foreach ($link in $Links) {
        $state = Get-LinkState -Path $link.Path -Target $link.Target
        switch ($state.State) {
            'ok' { Emit "[OK] already points here: $($link.Path)" }
            'copy' { Emit "[!] copy in place: $($link.Path) (a copy, not a link)" }
            'missing' { New-HubLink -Path $link.Path -Target $link.Target }
            'wrong' {
                if ($dry) { Emit "[+] would re-create $($link.Path) ($($state.Detail))" }
                else {
                    Remove-HubLink -Path $link.Path
                    New-HubLink -Path $link.Path -Target $link.Target
                }
            }
            'broken' {
                if ($dry) { Emit "[+] would re-create $($link.Path) ($($state.Detail))" }
                else {
                    Remove-HubLink -Path $link.Path
                    New-HubLink -Path $link.Path -Target $link.Target
                }
            }
            default {
                Write-Err "[!] occupied: $($link.Path) - $($state.Detail), not touching"
                $problems++
            }
        }
    }
    Emit ''
    if ($problems -gt 0) {
        Emit "links: $problems left alone"
        return 1
    }
    if ($dry) {
        Emit '(dry run: nothing was created)'
        return 0
    }
    Emit "done. check: pwsh -File $Hub/skills-manager.ps1 sources"
    if ($IsWindows) {
        Emit "[!] on Windows the bare link is a POSIX file: windows/install.ps1 writes the .cmd shim, or run pwsh -File skills-manager.ps1"
    }
    return 0
}

function Invoke-Remove {
    $problems = 0
    Emit "skills-hub links (hub: $Hub)"
    foreach ($link in $Links) {
        $state = Get-LinkState -Path $link.Path -Target $link.Target
        switch ($state.State) {
            'missing' { Emit "[OK] nothing to remove: $($link.Path)" }
            'ok' { Remove-HubLink -Path $link.Path }
            'copy' { Remove-HubLink -Path $link.Path }
            'broken' { Remove-HubLink -Path $link.Path }
            default {
                Write-Err "[!] not ours, not touching: $($link.Path) - $($state.Detail)"
                $problems++
            }
        }
    }
    Emit ''
    if ($problems -gt 0) {
        Emit "links: $problems left alone"
        return 1
    }
    Emit 'links: removed'
    return 0
}

# The same two links the bash installer creates: a command in ~/.local/bin and the skill for the agent.
$Links = @(
    [pscustomobject]@{
        Path   = Join-Path $AgentHome '.local/bin/skills-manager'
        Target = Join-Path $Hub 'skills-manager.sh'
    },
    [pscustomobject]@{
        Path   = Join-Path $AgentHome '.agents/skills/skills-ops'
        Target = $Hub
    }
)

$code = switch ($Command) {
    'status' { Invoke-Status }
    'remove' { Invoke-Remove }
    default { Invoke-Install }
}
exit $code
