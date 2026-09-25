#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    PowerShell tests for the hub's .ps1 scripts (no Pester: plain asserts, exit 1 on failure).

.DESCRIPTION
    Offline, like the bats suite: the HTTP indexes are served by tests/market-server.mjs, npx/gh/
    skills come from tests/stubs (the same bash stubs the bats suite uses), HOME is a temp directory -
    real ~/.agents, real links and the network are never touched.
    Covered: usage/sources, skills-sh search over the native HTTP path (sort, --limit, --json, empty),
    skillsmp ranking with duplicate collapse, --source all dedupe, list/install/fetch through the CLI
    stubs, --source auto both ways, unknown source/flag, doctor on an empty HOME, the npx timeout,
    the link installer (status/install/idempotence/dry-run/remove), the path scanner (clean tree,
    dirty tree, path-guard marker, collection skip) and the hourly check (hub without its manager,
    -Quick).
    Run directly (pwsh -File tests/hub-ps1.ps1) or through tests/hub.bats.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Hub = Split-Path -Parent $PSScriptRoot
$Manager = Join-Path $Hub 'skills-manager.ps1'
$LinkScript = Join-Path $Hub 'contrib/install-links.ps1'
$PathScript = Join-Path $Hub 'contrib/check-paths.ps1'
$HourlyScript = Join-Path $Hub 'contrib/skills-hub-check.ps1'
$MarketServer = Join-Path $Hub 'tests/market-server.mjs'
$PwshPath = (Get-Command pwsh).Source

# "clean" in Russian: the bash scanner prints this verdict word and other stations' tests grep it, so
# the port has to keep it. Built from code points on purpose - this file stays pure ASCII.
$CleanVerdict = -join [char[]]@(0x447, 0x438, 0x441, 0x442, 0x43E)

$script:Failed = 0

function Assert-That {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param($Expected, $Actual, [string] $Message)
    if ("$Expected" -ne "$Actual") { throw "$Message - expected '$Expected', got '$Actual'" }
}

function Assert-Contains {
    param([string] $Text, [string] $Needle, [string] $Message)
    if ($Text -notlike "*$Needle*") { throw "$Message - '$Needle' not found in: $($Text.Trim())" }
}

function Assert-NotContains {
    param([string] $Text, [string] $Needle, [string] $Message)
    if ($Text -like "*$Needle*") { throw "$Message - '$Needle' unexpectedly present in: $($Text.Trim())" }
}

function Assert-Match {
    param([string] $Text, [string] $Pattern, [string] $Message)
    if ($Text -notmatch $Pattern) { throw "$Message - /$Pattern/ not found in: $($Text.Trim())" }
}

function Assert-Lines {
    param([string] $Text, [int] $Count, [string] $Message)
    $lines = @($Text.TrimEnd() -split "`r?`n")
    if ($lines.Count -ne $Count) { throw "$Message - expected $Count line(s), got $($lines.Count): $($Text.Trim())" }
}

function Test-Case {
    param([string] $Name, [scriptblock] $Body)
    try {
        & $Body
        [Console]::Out.WriteLine("[OK] $Name")
    } catch {
        $script:Failed++
        [Console]::Out.WriteLine("[X]  $Name - $($_.Exception.Message)")
    }
}

# ------------------------------------------------------------ isolated world

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('skills-hub-ps1-' + [guid]::NewGuid().ToString('N'))
$FakeHome = Join-Path $root 'home'
$work = Join-Path $root 'work'
New-Item -ItemType Directory -Path $FakeHome, $work -Force | Out-Null

# $env:HOME is read-only on Unix (it is the same variable as $HOME), so the child processes get the
# temp home through the environment API - the suite itself never needs the fake home in $HOME.
[System.Environment]::SetEnvironmentVariable('HOME', $FakeHome)
$env:FIXTURES = Join-Path $Hub 'tests/fixtures'
$env:STUB_LOG = Join-Path $root 'stub.log'
New-Item -ItemType File -Path $env:STUB_LOG -Force | Out-Null
$env:PATH = (Join-Path $Hub 'tests/stubs') + [System.IO.Path]::PathSeparator + $env:PATH
foreach ($name in @('STUB_SLEEP', 'FIXTURE_SEARCH', 'FIXTURE_SKILLSMP', 'SKILLS_TIMEOUT', 'SKILLS_HTTP_TIMEOUT',
        'SKILLS_API_URL', 'SKILLSMP_API_URL', 'SKILLS_HUB_DIR', 'SKILLS_CENTER_DIR')) {
    Remove-Item -Path ("Env:" + $name) -ErrorAction SilentlyContinue
}
Set-Location $work

function Start-MarketServer {
    param([hashtable] $Environment = @{})
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command node).Source
    $info.ArgumentList.Add($MarketServer)
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment['FIXTURES'] = $env:FIXTURES
    foreach ($key in $Environment.Keys) { $info.Environment[$key] = $Environment[$key] }
    $process = [System.Diagnostics.Process]::Start($info)
    $line = $process.StandardOutput.ReadLine()
    if ($line -notmatch '^PORT=(\d+)$') {
        throw "market-server did not start: $line $($process.StandardError.ReadToEnd())"
    }
    return [pscustomobject]@{ Process = $process; Url = "http://127.0.0.1:$($Matches[1])" }
}

$api = Start-MarketServer
$apiEmpty = Start-MarketServer -Environment @{ FIXTURE_SEARCH = 'skills-sh-empty.json' }
$env:SKILLS_API_URL = $api.Url
$env:SKILLSMP_API_URL = $api.Url

function Invoke-Script {
    param([string] $Script, [string[]] $Arguments = @(), [hashtable] $Environment = @{})
    # previous values are restored, not blindly removed: the suite itself keeps SKILLS_API_URL set
    $previous = @{}
    foreach ($key in $Environment.Keys) {
        $previous[$key] = [System.Environment]::GetEnvironmentVariable($key)
        [System.Environment]::SetEnvironmentVariable($key, $Environment[$key])
    }
    try {
        $text = (& $PwshPath -NoProfile -File $Script @Arguments 2>&1 | Out-String)
        $code = $LASTEXITCODE
    } finally {
        foreach ($key in $Environment.Keys) { [System.Environment]::SetEnvironmentVariable($key, $previous[$key]) }
    }
    return [pscustomobject]@{ Text = $text; Code = $code }
}

function Invoke-Manager {
    param([string[]] $Arguments, [hashtable] $Environment = @{})
    return Invoke-Script -Script $Manager -Arguments $Arguments -Environment $Environment
}

# --------------------------------------------------------------------- tests

Test-Case 'help: usage lists every command' {
    $result = Invoke-Manager @('help')
    Assert-Equal 0 $result.Code 'exit code'
    foreach ($word in @('search <query>', 'inspect <pkg>', 'install <pkg>', 'check-spec', 'list', 'doctor', 'sources')) {
        Assert-Contains $result.Text $word 'usage line'
    }
}

Test-Case 'check-spec: valid skill passes, a wrong name fails' {
    $specRoot = Join-Path $work 'spec'
    $goodDir = Join-Path $specRoot 'good'
    New-Item -ItemType Directory -Path $goodDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $goodDir 'SKILL.md') -Value ("---`nname: good`ndescription: Use when checking the spec - a valid skill.`n---`n`nbody`n")

    $good = Invoke-Manager @('check-spec', $specRoot)
    Assert-Equal 0 $good.Code 'a valid skill should pass'
    Assert-NotContains $good.Text 'FAIL' 'no FAIL lines for a valid skill'

    $badDir = Join-Path $specRoot 'bad'
    New-Item -ItemType Directory -Path $badDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $badDir 'SKILL.md') -Value ("---`nname: not-the-dir`ndescription: Use when checking the spec.`n---`n`nbody`n")

    $bad = Invoke-Manager @('check-spec', $specRoot)
    Assert-Equal 1 $bad.Code 'a wrong name should fail'
    Assert-Contains $bad.Text 'FAIL' 'a FAIL line for a wrong name'
}

Test-Case 'no arguments: usage and a non-zero exit' {
    $result = Invoke-Manager @()
    Assert-Equal 1 $result.Code 'exit code'
    Assert-Contains $result.Text 'one entry point to skill markets' 'usage banner'
}

Test-Case 'sources: four markets, skills-sh first' {
    $result = Invoke-Manager @('sources')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Lines $result.Text 4 'market list'
    Assert-Match $result.Text '^skills-sh' 'first market'
    foreach ($name in @('github', 'clawhub', 'skillsmp')) { Assert-Contains $result.Text $name 'market' }
}

Test-Case 'search: native HTTP path sorts by installs and honours --limit' {
    $result = Invoke-Manager @('search', 'pdf', '--limit', '2')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Lines $result.Text 4 'result lines'
    Assert-Match $result.Text '^acme/tools@popular  \[900 installs\]' 'most installed first'
    Assert-Match $result.Text '(?m)^  https://skills\.sh/acme/tools/popular$' 'skills.sh link'
    Assert-Match $result.Text '(?m)^vercel-labs/json-render@react-pdf  \[100 installs\]$' 'second result'
}

Test-Case 'search: --json returns the parsed document, sorted and cut' {
    $result = Invoke-Manager @('search', 'pdf', '--json', '--limit', '1')
    Assert-Equal 0 $result.Code 'exit code'
    $document = $result.Text | ConvertFrom-Json
    Assert-Equal 1 @($document.skills).Count 'skills kept'
    Assert-Equal 'popular' $document.skills[0].name 'kept skill'
    Assert-Equal 'pdf' $document.query 'document keeps its other fields'
}

Test-Case 'search: empty answer is one line, not an error' {
    $result = Invoke-Manager @('search', 'nothing-matches-this') -Environment @{ SKILLS_API_URL = $apiEmpty.Url }
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Lines $result.Text 1 'answer'
    Assert-Equal 'nothing found for: nothing-matches-this' $result.Text.Trim() 'answer text'
}

Test-Case 'search: skillsmp ranks by query match and collapses duplicate refs' {
    $result = Invoke-Manager @('search', 'scraper', '--source', 'skillsmp', '--limit', '5')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Match $result.Text '^acme/tools@scraper' 'best match first'
    $dupes = @(($result.Text -split "`r?`n") | Where-Object { $_ -like '*acme/tools@dupe*' })
    Assert-Equal 1 $dupes.Count 'duplicate rows'
}

Test-Case 'search: --sort accepts only stars or recent' {
    $result = Invoke-Manager @('search', 'pdf', '--source', 'skillsmp', '--sort', 'bogus')
    Assert-Equal 1 $result.Code 'exit code'
    Assert-Contains $result.Text '--sort accepts stars or recent' 'explanation'
}

Test-Case 'search --source all: duplicates collapse across markets' {
    $result = Invoke-Manager @('search', 'pdf', '--source', 'all', '--limit', '5')
    Assert-Equal 0 $result.Code 'exit code'
    foreach ($name in @('skills-sh', 'github', 'clawhub', 'skillsmp')) {
        Assert-Contains $result.Text "== $name ==" 'market section'
    }
    $shared = @(($result.Text -split "`r?`n") | Where-Object { $_ -like '*acme/tools@shared*' })
    Assert-Equal 1 $shared.Count 'shared skill kept once'
    Assert-Equal '(duplicates hidden: 1)' (($result.Text.TrimEnd() -split "`r?`n")[-1]) 'hidden counter'
}

Test-Case 'list: global by default, unknown flag is not swallowed' {
    $result = Invoke-Manager @('list')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Contains $result.Text 'Global Skills' 'listing'
    Assert-Contains (Get-Content -LiteralPath $env:STUB_LOG -Raw) 'skills list -g' 'CLI arguments'

    $bad = Invoke-Manager @('list', '--nope')
    Assert-Equal 1 $bad.Code 'exit code'
    Assert-Contains $bad.Text 'unknown flag' 'flag rejection'
}

Test-Case 'list: npx timeout is an error, not a hang' {
    $result = Invoke-Manager @('list') -Environment @{ STUB_SLEEP = '5'; SKILLS_TIMEOUT = '1' }
    Assert-Equal 1 $result.Code 'exit code'
    Assert-Contains $result.Text 'did not answer within 1s' 'timeout message'
}

Test-Case 'inspect --source auto: owner/repo@skill goes to skills-sh' {
    $result = Invoke-Manager @('inspect', 'acme/tools@fixture', '--source', 'auto')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Match $result.Text '^source: skills-sh' 'resolved source'
    Assert-Contains $result.Text 'name: fixture' 'SKILL.md meta'
    Assert-Contains $result.Text '-- dependencies / permissions --' 'digest sections'
}

Test-Case 'inspect --source auto: a slug without a slash goes to clawhub through bash' {
    $result = Invoke-Manager @('inspect', 'fixture-slug', '--source', 'auto')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Match $result.Text '^source: clawhub' 'resolved source'
    Assert-Contains $result.Text 'name: fixture' 'SKILL.md meta'
}

Test-Case 'inspect --full prints the whole SKILL.md' {
    $result = Invoke-Manager @('inspect', 'acme/tools@fixture', '--source', 'skills-sh', '--full')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Contains $result.Text '# fixture' 'body'
    Assert-Contains $result.Text 'description:' 'front matter'
    Assert-NotContains $result.Text '-- meta --' 'digest not used'
}

Test-Case 'install --project: lock and skill folder inside the project' {
    $result = Invoke-Manager @('install', 'acme/tools@fixture', '--project')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Contains $result.Text "locked: $work/skills-lock.json" 'lock line'
    Assert-Contains $result.Text "skill:  $work/.agents/skills/fixture" 'skill line'
    Assert-That (Test-Path -LiteralPath (Join-Path $work '.agents/skills/fixture/SKILL.md')) 'SKILL.md installed'
}

Test-Case 'install --project --source github: folder and SKILL.md' {
    $result = Invoke-Manager @('install', 'acme/tools@shared', '--source', 'github', '--project')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Contains $result.Text "skill:  $work/.agents/skills/shared" 'skill line'
    Assert-That (Test-Path -LiteralPath (Join-Path $work '.agents/skills/shared/SKILL.md')) 'SKILL.md installed'
}

Test-Case 'unknown source and --source auto on search are explained' {
    $bad = Invoke-Manager @('search', 'pdf', '--source', 'bogus')
    Assert-Equal 1 $bad.Code 'exit code'
    Assert-Contains $bad.Text 'unknown source: bogus' 'source rejection'

    $auto = Invoke-Manager @('search', 'pdf', '--source', 'auto')
    Assert-Equal 1 $auto.Code 'exit code'
    Assert-Contains $auto.Text 'auto applies only to inspect/install' 'auto rejection'
}

Test-Case 'doctor: empty HOME gives two FAILs and exit 1' {
    $result = Invoke-Manager @('doctor')
    Assert-Equal 1 $result.Code 'exit code'
    $fails = @(($result.Text -split "`r?`n") | Where-Object { $_ -match 'FAIL' })
    Assert-Equal 2 $fails.Count 'FAIL rows'
    Assert-Contains $result.Text 'doctor: problems 2' 'verdict'
}

Test-Case 'doctor: a complete home reports ok' {
    $made = Invoke-Script -Script $LinkScript -Arguments @('install', '-AgentHome', $FakeHome)
    Assert-Equal 0 $made.Code 'link install'
    $result = Invoke-Manager @('doctor')
    $fails = @(($result.Text -split "`r?`n") | Where-Object { $_ -match 'FAIL' })
    Assert-Equal 0 $fails.Count 'FAIL rows'
}

Test-Case 'install-links: status on a clean home reports both links missing' {
    $fresh = Join-Path $root 'fresh-home'
    New-Item -ItemType Directory -Path $fresh -Force | Out-Null
    $result = Invoke-Script -Script $LinkScript -Arguments @('status', '-AgentHome', $fresh)
    Assert-Equal 1 $result.Code 'exit code'
    $missing = @(($result.Text -split "`r?`n") | Where-Object { $_ -like '*missing*' })
    Assert-Equal 2 $missing.Count 'missing links'
    Assert-Contains $result.Text '.local/bin/skills-manager' 'command link'
    Assert-Contains $result.Text '.agents/skills/skills-ops' 'skill link'
}

Test-Case 'install-links: install, idempotence, status, remove' {
    $target = Join-Path $root 'links-home'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $command = Join-Path $target '.local/bin/skills-manager'
    $skill = Join-Path $target '.agents/skills/skills-ops'

    $created = Invoke-Script -Script $LinkScript -Arguments @('install', '-AgentHome', $target)
    Assert-Equal 0 $created.Code 'exit code'
    Assert-That (Test-Path -LiteralPath $command) 'command link created'
    Assert-That (Test-Path -LiteralPath $skill) 'skill link created'
    Assert-Equal (Join-Path $Hub 'skills-manager.sh') (Get-Item -LiteralPath $command -Force).Target 'command target'
    Assert-Equal $Hub (Get-Item -LiteralPath $skill -Force).Target 'skill target'

    $again = Invoke-Script -Script $LinkScript -Arguments @('install', '-AgentHome', $target)
    Assert-Equal 0 $again.Code 'exit code'
    Assert-Contains $again.Text 'already points here' 'idempotence'

    $status = Invoke-Script -Script $LinkScript -Arguments @('status', '-AgentHome', $target)
    Assert-Equal 0 $status.Code 'exit code'
    Assert-NotContains $status.Text 'missing' 'no missing links'
    Assert-NotContains $status.Text '[X]' 'no failures'

    $removed = Invoke-Script -Script $LinkScript -Arguments @('remove', '-AgentHome', $target)
    Assert-Equal 0 $removed.Code 'exit code'
    Assert-That (-not (Test-Path -LiteralPath $command)) 'command link removed'
    Assert-That (-not (Test-Path -LiteralPath $skill)) 'skill link removed'
    Assert-That (Test-Path -LiteralPath $Manager) 'the hub itself survived remove'
    Assert-Equal 1 (Invoke-Script -Script $LinkScript -Arguments @('status', '-AgentHome', $target)).Code 'status after remove'
}

Test-Case 'install-links -DryRun: nothing is created' {
    $target = Join-Path $root 'dry-home'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $result = Invoke-Script -Script $LinkScript -Arguments @('install', '-AgentHome', $target, '-DryRun')
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Contains $result.Text 'would' 'dry-run wording'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $target '.local/bin/skills-manager'))) 'command link not created'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $target '.agents/skills/skills-ops'))) 'skill link not created'
}

Test-Case 'check-paths: the hub tree is clean' {
    $result = Invoke-Script -Script $PathScript
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Match $result.Text "^check-paths: $([regex]::Escape($CleanVerdict)) \(" 'verdict line'
}

Test-Case 'check-paths: flags user paths, honours path-guard and skips collection' {
    # The patterns are assembled from characters on purpose: a literal one here would make the hub
    # itself dirty for contrib/check-paths.sh, which the hub and every neighbor station run.
    $slash = [string][char]47
    $backslash = [string][char]92
    $dollar = [string][char]36
    $flagged = @(
        "home = ${slash}home${slash}alice${slash}project"
        "param = ${slash}home${slash}${dollar}USER${slash}DATA"
        "braced = ${slash}run${slash}media${slash}${dollar}{USER}${slash}disk"
        "winparam = C:${backslash}Users${backslash}%USERNAME%${backslash}app"
        "placeholder = ${slash}home${slash}<user>${slash}project"
        "unit = ${slash}run${slash}media${slash}disk${slash}skills-hub   # path-guard: ok"
        "win = C:${backslash}Users${backslash}Bob${backslash}app"
    )
    $dirty = Join-Path $root 'dirty'
    New-Item -ItemType Directory -Path (Join-Path $dirty 'sub'), (Join-Path $dirty 'collection') -Force | Out-Null
    $file = Join-Path $dirty 'sub/notes.txt'
    Set-Content -LiteralPath $file -Value $flagged
    Set-Content -LiteralPath (Join-Path $dirty 'collection/vendor.md') -Value "copy = ${slash}home${slash}bob${slash}secret"

    $result = Invoke-Script -Script $PathScript -Arguments @($dirty)
    Assert-Equal 1 $result.Code 'exit code'
    Assert-Contains $result.Text ("{0}:1:{1}" -f $file, $flagged[0]) 'first hit'
    # a parameterized path is the same finding as a literal one (the old pattern let it through)
    Assert-Contains $result.Text ("{0}:2:{1}" -f $file, $flagged[1]) 'dollar hit'
    Assert-Contains $result.Text ("{0}:3:{1}" -f $file, $flagged[2]) 'braced hit'
    Assert-Contains $result.Text ("{0}:4:{1}" -f $file, $flagged[3]) 'percent hit'
    Assert-Contains $result.Text ("{0}:7:{1}" -f $file, $flagged[6]) 'windows hit'
    Assert-NotContains $result.Text 'placeholder' 'placeholder line'
    Assert-NotContains $result.Text 'unit = ' 'guarded line'
    Assert-NotContains $result.Text 'collection' 'skipped directory'
    Assert-Contains $result.Text 'path-guard: ok"' 'hint mentions the marker'
}

Test-Case 'hourly check: a hub without its manager is reported, not skipped silently' {
    $empty = Join-Path $root 'no-hub'
    New-Item -ItemType Directory -Path $empty -Force | Out-Null
    $result = Invoke-Script -Script $HourlyScript -Environment @{ SKILLS_HUB_DIR = $empty }
    Assert-Equal 1 $result.Code 'exit code (broken install must fail visibly)'
    Assert-Contains $result.Text 'not in place' 'contract line'
    Assert-Contains $result.Text $empty 'the path is named'
}

Test-Case 'hourly check: -Quick runs doctor, skips the slow parts and names Unix-only ones' {
    $empty = Join-Path $root 'no-center'
    $bare = Join-Path $root 'hourly-home'
    New-Item -ItemType Directory -Path $empty, $bare -Force | Out-Null
    $result = Invoke-Script -Script $HourlyScript -Arguments @('-Quick') -Environment @{ SKILLS_CENTER_DIR = $empty; HOME = $bare }
    Assert-Equal 1 $result.Code 'exit code (empty HOME has no links)'
    Assert-Contains $result.Text '== doctor' 'doctor step'
    Assert-Contains $result.Text 'doctor: problems' 'doctor verdict'
    Assert-Contains $result.Text 'command-center not found' 'center skip'
    Assert-Contains $result.Text 'systemd' 'Unix-only note'
    Assert-Contains $result.Text 'PROBLEMS' 'verdict'
    Assert-NotContains $result.Text '== bats' 'bats skipped by -Quick'
}

# ------------------------------------------------------------------- cleanup

foreach ($server in @($api, $apiEmpty)) {
    try { $server.Process.Kill($true) } catch { }
}
Set-Location $Hub
try { Remove-Item -LiteralPath $root -Recurse -Force } catch { }

if ($script:Failed -gt 0) {
    [Console]::Out.WriteLine("ps1 tests: $($script:Failed) failed")
    exit 1
}
[Console]::Out.WriteLine('ps1 tests: ok')
exit 0
