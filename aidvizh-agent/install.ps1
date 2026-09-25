#Requires -Version 5.1
<#
.SYNOPSIS
    Install or update the agent on a Windows machine: fetch the prerequisites, run the mode
    (first install / -Update / -Reset), then the heavy stations the center does not install,
    then run a live check.

.DESCRIPTION
    Windows twin of install.sh - same flow, same modes, same finale:

      (no switch)  first install; if an agent environment is already present but the set is not,
                   install beside it (`center fresh --yes --no-cleanup`), removing nothing; if the
                   set itself is already there, explain -Update/-Reset and exit 1
      -Update      update in place: `center update all`, remove nothing
      -Reset       reinstall from scratch: `center fresh --yes`; the center removes ours only,
                   foreign files are untouched

      1) prerequisites. node, bun, uv, git, gh, jq (plus pwsh, see below) are checked and
         installed when missing: winget first, choco or scoop when winget itself is absent.
         `center prereqs` is the gate; if it fails, the script stops with exit 1.
      2) the mode: `center fresh --yes` (first install and -Reset) or `center update all`
         (-Update). `center fresh` makes the center install agents, hub links, skills, MCP
         servers without keys, memory, wiki, the persona and /prompt.
      3) the heavy stations the center does not install - stealth-browser and camoufox -
         through their .ps1 wrappers. They run in every mode and are idempotent.
      4) `center verify`: a live handshake. Success is the same summary install.sh looks
         for (the "provalov 0" line, built from code points below) plus the "dom zhiv"
         line and exit 0 - in every mode. Anything else prints the failure list and exits 1.

    pwsh (PowerShell 7) is bootstrapped although Windows ships 5.1: skills-hub's
    contrib/install-links.ps1 and camoufox-research's installer carry
    `#Requires -Version 7.0` and cannot run under the built-in 5.1. Without pwsh,
    `center fresh` fails on the "hub links" step.

    Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and would
    mangle Russian letters in the source. The engine writes UTF-8 (the console encoding is
    switched below), and the two Russian strings this script has to print and to match are
    built from code points, so the file itself stays pure ASCII.

.PARAMETER Update
    Update in place: `center update all` instead of a fresh install; nothing is removed.
    Then the heavy stations and the live check run as in every mode.
.PARAMETER Reset
    Reinstall from scratch: `center fresh --yes` even when an agent environment is already
    present. The center removes ours only; foreign files are untouched.
.PARAMETER SkipFresh
    Skip `center fresh --yes` (re-run over an already installed machine).
.PARAMETER SkipPrereqs
    Skip the winget/choco/scoop bootstrap; `center prereqs` still runs.
.PARAMETER Help
    Show this help and exit 0 (the install.sh `--help` twin).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
    pwsh -File install.ps1 -Update

.EXAMPLE
    pwsh -File install.ps1 -Reset

.EXAMPLE
    pwsh -File install.ps1 -SkipFresh
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output, the script returns no pipeline data.')]
[CmdletBinding()]
param(
    [Alias('h')]
    [switch] $Help,
    [switch] $Update,
    [switch] $Reset,
    [switch] $SkipFresh,
    [switch] $SkipPrereqs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$global:LASTEXITCODE = 0

# the engine writes UTF-8: without this Windows PowerShell 5.1 decodes its output in the OEM codepage
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
    Write-Verbose "console encoding not switched: $_"
}

# $IsWindows exists in pwsh 6+ only; 5.1 would throw under StrictMode - ask .NET instead
$script:OnWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$script:Clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:Here = $PSScriptRoot
$script:Center = Join-Path $script:Here 'command-center/bin/center.ps1'

# ---------------------------------------------------------------- output
function Write-Step { param([string] $Text) Write-Host ''; Write-Host "== $Text" }
function Write-Ok { param([string] $Text) Write-Host "   [ok] $Text" -ForegroundColor DarkGray }
function Write-Note { param([string] $Text) Write-Host "   [i] $Text" }
function Write-Warn { param([string] $Text) Write-Host "[*] $Text" -ForegroundColor Yellow }
function Write-Fail { param([string] $Text) Write-Host "[X] $Text" -ForegroundColor Red }
function Write-Elapsed { Write-Host "[i] elapsed: $([int]$script:Clock.Elapsed.TotalSeconds) s" }

# ---------------------------------------------------------------- text without non-ASCII bytes
# Windows PowerShell 5.1 reads .ps1 as ANSI: a Russian literal in this file would come out as
# mojibake. The two strings the user must see are built from code points instead - the source
# stays ASCII, the console gets real Cyrillic.
function Get-Text {
    param([Parameter(Mandatory)][int[]] $CodePoint)
    return (-join ($CodePoint | ForEach-Object { [char] $_ }))
}
$script:HomeAlive = Get-Text @(0x434, 0x43E, 0x43C, 0x20, 0x436, 0x438, 0x432)                     # dom zhiv
$script:FailNeedle = Get-Text @(0x43F, 0x440, 0x43E, 0x432, 0x430, 0x43B, 0x43E, 0x432, 0x20, 0x30) # provalov 0

# ---------------------------------------------------------------- tools and package managers
# Package ids per manager. winget ids are the ones center prereqs and camoufox-research
# already print in their hints; choco/scoop are the fallback when winget is not on the machine.
$script:WingetIds = @{
    node = 'OpenJS.NodeJS.LTS'
    bun  = 'Oven-sh.Bun'
    uv   = 'astral-sh.uv'
    git  = 'Git.Git'
    gh   = 'GitHub.cli'
    jq   = 'jqlang.jq'
    pwsh = 'Microsoft.PowerShell'
}
$script:ChocoIds = @{
    node = 'nodejs-lts'
    bun  = 'bun'
    uv   = 'uv'
    git  = 'git'
    gh   = 'gh'
    jq   = 'jq'
    pwsh = 'powershell-core'
}
$script:ScoopIds = @{
    node = 'nodejs-lts'
    bun  = 'bun'
    uv   = 'uv'
    git  = 'git'
    gh   = 'gh'
    jq   = 'jq'
    pwsh = 'pwsh'
}

function Get-ToolCommand {
    param([Parameter(Mandatory)][string] $Name)
    return (Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Test-Tool {
    param([Parameter(Mandatory)][string] $Name)
    return ($null -ne (Get-ToolCommand -Name $Name))
}

function Get-NodeMajor {
    # node 20+ is what README.md requires; 0 means "no usable node"
    $node = Get-ToolCommand -Name 'node'
    if ($null -eq $node) { return 0 }
    $raw = ''
    try { $raw = [string](& $node.Source --version) } catch { return 0 }
    if ($raw -match '^v?(\d+)\.') { return [int] $Matches[1] }
    return 0
}

function Get-ManagerOrder {
    # managers in preference order: winget first, choco and scoop as fallbacks
    $list = @()
    foreach ($name in @('winget', 'choco', 'scoop')) {
        if (Test-Tool -Name $name) { $list += $name }
    }
    return $list
}

function Add-KnownToolPath {
    # winget/choco/scoop edit the registry PATH; this process keeps the old one. Two ways out:
    # reopen the console (lost for an installer) or add the well-known directories by hand.
    # The list is exactly where these tools land on Windows.
    $dirs = @()
    if ($env:ProgramFiles) {
        $dirs += (Join-Path $env:ProgramFiles 'nodejs')
        $dirs += (Join-Path $env:ProgramFiles 'Git\cmd')
        $dirs += (Join-Path $env:ProgramFiles 'GitHub CLI')
        $dirs += (Join-Path $env:ProgramFiles 'PowerShell\7')
    }
    if (${env:ProgramFiles(x86)}) { $dirs += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd') }
    if ($env:LOCALAPPDATA) {
        $dirs += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links')
        $dirs += (Join-Path $env:LOCALAPPDATA 'Programs\uv')
    }
    if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA 'npm') }
    if ($env:USERPROFILE) {
        $dirs += (Join-Path $env:USERPROFILE '.bun\bin')
        $dirs += (Join-Path $env:USERPROFILE '.local\bin')
    }
    $known = @{}
    foreach ($part in ([string]$env:PATH -split ';')) {
        if ($part) { $known[$part.TrimEnd('\')] = $true }
    }
    $added = @()
    foreach ($dir in $dirs) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        $key = $dir.TrimEnd('\')
        if ($known.ContainsKey($key)) { continue }
        $env:PATH = "$dir;$env:PATH"
        $known[$key] = $true
        $added += $dir
    }
    if ($added.Count -gt 0) { Write-Verbose ("PATH += " + ($added -join '; ')) }
}

function Install-Tool {
    # One tool through every available manager, first success wins. Package manager exit codes
    # are not trusted ("already installed" is a failure there too) - the tool is re-checked.
    param([Parameter(Mandatory)][string] $Name)
    foreach ($manager in @(Get-ManagerOrder)) {
        $id = ''
        if ($manager -eq 'winget') { $id = $script:WingetIds[$Name] }
        elseif ($manager -eq 'choco') { $id = $script:ChocoIds[$Name] }
        else { $id = $script:ScoopIds[$Name] }
        if (-not $id) { continue }
        Write-Host "       $manager install $id"
        try {
            if ($manager -eq 'winget') {
                & winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
            } elseif ($manager -eq 'choco') {
                & choco install -y $id
            } else {
                & scoop install $id
            }
        } catch {
            Write-Warn "$manager could not start: $($_.Exception.Message)"
        }
        Add-KnownToolPath
        if (Test-Tool -Name $Name) { return $true }
        Write-Warn "$manager did not deliver $Name"
    }
    if ($Name -eq 'bun') {
        # the repo's own hint for Windows (center prereqs): npm is already there with node
        $npm = Get-ToolCommand -Name 'npm'
        if ($null -ne $npm) {
            Write-Host '       npm install -g bun'
            try { & $npm.Source install -g bun } catch { Write-Warn "npm could not start: $($_.Exception.Message)" }
            Add-KnownToolPath
            if (Test-Tool -Name 'bun') { return $true }
        }
    }
    return $false
}

function Invoke-ToolBootstrap {
    # Returns the tools that could not be installed; the caller reports them after the
    # center's own prereqs listing (that listing carries the per-tool hints).
    param([bool] $Skip)
    if ($Skip) {
        Write-Note 'tool bootstrap skipped (-SkipPrereqs); center prereqs still runs'
        return @()
    }
    if (-not $script:OnWindows) {
        Write-Warn 'not Windows: winget/choco/scoop are skipped - install.sh is the entry for Linux/macOS'
        return @()
    }

    $managers = @(Get-ManagerOrder)
    if ($managers.Count -eq 0) {
        # tools already on the machine are fine without a manager; only a missing tool is fatal,
        # and that is reported after center prereqs (which prints its own per-tool hints)
        Write-Warn 'no package manager found: winget, choco and scoop are all missing - already installed tools are kept, missing ones cannot be fetched'
    } else {
        Write-Ok "package managers: $($managers -join ', ')"
    }

    # pwsh is here on purpose: two steps of center fresh carry '#Requires -Version 7.0'
    # and the built-in 5.1 cannot run them (see the notes at the top).
    $tools = @('node', 'bun', 'uv', 'git', 'gh', 'jq', 'pwsh')
    $notInstalled = @()
    foreach ($tool in $tools) {
        if (Test-Tool -Name $tool) {
            Write-Ok "$tool - $((Get-ToolCommand -Name $tool).Source)"
            continue
        }
        Write-Note "$tool not found - installing"
        if (Install-Tool -Name $tool) {
            Write-Ok "$tool installed"
        } else {
            $notInstalled += $tool
            Write-Fail "$tool could not be installed by any package manager"
        }
    }

    if (Test-Tool -Name 'node') {
        $major = Get-NodeMajor
        if (($major -gt 0) -and ($major -lt 20)) {
            Write-Warn "node v$major is older than 20, README.md requires 20+ (upgrade: winget install OpenJS.NodeJS.LTS)"
        }
    }
    return $notInstalled
}

function Invoke-StationCommand {
    # Station wrappers are .ps1. camoufox-research carries '#Requires -Version 7.0', so under
    # the built-in 5.1 it is handed to pwsh 7 explicitly. Output goes straight to the console
    # (Out-Host), so only the exit code comes back to the caller.
    param([Parameter(Mandatory)][object] $Station)
    $global:LASTEXITCODE = 0
    if ($Station.NeedsPwsh7 -and ($PSVersionTable.PSVersion.Major -lt 7)) {
        $pwsh = Get-ToolCommand -Name 'pwsh'
        if ($null -eq $pwsh) {
            Write-Fail "$($Station.Label) needs PowerShell 7: its installer carries '#Requires -Version 7.0'"
            Write-Fail 'install it (winget install Microsoft.PowerShell) and run this script again'
            return 3
        }
        & $pwsh.Source -NoProfile -File $Station.Script @($Station.Arguments) | Out-Host
        return $LASTEXITCODE
    }
    & $Station.Script @($Station.Arguments) | Out-Host
    return $LASTEXITCODE
}

# ---------------------------------------------------------------- main
try {
    if ($Help) {
        Write-Host 'aidvizh agent - Windows install'
        Write-Host 'usage: install.ps1 [-Update | -Reset] [-SkipFresh] [-SkipPrereqs]'
        Write-Host '  (no switch)   first install; on a busy machine it installs beside (nothing removed);'
        Write-Host '                if the set is already here, it explains -Update / -Reset'
        Write-Host '  -Update       update in place (center update all), remove nothing'
        Write-Host '  -Reset        reinstall from scratch (center fresh --yes); ours only, foreign files untouched'
        Write-Host '  -SkipFresh    skip center fresh'
        Write-Host '  -SkipPrereqs  skip the winget/choco/scoop bootstrap; center prereqs still runs'
        exit 0
    }
    if (-not (Test-Path -LiteralPath $script:Center)) { throw "no command center at $script:Center" }
    if ($Update -and $Reset) { throw 'pick one mode: -Update or -Reset' }

    Write-Host 'aidvizh agent - Windows install'
    Write-Host 'tools -> install / update / reset -> heavy stations -> live check'

    Write-Step 'prerequisites: node, bun, uv, git, gh, jq, pwsh'
    $notInstalled = @(Invoke-ToolBootstrap -Skip $SkipPrereqs.IsPresent)

    Write-Step 'prerequisites check (center prereqs)'
    $global:LASTEXITCODE = 0
    & $script:Center prereqs
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        if ($notInstalled.Count -gt 0) { Write-Fail "could not install: $($notInstalled -join ', ')" }
        Write-Fail 'prerequisites are not met - install what is missing (each line above has a hint) and run this script again'
        Write-Elapsed
        exit 1
    }

    # ------------------------------------------------------------ the mode
    # -Update and -Reset are the two modes install.sh has; the plain run on a machine where the agent
    # environment already exists: our own footprint (the center command) -> explain and exit 1;
    # no footprint -> install beside (`center fresh --yes --no-cleanup`), removing nothing.
    # Whatever the mode's own step exits with is only a warning - the live check has the last word.
    $prepareCode = 0
    $Beside = $false
    $modeStep = if ($Update) { 'center update all' } else { 'center fresh' }
    if ($Update) {
        if ($SkipFresh) { Write-Note '-SkipFresh has no effect with -Update: the step is center update all' }
        Write-Step 'update (center update all)'
        $global:LASTEXITCODE = 0
        & $script:Center update all
        $prepareCode = $LASTEXITCODE
        if ($prepareCode -eq 0) {
            Write-Ok 'center update all done'
        } else {
            Write-Warn "center update all exited with code $prepareCode - carrying on to the stations; the final word belongs to the live check"
        }
    } else {
        if ((-not $Reset) -and (-not $SkipFresh)) {
            $markers = @(
                (Join-Path $HOME '.omp/agent'),
                (Join-Path $HOME '.pi/agent'),
                (Join-Path $HOME '.config/opencode'),
                (Join-Path $HOME '.agents/skills')
            )
            $found = @($markers | Where-Object { Test-Path -LiteralPath $_ })
            if ($found.Count -gt 0) {
                # the set's footprint - the center command from a previous install: an update, not a move-in
                $ours = (Test-Path -LiteralPath (Join-Path $HOME '.local/bin/center')) -or
                        (Test-Path -LiteralPath (Join-Path $HOME '.local/bin/center.cmd'))
                if ($ours) {
                    Write-Host ''
                    Write-Host 'the set is already installed on this machine - not removing anything.'
                    Write-Host '  update in place:         install.ps1 -Update'
                    Write-Host '  reinstall from scratch:  install.ps1 -Reset   (ours only; foreign files untouched)'
                    Write-Elapsed
                    exit 1
                }
                Write-Host ''
                Write-Host 'agent environment already present - installing beside, removing nothing.'
                $Beside = $true
            }
        }
        Write-Step 'install (center fresh)'
        if ($SkipFresh) {
            Write-Note 'center fresh skipped (-SkipFresh)'
        } else {
            $global:LASTEXITCODE = 0
            if ($Beside) {
                & $script:Center fresh --yes --no-cleanup
            } else {
                & $script:Center fresh --yes
            }
            $prepareCode = $LASTEXITCODE
            if ($prepareCode -eq 0) {
                Write-Ok 'center fresh done'
            } else {
                Write-Warn "center fresh exited with code $prepareCode - carrying on to the stations; the final word belongs to the live check"
            }
        }
    }

    Write-Step 'heavy stations the center does not install: stealth-browser and camoufox'
    $failures = @()
    $stations = @(
        [pscustomobject]@{ Label = 'stealth-setup';     Script = (Join-Path $script:Here 'mcp-station/bin/stealth-setup.ps1');       Arguments = @();          NeedsPwsh7 = $false }
        [pscustomobject]@{ Label = 'camoufox-research'; Script = (Join-Path $script:Here 'camoufox-research/scripts/install.ps1');   Arguments = @();          NeedsPwsh7 = $true }
    )
    foreach ($station in $stations) {
        if (-not (Test-Path -LiteralPath $station.Script)) {
            Write-Fail "$($station.Label): no .ps1 wrapper at $($station.Script)"
            $failures += "$($station.Label): wrapper missing"
            continue
        }
        Write-Host ''
        Write-Host "[>] $($station.Label)"
        try {
            $code = Invoke-StationCommand -Station $station
        } catch {
            $code = -1
            Write-Fail "$($station.Label) threw: $($_.Exception.Message)"
        }
        if ($code -ne 0) {
            Write-Fail "$($station.Label) exited with code $code"
            $failures += "$($station.Label): exit code $code"
        } else {
            Write-Ok "$($station.Label) done"
        }
    }

    Write-Step 'live check (center verify)'
    $script:VerifyText = ''
    $global:LASTEXITCODE = 0
    & $script:Center verify | ForEach-Object {
        Write-Host $_
        $script:VerifyText += "$_`n"
    }
    $verifyCode = $LASTEXITCODE
    $verifyOk = ($script:VerifyText -match $script:FailNeedle)
    if (-not $verifyOk) {
        Write-Note 'first pass found failures - retrying in 20 s (a busy machine can give a false red)'
        Start-Sleep -Seconds 20
        $script:VerifyText = ''
        $global:LASTEXITCODE = 0
        & $script:Center verify | ForEach-Object {
            Write-Host $_
            $script:VerifyText += "$_`n"
        }
        $verifyCode = $LASTEXITCODE
        $verifyOk = ($script:VerifyText -match $script:FailNeedle)
    }

    Write-Host ''
    if ($verifyOk -and ($failures.Count -eq 0)) {
        if ($prepareCode -ne 0) { Write-Warn "$modeStep exited with code $prepareCode even though the live check passed - look at its log above" }
        Write-Host "$($script:HomeAlive) - $([int]$script:Clock.Elapsed.TotalSeconds) s - next: provider logins and service keys (see README.md)"
        exit 0
    }

    Write-Host '[X] install finished with failures:'
    if (-not $verifyOk) {
        Write-Host "  - live check: center verify exit $verifyCode, no `"$($script:FailNeedle)`" in its summary"
    }
    foreach ($failure in $failures) { Write-Host "  - $failure" }
    Write-Host "[i] elapsed: $([int]$script:Clock.Elapsed.TotalSeconds) s"
    exit 1
} catch {
    Write-Host ''
    Write-Fail "install stopped: $($_.Exception.Message)"
    Write-Elapsed
    exit 1
}
