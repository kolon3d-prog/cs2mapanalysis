#Requires -Version 5.1
<#
.SYNOPSIS
    Install skills-hub on Windows: skill link, command shim, MCP registration, approval gate.

.DESCRIPTION
    The hub CLI is bash, so bash must be in PATH: Git for Windows (or WSL). It is checked but
    does not block the install - links and MCP configs are written anyway.
    Idempotent: a second run changes nothing. JSON configs are edited by set-mcp-entry.mjs (node)
    - not by ConvertTo-Json, which in 5.1 re-escapes strings and would rewrite the whole file.
    Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and mangles non-ASCII.
    Supports -WhatIf: it prints what would change and touches nothing.

.EXAMPLE
    pwsh -File windows/install.ps1
    pwsh -File windows/install.ps1 -Hub D:\AGGG\skills-hub -AgentHome $env:USERPROFILE
    pwsh -File windows/install.ps1 -WhatIf
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output, the script returns no pipeline data.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $Hub = (Split-Path -Parent $PSScriptRoot),
    [string] $AgentHome = $HOME
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Step { param([string] $Text) Write-Host "== $Text" }
function Ok { param([string] $Text) Write-Host "   [ok] $Text" -ForegroundColor DarkGray }
function Warn { param([string] $Text) Write-Host "   [!] $Text" -ForegroundColor Yellow }

try {
    $hub = (Resolve-Path -LiteralPath $Hub).Path
    $manager = Join-Path $hub 'skills-manager.sh'
    if (-not (Test-Path -LiteralPath $manager)) {
        throw "no skills-manager.sh in $hub - pass the hub directory with -Hub"
    }
    $hubPosix = $hub -replace '\\', '/'

    Step 'environment'
    $bash = Get-Command bash -ErrorAction SilentlyContinue
    if ($bash) {
        Ok "bash: $($bash.Source)"
    } else {
        Warn 'bash not found: install Git for Windows (or WSL) and put bash in PATH - without it neither the CLI nor MCP works'
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found: the MCP server and the config editor need it' }
    Ok "node: $($node.Source)"

    Step 'profile directories'
    $binDir = Join-Path $AgentHome '.local\bin'
    $skillsDir = Join-Path $AgentHome '.agents\skills'
    $configDirs = @(
        (Join-Path $AgentHome '.config\opencode'),
        (Join-Path $AgentHome '.omp\agent')
    )
    foreach ($dir in @($binDir, $skillsDir) + $configDirs) {
        if (Test-Path -LiteralPath $dir) {
            Ok $dir
        } elseif ($PSCmdlet.ShouldProcess($dir, 'create directory')) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Ok "$dir (created)"
        }
    }

    Step 'skill skills-ops'
    $link = Join-Path $skillsDir 'skills-ops'
    $linkIsRight = $false
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
        $target = $null
        if ($item) { $target = $item.Target }
        if ($target -is [array]) { $target = $target[0] }
        if ($target) {
            $linkIsRight = ($target.TrimEnd('\', '/') -eq $hub.TrimEnd('\', '/'))
        } else {
            # 5.1 does not always report Target for junctions - fall back to the content check
            $linkIsRight = Test-Path -LiteralPath (Join-Path $link 'skills-manager.sh')
        }
    }
    if ($linkIsRight) {
        Ok "already points to $hub"
    } elseif ($PSCmdlet.ShouldProcess($link, "link to $hub")) {
        if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Recurse -Force }
        try {
            New-Item -ItemType SymbolicLink -Path $link -Value $hub -ErrorAction Stop | Out-Null
            Ok "symlink -> $hub"
        } catch {
            New-Item -ItemType Junction -Path $link -Value $hub -ErrorAction Stop | Out-Null
            Ok "junction -> $hub (symlink needs privileges or Developer Mode)"
        }
    }

    Step 'command skills-manager'
    $shim = Join-Path $binDir 'skills-manager.cmd'
    $shimBody = "@echo off`r`nrem skills-hub: $hubPosix`r`nbash `"$hubPosix/skills-manager.sh`" %*`r`n"
    $shimOld = ''
    if (Test-Path -LiteralPath $shim) { $shimOld = [System.IO.File]::ReadAllText($shim) }
    if ($shimOld -eq $shimBody) {
        Ok "shim up to date: $shim"
    } elseif ($PSCmdlet.ShouldProcess($shim, 'write shim')) {
        [System.IO.File]::WriteAllText($shim, $shimBody, [System.Text.Encoding]::ASCII)
        Ok "shim created: $shim"
    }

    Step 'MCP registration'
    $setEntry = Join-Path $hub 'windows/set-mcp-entry.mjs'
    foreach ($client in @('opencode', 'omp')) {
        if ($client -eq 'opencode') {
            $configPath = Join-Path $AgentHome '.config\opencode\opencode.json'
        } else {
            $configPath = Join-Path $AgentHome '.omp\agent\mcp.json'
        }
        if (-not $PSCmdlet.ShouldProcess($configPath, "register skills-hub for $client")) { continue }
        # the editor writes UTF-8: without this the Windows console decodes it in the OEM codepage
        try {
            [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
        } catch {
            Write-Verbose "console encoding not switched: $_"
        }

        $lines = & node $setEntry --client $client --file $configPath 2>&1
        if ($LASTEXITCODE -ne 0) { throw "cannot update $configPath : $lines" }
        $text = $lines -join ' '
        Ok $text
    }

    Step 'next'
    Ok "1. add $binDir to PATH if it is not there yet - otherwise skills-manager is not found"
    Ok '2. restart the clients (opencode window, omp session) so MCP re-reads the config'
    Ok '3. check: skills-manager doctor      (in Git Bash it should end with "doctor: ok")'
    Ok '4. check MCP: ask the client to list installed skills (tool skills_list)'

    Write-Host ''
    Write-Host '[OK] done'
    exit 0
} catch {
    Write-Warning "Error: $_"
    exit 1
}
