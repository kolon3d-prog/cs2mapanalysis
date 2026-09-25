#Requires -Version 5.1
<#
.SYNOPSIS
    prompt-station on Windows: flash a persona into omp, pi and opencode.

.DESCRIPTION
    Thin wrapper around bin/prompt-station.mjs - one engine for every OS, so the target table
    (oMP/pi APPEND_SYSTEM.md, opencode AGENTS.md) lives in one place. The station root comes from
    $PSScriptRoot: no absolute paths anywhere. -WhatIf is forwarded as --dry-run, and the messages
    are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.

.EXAMPLE
    pwsh -File bin/prompt-station.ps1 list
    pwsh -File bin/prompt-station.ps1 flash duck
    pwsh -File bin/prompt-station.ps1 status -WhatIf
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
    $engine = Join-Path $root 'bin/prompt-station.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no station engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the station engine needs it' }

    $forward = @()
    if ($Arguments) { $forward += $Arguments }
    if ($WhatIfPreference) { $forward += '--dry-run' }
    if ($forward.Count -eq 0) { $forward += 'status' }

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
