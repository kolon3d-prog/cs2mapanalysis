#Requires -Version 7.0
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

<#
.SYNOPSIS
    Кауфми-пульс на Windows: «живо ли племя» без Unix-специфики.

.DESCRIPTION
    Windows-аналог scripts/health_pulse.py — те же четыре артерии и ТОТ ЖЕ
    формат строки в health-pulse.log (его читают и Unix-инструменты):

      1) MCP-сервер жив    — пидфайл (%TEMP%\camoufox-mcp.pid) + проверка
         процесса. /proc на Windows нет, поэтому страховка — скан по списку
         процессов (Win32_Process.CommandLine содержит «camoufox_research»);
      2) сторож поиска свеж — последний `ok:` в watchdog.log <= 48ч:
            машина недавно загрузилась (< 20ч) → WARN «машина спала»,
            работала > 20ч и молчит → FAIL «сторож умер»,
            время загрузки неизвестно → WARN (честно, а не «наверное спала»);
      3) cache.db на месте — добыча не потеряна;
      4) последний бэкап свеж — backup_cache.log <= 36ч.

    FAIL → файл health-pulse_ALERT (жив, пока беда жива, как watchdog_ALERT).
    Уведомление на рабочий стол — ТОЛЬКО при HEALTH_PULSE_NOTIFY=1 (в Unix
    и Windows версиях одно правило: по умолчанию не спамим) и не чаще, чем
    раз в HEALTH_PULSE_NOTIFY_REPEAT_MIN минут для одного и того же вердикта.

    Чего на Windows НЕТ (Unix-only): cron-строки и systemd-таймеры репо —
    расписание задаёт Task Scheduler (пример в docs/install-windows.md).
    Пульс работает и без них: он сам и есть проверка.

.PARAMETER Cache
    Каталог кэша (по умолчанию CAMOUFOX_CACHE_DIR или ~/.cache/camoufox-research —
    как в Unix-версии, чтобы пульсы двух систем смотрели в одно место).
.PARAMETER PidFile
    Пидфайл MCP-сервера (по умолчанию CAMOUFOX_PIDFILE или %TEMP%\camoufox-mcp.pid).
.PARAMETER StaleHours
    Порог «сторож умер», часы (по умолчанию HEALTH_PULSE_STALE_H или 48).
.PARAMETER BootGraceHours
    Окно «машина только загрузилась», часы (HEALTH_PULSE_BOOT_GRACE_H или 20).
.PARAMETER BackupStaleHours
    Порог свежести бэкапа, часы (HEALTH_PULSE_BACKUP_STALE_H или 36).
.PARAMETER NotifyRepeatMinutes
    Как часто повторять одно и то же состояние (HEALTH_PULSE_NOTIFY_REPEAT_MIN или 1440).
.PARAMETER DryRun
    Посчитать вердикт и показать его, но НИЧЕГО не писать: ни строки в
    health-pulse.log, ни ALERT, ни уведомлений, ни состояния дедупа.
    Код возврата тот же, что у обычного прогона (0 — PASS/WARN, 1 — FAIL).
.PARAMETER TestNotify
    Ручная проверка канала уведомлений (BurntToast или Windows.UI.Notifications
    через Windows PowerShell 5.1) — гейт HEALTH_PULSE_NOTIFY обходится
    осознанно, потому что это тест по требованию человека.

.OUTPUTS
    Код возврата: 0 — PASS/WARN, 1 — FAIL, 2 — сбой самого пульса
    (не создался лог/ALERT, кончилось место и т.п.): авария пульса и авария
    инфраструктуры — разные вещи, смешивать их в один код нельзя.

.EXAMPLE
    PS> .\scripts\health_pulse.ps1 -DryRun
    Вердикт без единой записи (проверяется и на Linux-pwsh).
.EXAMPLE
    PS> $env:HEALTH_PULSE_NOTIFY = 1; .\scripts\health_pulse.ps1 -TestNotify
    Проверить, что уведомления реально доходят.
#>

[CmdletBinding()]
param(
    [string]$Cache = $(if ($env:CAMOUFOX_CACHE_DIR) { $env:CAMOUFOX_CACHE_DIR } else { Join-Path $HOME '.cache/camoufox-research' }),
    [string]$PidFile = '',
    [int]$StaleHours = $(if ($env:HEALTH_PULSE_STALE_H) { [int]$env:HEALTH_PULSE_STALE_H } else { 48 }),
    [int]$BootGraceHours = $(if ($env:HEALTH_PULSE_BOOT_GRACE_H) { [int]$env:HEALTH_PULSE_BOOT_GRACE_H } else { 20 }),
    [int]$BackupStaleHours = $(if ($env:HEALTH_PULSE_BACKUP_STALE_H) { [int]$env:HEALTH_PULSE_BACKUP_STALE_H } else { 36 }),
    [int]$NotifyRepeatMinutes = $(if ($env:HEALTH_PULSE_NOTIFY_REPEAT_MIN) { [int]$env:HEALTH_PULSE_NOTIFY_REPEAT_MIN } else { 1440 }),
    [switch]$DryRun,
    [switch]$TestNotify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Признак «это наш сервер» в командной строке процесса. Нужны ОБА варианта:
# camoufox-research.exe (консольный скрипт venv, Windows) и
# camoufox_research.camoufox_research (запуск модулем) — python-версия искала
# только «bin/camoufox-research», и с одним вариантом пульс на Windows
# считал бы живой сервер мёртвым.
$ServerNeedle = 'camoufox[-_]research'
$LogName = 'health-pulse.log'
$AlertName = 'health-pulse_ALERT'
$NotifyStateName = 'health-pulse_notify.state'

trap {
    $inv = $_.InvocationInfo
    Write-Host ("[!] сбой пульса: {0} (строка {1}: {2})" -f $_.Exception.Message, $inv.ScriptLineNumber, $inv.Line.Trim()) -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 2
}

# --- пути ------------------------------------------------------------------
function Resolve-PidFilePath {
    <# Пидфайл по умолчанию: явный -PidFile > CAMOUFOX_PIDFILE > XDG_RUNTIME_DIR
    > %TEMP%\camoufox-mcp.pid. Временный каталог берём через
    Path::GetTempPath (на Windows — %TEMP%, на Linux-pwsh — /tmp), а не
    $env:TEMP: в Linux-консоли TEMP пуст, и путь получался бы относительным. #>
    param([string]$Explicit)
    if ($Explicit) { return $Explicit }
    if ($env:CAMOUFOX_PIDFILE) { return $env:CAMOUFOX_PIDFILE }
    if ($env:XDG_RUNTIME_DIR) { return (Join-Path $env:XDG_RUNTIME_DIR 'camoufox-mcp.pid') }
    return (Join-Path ([System.IO.Path]::GetTempPath()) 'camoufox-mcp.pid')
}

# --- 1. сервер -------------------------------------------------------------
function Get-PidFromFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
    $pid2 = 0
    if ([int]::TryParse(("$raw").Trim(), [ref]$pid2)) { return $pid2 }
    return 0
}

function Test-PidIsServer {
    <# PID жив И похож на наш сервер. Командную строку отдаёт только
    Win32_Process (WMI/CIM): нет CIM (Linux-pwsh без модулей) — верим самому
    факту «процесс жив», как Unix-версия верит пидфайлу без /proc. #>
    param([Parameter(Mandatory)][int]$ProcessId)
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $false }
    $cmd = Get-ProcessCommandLine -ProcessId $ProcessId
    if (-not $cmd) { return $true }
    return ($cmd -match $ServerNeedle)
}

function Get-ProcessCommandLine {
    <# Командная строка процесса; '' — узнать нельзя. Windows — Win32_Process
    (CIM), Linux-pwsh — /proc/<pid>/cmdline. Нужна, чтобы пидфайл не «застыл»
    за чужим живым PID (в python это `_pid_cmdline`); без неё Test-PidIsServer
    верил бы любому живому процессу с тем же номером. #>
    param([Parameter(Mandatory)][int]$ProcessId)
    if (Test-CimAvailable) {
        try {
            $info = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -ErrorAction Stop
            if ($null -ne $info -and $info.CommandLine) { return [string]$info.CommandLine }
        }
        catch { }
        return ''
    }
    $cmdlinePath = '/proc/{0}/cmdline' -f $ProcessId
    if (Test-Path -LiteralPath $cmdlinePath) {
        try {
            return [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($cmdlinePath))
        }
        catch { }
    }
    return ''
}

function Test-CimAvailable {
    return ($IsWindows -and ($null -ne (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)))
}

function Get-ServerProcesses {
    <# Скан процессов (страховка от застывшего пидфайла — урок 31.08 19:46).
    Windows — Win32_Process по имени, Linux-pwsh — /proc (нужно только для
    dev-прогонов пульса вне Windows). Пустой список = «не нашли», и это
    честный ответ, а не «сервер мёртв»: решение принимает вызывающий. #>
    $found = @()
    if (Test-CimAvailable) {
        try {
            $cands = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
                Where-Object { $_.Name -match 'python|camoufox' }
            foreach ($cand in $cands) {
                if ($cand.CommandLine -and ($cand.CommandLine -match $ServerNeedle)) {
                    $found += [int]$cand.ProcessId
                }
            }
        }
        catch { }
        return $found
    }
    if (Test-Path -LiteralPath '/proc') {
        # -Filter '[0-9]*' тут НЕ работает: у FileSystem-провайдера в -Filter
        # есть только * и ?, скобочные диапазоны он не понимает и вернул НОЛЬ
        # каталогов — скан молча не находил ни одного процесса (грабля поймана
        # прогоном на Linux-pwsh). Фильтруем регуляркой по имени.
        $procDirs = @(Get-ChildItem -Path '/proc' -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^\d+$' })
        foreach ($d in $procDirs) {
            $text = Get-ProcessCommandLine -ProcessId ([int]$d.Name)
            if ($text -match $ServerNeedle) { $found += [int]$d.Name }
        }
    }
    return $found
}

function Test-CamoufoxServer {
    param([Parameter(Mandatory)][string]$PidPath)
    $pidValue = Get-PidFromFile -Path $PidPath
    if ($pidValue -gt 0 -and (Test-PidIsServer -ProcessId $pidValue)) { return $true }
    return (@(Get-ServerProcesses).Count -gt 0)
}

# --- 2. время загрузки -----------------------------------------------------
function Get-BootTime {
    <# Время загрузки или $null — «не знаем». Windows: CIM LastBootUpTime,
    запасной путь — TickCount64 (есть в .NET 6+, нет в Windows PowerShell 5.1).
    Linux-pwsh: /proc/uptime (нужно для dev-прогонов: без времени загрузки
    ветка FAIL-STALE недостижима и проверить её нечем).
    $null НИКОГДА не подменяем текущим временем: в python-версии такая
    подмена выдавала настоящую аварию за «машина спала». #>
    if ($IsWindows) {
        try {
            $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
            if ($null -ne $os -and $os.LastBootUpTime) { return [datetime]$os.LastBootUpTime }
        }
        catch { }
        try { return (Get-Date).AddMilliseconds(-[double][Environment]::TickCount64) }
        catch { }
        return $null
    }
    $uptimeFile = '/proc/uptime'
    if (Test-Path -LiteralPath $uptimeFile) {
        try {
            $up = (Get-Content -LiteralPath $uptimeFile -Raw).Split()[0]
            return (Get-Date).AddSeconds(-[double]$up)
        }
        catch { }
    }
    return $null
}

# --- 3. сторож и добыча ----------------------------------------------------
function Get-LastWatchdogOk {
    <# Последний `ok:` из watchdog.log («27.08 18:25 ok: 8 результатов»).
    Год берём текущий, как Unix-версия: в логе его нет. #>
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue)
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $m = [regex]::Match($lines[$i], '^(\d{2})\.(\d{2}) (\d{2}):(\d{2}) ok:')
        if ($m.Success) {
            $year = (Get-Date).Year
            try {
                return [datetime]::new($year, [int]$m.Groups[2].Value, [int]$m.Groups[1].Value,
                    [int]$m.Groups[3].Value, [int]$m.Groups[4].Value, 0)
            }
            catch { return $null }
        }
    }
    return $null
}

function Test-FreshFile {
    <# Файл есть и его mtime не старше порога (часов). #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int]$MaxAgeHours
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $age = (Get-Date) - (Get-Item -LiteralPath $Path).LastWriteTime
    return ($age.TotalHours -le $MaxAgeHours)
}

function Test-NonEmptyFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path
    return ($item.Length -gt 0)
}

# --- 4. уведомления --------------------------------------------------------
function Get-StateKey {
    <# Ключ дедупа: СМЫСЛ вердикта, без времени. Со временем каждый прогон в
    новую минуту считался новым состоянием, и уведомления шли подряд
    (урок 21.09, найден вопросом владельца «почему всё ещё спамит»). #>
    param(
        [Parameter(Mandatory)][string]$Verdict,
        [Parameter(Mandatory)][string[]]$Checks
    )
    return ("{0} {1}" -f $Verdict, ($Checks -join ' '))
}

function Test-NotifyAllowed {
    <# Уведомления ВЫКЛЮЧЕНЫ по умолчанию (требование владельца 21.09:
    «спамит — прекрати»). Пульс — фоновая проверка: вердикт лежит в
    health-pulse.log и в ALERT-файле. Включается ровно одним способом:
    HEALTH_PULSE_NOTIFY=1 (Linux-версия дополнительно требует дисплей и
    сессионную шину — на Windows их нет, и уведомление работает). #>
    $flag = "$env:HEALTH_PULSE_NOTIFY".Trim().ToLowerInvariant()
    return ($flag -in @('1', 'true', 'yes', 'on'))
}

function Test-NotifyWorthIt {
    <# Помним последнее отправленное СОСТОЯНИЕ: то же состояние молчит, пока
    не истекло окно NotifyRepeatMinutes, потом напоминает. Смена состояния
    уведомляет сразу. Состояние пишем ДО отправки (как Unix-версия): иначе
    без механизма уведомлений дедуп не работал бы вовсе. #>
    param([Parameter(Mandatory)][string]$State)
    $statePath = Join-Path $Cache $NotifyStateName
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $prevState = ''
    $prevTs = 0.0
    try {
        if (Test-Path -LiteralPath $statePath) {
            $last = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            # Свойства спрашиваем через PSObject: чужой/побитый файл состояния
            # под StrictMode уронил бы пульс на «property cannot be found» —
            # а состояние уведомлений не стоит ни одного потерянного вердикта.
            if ($null -ne $last.PSObject.Properties['state']) { $prevState = [string]$last.state }
            if ($null -ne $last.PSObject.Properties['ts']) { $prevTs = [double]$last.ts }
        }
    }
    catch {
        $prevState = ''
        $prevTs = 0.0
    }
    if ($prevState -eq $State -and ($now - $prevTs) -lt ($NotifyRepeatMinutes * 60)) {
        return $false
    }
    try {
        # состояние не записалось — уведомление важнее, шлём
        Set-Content -LiteralPath $statePath -Value ([pscustomobject]@{ state = $State; ts = $now } |
                ConvertTo-Json -Compress) -Encoding utf8
    }
    catch { }
    return $true
}

function Get-NotifyMechanism {
    <# Чем уведомлять: BurntToast (модуль, если поставлен вручную) →
    штатный Windows.UI.Notifications через Windows PowerShell 5.1 (есть в
    любой Windows 10/11) → $null («механизма нет» — честно, вместо
    «попробуем и упадём»). На Linux-pwsh механизма нет: это ожидаемо. #>
    if ($null -ne (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ Name = 'BurntToast (модуль)'; Kind = 'module' }
    }
    if ($IsWindows) {
        $root = $env:SystemRoot
        if ($root) {
            $ps51 = Join-Path $root 'System32/WindowsPowerShell/v1.0/powershell.exe'
            if (Test-Path -LiteralPath $ps51) {
                return [pscustomobject]@{ Name = 'Windows.UI.Notifications (Windows PowerShell 5.1)'; Kind = 'winrt'; Exe = $ps51 }
            }
        }
    }
    return $null
}

function Send-WinRtToast {
    <# Toast через Windows PowerShell 5.1. Текст передаём ФАЙЛОМ, а не
    аргументом: сообщение содержит кавычки/кириллицу, и склейка командной
    строки их бы съела. Имя временного файла — случайное (общий %TEMP%:
    предсказуемое имя подменяется чужим симлинком — конвенция репо).
    Ограничение по времени — 5с и Kill: висящий нотификатор не должен
    уносить пульс (урок 21.09, так пульс и потерял вердикт). #>
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$Message
    )
    $stamp = [System.IO.Path]::GetRandomFileName()
    $textPath = Join-Path ([System.IO.Path]::GetTempPath()) ("camoufox-toast-{0}.txt" -f $stamp)
    $scriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ("camoufox-toast-{0}.ps1" -f $stamp)
    # Однострочный вход: toast берёт две первые строки файла.
    $payload = @(
        ($Title -replace '[\r\n]+', ' '),
        ($Message -replace '[\r\n]+', ' ')
    )
    $toast = @"
`$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > `$null
`$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
`$x = `$t.GetElementsByTagName('text')
`$lines = Get-Content -LiteralPath '$textPath' -Encoding UTF8
`$x.Item(0).AppendChild(`$t.CreateTextNode(`$lines[0])) > `$null
`$x.Item(1).AppendChild(`$t.CreateTextNode(`$lines[1])) > `$null
`$n = [Windows.UI.Notifications.ToastNotification]::new(`$t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('camoufox-research').Show(`$n)
"@
    try {
        Set-Content -LiteralPath $textPath -Value $payload -Encoding utf8
        Set-Content -LiteralPath $scriptPath -Value $toast -Encoding utf8
        $proc = Start-Process -FilePath $Exe -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath) -PassThru -WindowStyle Hidden
        if (-not $proc.WaitForExit(5000)) {
            $proc.Kill()
            throw 'toast не ответил за 5 секунд'
        }
    }
    finally {
        Remove-Item -LiteralPath $textPath, $scriptPath -ErrorAction SilentlyContinue
    }
}

function Send-PulseNotification {
    <# Уведомление на рабочий стол: best-effort и НЕ блокирует пульс.
    Порядок как в Unix-версии: гейт (opt-in) → дедуп по состоянию →
    механизм → отправка с глушением ЛЮБОЙ ошибки. Вердикт пульса важнее
    того, дошёл ли тост. #>
    param(
        [Parameter(Mandatory)][string]$Message,
        [Parameter(Mandatory)][string]$State,
        [string]$Title = 'Кауфми-пульс',
        [switch]$Force
    )
    if (-not $Force) {
        if (-not (Test-NotifyAllowed)) { return }
        if (-not (Test-NotifyWorthIt -State $State)) { return }
    }
    $mech = Get-NotifyMechanism
    if ($null -eq $mech) {
        Write-Host '[*] механизм уведомлений не найден (нет BurntToast и Windows PowerShell 5.1) — вердикт только в логе' -ForegroundColor Yellow
        return
    }
    try {
        if ($mech.Kind -eq 'module') {
            New-BurntToastNotification -Text $Title, $Message | Out-Null
        }
        else {
            Send-WinRtToast -Exe $mech.Exe -Title $Title -Message $Message
        }
        Write-Host ("[i] уведомление отправлено: {0}" -f $mech.Name) -ForegroundColor Gray
    }
    catch {
        Write-Host ("[*] уведомление не ушло ({0}) — вердикт важнее" -f $_.Exception.Message) -ForegroundColor Yellow
    }
}

# --- ручная проверка канала уведомлений ------------------------------------
if ($TestNotify) {
    $mechanism = Get-NotifyMechanism
    if ($null -eq $mechanism) {
        Write-Host '[*] уведомления недоступны: BurntToast не установлен, Windows PowerShell 5.1 не найден.' -ForegroundColor Yellow
        Write-Host '    Это ожидаемо вне Windows: проверить канал можно только на Windows 10/11.' -ForegroundColor Yellow
    }
    else {
        Write-Host ("[i] механизм: {0}" -f $mechanism.Name) -ForegroundColor Gray
        Send-PulseNotification -Message ('тест канала {0}' -f (Get-Date -Format 'dd.MM HH:mm')) -State 'selftest' -Force
    }
    exit 0
}

# --- сам пульс -------------------------------------------------------------
$checks = @()
$fail = $false
$warn = $false
$pidPath = Resolve-PidFilePath -Explicit $PidFile

# 1. сервер жив
$mcp = if (Test-CamoufoxServer -PidPath $pidPath) { 'alive' } else { 'MISSING' }
$checks += ("mcp={0}" -f $mcp)
if ($mcp -ne 'alive') { $fail = $true }

# 2. сторож поиска свеж (с поправкой «машина спала»)
$lastOk = Get-LastWatchdogOk -Path (Join-Path $Cache 'watchdog.log')
$boot = Get-BootTime
$uptimeHours = $null
if ($null -ne $boot) { $uptimeHours = ((Get-Date) - $boot).TotalHours }
if ($null -eq $lastOk) {
    $warn = $true
    $checks += 'watchdog=no-data'
}
elseif (((Get-Date) - $lastOk).TotalHours -gt $StaleHours) {
    if ($null -ne $uptimeHours -and $uptimeHours -lt $BootGraceHours) {
        $warn = $true
        $checks += 'watchdog=stale(machine-was-off)'
    }
    elseif ($null -eq $uptimeHours) {
        # Время загрузки неизвестно — честный WARN, а не выдуманный FAIL.
        $warn = $true
        $checks += 'watchdog=stale(uptime-unknown)'
    }
    else {
        $fail = $true
        $checks += 'watchdog=STALE-FAIL'
    }
}
else {
    $checks += 'watchdog=ok'
}

# 3. добыча (cache.db)
if (Test-NonEmptyFile -Path (Join-Path $Cache 'cache.db')) {
    $checks += 'cache=ok'
}
else {
    $fail = $true
    $checks += 'cache=MISSING'
}

# 4. последний бэкап
$backupLog = Join-Path $Cache 'backup_cache.log'
if (Test-FreshFile -Path $backupLog -MaxAgeHours $BackupStaleHours) {
    $checks += 'backup=ok'
}
else {
    $warn = $true
    $checks += $(if (Test-Path -LiteralPath $backupLog) { 'backup=stale' } else { 'backup=no-data' })
}

$stamp = Get-Date -Format 'dd.MM HH:mm'
$verdict = if ($fail) { 'FAIL' } elseif ($warn) { 'WARN' } else { 'PASS' }
$line = ("{0} PULSE {1} {2}" -f $stamp, $verdict, ($checks -join ' '))
$stateKey = Get-StateKey -Verdict $verdict -Checks $checks

if ($DryRun) {
    Write-Host ("[i] dry-run: {0}" -f $line) -ForegroundColor Gray
    Write-Host ("[i] dry-run: файлы не менялись (ни {0}, ни {1}), уведомлений нет" -f $LogName, $AlertName) -ForegroundColor Gray
    Write-Host ("[i] пути: cache={0} pidfile={1}" -f $Cache, $pidPath) -ForegroundColor Gray
    exit $(if ($fail) { 1 } else { 0 })
}

if (-not (Test-Path -LiteralPath $Cache)) {
    New-Item -ItemType Directory -Path $Cache -Force | Out-Null
    Write-Host ("[i] создан каталог кэша: {0}" -f $Cache) -ForegroundColor Gray
}
Add-Content -LiteralPath (Join-Path $Cache $LogName) -Value $line -Encoding utf8
Write-Host ("[i] {0}" -f $line) -ForegroundColor $(if ($fail) { 'Red' } elseif ($warn) { 'Yellow' } else { 'Green' })

$alertPath = Join-Path $Cache $AlertName
if ($fail) {
    # Строка БЕЗ добавочного перевода: Set-Content сам ставит один "\n" в
    # конце — как `write_text(line + "\n")` в Unix-версии (файлы должны быть
    # побайтово одинаковыми: их читают одни и те же инструменты).
    Set-Content -LiteralPath $alertPath -Value $line -Encoding utf8
    Send-PulseNotification -Message $line -State $stateKey
    exit 1
}
if (Test-Path -LiteralPath $alertPath) { Remove-Item -LiteralPath $alertPath }
if ($warn) {
    Send-PulseNotification -Message ("{0} — догон сработает при загрузке" -f $line) -State $stateKey
}
exit 0
