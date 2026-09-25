#Requires -Version 5.1
<#
.SYNOPSIS
    sentinel on Windows: is the set directory present and are the $HOME links alive.

.DESCRIPTION
    Thin wrapper: the engine (bin/sentinel.mjs) is shared with the bash version, so the verdict and
    the lines are the same on every OS. The set root and the registry come from $PSScriptRoot -
    no absolute paths anywhere. The engine prints Russian text; the console is switched to UTF-8 so
    it does not turn into mojibake (this file itself stays ASCII: Windows PowerShell 5.1 reads .ps1
    as ANSI).

    On Windows there are no mount points: the engine answers about the path existing, and says so.

.EXAMPLE
    pwsh -File bin/sentinel.ps1
    pwsh -File bin/sentinel.ps1 --quiet
    pwsh -File bin/sentinel.ps1 --json
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
    $engine = Join-Path $root 'bin/sentinel.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no sentinel engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the sentinel engine needs it' }

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
