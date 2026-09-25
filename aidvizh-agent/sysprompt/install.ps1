#Requires -Version 5.1
<#
.SYNOPSIS
    Install the sysprompt plugin/extension: /prompt for opencode, omp and pi on any OS with pwsh.

.DESCRIPTION
    PowerShell twin of install.sh - one installer for Linux, macOS and Windows (pwsh 7).
    On Windows it is the only correct path: Git Bash `ln -s` silently produces copies, so the
    bash installer refuses there and points here.

    What it does:
      * links natively - symbolic link, else a hard link on the same volume, else a copy with an
        honest warning that project edits will not reach the client;
      * directories - symbolic link, else a junction (no privilege needed);
      * never deletes anything silently: a foreign file or directory at the destination is moved
        aside as `<name>.bak-<stamp>` before the link is made;
      * verifies the result - every destination must exist and point at the project file, and the
        exit code is non-zero when a link is missing;
      * idempotent (a second run changes nothing) and supports -WhatIf (plan only).

    -Target defaults to all (opencode + omp + pi), the behaviour of the previous PowerShell
    installer, so `center run` and a bare `pwsh -File install.ps1` keep working. -Target auto
    mirrors install.sh: it reads `opencode2 --version` and refuses when the build is not a dev
    build instead of guessing.

    Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and mangles
    non-ASCII.

.EXAMPLE
    pwsh -File install.ps1
    pwsh -File install.ps1 -Target omp -AgentHome $env:USERPROFILE
    pwsh -File install.ps1 -WhatIf
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output, the script returns no pipeline data.')]
[CmdletBinding(SupportsShouldProcess = $true, PositionalBinding = $false)]
param(
    [Parameter(Position = 0)]
    [ValidateSet('auto', 'all', 'opencode', 'opencode-dev', 'omp', 'pi')]
    [string] $Target = 'all',
    [string] $Project = $PSScriptRoot,
    [string] $AgentHome = $HOME,
    [string] $ConfigDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Text) Write-Host "== $Text" }
function Write-Ok { param([string] $Text) Write-Host "   [ok] $Text" -ForegroundColor DarkGray }
function Write-Note { param([string] $Text) Write-Host "   [!] $Text" -ForegroundColor Yellow }
function Write-Fail { param([string] $Text) Write-Host "   [X] $Text" -ForegroundColor Red }

function Resolve-LinkTarget {
    # A link target may be relative (install.sh makes such links on purpose: `../../../.agents/...`),
    # and a relative target is resolved against the directory holding the link, not against $PWD.
    param([string] $Destination, [string] $Target)

    if ([System.IO.Path]::IsPathRooted($Target)) { return [System.IO.Path]::GetFullPath($Target) }
    return [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $Destination) $Target))
}

function Move-Aside {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string] $Path)

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$Path.bak-$stamp"
    $suffix = 0
    while ((Test-Path -LiteralPath $backup) -and ($suffix -lt 100)) {
        $suffix++
        $backup = "$Path.bak-$stamp-$suffix"
    }
    if (-not $PSCmdlet.ShouldProcess($Path, "move aside to $backup")) { return }
    Move-Item -LiteralPath $Path -Destination $backup -Force
    Write-Note "not ours, moved aside: $Path -> $backup"
}

function New-Link {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string] $Source,
        [string] $Destination,
        [switch] $Directory
    )
    if (-not (Test-Path -LiteralPath $Source)) { throw "no such source: $Source" }

    $existing = Get-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    if ($existing) {
        $current = $existing.Target
        if ($current -is [array]) { $current = $current[0] }
        if ($current -and ((Resolve-LinkTarget -Destination $Destination -Target $current) -eq $Source)) {
            Write-Ok "already in place: $Destination"
            return
        }
        if ($existing.LinkType -eq 'HardLink') {
            # A hard link has no target to compare: identity is proved by content, otherwise a
            # hard link to some other file would be accepted as "already in place".
            $same = $false
            if (-not $existing.PSIsContainer) {
                $same = (Get-FileHash -LiteralPath $Source).Hash -eq (Get-FileHash -LiteralPath $Destination).Hash
            }
            if ($same) {
                Write-Ok "already in place (hardlink): $Destination"
                return
            }
            if (-not $PSCmdlet.ShouldProcess($Destination, 'move aside and link')) { return }
            Move-Aside -Path $Destination
        } else {
            if (-not $PSCmdlet.ShouldProcess($Destination, 'move aside and link')) { return }
            Move-Aside -Path $Destination
        }
    } elseif (-not $PSCmdlet.ShouldProcess($Destination, "link to $Source")) {
        return
    }

    if ($Directory) {
        try {
            New-Item -ItemType SymbolicLink -Path $Destination -Value $Source -ErrorAction Stop | Out-Null
            Write-Ok "symlink -> $Destination"
        } catch {
            New-Item -ItemType Junction -Path $Destination -Value $Source -ErrorAction Stop | Out-Null
            Write-Ok "junction -> $Destination"
        }
        return
    }

    try {
        New-Item -ItemType SymbolicLink -Path $Destination -Value $Source -ErrorAction Stop | Out-Null
        Write-Ok "symlink -> $Destination"
    } catch {
        try {
            New-Item -ItemType HardLink -Path $Destination -Value $Source -ErrorAction Stop | Out-Null
            Write-Ok "hardlink -> $Destination"
        } catch {
            Copy-Item -LiteralPath $Source -Destination $Destination -Force
            Write-Note "copied (symlink and hardlink both failed): $Destination - project edits will not reach the client, re-run the installer"
        }
    }
}

function Test-Link {
    param([string] $Source, [string] $Destination, [switch] $Directory)

    if (-not (Test-Path -LiteralPath $Destination)) {
        Write-Fail "missing: $Destination"
        return $false
    }
    $item = Get-Item -LiteralPath $Destination -Force
    $current = $item.Target
    if ($current -is [array]) { $current = $current[0] }
    if ($current) {
        if ((Resolve-LinkTarget -Destination $Destination -Target $current) -eq $Source) {
            Write-Ok "verified: $Destination"
            return $true
        }
        Write-Fail "points elsewhere: $Destination -> $current"
        return $false
    }
    # Hard link or copy: identity is proved by content, not by the link target.
    if ($Directory) {
        $rel = Join-Path $Source 'SKILL.md'
        if (-not (Test-Path -LiteralPath $rel)) { Write-Fail "nothing to compare for $Destination"; return $false }
        $same = (Get-FileHash -LiteralPath $rel).Hash -eq (Get-FileHash -LiteralPath (Join-Path $Destination 'SKILL.md')).Hash
    } else {
        $same = (Get-FileHash -LiteralPath $Source).Hash -eq (Get-FileHash -LiteralPath $Destination).Hash
    }
    if ($same) {
        Write-Ok "verified (content): $Destination"
        return $true
    }
    Write-Fail "content differs: $Destination"
    return $false
}

try {
    $project = (Resolve-Path -LiteralPath $Project).Path
    if ($Target -eq 'auto') {
        $version = ''
        $cli = Get-Command opencode2 -ErrorAction SilentlyContinue
        if ($cli) { $version = @(& $cli.Source --version 2>$null | Select-Object -First 1) -join ' ' }
        if ($version -match '-dev-') {
            $Target = 'opencode-dev'
            Write-Ok "opencode build: $version -> target opencode-dev"
        } else {
            throw "opencode build not recognised: $(if ($version) { $version } else { 'binary not found' }); pass -Target explicitly: opencode-dev | omp | pi | all"
        }
    }
    $installOpencode = $Target -eq 'all' -or $Target -eq 'opencode' -or $Target -eq 'opencode-dev'
    $installOmp = $Target -eq 'all' -or $Target -eq 'omp'
    $installPi = $Target -eq 'all' -or $Target -eq 'pi'

    $plugin = Join-Path $project 'opencode/dev/plugin/sysprompt.ts'
    $command = Join-Path $project 'opencode/dev/command/prompt.md'
    $skill = Join-Path $project 'opencode/skill'
    $ompExtension = Join-Path $project 'omp/dev/extension/sysprompt.ts'
    $piExtension = Join-Path $project 'pi/dev/extension/sysprompt.ts'
    $sources = @()
    if ($installOpencode) { $sources += @($plugin, $command, (Join-Path $skill 'SKILL.md')) }
    if ($installOmp) { $sources += $ompExtension }
    if ($installPi) { $sources += $piExtension }
    foreach ($source in $sources) {
        if (-not (Test-Path -LiteralPath $source)) {
            throw "no $source - pass the project directory with -Project"
        }
    }

    if (-not $ConfigDir) {
        if ($env:XDG_CONFIG_HOME) { $ConfigDir = Join-Path $env:XDG_CONFIG_HOME 'opencode' }
        else { $ConfigDir = Join-Path (Join-Path $AgentHome '.config') 'opencode' }
    }
    if ($env:PI_CODING_AGENT_DIR) {
        $ompAgentDir = $env:PI_CODING_AGENT_DIR
        $piAgentDir = $env:PI_CODING_AGENT_DIR
    } else {
        $ompAgentDir = Join-Path (Join-Path $AgentHome '.omp') 'agent'
        $piAgentDir = Join-Path (Join-Path $AgentHome '.pi') 'agent'
    }
    $agentsSkills = Join-Path (Join-Path $AgentHome '.agents') 'skills'
    $links = @()

    Write-Step 'directories'
    $dirs = @()
    if ($installOmp) { $dirs += (Join-Path $ompAgentDir 'extensions') }
    if ($installPi) { $dirs += (Join-Path $piAgentDir 'extensions') }
    if ($installOpencode) {
        $dirs += @(
            (Join-Path $ConfigDir 'plugins'),
            (Join-Path $ConfigDir 'commands'),
            (Join-Path $ConfigDir 'skills'),
            $agentsSkills
        )
    }
    foreach ($dir in $dirs) {
        if (Test-Path -LiteralPath $dir -PathType Container) {
            Write-Ok $dir
        } elseif (Test-Path -LiteralPath $dir) {
            throw "$dir exists and is not a directory - move it away and retry"
        } elseif ($PSCmdlet.ShouldProcess($dir, 'create directory')) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Write-Ok "$dir (created)"
        }
    }

    if ($installOpencode) {
        Write-Step 'opencode'
        New-Link -Source $plugin -Destination (Join-Path (Join-Path $ConfigDir 'plugins') 'sysprompt.ts')
        New-Link -Source $command -Destination (Join-Path (Join-Path $ConfigDir 'commands') 'prompt.md')
        New-Link -Source $skill -Destination (Join-Path $agentsSkills 'sysprompt') -Directory
        New-Link -Source $skill -Destination (Join-Path (Join-Path $ConfigDir 'skills') 'sysprompt') -Directory
        $links += @(
            @{ Source = $plugin; Destination = (Join-Path (Join-Path $ConfigDir 'plugins') 'sysprompt.ts'); Directory = $false },
            @{ Source = $command; Destination = (Join-Path (Join-Path $ConfigDir 'commands') 'prompt.md'); Directory = $false },
            @{ Source = $skill; Destination = (Join-Path $agentsSkills 'sysprompt'); Directory = $true },
            @{ Source = $skill; Destination = (Join-Path (Join-Path $ConfigDir 'skills') 'sysprompt'); Directory = $true }
        )
    }

    if ($installOmp) {
        Write-Step 'omp'
        New-Link -Source $ompExtension -Destination (Join-Path (Join-Path $ompAgentDir 'extensions') 'sysprompt.ts')
        $links += @{ Source = $ompExtension; Destination = (Join-Path (Join-Path $ompAgentDir 'extensions') 'sysprompt.ts'); Directory = $false }
    }

    if ($installPi) {
        Write-Step 'pi'
        New-Link -Source $piExtension -Destination (Join-Path (Join-Path $piAgentDir 'extensions') 'sysprompt.ts')
        $links += @{ Source = $piExtension; Destination = (Join-Path (Join-Path $piAgentDir 'extensions') 'sysprompt.ts'); Directory = $false }
    }

    Write-Host ''
    if ($WhatIfPreference) {
        Write-Host '[i] plan only (-WhatIf): nothing was changed'
        exit 0
    }

    Write-Step 'verify'
    $failed = 0
    foreach ($link in $links) {
        if ($link.Directory) {
            if (-not (Test-Link -Source $link.Source -Destination $link.Destination -Directory)) { $failed++ }
        } elseif (-not (Test-Link -Source $link.Source -Destination $link.Destination)) {
            $failed++
        }
    }
    if ($failed -gt 0) {
        Write-Host "[X] verification failed: $failed of $($links.Count) destinations are not linked to the project" -ForegroundColor Red
        exit 1
    }

    Write-Host ''
    Write-Step 'next'
    if ($installOpencode) { Write-Ok 'restart opencode: opencode2 service restart' }
    if ($installOmp) { Write-Ok 'restart omp: extensions are read at session start' }
    if ($installPi) { Write-Ok 'restart pi: extensions are read at session start (/reload picks them up live)' }
    Write-Ok 'check: /prompt <text> in the client, then /prompt clear'

    Write-Host ''
    Write-Host '[OK] done'
    exit 0
} catch {
    Write-Warning "Error: $_"
    exit 1
}
