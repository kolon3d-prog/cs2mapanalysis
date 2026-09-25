#Requires -Version 5.1
<#
.SYNOPSIS
    Keys console for the MCP station: add, list and remove API keys (any number per provider).

.DESCRIPTION
    Thin wrapper around bin/keys.mjs so the file logic lives in one place. With no arguments it opens
    the interactive menu - that is what the double-click launcher (bin/keys.cmd) calls.
    This file is ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI; the engine prints
    Russian text, so the console is switched to UTF-8 before it runs.

.EXAMPLE
    pwsh -File bin/keys.ps1 list
    pwsh -File bin/keys.ps1 add exa
    pwsh -File bin/keys.ps1 remove exa
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive launcher: colored console output, the engine output goes to the pipeline.')]
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    $root = Split-Path -Parent $PSScriptRoot
    $engine = Join-Path $root 'bin/keys.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no keys engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the keys console needs it' }

    # the engine writes UTF-8: without this the Windows console decodes it in the OEM codepage
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    } catch {
        Write-Verbose "console encoding not switched: $_"
    }

    $forward = @()
    if ($Arguments) { $forward += $Arguments }
    if ($forward.Count -eq 0) { Write-Host '[i] keys: interactive menu (list / add / remove)' }

    & node $engine @forward
    exit $LASTEXITCODE
} catch {
    Write-Warning "Error: $_"
    exit 1
}
