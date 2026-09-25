#Requires -Version 5.1
<#
.SYNOPSIS
    cleanup-station on Windows: remove agents, skills, prompts, extensions and MCP registrations.

.DESCRIPTION
    Thin wrapper around bin/cleanup.mjs - one engine for every OS. Everything is limited to the home
    directory, only known files and links are touched, and clean-all without -Yes is a dry run.
    -WhatIf is forwarded as --dry-run; messages are ASCII (Windows PowerShell 5.1 reads .ps1 as ANSI).

.EXAMPLE
    pwsh -File bin/cleanup.ps1 plan
    pwsh -File bin/cleanup.ps1 clean-skills --layer all -WhatIf
    pwsh -File bin/cleanup.ps1 clean-all -Yes
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
    $engine = Join-Path $root 'bin/cleanup.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no cleanup engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the cleanup engine needs it' }

    $forward = @()
    if ($Arguments) { $forward += $Arguments }
    if ($WhatIfPreference) { $forward += '--dry-run' }
    if ($forward.Count -eq 0) { $forward += 'plan' }

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
