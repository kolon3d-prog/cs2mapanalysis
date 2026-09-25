#Requires -Version 5.1
<#
.SYNOPSIS
    wiki-station on Windows: knowledge wiki (Karpathy LLM Wiki schema) - new, list, open, search, lint.

.DESCRIPTION
    Thin wrapper: the engine (bin/wiki.mjs) is shared with the bash version. Station root comes from
    $PSScriptRoot - no absolute paths. -WhatIf is forwarded as --dry-run.

.EXAMPLE
    pwsh -File bin/wiki-station.ps1 list
    pwsh -File bin/wiki-station.ps1 open "Wiki VibeCoding" index.md
    pwsh -File bin/wiki-station.ps1 search "агент"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

Set-StrictMode -Version Latest

$engine = Join-Path $PSScriptRoot 'wiki.mjs'
if (-not (Test-Path $engine)) { Write-Error "wiki-station: no engine at $engine"; exit 1 }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'wiki-station: node is required'; exit 1 }

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
