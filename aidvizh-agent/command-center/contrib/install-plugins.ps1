#Requires -Version 5.1
<#
.SYNOPSIS
    Install the /center plugin into the three clients (opencode2, omp, pi) on Windows.

.DESCRIPTION
    Thin wrapper: the engine (contrib/install-plugins.mjs) is shared with the bash version, so both
    operating systems install the same thing and print the same lines.

    How a plugin is attached differs per OS, and the engine is honest about it:
      * symbolic link first - on Windows it needs Developer Mode or an elevated shell;
      * a junction next - directories only, and it needs no privileges;
      * a copy last, with a plain warning that edits in the station will not reach the client.
    A live client file at the destination is never overwritten: it moves to <file>.bak.
    Idempotent: a link that already points here is left alone.

    -WhatIf is forwarded as --dry-run. This file stays ASCII: Windows PowerShell 5.1 reads .ps1 as
    ANSI, while the engine prints Russian text as UTF-8 (the console is switched to UTF-8 below).

.EXAMPLE
    pwsh -File contrib/install-plugins.ps1 install
    pwsh -File contrib/install-plugins.ps1 status
    pwsh -File contrib/install-plugins.ps1 uninstall
    pwsh -File contrib/install-plugins.ps1 install -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    $center = Split-Path -Parent $PSScriptRoot
    $engine = Join-Path $center 'contrib/install-plugins.mjs'
    if (-not (Test-Path -LiteralPath $engine)) { throw "no plugin install engine at $engine" }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the plugin install engine needs it' }

    # the engine writes UTF-8: without this the Windows console decodes it in the OEM codepage
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    } catch {
        Write-Verbose "console encoding not switched: $_"
    }

    $forward = @()
    if ($Arguments) { $forward += $Arguments }
    if ($WhatIfPreference) { $forward += '--dry-run' }

    & node $engine @forward
    exit $LASTEXITCODE
} catch {
    Write-Warning "Error: $_"
    exit 1
}
