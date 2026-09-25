#Requires -Version 5.1
<#
.SYNOPSIS
    command-center on Windows: status, doctor, verify, links, run, activate, bootstrap, check.

.DESCRIPTION
    Thin wrapper around bin/center.mjs - one engine for every OS. The registry keeps relative paths
    only, so nothing breaks when the disk moves. -WhatIf is forwarded as --dry-run; messages are
    ASCII because Windows PowerShell 5.1 reads .ps1 as ANSI.

.EXAMPLE
    pwsh -File bin/center.ps1 status
    pwsh -File bin/center.ps1 doctor
    pwsh -File bin/center.ps1 verify --timeout 30
    pwsh -File bin/center.ps1 activate -WhatIf
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
    $engine = Join-Path $root 'bin/center.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no center engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the center engine needs it' }

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
