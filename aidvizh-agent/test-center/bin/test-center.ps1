#Requires -Version 5.1
<#
.SYNOPSIS
    test-center on Windows: end-to-end check of the AGGG system, writes bagreport.md on the first failure.

.DESCRIPTION
    Thin wrapper: the engine (bin/test.mjs) is shared with bash, so the logic lives in one place.
    Station root comes from $PSScriptRoot - no absolute paths. -WhatIf is forwarded as --dry-run.
    Suites that need tools missing on this OS are skipped, not failed (bats, omp).

.EXAMPLE
    pwsh -File bin/test-center.ps1 run
    pwsh -File bin/test-center.ps1 run --only=smoke,wiki --no-model
    pwsh -File bin/test-center.ps1 report
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

Set-StrictMode -Version Latest

$engine = Join-Path $PSScriptRoot 'test.mjs'
if (-not (Test-Path $engine)) { Write-Error "test-center: no engine at $engine"; exit 1 }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'test-center: node is required'; exit 1 }

$passed = @()
if ($Arguments) { $passed += $Arguments }
if ($WhatIfPreference) { $passed += '--dry-run' }

# the engine writes UTF-8: without this the Windows console decodes it in the OEM codepage
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
    Write-Verbose "console encoding not switched: $_"
}

& node $engine @passed
exit $LASTEXITCODE
