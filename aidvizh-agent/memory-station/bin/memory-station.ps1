#Requires -Version 5.1
<#
.SYNOPSIS
    memory-station on Windows: agent memory (basic-memory) - install, status, notes, checks.

.DESCRIPTION
    Thin wrapper: the engine (bin/memory.mjs) is shared with the bash version, so the logic lives in
    one place. The station root is derived from $PSScriptRoot - no absolute paths. -WhatIf is
    forwarded as --dry-run. Messages are ASCII: Windows PowerShell 5.1 reads .ps1 as ANSI.

.EXAMPLE
    pwsh -File bin/memory-station.ps1 status
    pwsh -File bin/memory-station.ps1 install
    pwsh -File bin/memory-station.ps1 note "решили X, потому что Y" --folder=code
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

Set-StrictMode -Version Latest

$engine = Join-Path $PSScriptRoot 'memory.mjs'
if (-not (Test-Path $engine)) {
    Write-Error "memory-station: no engine at $engine"
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'memory-station: node is required'
    exit 1
}

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
