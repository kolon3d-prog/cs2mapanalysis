#Requires -Version 5.1
<#
.SYNOPSIS
    Install the omp-zen-free extension for omp and/or pi on Windows.

.DESCRIPTION
    Puts zen-free-tier-headers.ts into the harness extensions directory so it loads at session start.
    Tries a symbolic link, then a hard link, then a copy (with a warning). Honors
    $env:PI_CODING_AGENT_DIR, otherwise uses $AgentHome\.omp\agent and $AgentHome\.pi\agent.
    Idempotent, supports -WhatIf. Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1
    as ANSI and mangles non-ASCII.

.EXAMPLE
    pwsh -File install.ps1
    pwsh -File install.ps1 -Target omp
    pwsh -File install.ps1 -WhatIf
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output, the script returns no pipeline data.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $Project = $PSScriptRoot,
    [string] $AgentHome = $HOME,
    [ValidateSet('all', 'omp', 'pi')]
    [string] $Target = 'all'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Ok { param([string] $Text) Write-Host "   [ok] $Text" -ForegroundColor DarkGray }
function Write-Note { param([string] $Text) Write-Host "   [!] $Text" -ForegroundColor Yellow }

function New-Link {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string] $Source,
        [string] $Destination
    )
    if (-not (Test-Path -LiteralPath $Source)) { throw "no such source: $Source" }

    $extDir = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $extDir)) {
        if ($PSCmdlet.ShouldProcess($extDir, 'create directory')) {
            New-Item -ItemType Directory -Path $extDir -Force | Out-Null
            Write-Ok "$extDir (created)"
        }
    }

    $existing = Get-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    if ($existing) {
        $current = $existing.Target
        if ($current -is [array]) { $current = $current[0] }
        if ($current -and ($current -eq $Source)) {
            Write-Ok "already in place: $Destination"
            return
        }
        if ($existing.LinkType -eq 'HardLink') {
            Write-Ok "already in place (hardlink): $Destination"
            return
        }
        if (-not $PSCmdlet.ShouldProcess($Destination, 'replace with a link')) { return }
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }

    if (-not $PSCmdlet.ShouldProcess($Destination, "link to $Source")) { return }
    try {
        New-Item -ItemType SymbolicLink -Path $Destination -Value $Source -ErrorAction Stop | Out-Null
        Write-Ok "symlink -> $Destination"
    } catch {
        try {
            New-Item -ItemType HardLink -Path $Destination -Value $Source -ErrorAction Stop | Out-Null
            Write-Ok "hardlink -> $Destination"
        } catch {
            Copy-Item -LiteralPath $Source -Destination $Destination -Force
            Write-Note "copied (symlink and hardlink both failed): $Destination - project edits will not reach the client, re-run after updates"
        }
    }
}

try {
    $headers = Join-Path $Project 'zen-free-tier-headers.ts'
    $keys = Join-Path $Project 'keys.ts'
    if (-not (Test-Path -LiteralPath $headers)) { throw "no zen-free-tier-headers.ts in $Project" }
    if (-not (Test-Path -LiteralPath $keys)) { throw "no keys.ts in $Project" }

    if ($env:PI_CODING_AGENT_DIR) {
        $ompDir = $env:PI_CODING_AGENT_DIR
        $piDir = $env:PI_CODING_AGENT_DIR
    } else {
        $ompDir = Join-Path $AgentHome '.omp\agent'
        $piDir = Join-Path $AgentHome '.pi\agent'
    }
    $ompExt = Join-Path $ompDir 'extensions'
    $piExt = Join-Path $piDir 'extensions'

    if ($Target -eq 'all' -or $Target -eq 'omp') {
        New-Link -Source $headers -Destination (Join-Path $ompExt 'zen-free-tier-headers.ts')
        New-Link -Source $keys -Destination (Join-Path $ompExt 'keys.ts')
    }
    if ($Target -eq 'all' -or $Target -eq 'pi') {
        New-Link -Source $headers -Destination (Join-Path $piExt 'zen-free-tier-headers.ts')
    }

    Write-Host ''
    Write-Host '[ok] done: extensions are read when an omp/pi session starts'
    exit 0
} catch {
    Write-Warning "Error: $_"
    exit 1
}
