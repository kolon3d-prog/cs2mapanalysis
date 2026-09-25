#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    Scans a tree for user absolute paths (PowerShell twin of contrib/check-paths.sh).

.DESCRIPTION
    Why: a path like /home/<user>/..., /run/media/<disk>/..., C:\Users\<user>\... is dead on another
    machine and breaks when the disk moves (the hub had exactly that: DATA/11 -> DATA/AGGG). A
    parameterized path (/home/$USER/..., /run/media/${USER}/...) is caught the same way: it is tied to
    someone else's home just the same.

    The rules are the bash scanner's rules, so both scanners answer the same way:
      pattern      /home/..., /Users/..., /run/media/..., /mnt/..., C:\Users\... followed by a letter,
                   a digit or a parameter ($HOME, $USER, ${USER}, %USERNAME%)
      skipped      .git, __pycache__, node_modules, collection, vendor, sessions,
                   *.min.js, *.pyc, binary files, and both scanners themselves
      ignored      lines marked "path-guard: ok" and placeholders such as /home/<user> (no letter and
                   no parameter right after the prefix)
      output       hits as file:line:text, exit 1; a clean tree prints
                   "check-paths: <word> (<roots>)" and exits 0

    The verdict word is built from code points on purpose: other stations' tests grep that exact word,
    while this file stays pure ASCII (Windows PowerShell mangles non-ASCII .ps1 sources).

.EXAMPLE
    pwsh -File contrib/check-paths.ps1
    pwsh -File contrib/check-paths.ps1 D:\AGGG\skills-hub D:\AGGG\agent-bundle
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]] $Roots
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$UserPart = '[A-Za-z0-9$%{]'
$Pattern = "(/home/$UserPart|/Users/$UserPart|/run/media/$UserPart|/mnt/$UserPart|C:\\Users\\$UserPart)"
$SkipDirs = @('.git', '__pycache__', 'node_modules', 'collection', 'vendor', 'sessions')
$SkipNames = @('*.min.js', '*.pyc', 'check-paths.sh', 'check-paths.ps1')
$CleanVerdict = -join [char[]]@(0x447, 0x438, 0x441, 0x442, 0x43E)

$scanRoots = @()
if ($Roots) { $scanRoots = @($Roots) }
if ($scanRoots.Count -eq 0) { $scanRoots = @((Split-Path -Parent $PSScriptRoot)) }

function Test-SkippedDirectory {
    param([string] $Path, [string] $Root)
    $relative = $Path
    if ($relative.StartsWith($Root, [System.StringComparison]::Ordinal)) { $relative = $relative.Substring($Root.Length) }
    foreach ($part in ($relative -split '[\\/]')) {
        if ($SkipDirs -contains $part) { return $true }
    }
    return $false
}

function Test-BinaryFile {
    param([string] $Path)
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $buffer = [byte[]]::new(8192)
            $read = $stream.Read($buffer, 0, $buffer.Length)
            for ($i = 0; $i -lt $read; $i++) { if ($buffer[$i] -eq 0) { return $true } }
        } finally { $stream.Dispose() }
    } catch { return $true }
    return $false
}

$hits = [System.Collections.Generic.List[string]]::new()
foreach ($root in $scanRoots) {
    if (-not (Test-Path -LiteralPath $root)) {
        [Console]::Error.WriteLine("[!] check-paths: no such path: $root")
        continue
    }
    $item = Get-Item -LiteralPath $root -Force
    $files = @()
    if ($item.PSIsContainer) {
        $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)
    } else {
        $files = @($item)
    }
    foreach ($file in $files) {
        $skipped = $false
        foreach ($name in $SkipNames) { if ($file.Name -like $name) { $skipped = $true } }
        if ($skipped) { continue }
        if ($item.PSIsContainer -and (Test-SkippedDirectory -Path $file.FullName -Root $item.FullName)) { continue }
        if (Test-BinaryFile $file.FullName) { continue }

        $lines = @(Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue)
        for ($number = 0; $number -lt $lines.Count; $number++) {
            $line = $lines[$number]
            if ($line -notmatch $Pattern) { continue }
            if ($line -match 'path-guard: ok') { continue }
            $hits.Add("$($file.FullName):$($number + 1):$line")
        }
    }
}

if ($hits.Count -eq 0) {
    [Console]::Out.WriteLine("check-paths: $CleanVerdict ($($scanRoots -join ' '))")
    exit 0
}

foreach ($hit in $hits) { [Console]::Out.WriteLine($hit) }
[Console]::Error.WriteLine('')
[Console]::Error.WriteLine("check-paths: $($hits.Count) line(s) with user absolute paths - derive the path from the script/`$HOME or mark the line with `"path-guard: ok`"")
exit 1
