#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    skills-hub disk check on Windows: doctor, the hub test suite, the center, the docs gate.

.DESCRIPTION
    PowerShell twin of contrib/skills-hub-check.sh (the hourly systemd unit / cron entry on Linux).
    It runs what is cross-platform here: skills-manager.ps1 doctor, the hub bats suite when bats is
    present, the center (status, doctor, outdated, verify) and the docs gate through bash when Git
    Bash is available. -Quick skips the slow and live steps (bats, center outdated/verify, docs gate).
    Unix-only parts are named, never faked: the systemd unit and its timer live in
    contrib/install-units.sh, and the neighbor station suites are POSIX bats suites run by
    `center check` under bash. The script itself lives in the hub, so a missing skills-manager.ps1 is
    a broken install, not an absent disk: it is reported as "not in place" and exits 1 visibly.
    Output is ASCII on purpose: Windows PowerShell mangles non-ASCII .ps1 sources.

.EXAMPLE
    pwsh -File contrib/skills-hub-check.ps1
    pwsh -File contrib/skills-hub-check.ps1 -Quick
#>
[CmdletBinding()]
param(
    [switch] $Quick
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Hub = [System.Environment]::GetEnvironmentVariable('SKILLS_HUB_DIR')
if (-not $Hub) { $Hub = Split-Path -Parent $PSScriptRoot }
$CenterDir = [System.Environment]::GetEnvironmentVariable('SKILLS_CENTER_DIR')
if (-not $CenterDir) { $CenterDir = Join-Path (Split-Path -Parent $Hub) 'command-center' }
$PwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $PwshExe) { $PwshExe = Join-Path $PSHOME 'pwsh' }

function Emit {
    param([string] $Text)
    [Console]::Out.WriteLine($Text)
}

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)][string] $File,
        [string[]] $Arguments = @(),
        [int] $TimeoutSeconds = 0
    )
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $File
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($info)
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    $timedOut = $false
    if ($TimeoutSeconds -gt 0) {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            try { $process.Kill($true) } catch { }
            try { $process.WaitForExit() } catch { }
        }
    } else {
        $process.WaitForExit()
    }
    return [pscustomobject]@{
        ExitCode = if ($timedOut) { 124 } else { $process.ExitCode }
        Out      = $outTask.GetAwaiter().GetResult()
        Err      = $errTask.GetAwaiter().GetResult()
        TimedOut = $timedOut
    }
}

function Get-JsonField {
    param($Document, [string] $Name)
    if ($null -eq $Document) { return $null }
    $property = $Document.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Get-FirstLine {
    param([string] $Text)
    if (-not $Text) { return '' }
    return (($Text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
}

if (-not (Test-Path -LiteralPath (Join-Path $Hub 'skills-manager.ps1'))) {
    Emit "skills-hub is not in place: $Hub"
    exit 1
}

Set-Location $Hub
$status = 0

Emit '== doctor'
$doctor = Invoke-External -File $PwshExe -Arguments @('-NoProfile', '-File', (Join-Path $Hub 'skills-manager.ps1'), 'doctor')
Emit $doctor.Out.TrimEnd()
if ($doctor.Err) { [Console]::Error.Write($doctor.Err) }
if ($doctor.ExitCode -ne 0) { $status = 1 }

# Skill spec (agentskills.io): errors fail the run, warnings are only in the summary line.
Emit ''
Emit '== spec-check: skill collection (agentskills.io)'
$specScript = Join-Path $Hub 'contrib/check-spec.mjs'
$collection = Join-Path (Split-Path -Parent $Hub) 'skills-station/collection'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ((Test-Path -LiteralPath $specScript) -and (Test-Path -LiteralPath $collection) -and $node) {
    $spec = Invoke-External -File $node -Arguments @($specScript, $collection, '--quiet')
    Emit $spec.Out.TrimEnd()
    if ($spec.Err) { [Console]::Error.Write($spec.Err) }
    if ($spec.ExitCode -ne 0) { $status = 1 }
} else {
    Emit 'node or the collection is unavailable - skipped'
}

if (-not $Quick) {
    Emit ''
    Emit '== bats: skills-hub'
    $bats = (Get-Command bats -ErrorAction SilentlyContinue).Source
    if ($bats) {
        $suite = Invoke-External -File $bats -Arguments @('tests/hub.bats')
        Emit $suite.Out.TrimEnd()
        if ($suite.Err) { [Console]::Error.Write($suite.Err) }
        if ($suite.ExitCode -ne 0) { $status = 1 }
    } else {
        Emit 'bats is not installed - the hub suite was skipped (install bats to run it)'
        $status = 1
    }
}

Emit ''
Emit '== center'
$center = Join-Path $CenterDir 'bin/center.ps1'
if (-not (Test-Path -LiteralPath $center)) {
    Emit "command-center not found ($CenterDir) - skipped"
} elseif ($Quick) {
    Emit 'quick pass: center status/doctor/outdated/verify skipped'
} else {
    foreach ($step in @('status', 'doctor')) {
        $run = Invoke-External -File $PwshExe -Arguments @('-NoProfile', '-File', $center, $step) -TimeoutSeconds 300
        Emit $run.Out.TrimEnd()
        if ($run.Err) { [Console]::Error.Write($run.Err) }
        if ($run.ExitCode -ne 0) { $status = 1 }
        Emit ''
    }

    # outdated: the center asks every project what it declares - the summary is what the hourly log wants
    $outdated = Invoke-External -File $PwshExe -Arguments @('-NoProfile', '-File', $center, 'outdated', '--json') -TimeoutSeconds 300
    if ($outdated.ExitCode -eq 0 -and $outdated.Out.Trim()) {
        try {
            $rows = @((Get-JsonField ($outdated.Out | ConvertFrom-Json) 'projects'))
            $drift = @($rows | Where-Object { (Get-JsonField $_ 'status') -eq 'updates' })
            $current = @($rows | Where-Object { (Get-JsonField $_ 'status') -eq 'current' })
            $unknown = @($rows | Where-Object { (Get-JsonField $_ 'status') -eq 'unknown' })
            Emit "outdated: $($drift.Count) - current: $($current.Count) - no machine check: $($unknown.Count)"
            foreach ($row in $drift) { Emit "  * $(Get-JsonField $row 'name'): $(Get-JsonField $row 'detail')" }
            Emit 'update: center update   (plan: center update --dry-run all)'
        } catch {
            Emit "outdated: the center answer was not parsed - see center outdated by hand ($($_.Exception.Message))"
        }
    } else {
        Emit 'outdated: the center did not answer - skipped'
    }

    Emit ''
    # live MCP check: real servers are spawned (some start a browser), so it is its own step and the
    # timeout is capped - otherwise one hung server would hold the hourly run for minutes
    $verify = Invoke-External -File $PwshExe -Arguments @('-NoProfile', '-File', $center, 'verify', '--json', '--timeout', '8') -TimeoutSeconds 180
    if ($verify.Out.Trim()) {
        try {
            $document = $verify.Out | ConvertFrom-Json
            $mcp = Get-JsonField $document 'mcp'
            $parts = [System.Collections.Generic.List[string]]::new()
            $failed = 0
            foreach ($name in @('omp', 'opencode', 'pi')) {
                $row = Get-JsonField $mcp $name
                if ($null -eq $row) { $parts.Add("$name -"); continue }
                $good = [int](Get-JsonField $row 'connected')
                $bad = [int](Get-JsonField $row 'failed')
                $parts.Add("$name $good/$($good + $bad)")
                $failed += $bad
            }
            $missing = [int](Get-JsonField (Get-JsonField $document 'summary') 'harness_missing')
            Emit "MCP: $($parts -join ' - ')"
            $errorText = Get-JsonField $document 'error'
            $ok = Get-JsonField $document 'ok'
            if ($errorText) {
                Emit "MCP: FAIL - $errorText"
                $status = 1
            } elseif ($failed -or $missing -or -not $ok) {
                Emit "MCP: FAIL - servers that did not answer: $failed, harnesses missing: $missing (details: center verify)"
                $status = 1
            }
        } catch {
            Emit "MCP: the center answer was not parsed - see center verify by hand ($($_.Exception.Message))"
            $status = 1
        }
    } else {
        Emit 'MCP: the center did not answer - skipped (check: center verify)'
        $status = 1
    }
}

Emit ''
Emit '== docs gate'
$docsCheck = Join-Path $CenterDir 'bin/docs-check.sh'
$bash = (Get-Command bash -ErrorAction SilentlyContinue).Source
if ($Quick) {
    Emit 'quick pass: docs gate skipped'
} elseif (-not (Test-Path -LiteralPath $docsCheck)) {
    Emit "docs gate not found ($docsCheck) - skipped"
} elseif (-not $bash) {
    Emit 'the docs gate is a bash script: needs bash (Git Bash or WSL) - skipped'
} else {
    $gate = Invoke-External -File $bash -Arguments @($docsCheck) -TimeoutSeconds 300
    Emit $gate.Out.TrimEnd()
    if ($gate.Err) { [Console]::Error.Write($gate.Err) }
    if ($gate.ExitCode -ne 0) { $status = 1 }
}

Emit ''
Emit '== Unix-only parts (named, not faked)'
Emit '[!] the hourly timer is a systemd user unit: contrib/install-units.sh writes it (Linux only).'
Emit '    On Windows schedule this script instead, for example:'
Emit "    schtasks /Create /SC HOURLY /TN skills-hub-check /TR `"pwsh -NoProfile -File $Hub\contrib\skills-hub-check.ps1`""
Emit '[!] cron is the other Unix-only path: the same job, contrib/skills-hub-check.sh in one line.'
Emit '[!] neighbor station suites (sysprompt, mcp-station, cli-station, ...) are POSIX bats suites:'
Emit '    center check runs them under bash (Git Bash on Windows); this script checks the hub itself.'
if ($Quick) {
    Emit '[!] -Quick: bats, center outdated/verify and the docs gate were skipped.'
}

Emit ''
if ($status -eq 0) {
    Emit 'skills-hub: check passed'
} else {
    Emit 'skills-hub: PROBLEMS (see above)'
}
exit $status
