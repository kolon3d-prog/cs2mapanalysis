#Requires -Version 5.1
<#
.SYNOPSIS
    junk-report-station on Windows: report junk on the data disk (read-only, removes nothing).
.DESCRIPTION
    Thin wrapper around bin/junk-report.mjs - one engine for every OS (node stdlib only).
    Finds regenerable caches, dump directories, loose artifacts in the disk root.
    --strict turns findings into a non-zero exit code (cron/CI). ASCII output only.
.EXAMPLE
    pwsh -File bin/junk-report.ps1 --json
    pwsh -File bin/junk-report.ps1 --strict
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
    $engine = Join-Path $root 'bin/junk-report.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no junk-report engine at $engine" }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the report engine needs it' }
    $forward = @()
    if ($Arguments) { $forward += $Arguments }
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
