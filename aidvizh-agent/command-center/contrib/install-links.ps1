#Requires -Version 5.1
<#
.SYNOPSIS
    command-center links: the `center` command in PATH.

.DESCRIPTION
    The docs say `center status`, but nothing used to put that command anywhere - on a fresh
    machine the first `center prereqs` failed with "command not found". This writes the link.
    On Windows a bare link to a .sh is not executable, so the shim is center.cmd in the same
    directory; on Unix the twin contrib/install-links.sh makes a symlink to bin/center.sh.
    Both write the same one entry point, so running either installer changes nothing after the
    first. Idempotent: a second run reports "already" and touches nothing.
    Messages are ASCII because Windows PowerShell 5.1 reads .ps1 as ANSI.

.EXAMPLE
    pwsh -File contrib/install-links.ps1
    pwsh -File contrib/install-links.ps1 -DryRun
    pwsh -File contrib/install-links.ps1 status
    pwsh -File contrib/install-links.ps1 -AgentHome D:\tmp\home
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: the script returns no pipeline data.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'status')]
    [string] $Command = 'install',

    [string] $AgentHome = $HOME,

    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dry = $DryRun -or $WhatIfPreference
$Center = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Center) { $Center = Split-Path -Parent $PSScriptRoot }

function Emit { param([string] $Text) [Console]::Out.WriteLine($Text) }

$entry = Join-Path $Center 'bin/center.cmd'
$binDir = Join-Path $AgentHome '.local/bin'
$link = Join-Path $binDir 'center.cmd'

if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    [Console]::Error.WriteLine("no entry point: $entry - the center cannot run from this disk")
    exit 2
}

if ($Command -eq 'status') {
    if (Test-Path -LiteralPath $link) { Emit "present: $link" }
    else { Emit "missing: $link (run: pwsh -File contrib/install-links.ps1)"; exit 1 }
    exit 0
}

if (Test-Path -LiteralPath $link) {
    Emit "already: $link"
    exit 0
}

if ($dry) {
    Emit "[+] would create $link -> $entry"
    exit 0
}

New-Item -ItemType Directory -Path $binDir -Force | Out-Null
# a copy, not a link: symlinking needs privileges or Developer Mode, and a .cmd shim works either way
Copy-Item -LiteralPath $entry -Destination $link -Force
Emit "[OK] shim    $link -> $entry (a copy: link rights are not required)"
Emit "done. check: center.cmd version"
