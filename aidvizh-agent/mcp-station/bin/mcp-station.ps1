#Requires -Version 5.1
<#
.SYNOPSIS
    mcp-station on Windows: install MCP servers into omp/pi and opencode configs in one step.

.DESCRIPTION
    Thin wrapper: the engine (bin/station.mjs) is shared with the bash version, so the JSON logic
    lives in one place. The station root is derived from $PSScriptRoot - no absolute paths.
    -WhatIf is forwarded as --dry-run. This file is ASCII on purpose: Windows PowerShell 5.1 reads
    .ps1 as ANSI; the engine prints Russian text, so the console is switched to UTF-8 before it runs.
    With no arguments the station installs the core catalog (servers without keys) - keyed servers
    need --profile keyed (also available by double-clicking bin/mcp-station.cmd).

.EXAMPLE
    pwsh -File bin/mcp-station.ps1                 # install the core catalog
    pwsh -File bin/mcp-station.ps1 list
    pwsh -File bin/mcp-station.ps1 install exa -WhatIf
    pwsh -File bin/mcp-station.ps1 update --prune --yes
    pwsh -File bin/mcp-station.ps1 verify --client omp --timeout 60
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
    $engine = Join-Path $root 'bin/station.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no station engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the station engine and the MCP servers need it' }

    # the engine writes UTF-8: without this the Windows console decodes it in the OEM codepage
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    } catch {
        Write-Verbose "console encoding not switched: $_"
    }

    $forward = @()
    if ($Arguments) { $forward += $Arguments }
    if ($WhatIfPreference) { $forward += '--dry-run' }

    if ($forward.Count -eq 0) {
        Write-Host '[i] mcp-station: installing the whole catalog into every client'
    }

    & node $engine @forward
    exit $LASTEXITCODE
} catch {
    Write-Warning "Error: $_"
    exit 1
}
