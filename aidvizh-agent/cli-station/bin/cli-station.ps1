#Requires -Version 5.1
<#
.SYNOPSIS
    cli-station on Windows: install omp, pi and opencode (opencode2) in one step.

.DESCRIPTION
    Thin wrapper around bin/cli-station.mjs - the engine is shared with the bash version, so the
    method table lives in one place. The station root comes from $PSScriptRoot: no absolute paths.
    -WhatIf is forwarded as --dry-run. Messages are ASCII: Windows PowerShell 5.1 reads .ps1 as ANSI.
    With no arguments the station installs everything from the catalog.

.EXAMPLE
    pwsh -File bin/cli-station.ps1
    pwsh -File bin/cli-station.ps1 status
    pwsh -File bin/cli-station.ps1 install opencode --channel latest -WhatIf
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
    $engine = Join-Path $root 'bin/cli-station.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no station engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the station engine needs it' }

    $forward = @()
    if ($Arguments) { $forward += $Arguments }
    if ($WhatIfPreference) { $forward += '--dry-run' }

    if ($forward.Count -eq 0) { Write-Host '[i] cli-station: installing the whole catalog' }

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
