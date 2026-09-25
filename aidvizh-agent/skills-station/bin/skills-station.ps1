#Requires -Version 5.1
<#
.SYNOPSIS
    skills-station on Windows: put skills from the collection into a layer (global, project, own path).

.DESCRIPTION
    Thin wrapper around bin/skills-station.mjs - one engine for every OS. Paths are derived from the
    user profile and the current directory: the station never stores absolute disk paths. -WhatIf is
    forwarded as --dry-run; messages are ASCII because Windows PowerShell 5.1 reads .ps1 as ANSI.

.EXAMPLE
    pwsh -File bin/skills-station.ps1 list
    pwsh -File bin/skills-station.ps1 install firecrawl tavily --layer project
    pwsh -File bin/skills-station.ps1 install all --dir D:\work\.agents\skills -WhatIf
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive launcher: colored console output, the engine output goes to the pipeline.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    $root = Split-Path -Parent $PSScriptRoot
    $engine = Join-Path $root 'bin/skills-station.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no station engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the station engine needs it' }

    $forward = @()
    if ($Arguments) { $forward += $Arguments }
    if ($WhatIfPreference) { $forward += '--dry-run' }
    if ($forward.Count -eq 0) { $forward += 'list' }

    # the engine writes UTF-8: without this the Windows console decodes it in the OEM codepage
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    } catch {
        Write-Verbose "console encoding not switched: $_"
    }

    & node $engine @forward
    exit $LASTEXITCODE
} catch {
    Write-Warning "Error: $_"
    exit 1
}
