#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    skills-hub on Windows: search, inspect, install, check-spec, list, doctor, sources.

.DESCRIPTION
    PowerShell twin of skills-manager.sh, native where the base really works on Windows:
      skills-sh  - the skills.sh HTTP API for search, the npx skills CLI for fetch/install/list
      github     - the gh skill CLI
      skillsmp   - the SkillsMP HTTP API (index only)
    clawhub is not re-implemented: it runs markets/clawhub.sh through bash (Git Bash or WSL), so the
    adapter stays the single implementation. No bash -> one honest line, never a stack trace.
    Output is ASCII on purpose: Windows PowerShell mangles non-ASCII .ps1 sources.
    Timeouts: SKILLS_TIMEOUT for npx/gh (default 180s), SKILLS_HTTP_TIMEOUT for the indexes (default 30s).

.EXAMPLE
    pwsh -File skills-manager.ps1 search pdf --limit 5
    pwsh -File skills-manager.ps1 search pdf --source all
    pwsh -File skills-manager.ps1 inspect acme/tools@pdf --full
    pwsh -File skills-manager.ps1 install acme/tools@pdf --project
    pwsh -File skills-manager.ps1 check-spec
    pwsh -File skills-manager.ps1 list
    pwsh -File skills-manager.ps1 doctor
    pwsh -File skills-manager.ps1 sources
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Command,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Rest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) { $Root = $PSScriptRoot }
$Markets = Join-Path $Root 'markets'
$DefaultSource = 'skills-sh'
$SourcesOrder = @('skills-sh', 'github', 'clawhub', 'skillsmp')
$SectionLines = 20

$script:WorkDirs = [System.Collections.Generic.List[string]]::new()

# ------------------------------------------------------------------ output

function Emit {
    param([string] $Text)
    [Console]::Out.WriteLine($Text)
}

function Emit-Lines {
    param([string[]] $Lines)
    foreach ($line in $Lines) {
        if ($null -eq $line) { continue }
        foreach ($part in ($line -split "`r?`n")) { [Console]::Out.WriteLine($part) }
    }
}

function Write-Err {
    param([string] $Text)
    [Console]::Error.WriteLine($Text)
}

function Fail {
    param([string] $Message)
    throw $Message
}

function Die {
    param([string] $Message)
    [Console]::Error.WriteLine("skills-manager: $Message")
    exit 1
}

# ----------------------------------------------------------------- helpers

function Get-TimeoutSetting {
    param([string] $Name, [int] $Default)
    $raw = [System.Environment]::GetEnvironmentVariable($Name)
    if ($raw -match '^\d+$') { return [int]$raw }
    return $Default
}

function Remove-Ansi {
    param([string] $Text)
    if (-not $Text) { return '' }
    return ($Text -replace ([string][char]27 + '\[[0-9;?]*[a-zA-Z]'), '')
}

function New-WorkDir {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('skills-manager-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $script:WorkDirs.Add($dir)
    return $dir
}

function Remove-WorkDirs {
    foreach ($dir in $script:WorkDirs) {
        try {
            if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
        } catch { }
    }
}

function Get-JsonProperty {
    param($Document, [string] $Name)
    if ($null -eq $Document) { return $null }
    if ($Document -is [System.Collections.IDictionary]) {
        if ($Document.Contains($Name)) { return $Document[$Name] }
        return $null
    }
    $property = $Document.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)][string] $File,
        [string[]] $Arguments = @(),
        [int] $TimeoutSeconds = 0,
        [switch] $Stream
    )
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $File
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    if (-not $Stream) {
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
    }
    $process = [System.Diagnostics.Process]::Start($info)
    if ($Stream) {
        $process.WaitForExit()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Out = ''; Err = ''; TimedOut = $false }
    }
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

function Get-ToolPath {
    param([string] $Name, [string[]] $Alternatives = @())
    foreach ($candidate in @($Name) + $Alternatives) {
        $found = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($found) { return $found.Source }
    }
    return ''
}

function Get-Json {
    param([string] $Uri, [string] $Label)
    try {
        return Invoke-RestMethod -Uri $Uri -TimeoutSec $HttpTimeout -ErrorAction Stop
    } catch {
        Fail "$Label request failed (timeout ${HttpTimeout}s - raise SKILLS_HTTP_TIMEOUT): $($_.Exception.Message)"
    }
}

function Get-FirstLine {
    param([string] $Text)
    if (-not $Text) { return '' }
    return (($Text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
}

function Get-SplitLines {
    param([string] $Text)
    if (-not $Text) { return @() }
    return @($Text -split "`r?`n")
}

function Get-ApiBase {
    param([string] $Name, [string] $Default)
    $value = [System.Environment]::GetEnvironmentVariable($Name)
    if ($value) { return $value.TrimEnd('/') }
    return $Default
}

$CliTimeout = Get-TimeoutSetting 'SKILLS_TIMEOUT' 180
$HttpTimeout = Get-TimeoutSetting 'SKILLS_HTTP_TIMEOUT' 30

function Show-Usage {
    Emit 'skills-manager: one entry point to skill markets'
    Emit ''
    Emit '  search <query> [--source NAME] [adapter flags]'
    Emit '      skills-sh by default; --source all queries every market and collapses duplicates'
    Emit '  inspect <pkg> [--source NAME|auto] [--full]'
    Emit '      SKILL.md digest: name, description, permissions, dependencies/install; --full prints all'
    Emit '  install <pkg> [--source NAME|auto] [--project]'
    Emit '      skills-sh by default; global into ~/.agents/skills, --project into ./.agents/skills'
    Emit '  check-spec [path] [--strict] [--quiet]'
    Emit '      validate SKILL.md against the agentskills.io spec (default: ~/.agents/skills)'
    Emit '  list [--source NAME]'
    Emit '      installed skills (skills-sh: global by default)'
    Emit '  doctor'
    Emit '      environment check: dependencies, links, MCP registration, gh auth'
    Emit '  sources'
    Emit '      list of markets'
    Emit ''
    Emit '--source auto: source by package shape - owner/repo@skill goes to skills-sh first, then github;'
    Emit 'a slug without a slash goes to clawhub.'
    Emit 'Markets: skills-sh (npx skills), github (gh skill), clawhub (through bash), skillsmp (index only:'
    Emit 'install what you find with --source skills-sh|github).'
    Emit 'npx/gh timeout: SKILLS_TIMEOUT seconds (default 180); index HTTP timeout: SKILLS_HTTP_TIMEOUT (default 30).'
}

# --------------------------------------------------------------- check-spec

function Invoke-CheckSpec {
    param([string[]] $Arguments)
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Die 'check-spec: node is required (see doctor)' }
    $script = Join-Path $Root 'contrib/check-spec.mjs'
    $argumentList = @($script)
    $hasTarget = $false
    foreach ($argument in $Arguments) {
        if ($argument -notlike '-*') { $hasTarget = $true }
        $argumentList += $argument
    }
    if (-not $hasTarget) {
        $argumentList = @($script, (Join-Path $HOME '.agents/skills')) + $Arguments
    }
    $result = Invoke-External -File $node -Arguments $argumentList
    if ($result.Out) { Emit $result.Out.TrimEnd() }
    if ($result.Err) { [Console]::Error.Write($result.Err) }
    if ($result.ExitCode -ne 0) { exit $result.ExitCode }
}

# --------------------------------------------------------------- skills-sh

function ConvertTo-SkillsShPackage {
    param([string] $Package)
    $package = $Package
    $package = $package -replace '^https?://skills\.sh/', ''
    $package = $package.TrimEnd('/')
    if ($package -notmatch '@' -and $package -notmatch '://') {
        $parts = $package -split '/'
        if ($parts.Count -ge 3) { $package = "$($parts[0])/$($parts[1])@$($parts[2])" }
    }
    return $package
}

function Invoke-SkillsCli {
    param([string[]] $Arguments)
    $skills = Get-ToolPath 'skills'
    if ($skills) {
        $file = $skills
        $cliArgs = $Arguments
    } else {
        $npx = Get-ToolPath 'npx' @('npx.cmd')
        if (-not $npx) { Fail 'npx not found: install node (or put npx.cmd in PATH) - without it the skills CLI cannot run' }
        $file = $npx
        $cliArgs = @('-y', 'skills@latest') + $Arguments
    }
    $result = Invoke-External -File $file -Arguments $cliArgs -TimeoutSeconds $CliTimeout
    if ($result.TimedOut) { Fail "skills CLI did not answer within ${CliTimeout}s (SKILLS_TIMEOUT overrides)" }
    return $result
}

function Get-SkillMdFromUseOutput {
    param([string] $Text)
    $lines = Get-SplitLines $Text
    $start = -1
    $end = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($start -lt 0 -and $lines[$i] -eq '<SKILL.md>') { $start = $i }
        elseif ($start -ge 0 -and $lines[$i] -eq '</SKILL.md>') { $end = $i; break }
    }
    if ($start -ge 0 -and $end -gt $start) {
        $block = ($lines[($start + 1)..($end - 1)]) -join "`n"
        if ($block.Trim()) { return $block }
    }
    return $Text.TrimEnd()
}

function Search-SkillsSh {
    param([string[]] $Arguments)
    $json = $false
    $limit = 10
    $owner = ''
    $query = ''
    $i = 0
    while ($i -lt $Arguments.Count) {
        $argument = $Arguments[$i]
        if ($argument -eq '--json') { $json = $true }
        elseif ($argument -eq '--limit') {
            $i++
            if ($i -ge $Arguments.Count) { Fail '--limit requires a value' }
            $limit = [int]$Arguments[$i]
        } elseif ($argument -eq '--owner') {
            $i++
            if ($i -ge $Arguments.Count) { Fail '--owner requires a value' }
            $owner = $Arguments[$i]
        } elseif ($argument -eq '-h' -or $argument -eq '--help') { Show-Usage; exit 0 }
        elseif ($argument -like '-*') { Fail "unknown flag: $argument" }
        elseif ($query) { $query = "$query $argument" }
        else { $query = $argument }
        $i++
    }
    if (-not $query) { Fail 'usage: search <query> [--limit N] [--owner O] [--json]' }

    $base = Get-ApiBase 'SKILLS_API_URL' 'https://skills.sh'
    $uri = "$base/api/search?q=$([uri]::EscapeDataString($query))&limit=$limit"
    if ($owner) { $uri += "&owner=$([uri]::EscapeDataString($owner))" }
    $document = Get-Json $uri 'skills.sh search'
    $skills = @(Get-JsonProperty $document 'skills')
    $sorted = @($skills |
        Sort-Object -Property @{ Expression = { [int](Get-JsonProperty $_ 'installs') }; Descending = $true } -Stable |
        Select-Object -First $limit)

    if ($json) {
        $document.skills = $sorted
        return Get-SplitLines ($document | ConvertTo-Json -Depth 10)
    }
    if ($skills.Count -eq 0) { return @("nothing found for: $query") }
    $out = [System.Collections.Generic.List[string]]::new()
    foreach ($skill in $sorted) {
        $out.Add("$(Get-JsonProperty $skill 'source')@$(Get-JsonProperty $skill 'name')  [$(Get-JsonProperty $skill 'installs') installs]")
        $out.Add("  https://skills.sh/$(Get-JsonProperty $skill 'id')")
    }
    return $out.ToArray()
}

function Fetch-SkillsSh {
    param([string] $Package)
    $package = ConvertTo-SkillsShPackage $Package
    if ($package -notmatch '@') { Fail 'fetch needs an exact skill: owner/repo@skill' }
    $result = Invoke-SkillsCli @('use', $package)
    if ($result.ExitCode -ne 0) {
        Write-Err $result.Err.TrimEnd()
        Write-Err ((Get-SplitLines $result.Out | Select-Object -First 3) -join "`n")
        Fail "failed to fetch $package"
    }
    return Get-SkillMdFromUseOutput $result.Out
}

function Test-SkillLocked {
    param([string] $Lock, [string] $Name)
    try {
        $document = Get-Content -LiteralPath $Lock -Raw | ConvertFrom-Json
        $skills = Get-JsonProperty $document 'skills'
        if ($null -eq $skills) { return $false }
        return @($skills.PSObject.Properties.Name) -contains $Name
    } catch {
        return $false
    }
}

function Install-SkillsSh {
    param([string[]] $Arguments)
    $project = $false
    $package = ''
    foreach ($argument in $Arguments) {
        if ($argument -eq '--project') { $project = $true }
        elseif ($argument -eq '-h' -or $argument -eq '--help') { Show-Usage; exit 0 }
        elseif ($argument -like '-*') { Fail "unknown flag: $argument (call npx skills add directly for the rest)" }
        else { $package = $argument }
    }
    if (-not $package) { Fail 'usage: install <pkg> [--project]' }
    $package = ConvertTo-SkillsShPackage $package

    if ($package -match '@') { $name = $package.Substring($package.LastIndexOf('@') + 1) }
    else { $name = $package.Substring($package.LastIndexOf('/') + 1) }

    $cliArgs = @('add', $package, '-y')
    if (-not $project) { $cliArgs += '-g' }
    $result = Invoke-SkillsCli $cliArgs
    $out = [System.Collections.Generic.List[string]]::new()
    foreach ($line in Get-SplitLines (Remove-Ansi ($result.Out + $result.Err))) { $out.Add($line) }

    if ($project) {
        $lock = Join-Path (Get-Location).Path 'skills-lock.json'
        $skillsDir = Join-Path (Get-Location).Path '.agents/skills'
    } else {
        $lock = Join-Path $HOME '.agents/.skill-lock.json'
        $skillsDir = Join-Path $HOME '.agents/skills'
    }
    if ((Test-Path -LiteralPath $lock) -and (Test-SkillLocked -Lock $lock -Name $name)) {
        $out.Add("locked: $lock")
        $out.Add("skill:  $(Join-Path $skillsDir $name)")
    } else {
        Write-Err "warning: $name not found in $lock"
    }
    return $out.ToArray()
}

function List-SkillsSh {
    param([string[]] $Arguments)
    $cliArgs = @('list', '-g')
    foreach ($argument in $Arguments) {
        if ($argument -eq '-g' -or $argument -eq '--global') { $cliArgs += $argument }
        else { Fail "unknown flag: $argument (call npx skills list directly for the rest)" }
    }
    $result = Invoke-SkillsCli $cliArgs
    $text = Remove-Ansi ($result.Out + $result.Err)
    if ($result.ExitCode -ne 0) {
        Write-Err $text.TrimEnd()
        Fail "skills CLI failed (exit $($result.ExitCode)): $(Get-FirstLine $text)"
    }
    return Get-SplitLines $text
}

# ----------------------------------------------------------------- github

function Get-GhPath {
    $gh = Get-ToolPath 'gh' @('gh.exe')
    if (-not $gh) { Fail 'gh not found (on Windows install GitHub CLI and put gh.exe in PATH)' }
    return $gh
}

function Split-GithubPackage {
    param([string] $Package)
    if ($Package -notmatch '@' -or $Package -notmatch '^[^@]+@[^@]+$') {
        Fail "need owner/repo@skill, got: $Package"
    }
    $parts = $Package -split '@'
    return [pscustomobject]@{ Repo = $parts[0]; Skill = $parts[1] }
}

function Search-Github {
    param([string[]] $Arguments)
    $json = $false
    $limit = 15
    $owner = ''
    $query = ''
    $i = 0
    while ($i -lt $Arguments.Count) {
        $argument = $Arguments[$i]
        if ($argument -eq '--json') { $json = $true }
        elseif ($argument -eq '--limit') {
            $i++
            if ($i -ge $Arguments.Count) { Fail '--limit requires a value' }
            $limit = [int]$Arguments[$i]
        } elseif ($argument -eq '--owner') {
            $i++
            if ($i -ge $Arguments.Count) { Fail '--owner requires a value' }
            $owner = $Arguments[$i]
        } elseif ($argument -eq '-h' -or $argument -eq '--help') { Show-Usage; exit 0 }
        elseif ($argument -like '-*') { Fail "unknown flag: $argument" }
        elseif ($query) { $query = "$query $argument" }
        else { $query = $argument }
        $i++
    }
    if (-not $query) { Fail 'usage: search <query> [--limit N] [--owner O] [--json]' }

    $gh = Get-GhPath
    $cliArgs = @('skill', 'search', $query, '-L', "$limit", '--json', 'repo,skillName,namespace,path,stars,description')
    if ($owner) { $cliArgs += @('--owner', $owner) }
    $result = Invoke-External -File $gh -Arguments $cliArgs -TimeoutSeconds $CliTimeout
    if ($result.TimedOut) { Fail "gh skill search did not answer within ${CliTimeout}s (SKILLS_TIMEOUT overrides)" }
    if ($result.ExitCode -ne 0) { Fail "gh skill search failed (exit $($result.ExitCode)): $(Get-FirstLine ($result.Err + $result.Out))" }
    if ($json) { return Get-SplitLines $result.Out.TrimEnd() }

    $rows = @()
    try { $rows = @($result.Out | ConvertFrom-Json) } catch { Fail "gh skill search output is not JSON: $($_.Exception.Message)" }
    $out = [System.Collections.Generic.List[string]]::new()
    foreach ($row in $rows) {
        $namespace = Get-JsonProperty $row 'namespace'
        $name = Get-JsonProperty $row 'skillName'
        $skill = if ($namespace) { "$namespace/$name" } else { $name }
        $stars = Get-JsonProperty $row 'stars'
        if ($null -eq $stars) { $stars = 0 }
        $out.Add("$(Get-JsonProperty $row 'repo')@$skill  [$stars stars]")
        $out.Add("  https://github.com/$(Get-JsonProperty $row 'repo')")
    }
    return $out.ToArray()
}

function Fetch-Github {
    param([string] $Package)
    $parts = Split-GithubPackage $Package
    $gh = Get-GhPath
    $dir = New-WorkDir
    $result = Invoke-External -File $gh -Arguments @('skill', 'install', $parts.Repo, $parts.Skill, '--dir', $dir, '-f') -TimeoutSeconds $CliTimeout
    if ($result.ExitCode -ne 0) {
        Write-Err $result.Err.TrimEnd()
        Write-Err $result.Out.TrimEnd()
        Fail "failed to fetch $Package"
    }
    $found = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter 'SKILL.md' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { Fail 'SKILL.md not found in downloaded skill' }
    return Get-Content -LiteralPath $found.FullName -Raw
}

function Install-Github {
    param([string[]] $Arguments)
    $project = $false
    $package = ''
    foreach ($argument in $Arguments) {
        if ($argument -eq '--project') { $project = $true }
        elseif ($argument -eq '-h' -or $argument -eq '--help') { Show-Usage; exit 0 }
        elseif ($argument -like '-*') { Fail "unknown flag: $argument (pass thin gh skill flags straight to gh)" }
        else { $package = $argument }
    }
    if (-not $package) { Fail 'usage: install <pkg> [--project]' }
    $parts = Split-GithubPackage $package
    $gh = Get-GhPath

    $dir = if ($project) { Join-Path (Get-Location).Path '.agents/skills' } else { Join-Path $HOME '.agents/skills' }
    $result = Invoke-External -File $gh -Arguments @('skill', 'install', $parts.Repo, $parts.Skill, '--dir', $dir, '-f') -TimeoutSeconds $CliTimeout
    $out = Get-SplitLines (Remove-Ansi ($result.Out + $result.Err))
    $name = $parts.Skill.Substring($parts.Skill.LastIndexOf('/') + 1)
    if (Test-Path -LiteralPath (Join-Path $dir $name)) { return @($out + "skill:  $(Join-Path $dir $name)") }
    Write-Err "warning: $name not found in $dir"
    return $out
}

function List-Github {
    $gh = Get-GhPath
    $result = Invoke-External -File $gh -Arguments @('skill', 'list') -TimeoutSeconds $CliTimeout
    $text = Remove-Ansi ($result.Out + $result.Err)
    if ($result.ExitCode -ne 0) {
        Write-Err $text.TrimEnd()
        Fail "gh skill list failed (exit $($result.ExitCode))"
    }
    return Get-SplitLines $text
}

# ---------------------------------------------------------------- clawhub

# The clawhub adapter stays the single implementation: it is called through bash, exactly like the
# bash engine and the MCP server call it. No bash on this machine -> one honest line.
function Invoke-ClawhubAdapter {
    param([string[]] $Arguments, [switch] $Capture)
    $bash = Get-ToolPath 'bash'
    if (-not $bash) {
        Fail 'clawhub needs bash (Git Bash or WSL): install Git for Windows, or use --source skills-sh'
    }
    $adapter = Join-Path $Markets 'clawhub.sh'
    if (-not (Test-Path -LiteralPath $adapter)) { Fail "unknown source: clawhub (adapter not found: $adapter)" }
    $result = Invoke-External -File $bash -Arguments (@($adapter) + $Arguments) -TimeoutSeconds $CliTimeout -Stream:(-not $Capture)
    if (-not $Capture) { return $result.ExitCode }
    if ($result.TimedOut) { Fail "clawhub adapter did not answer within ${CliTimeout}s (SKILLS_TIMEOUT overrides)" }
    if ($result.ExitCode -ne 0) {
        Write-Err $result.Err.TrimEnd()
        Fail "clawhub adapter failed (exit $($result.ExitCode)): $(Get-FirstLine $result.Err)"
    }
    return $result.Out
}

# --------------------------------------------------------------- skillsmp

function Get-SkillsmpRanked {
    param($Skills, [string] $Query)
    $phrase = $Query.ToLowerInvariant()
    $terms = @([regex]::Matches($phrase, '[A-Za-z0-9]{3,}') | ForEach-Object { $_.Value })
    $seen = @{}
    $ranked = [System.Collections.Generic.List[object]]::new()
    foreach ($skill in $Skills) {
        $route = Get-JsonProperty $skill 'route'
        $name = "$(Get-JsonProperty $skill 'name')"
        $key = "$(Get-JsonProperty $route 'ownerSlug')/$(Get-JsonProperty $route 'repoSlug')@$name"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true

        $nameHay = $name.ToLowerInvariant()
        $repoHay = "$(Get-JsonProperty $route 'ownerSlug') $(Get-JsonProperty $route 'repoSlug')".ToLowerInvariant()
        $description = Get-JsonProperty $skill 'description'
        $descHay = if ($null -eq $description) { '' } else { "$description".ToLowerInvariant() }

        $score = 0
        foreach ($term in $terms) {
            if ($nameHay.Contains($term)) { $score += 3 }
            if ($repoHay.Contains($term)) { $score += 2 }
            if ($descHay.Contains($term)) { $score += 1 }
        }
        if ($nameHay.Contains($phrase)) { $score += 6 }
        if ($descHay.Contains($phrase)) { $score += 3 }
        $ranked.Add([pscustomobject]@{ Skill = $skill; Score = $score })
    }
    return @($ranked | Sort-Object -Property Score -Descending -Stable | ForEach-Object { $_.Skill })
}

function Search-Skillsmp {
    param([string[]] $Arguments)
    $json = $false
    $limit = 10
    $sort = 'stars'
    $query = ''
    $i = 0
    while ($i -lt $Arguments.Count) {
        $argument = $Arguments[$i]
        if ($argument -eq '--json') { $json = $true }
        elseif ($argument -eq '--limit') {
            $i++
            if ($i -ge $Arguments.Count) { Fail '--limit requires a value' }
            $limit = [int]$Arguments[$i]
        } elseif ($argument -eq '--sort') {
            $i++
            if ($i -ge $Arguments.Count) { Fail '--sort requires a value' }
            $sort = $Arguments[$i]
        } elseif ($argument -eq '-h' -or $argument -eq '--help') { Show-Usage; exit 0 }
        elseif ($argument -like '-*') { Fail "unknown flag: $argument" }
        elseif ($query) { $query = "$query $argument" }
        else { $query = $argument }
        $i++
    }
    if (-not $query) { Fail 'usage: search <query> [--limit N] [--sort stars|recent] [--json]' }
    if ($sort -notin @('stars', 'recent')) {
        Fail '--sort accepts stars or recent: the index silently falls back to stars for anything else'
    }

    $base = Get-ApiBase 'SKILLSMP_API_URL' 'https://skillsmp.com'
    $uri = "$base/api/skills?search=$([uri]::EscapeDataString($query))&limit=$($limit + 20)&sortBy=$sort"
    $document = Get-Json $uri 'skillsmp'
    $skills = @(Get-JsonProperty $document 'skills')
    if ($skills.Count -eq 0) { return @("nothing found for: $query") }

    $ranked = @(Get-SkillsmpRanked -Skills $skills -Query $query)
    if ($json) {
        $document.skills = @($ranked | Select-Object -First $limit)
        return Get-SplitLines ($document | ConvertTo-Json -Depth 10)
    }
    $out = [System.Collections.Generic.List[string]]::new()
    foreach ($skill in @($ranked | Select-Object -First $limit)) {
        $route = Get-JsonProperty $skill 'route'
        $stars = Get-JsonProperty $skill 'stars'
        if ($null -eq $stars) { $stars = 0 }
        $out.Add("$(Get-JsonProperty $route 'ownerSlug')/$(Get-JsonProperty $route 'repoSlug')@$(Get-JsonProperty $skill 'name')  [$stars stars]")
        $out.Add("  $(Get-JsonProperty $skill 'githubUrl')")
    }
    return $out.ToArray()
}

# ---------------------------------------------------------------- routing

function Invoke-MarketSearch {
    param([string] $Source, [string[]] $Arguments)
    switch ($Source) {
        'skills-sh' { return @(Search-SkillsSh $Arguments) }
        'github' { return @(Search-Github $Arguments) }
        'clawhub' { return Get-SplitLines (Remove-Ansi (Invoke-ClawhubAdapter -Arguments (@('search') + $Arguments) -Capture)) }
        'skillsmp' { return @(Search-Skillsmp $Arguments) }
        default { Fail "unknown source: $Source (see skills-manager.ps1 sources)" }
    }
}

function Get-MarketSkillMd {
    param([string] $Source, [string] $Package)
    switch ($Source) {
        'skills-sh' { return Fetch-SkillsSh $Package }
        'github' { return Fetch-Github $Package }
        'clawhub' { return Invoke-ClawhubAdapter -Arguments @('fetch', $Package) -Capture }
        'skillsmp' { Fail 'skillsmp is index only: install what you find with --source skills-sh or --source github' }
        default { Fail "unknown source: $Source (see skills-manager.ps1 sources)" }
    }
}

function Resolve-Source {
    param([string] $Package)
    if ($Package -like 'skills-sh:*') { return 'skills-sh' }
    $lastError = ''
    $candidates = if ($Package -match '/.*@') { @('skills-sh', 'github') } else { @('clawhub') }
    foreach ($candidate in $candidates) {
        try {
            $null = Get-MarketSkillMd -Source $candidate -Package $Package
            return $candidate
        } catch { $lastError = $_.Exception.Message }
    }
    $hint = if ($lastError) { " (last: $lastError)" } else { '' }
    Fail "auto: $Package not found in skills-sh, github, clawhub$hint"
}

function Get-ResultKey {
    param([string] $Line)
    if ($Line -match 'skills-sh:([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)') {
        return "$($Matches[1])/$($Matches[2])@$($Matches[3])"
    }
    if ($Line -match '([A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+)') { return $Matches[1] }
    $slug = ($Line -split '\s+')[0]
    if (-not $slug) { return '' }
    $owner = ''
    if ($Line -match '@([A-Za-z0-9._-]+)') { $owner = $Matches[1] }
    if ($owner) { return "$owner/$slug" }
    return "slug:$slug"
}

function Get-DedupedMarketOutput {
    param([string[]] $Lines)
    $seen = @{}
    $out = [System.Collections.Generic.List[string]]::new()
    $hidden = 0
    $dropping = $false
    foreach ($line in $Lines) {
        if ($line -match '^== .* ==$') { $dropping = $false; $out.Add($line); continue }
        if ($line -match '^\s' -or $line -eq '') {
            if (-not $dropping) { $out.Add($line) }
            continue
        }
        $key = Get-ResultKey $line
        if ($key -and $seen.ContainsKey($key)) { $hidden++; $dropping = $true; continue }
        if ($key) { $seen[$key] = $true }
        $dropping = $false
        $out.Add($line)
    }
    if ($hidden -gt 0) { $out.Add("(duplicates hidden: $hidden)") }
    return $out.ToArray()
}

function Show-Sources {
    Emit ('{0,-10} {1}' -f 'skills-sh', 'skills.sh through npx skills (search/fetch/install/list)')
    Emit ('{0,-10} {1}' -f 'github', 'GitHub through gh skill (search/fetch/install/list)')
    Emit ('{0,-10} {1}' -f 'clawhub', 'ClawHub/OpenClaw (search/fetch/install/list; runs the bash adapter)')
    Emit ('{0,-10} {1}' -f 'skillsmp', 'SkillsMP, index only (search)')
}

# ---------------------------------------------------------------- summary

function Get-SkillSummary {
    param([string] $Text)
    $lines = Get-SplitLines $Text

    $meta = [System.Collections.Generic.List[string]]::new()
    if ($lines.Count -gt 0 -and $lines[0] -eq '---') {
        $keep = $false
        for ($i = 1; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            if ($line -eq '---') { break }
            if ($line -match '^[A-Za-z_][A-Za-z0-9_-]*:') {
                $key = ($line -split ':')[0]
                $keep = $key -match '^(name|description|license|allowed-tools|permissions|tools|metadata|version)$'
            } elseif ($line -notmatch '^\s') {
                $keep = $false
            }
            if ($keep) { $meta.Add($line) }
        }
    }

    $found = [System.Collections.Generic.List[string]]::new()
    $active = $false
    $count = 0
    $sections = 0
    foreach ($line in $lines) {
        if ($line -match '^#{1,6} ') {
            $active = $line -match '(?i)(install|setup|dependen|requirement|prerequisit|permission|allowed|tools|requires|credentials|secrets)'
            $count = 0
            if ($active) {
                if ($sections -gt 0) { $found.Add('') }
                $sections++
                $found.Add($line)
            }
            continue
        }
        if ($active -and $count -lt $SectionLines -and $line -notmatch '^\s*$') {
            $found.Add($line)
            $count++
        }
    }

    $out = [System.Collections.Generic.List[string]]::new()
    $out.Add('')
    $out.Add('-- meta --')
    foreach ($line in $meta) { $out.Add($line) }
    $out.Add('')
    $out.Add('-- dependencies / permissions --')
    if ($found.Count -gt 0) { foreach ($line in $found) { $out.Add($line) } }
    else { $out.Add('no explicit sections') }
    return $out.ToArray()
}

# ----------------------------------------------------------------- doctor

$script:Problems = 0

function Report {
    param([string] $Status, [string] $Name, [string] $Detail)
    Emit ('{0,-34} {1,-5} {2}' -f $Name, $Status, $Detail)
}

function Check-Dep {
    param([string] $Bin, [string] $Required, [string] $Hint = '')
    $found = Get-ToolPath $Bin
    if ($found) { Report 'ok' $Bin $found; return }
    $detail = if ($Hint) { $Hint } else { 'not found' }
    if ($Required -eq 'required') {
        Report 'FAIL' $Bin $detail
        $script:Problems++
    } else {
        Report 'warn' $Bin $detail
    }
}

function Get-LinkTarget {
    param([string] $Path)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        $target = $item.Target
        if ($target -is [array]) { $target = $target[0] }
        if ($target) { return [string]$target }
    } catch { }
    return ''
}

function Get-FullPath {
    param([string] $Path)
    try { return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path.TrimEnd('\', '/') }
    catch { return $Path.TrimEnd('\', '/') }
}

function Check-CommandEntry {
    param([string] $Hub)
    $binDir = Join-Path $HOME '.local/bin'
    $shim = Join-Path $binDir 'skills-manager.cmd'
    if (Test-Path -LiteralPath $shim) {
        $text = Get-Content -LiteralPath $shim -Raw
        if ($text -match 'skills-manager\.(sh|ps1)') { Report 'ok' $shim 'shim for the hub CLI'; return }
        Report 'FAIL' $shim 'shim does not point at the hub CLI'
        $script:Problems++
        return
    }
    $link = Join-Path $binDir 'skills-manager'
    $expected = Join-Path $Hub 'skills-manager.sh'
    if (-not (Test-Path -LiteralPath $link)) {
        Report 'FAIL' $link 'no command here - create it: contrib/install-links.ps1'
        $script:Problems++
        return
    }
    $target = Get-LinkTarget $link
    if (-not $target) {
        if ((Test-Path -LiteralPath $link -PathType Leaf) -and (Test-Path -LiteralPath $expected) -and
            ((Get-FileHash -LiteralPath $link).Hash -eq (Get-FileHash -LiteralPath $expected).Hash)) {
            Report 'warn' $link 'a copy, not a link (re-create it after the hub moves)'
        } else {
            Report 'FAIL' $link 'not a link to the hub - re-create it: contrib/install-links.ps1'
            $script:Problems++
        }
        return
    }
    if (-not (Test-Path -LiteralPath $target)) {
        Report 'FAIL' $link "broken -> $target"
        $script:Problems++
        return
    }
    if ((Get-FullPath $target) -ne (Get-FullPath $expected)) {
        Report 'FAIL' $link "-> $target (expected $expected)"
        $script:Problems++
        return
    }
    Report 'ok' $link "-> $target"
}

function Check-SkillLink {
    param([string] $Hub)
    $link = Join-Path $HOME '.agents/skills/skills-ops'
    if (-not (Test-Path -LiteralPath $link)) {
        Report 'FAIL' $link 'no skill link - create it: contrib/install-links.ps1'
        $script:Problems++
        return
    }
    $target = Get-LinkTarget $link
    if ($target) {
        if (-not (Test-Path -LiteralPath $target)) {
            Report 'FAIL' $link "broken -> $target"
            $script:Problems++
            return
        }
        if ((Get-FullPath $target) -ne (Get-FullPath $Hub)) {
            Report 'FAIL' $link "-> $target (expected $Hub)"
            $script:Problems++
            return
        }
        Report 'ok' $link "-> $target"
        return
    }
    if (Test-Path -LiteralPath (Join-Path $link 'skills-manager.sh')) {
        Report 'warn' $link 'a copy, not a link (re-create it after the hub moves)'
        return
    }
    Report 'FAIL' $link 'not the hub'
    $script:Problems++
}

function Check-Mcp {
    param([string] $File, [string] $Label)
    if (-not (Test-Path -LiteralPath $File)) {
        Report 'warn' "mcp $Label" "no file $File"
        return
    }
    $text = Get-Content -LiteralPath $File -Raw
    $paths = @([regex]::Matches($text, '[^ "''`]*skills-[a-z]+/mcp/server\.mjs') | ForEach-Object { $_.Value } | Sort-Object -Unique)
    if ($paths.Count -eq 0) {
        Report 'warn' "mcp $Label" 'skills-hub is not registered'
        return
    }
    foreach ($path in $paths) {
        $expanded = $path -replace '\$HOME', $HOME -replace '^~', $HOME
        if (Test-Path -LiteralPath $expanded) { Report 'ok' "mcp $Label" $expanded }
        else {
            Report 'FAIL' "mcp $Label" "broken path: $expanded"
            $script:Problems++
        }
    }
}

function Invoke-Doctor {
    $script:Problems = 0
    Emit "root: $Root"
    Emit ''

    $os = if ($IsWindows) { 'Windows' } elseif ($IsMacOS) { 'macOS' } else { 'Linux' }
    $note = if ($IsWindows) { 'native PowerShell CLI' } else { 'native PowerShell CLI; the bash engine (skills-manager.sh) is canonical here' }
    Report 'ok' 'platform' "$os $([System.Environment]::OSVersion.Version) - $note"

    Check-Dep 'node' 'required' 'the skills CLI and the MCP server need it'
    Check-Dep 'npx' 'required' 'ships with node'
    Check-Dep 'gh' 'optional' 'needed for --source github only'
    Check-Dep 'bash' 'optional' 'Git Bash or WSL: the clawhub adapter, the bash engine and the MCP server need it'
    Check-Dep 'bats' 'optional' 'needed for the test suite'
    Emit ''

    Check-CommandEntry $Root
    Check-SkillLink $Root
    Emit ''

    Check-Mcp (Join-Path $HOME '.config/opencode/opencode.json') 'opencode'
    Check-Mcp (Join-Path $HOME '.omp/agent/mcp.json') 'omp'
    Emit ''

    $gh = Get-ToolPath 'gh'
    if ($gh) {
        $result = Invoke-External -File $gh -Arguments @('auth', 'status') -TimeoutSeconds 30
        if ($result.ExitCode -eq 0) {
            $account = (Get-SplitLines ($result.Out + $result.Err) | Where-Object { $_ -match 'account ' } | Select-Object -First 1)
            if ($account) { $account = ($account -replace '.*account\s+', '').Trim() } else { $account = 'logged in' }
            Report 'ok' 'gh auth' $account
        } else {
            Report 'warn' 'gh auth' 'not logged in: gh auth login'
        }
    }

    Emit ''
    if ($script:Problems -eq 0) {
        Emit 'doctor: ok'
        return
    }
    Emit "doctor: problems $($script:Problems)"
    exit 1
}

# ------------------------------------------------------------------- main

function Invoke-Inspect {
    param([string] $Source, [string[]] $Arguments)
    $full = $false
    $package = ''
    foreach ($argument in $Arguments) {
        if ($argument -eq '--full') { $full = $true }
        elseif ($argument -eq '-h' -or $argument -eq '--help') { Show-Usage; exit 0 }
        elseif ($argument -like '-*') { Fail "unknown flag: $argument" }
        else { $package = $argument }
    }
    if (-not $package) { Fail 'usage: inspect <pkg> [--source NAME] [--full]' }
    if ($Source -eq 'auto') { $Source = Resolve-Source $package }

    $text = Get-MarketSkillMd -Source $Source -Package $package
    Emit "source: $Source"
    Emit "pkg:    $package"
    if ($full) {
        Emit ''
        [Console]::Out.Write($text)
        if (-not $text.EndsWith("`n")) { [Console]::Out.WriteLine('') }
        return
    }
    Emit-Lines (Get-SkillSummary $text)
}

function Invoke-SpecCheckAfterInstall {
    param([string[]] $Arguments)
    $script = Join-Path $Root 'contrib/check-spec.mjs'
    if (-not (Test-Path -LiteralPath $script)) { return }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { return }
    $target = Join-Path $HOME '.agents/skills'
    foreach ($argument in $Arguments) {
        if ($argument -eq '--project') { $target = Join-Path (Get-Location) '.agents/skills' }
    }
    if (-not (Test-Path -LiteralPath $target)) { return }
    Emit ''
    Emit '-- spec check (agentskills.io)'
    $result = Invoke-External -File $node -Arguments @($script, $target, '--quiet')
    if ($result.Out) { Emit $result.Out.TrimEnd() }
    if ($result.Err) { [Console]::Error.Write($result.Err) }
}

function Invoke-Install {
    param([string] $Source, [string[]] $Arguments)
    if ($Source -eq 'auto') {
        $package = ''
        foreach ($argument in $Arguments) {
            if ($argument -like '-*') { continue }
            $package = $argument
            break
        }
        if (-not $package) { Fail 'install: a package is required' }
        $Source = Resolve-Source $package
    }
    switch ($Source) {
        'skills-sh' { Emit-Lines (Install-SkillsSh $Arguments); return }
        'github' { Emit-Lines (Install-Github $Arguments); return }
        'clawhub' { exit (Invoke-ClawhubAdapter -Arguments (@('install') + $Arguments)) }
        'skillsmp' { Fail 'skillsmp is index only: install what you find with --source skills-sh or --source github' }
        default { Fail "unknown source: $Source (see skills-manager.ps1 sources)" }
    }
}

function Invoke-List {
    param([string] $Source, [string[]] $Arguments)
    switch ($Source) {
        'skills-sh' { Emit-Lines (List-SkillsSh $Arguments); return }
        'github' { Emit-Lines (List-Github); return }
        'clawhub' { exit (Invoke-ClawhubAdapter -Arguments (@('list') + $Arguments)) }
        'skillsmp' { Fail 'skillsmp is index only: it has no list' }
        default { Fail "unknown source: $Source (see skills-manager.ps1 sources)" }
    }
}

function Invoke-Search {
    param([string] $Source, [string[]] $Arguments)
    if ($Source -ne 'all') {
        Emit-Lines (Invoke-MarketSearch -Source $Source -Arguments $Arguments)
        return
    }
    $collected = [System.Collections.Generic.List[string]]::new()
    $answered = $false
    foreach ($name in $SourcesOrder) {
        $collected.Add('')
        $collected.Add("== $name ==")
        try {
            foreach ($line in @(Invoke-MarketSearch -Source $name -Arguments $Arguments)) { $collected.Add($line) }
            $answered = $true
        } catch {
            Write-Err "($name failed: $($_.Exception.Message))"
        }
    }
    Emit-Lines (Get-DedupedMarketOutput $collected.ToArray())
    if (-not $answered) { Fail 'all sources failed' }
}

if (-not $Command) {
    Show-Usage
    exit 1
}

$source = $DefaultSource
$adapterArgs = [System.Collections.Generic.List[string]]::new()
$extra = @()
if ($Rest) { $extra = @($Rest) }
$i = 0
while ($i -lt $extra.Count) {
    $argument = $extra[$i]
    if ($argument -eq '--source') {
        if ($i + 1 -ge $extra.Count) { Die '--source requires a value' }
        $source = $extra[$i + 1]
        $i += 2
        continue
    }
    $adapterArgs.Add($argument)
    $i++
}
$Arguments = $adapterArgs.ToArray()

$packageCommands = @('inspect', 'read', 'show', 'install', 'add', '-h', '--help', 'help')
if ($packageCommands -notcontains $Command -and $source -eq 'auto') {
    Die '--source auto applies only to inspect/install: search and list take no package'
}

try {
    switch ($Command) {
        'search' { Invoke-Search -Source $source -Arguments $Arguments }
        'inspect' { Invoke-Inspect -Source $source -Arguments $Arguments }
        'read' { Invoke-Inspect -Source $source -Arguments $Arguments }
        'show' { Invoke-Inspect -Source $source -Arguments $Arguments }
        'install' { Invoke-Install -Source $source -Arguments $Arguments; Invoke-SpecCheckAfterInstall -Arguments $Arguments }
        'add' { Invoke-Install -Source $source -Arguments $Arguments }
        'list' { Invoke-List -Source $source -Arguments $Arguments }
        'ls' { Invoke-List -Source $source -Arguments $Arguments }
        'check-spec' { Invoke-CheckSpec -Arguments $Arguments }
        'doctor' { Invoke-Doctor }
        'sources' { Show-Sources }
        '-h' { Show-Usage }
        '--help' { Show-Usage }
        'help' { Show-Usage }
        default {
            Show-Usage
            Die "unknown command: $Command"
        }
    }
} catch {
    Die $_.Exception.Message
} finally {
    Remove-WorkDirs
}
