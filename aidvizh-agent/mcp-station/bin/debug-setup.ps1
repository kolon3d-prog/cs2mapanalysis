#Requires -Version 5.1
<#
.SYNOPSIS
    Debug MCP runtimes for mcp-station: venvs under $HOME\.venvs for frida-mcp,
    mitmproxy-mcp and wireshark-mcp - the Windows twin of bin/debug-setup.sh.

.DESCRIPTION
    The Unix twin also builds bpftrace-mcp-server and the lldb bridge; neither has a Windows
    counterpart (eBPF is Linux-only, and LLVM 22 lldb-mcp on Windows is not a stdio server yet).
    Idempotent: an existing venv is left alone. System tools are not installed - the script
    checks and prints what to get.

    Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and mangles
    non-ASCII.

.EXAMPLE
    pwsh -File bin/debug-setup.ps1
    pwsh -File bin/debug-setup.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$AgentHome = if ($env:MCP_STATION_HOME) { $env:MCP_STATION_HOME } else { $HOME }

function Say([string] $Text) { Write-Host $Text }
function Have([string] $Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

$missing = @()
foreach ($tool in @('gdb', 'tshark')) {
    if (-not (Have $tool)) { $missing += $tool }
}
if ($missing.Count -gt 0) {
    Say "missing system tools: $($missing -join ', ')"
    Say '  gdb    - MSYS2/MinGW-w64 toolchain (pacman -S mingw-w64-x86_64-gdb) or your toolchain gdb'
    Say '  tshark - Wireshark installer (keep "tshark" in PATH), then: wireshark-mcp works'
}

if (-not (Have 'uv')) {
    Say 'no uv: winget install astral-sh.uv  (or: scoop install uv)'
    exit 1
}

function New-Venv([string] $Name, [string] $Python, [string[]] $Packages) {
    $dir = Join-Path $AgentHome ".venvs\$Name"
    $exe = Join-Path $dir "Scripts\$Name.exe"
    if (Test-Path $exe) { Say "$Name : already built"; return }
    if (-not $PSCmdlet.ShouldProcess($dir, "uv venv + pip install $($Packages -join ' ')")) { return }
    Say "$Name : building (python $Python)"
    & uv venv $dir --python $Python
    if ($LASTEXITCODE -ne 0) { throw "uv venv failed for $Name" }
    & uv pip install --python (Join-Path $dir 'Scripts\python.exe') @Packages
    if ($LASTEXITCODE -ne 0) { throw "uv pip install failed for $Name" }
}

# Package defaults come from the packages themselves, not from guesses:
#   python 3.12 - mitmproxy-mcp declares Requires-Python >=3.12,<3.14 (PyPI);
#                 frida publishes no cp314 wheels, so uv fetches 3.12
#   mcp<2       - frida_mcp/cli.py:11 imports mcp.server.fastmcp (gone in mcp 2.x)
#   wireshark-mcp asks for mcp>=2.1.1,<3 itself, so it is installed without a pin
New-Venv 'frida-mcp'     '3.12' @('frida', 'frida-mcp', 'mcp<2')
New-Venv 'mitmproxy-mcp' '3.12' @('mitmproxy-mcp')
New-Venv 'wireshark-mcp' '3.12' @('wireshark-mcp')

# wireshark-mcp 3.x fails closed on file-creating tools without WIRESHARK_MCP_ALLOWED_DIRS,
# and there is no bash on Windows to export it - so the entry calls this .cmd shim.
$shim = Join-Path $AgentHome '.local\bin\wireshark-mcp.cmd'
if (-not (Test-Path $shim)) {
    if ($PSCmdlet.ShouldProcess($shim, 'write cmd shim (allowed dirs + serve)')) {
        New-Item -ItemType Directory -Force -Path (Split-Path $shim) | Out-Null
        $body = @(
            '@echo off'
            'rem mcp-station: capture/output roots = the user profile, then run the server'
            'set "WIRESHARK_MCP_ALLOWED_DIRS=%USERPROFILE%"'
            '"%USERPROFILE%\.venvs\wireshark-mcp\Scripts\wireshark-mcp.exe" serve %*'
        ) -join "`r`n"
        Set-Content -Path $shim -Value $body -Encoding ASCII
        Say "wireshark shim: $shim"
    }
}

Say 'done. next: bin/mcp-station.ps1 install gdb frida-mcp mitmproxy-mcp wireshark-mcp'
