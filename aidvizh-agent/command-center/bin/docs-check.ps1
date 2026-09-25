#Requires -Version 5.1
<#
.SYNOPSIS
    docs-check on Windows: numbers, lists and commands in README/docs checked against fact.

.DESCRIPTION
    Thin wrapper: the engine (bin/docs-check.mjs) is shared with the bash version, so the verdict on
    bash and on PowerShell is the same one - facts, line formats and --json live in one place.
    The station root comes from $PSScriptRoot - no absolute paths anywhere.
    The engine prints Russian text; the console is switched to UTF-8 so it does not turn into mojibake
    (this file itself stays ASCII: Windows PowerShell 5.1 reads .ps1 as ANSI).

    DOCS_CHECK_ROOT - check another tree (test suites drop in a mini disk).

.EXAMPLE
    pwsh -File bin/docs-check.ps1
    pwsh -File bin/docs-check.ps1 --quiet
    pwsh -File bin/docs-check.ps1 --json
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    $root = Split-Path -Parent $PSScriptRoot
    $engine = Join-Path $root 'bin/docs-check.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no docs-check engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the docs gate counts facts with it, like every station engine' }

    # the engine writes UTF-8: without this the Windows console decodes it in the OEM codepage
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    } catch {
        Write-Verbose "console encoding not switched: $_"
    }

    if (-not $Arguments) { $Arguments = @() }
    & node $engine @Arguments
    exit $LASTEXITCODE
} catch {
    Write-Warning "Error: $_"
    exit 1
}
