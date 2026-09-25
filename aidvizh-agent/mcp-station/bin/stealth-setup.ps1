#Requires -Version 5.1
<#
.SYNOPSIS
    Install stealth-browser-mcp (nodriver) - the only catalog server that is built from git.

.DESCRIPTION
    PowerShell twin of bin/stealth-setup.sh, works on Windows and on Linux/macOS pwsh.
    Idempotent: an existing clone is only updated.

    git and uv are both required and are checked up front - the failure is loud and says what
    to install. uv is used because python 3.14 cannot build the nodriver dependencies, so uv
    fetches and pins python 3.13 for the venv.

    -WhatIf prints the plan, checks git/uv and changes nothing.

    Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and mangles
    non-ASCII.

.EXAMPLE
    pwsh -File bin/stealth-setup.ps1
    pwsh -File bin/stealth-setup.ps1 -WhatIf
    pwsh -File bin/stealth-setup.ps1 -Dir D:\agents\mcp\stealth-browser-mcp
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output, the script returns no pipeline data.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $Dir = '',
    [string] $Repo = 'https://github.com/vibheksoni/stealth-browser-mcp.git'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Text) Write-Host "== $Text" }
function Write-Ok { param([string] $Text) Write-Host "   [ok] $Text" -ForegroundColor DarkGray }
function Write-Plan { param([string] $Text) Write-Host "   [plan] $Text" -ForegroundColor DarkGray }
function Write-Fail { param([string] $Text) Write-Host "[X] $Text" -ForegroundColor Red }

# $IsWindows/$IsLinux exist in pwsh 6+; on Windows PowerShell 5.1 they are undefined and
# StrictMode would throw, so the platform check is done through .NET.
$onWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT

try {
    $dest = $Dir
    if (-not $dest) { $dest = $env:STEALTH_DIR }
    if (-not $dest) { $dest = Join-Path (Join-Path (Join-Path $HOME '.agents') 'mcp') 'stealth-browser-mcp' }
    $dest = [System.IO.Path]::GetFullPath($dest)

    $venvDir = Join-Path $dest 'venv'
    if ($onWindows) { $venvBin = 'Scripts/python.exe' } else { $venvBin = 'bin/python' }
    $venvPython = Join-Path $venvDir $venvBin
    $requirements = Join-Path $dest 'requirements.txt'
    $server = Join-Path (Join-Path $dest 'src') 'server.py'

    Write-Step 'prerequisites'
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        Write-Fail 'stealth-setup: git not found - install git (winget install Git.Git / dnf install git) and retry'
        exit 1
    }
    Write-Ok "git: $($git.Source)"

    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) {
        Write-Fail 'stealth-setup: uv not found.'
        if ($onWindows) {
            Write-Fail '  install: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
        } else {
            Write-Fail '  install: curl -fsSL https://astral.sh/uv/install.sh | sh'
        }
        Write-Fail '  uv is required because python 3.14 cannot build the nodriver dependencies; uv fetches 3.13 itself.'
        exit 1
    }
    Write-Ok "uv: $($uv.Source)"

    $cloned = Test-Path -LiteralPath (Join-Path $dest '.git')
    if ((Test-Path -LiteralPath $dest) -and -not $cloned) {
        throw "$dest exists but is not a git clone - move it away or pass -Dir elsewhere"
    }

    Write-Step "target: $dest"
    if (-not $cloned) {
        if ($PSCmdlet.ShouldProcess($dest, "git clone $Repo")) {
            & $git.Source clone --depth 1 $Repo $dest
            if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)" }
            Write-Ok 'cloned'
        } else {
            Write-Plan "git clone --depth 1 $Repo $dest"
        }
    } else {
        if ($PSCmdlet.ShouldProcess($dest, 'git pull --ff-only --depth 1')) {
            & $git.Source -C $dest pull --ff-only --depth 1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }
            Write-Ok 'repository updated'
        } else {
            Write-Plan "git -C $dest pull --ff-only --depth 1"
        }
    }

    Write-Step 'venv and dependencies (python 3.13)'
    if (Test-Path -LiteralPath $venvPython) {
        Write-Ok "venv: $venvDir"
    } elseif ($PSCmdlet.ShouldProcess($venvDir, 'uv venv --python 3.13')) {
        & $uv.Source venv --python 3.13 $venvDir
        if ($LASTEXITCODE -ne 0) { throw "uv venv failed (exit $LASTEXITCODE)" }
        if (-not (Test-Path -LiteralPath $venvPython)) { throw "venv was not created: $venvPython" }
        Write-Ok "venv: $venvDir"
    } else {
        Write-Plan "uv venv --python 3.13 $venvDir"
    }

    if ($PSCmdlet.ShouldProcess($requirements, 'uv pip install -r requirements.txt')) {
        & $uv.Source pip install -q -r $requirements --python $venvPython
        if ($LASTEXITCODE -ne 0) { throw "uv pip install failed (exit $LASTEXITCODE)" }
        Write-Ok 'dependencies installed'
    } else {
        Write-Plan "uv pip install -q -r $requirements --python $venvPython"
    }

    Write-Step 'check'
    $probe = 'import nodriver, fastmcp; print("nodriver and fastmcp are importable")'
    if ($PSCmdlet.ShouldProcess($venvPython, 'import nodriver, fastmcp')) {
        & $venvPython -c $probe
        if ($LASTEXITCODE -ne 0) { throw "import check failed - dependencies are not usable (exit $LASTEXITCODE)" }
        Write-Ok 'nodriver and fastmcp are in place'
    } else {
        Write-Plan "& '$venvPython' -c '$probe'"
    }

    Write-Host ''
    if ($WhatIfPreference) {
        Write-Host '[i] plan only (-WhatIf): nothing was changed'
        exit 0
    }
    Write-Host "[OK] done: $venvPython $server"
    exit 0
} catch {
    Write-Warning "Error: $_"
    exit 1
}
