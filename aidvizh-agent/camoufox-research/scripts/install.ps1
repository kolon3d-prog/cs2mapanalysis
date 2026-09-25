#Requires -Version 7.0
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

<#
.SYNOPSIS
    Нативная установка camoufox-research на Windows (без WSL и без Git-Bash).

.DESCRIPTION
    Windows-аналог scripts/install.sh. Шаги (идемпотентно, повторный прогон
    ничего не ломает):
      1/8 репозиторий — готовый клон рядом (скрипт/-Dir/текущий каталог) или
          клон в -Dir (по умолчанию $HOME\camoufox-research): можно ставить
          «в один клик» без клона;
      2/8 python >= 3.10 — поиск (py-лаунчер, python/python3, uv) или
          установка через winget (-BootstrapPython);
      3/8 системные зависимости — VC++ Redistributable 2015-2022 x64
          (без него Firefox-стек не стартует); -SkipDeps пропускает;
      4/8 venv В РАНТАЙМЕ — $HOME\.venvs\camoufox-research (не внутри клона):
          репозиторий — только код, окружение и кэши живут в $HOME;
      5/8 pip install . из КЛОНА (не git+https: ставим то, что на диске);
      6/8 python -m camoufox fetch — браузер (повторный прогон не качает);
      7/8 секция MCP в конфиге клиента (opencode/Claude) — с бэкапом
          и идемпотентностью (совпадает — не трогаем);
      8/8 проверка: импорт из venv, консольный скрипт, версия браузера и
          РУКОПОЖАТИЕ MCP (scripts/mcp_drive.py: initialize + tools/list —
          установка не считается успешной, если тулы не отдаются).

    ОТКУДА СТАВИМ (один результат; таблица — docs/install-windows.md):

      * ИЗ КЛОНА — основной путь: репо уже на диске, сеть не нужна, шага
        «клонировать» нет (ставится код из клона, в т.ч. своя ветка):
            pwsh -NoProfile -File <репо>\scripts\install.ps1 [-WhatIf]
        клон ищется рядом со скриптом; если он в другом месте — -Repo ПУТЬ
        (или env CAMOUFOX_REPO).

      * ОДНОЙ СТРОКОЙ — фолбэк для ДРУГОЙ машины, где клона нет (шаг 1/8
        склонирует сам в $HOME\camoufox-research):
            irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1 | iex

    Флаги в режиме iex не передать — форма для плана и настройки:
        $u = 'https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1'
        iwr $u -OutFile $env:TEMP\camoufox-install.ps1
        pwsh -NoProfile -File $env:TEMP\camoufox-install.ps1 -WhatIf
    либо (флаги принимаются, сессия остаётся чистой):
        & ([scriptblock]::Create((irm $u))) -Yes

    ЧЕСТНО про режим iex: скрипт не зовёт `exit` (в iex это убило бы консоль
    пользователя) и всё тело выполняется в дочерней области — ни функции, ни
    $ErrorActionPreference после установки в сессии не остаются.

    -WhatIf показывает план и НИЧЕГО не меняет: ни клон, ни venv, ни конфиг,
    ни бэкапов.

    ГДЕ ЧТО ЛЕЖИТ (рантайм вне репозитория — репозиторий это только код):
      * venv    — $HOME\.venvs\camoufox-research   (-Venv, env CAMOUFOX_VENV)
      * клон    — $HOME\camoufox-research          (-Dir, либо -Repo)
      * кэш     — $HOME\.cache\camoufox-research   (env CAMOUFOX_CACHE_DIR)
      * гейты   — <кэш>\gates                      (scripts/gates.sh)
      * браузер — путь Camoufox (Unix-канон ~/.cache/camoufox); на Windows это
                  %LOCALAPPDATA%\camoufox\camoufox\Cache. Точное значение
                  печатает -Version (спрашивает сам пакет, не угадывает).

    На не-Windows (Linux/macOS-pwsh) скрипт работоспособен как проверочный
    путь: пути venv берутся bin/, winget и VC++ пропускаются, MCP
    регистрируется теми же функциями. Штатная цель — Windows.

    ЧЕСТНО про Windows — чего в репозитории НЕТ (Unix-only, почему — в
    docs/install-windows.md):
      * cron-строки (scripts/install_cron.sh) и systemd-таймеры
        (scripts/install_timers.sh): расписание на Windows — Task Scheduler;
      * bash-стражи (guard-all.sh, git-pre-*.sh, gitleaks-precommit.sh) и
        git-хук gitleaks — bash; секрет-скан остаётся CI (GitHub Actions);
      * обёртка caps (scripts/update_mcp.sh) — bash; профиль тулов на Windows
        установщик кладёт в env самой записи клиента (CAMOUFOX_CAPS =
        research,browser,session,vision): ресёрч, чтение страниц, живая вкладка
        и картинки сразу, без ручной настройки. Сузить профиль — правкой env
        записи в конфиге клиента (например "research,browser");
      * scripts/install_mcp.py (пути venv/bin, config.env) — вместо него
        ЭТОТ скрипт; config.env на Windows не пишется (его читают
        Unix-крон-скрипты, которых тут нет).

.PARAMETER Dir
    Куда клонировать репозиторий, если готового клона рядом нет
    (по умолчанию $HOME\camoufox-research).
.PARAMETER Repo
    Готовый клон. По умолчанию клон ищется рядом со скриптом, затем в -Dir,
    затем в текущем каталоге.
.PARAMETER Ref
    Ветка/тег для клона (по умолчанию env CAMOUFOX_REF, иначе main).
.PARAMETER Venv
    Каталог venv (по умолчанию $HOME\.venvs\camoufox-research; env
    CAMOUFOX_VENV). Внутри клона venv НЕ создаётся: репозиторий — только код.
.PARAMETER Client
    Куда прописать MCP: auto (только для найденных клиентов), opencode,
    claude, both, none.
.PARAMETER OpencodePath
    Путь к opencode.json (по умолчанию $HOME\.config\opencode\opencode.json).
.PARAMETER ClaudePath
    Путь к claude_desktop_config.json (по умолчанию %APPDATA%\Claude\...).
.PARAMETER Python
    Явный интерпретатор >= 3.10 (иначе ищем сами; список — в -WhatIf).
.PARAMETER BootstrapPython
    Подходящего python нет — поставить через winget (Python.Python.3.13).
.PARAMETER SkipDeps
    Не проверять и не ставить системные зависимости (Windows: VC++
    Redistributable 2015-2022 x64) — считаем, что их поставили вручную.
.PARAMETER RegisterOnly
    Пропустить шаги 2-6 (python/venv/pip/браузер уже готовы) и только
    прописать MCP. Так же проверяется регистрация на не-Windows ОС.
.PARAMETER SkipBrowser
    Не качать браузер (нет сети/прокси): установка продолжится, но research
    без браузера не работает.
.PARAMETER Reinstall
    Переставить пакет (pip --force-reinstall --no-deps). Venv не удаляется.
.PARAMETER Uninstall
    Убрать venv и запись MCP из конфига клиента (с бэкапом). Кэш добычи
    ($HOME\.cache\camoufox-research) и браузер НЕ трогаются: там cache.db,
    отчёты и 200+ МБ бинарников — их удаляют осознанно, команды печатаются.
.PARAMETER Yes
    Не задавать вопросов (подтверждение -Uninstall) — для неинтерактивного
    запуска (CI, пайп).
.PARAMETER Version
    Показать версии и пути (скрипт, python, пакет, браузер, кэши) и выйти,
    ничего не меняя.

.OUTPUTS
    Код возврата: 0 — ок, 1 — ошибка установки, 2 — ошибка входных данных
    (клон не найден/не клон, битый JSON конфига, неизвестный клиент).
    В режиме iex код не возвращается — сбой виден исключением в консоли.

.EXAMPLE
    PS> .\scripts\install.ps1
    Основной путь: установка из КЛОНА на диске — из GitHub ничего не тянется,
    ставится код клона. Клон в другом месте — .\scripts\install.ps1 -Repo C:\src\camoufox-research
.EXAMPLE
    PS> .\scripts\install.ps1 -WhatIf
    План без единого изменения в системе.
.EXAMPLE
    PS> .\scripts\install.ps1 -BootstrapPython -Client both
    Установка с нуля; MCP — и в opencode, и в Claude Desktop.
.EXAMPLE
    PS> .\scripts\install.ps1 -Uninstall -Yes
    Снести venv и запись MCP; кэш и браузер остаются.
.EXAMPLE
    PS> irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1 | iex
    Фолбэк для машины БЕЗ клона: склонирует репо в $HOME\camoufox-research,
    поднимет venv в $HOME\.venvs\camoufox-research, скачает браузер, пропишет
    MCP, проверит. Флаги в этом режиме не передать — см. -File выше.
#>

# Подавления PSScriptAnalyzer — с обоснованием, а не «чтобы было тихо»:
#   * Write-Host: это КОНСОЛЬНЫЙ установщик, цветные маркеры шагов — суть UI
#     (в пайп ничего не отдаём намеренно: тело работает через Write-Host);
#   * ShouldProcess-правила: изменения идут только через Invoke-Step, а он
#     зовёт ShouldProcess на объекте скрипта ($Gate) — статически не видно;
#   * UnusedParameter: параметры дочернего скриптблока читают ВЛОЖЕННЫЕ
#     функции (динамическая область видимости) — анализатор их не считает;
#   * SingularNouns: функции возвращают коллекцию (кандидаты/пути/цели) —
#     плюрал тут по смыслу;
#   * BOM: репозиторий держит .ps1 в UTF-8 БЕЗ BOM (так же health_pulse.ps1),
#     PowerShell 7 читает UTF-8 по умолчанию.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Консольный установщик: цветные маркеры шагов — это UI.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSShouldProcess', '', Justification = 'Изменения идут через Invoke-Step, который зовёт ShouldProcess на $Gate.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'ShouldProcess вызывается в единой точке Invoke-Step.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', '', Justification = 'Параметры скриптблока читают вложенные функции (динамическая область).')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns', '', Justification = 'Плюрал по смыслу: функция возвращает коллекцию.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseBOMForUnicodeEncodedFile', '', Justification = 'UTF-8 без BOM — конвенция репозитория (как health_pulse.ps1).')]
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$Dir = '',
    [string]$Repo = '',
    [string]$Ref = '',
    [string]$Venv = '',
    [ValidateSet('auto', 'opencode', 'claude', 'both', 'none')]
    [string]$Client = 'auto',
    [string]$OpencodePath = '',
    [string]$ClaudePath = '',
    [string]$Python = '',
    [switch]$BootstrapPython,
    [switch]$SkipDeps,
    [switch]$SkipBrowser,
    [switch]$RegisterOnly,
    [switch]$Reinstall,
    [switch]$Uninstall,
    [switch]$Yes,
    [switch]$Version
)

# --- проводник -------------------------------------------------------------
# Почему тело в скриптблоке, а не «плоско»: в режиме `irm ... | iex` код
# выполняется в области СЕССИИ, и «плоский» скрипт оставил бы там свои
# функции, $ErrorActionPreference='Stop' и $ProgressPreference — человек
# получил бы установку с побочкой в своём окне. Скриптблок, вызванный через
# `&`, работает в дочерней области: функции и преференсы умирают вместе с ней.
# Побочный эффект приятный: режим iex (нет файла скрипта) и режим файла
# отличаются ТОЛЬКО тем, можно ли звать `exit` — в iex `exit` убивает консоль
# пользователя (проверено), поэтому там сбой бросает исключение.
#
# $PSCmdlet (гейт ShouldProcess) в iex НЕ определён — читаем через Get-Variable;
# в режиме `& ([scriptblock]::Create(...)) -Yes` он есть, и -WhatIf работает.
& {
    param(
        [hashtable]$Bound,
        [string]$ScriptPath,
        [bool]$Inline,
        [object]$Gate,
        [bool]$WhatIf
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    # $LASTEXITCODE создаётся только ПОСЛЕ первого внешнего процесса, а читаем мы
    # его всегда — под StrictMode это «cannot be retrieved because it has not been
    # set» (грабля PS 7). Обнуляем заранее, а не оборачиваем каждое чтение.
    $global:LASTEXITCODE = 0
    $ProgressPreference = 'SilentlyContinue'   # прогресс-бар загрузок — шум в консоли

    if ($null -eq $Bound) { $Bound = @{} }

    # --- параметры: значения из хештейбла привязки ------------------------
    # (имена на Get-, а не Arg-: PSScriptAnalyzer требует одобренных глаголов,
    #  Get — одобрен; смысл тот же — «взять значение из привязки»)
    function Get-ArgString {
        param([Parameter(Mandatory)][string]$Name)
        if ($Bound.ContainsKey($Name)) { return [string]$Bound[$Name] }
        return ''
    }
    function Get-ArgSwitch {
        param([Parameter(Mandatory)][string]$Name)
        if ($Bound.ContainsKey($Name)) { return [bool]$Bound[$Name].IsPresent }
        return $false
    }

    $OptDir = Get-ArgString 'Dir'
    $OptRepo = Get-ArgString 'Repo'
    $OptRef = Get-ArgString 'Ref'
    $OptVenv = Get-ArgString 'Venv'
    $OptClient = Get-ArgString 'Client'
    if (-not $OptClient) { $OptClient = 'auto' }
    $OptOpencodePath = Get-ArgString 'OpencodePath'
    $OptClaudePath = Get-ArgString 'ClaudePath'
    $OptPython = Get-ArgString 'Python'
    $FlagBootstrap = Get-ArgSwitch 'BootstrapPython'
    $FlagSkipDeps = Get-ArgSwitch 'SkipDeps'
    $FlagSkipBrowser = Get-ArgSwitch 'SkipBrowser'
    $FlagRegisterOnly = Get-ArgSwitch 'RegisterOnly'
    $FlagReinstall = Get-ArgSwitch 'Reinstall'
    $FlagUninstall = Get-ArgSwitch 'Uninstall'
    $FlagYes = Get-ArgSwitch 'Yes'
    $FlagVersion = Get-ArgSwitch 'Version'

    # env-фолбэк для клона — как у install.sh (CAMOUFOX_REPO): у пути установки
    # должен быть один источник истины, а не два разных у .sh и .ps1.
    if (-not $OptRepo) { $OptRepo = [string]$env:CAMOUFOX_REPO }

    $OnWindows = [bool]$IsWindows
    # План-режим берём из ЯВНО привязанного -WhatIf ($PSBoundParameters), а не из
    # $WhatIfPreference: у скрипта с CmdletBinding последний в iex-области не
    # отражает вызов (проверено: -WhatIf на `-File` там остаётся False, а
    # $PSBoundParameters['WhatIf'] — True). Гейт — вторая, независимая опора.
    $PlanMode = [bool]$WhatIf
    if ((-not $PlanMode) -and ($null -ne $Gate)) {
        try { $PlanMode = [bool]$Gate.MyInvocation.BoundParameters['WhatIf'] }
        catch { $PlanMode = $false }
    }
    $Interactive = $false
    try { $Interactive = ([Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)) }
    catch { $Interactive = $false }

    $InstallerVersion = '2.0.0'
    $GithubRepo = 'aidvizhhub/camoufox-research'
    $GitUrl = "https://github.com/$GithubRepo.git"
    $DefaultBranch = 'main'
    $RawUrl = "https://raw.githubusercontent.com/$GithubRepo/$DefaultBranch/scripts/install.ps1"
    $DefaultDirName = 'camoufox-research'
    $MinPythonMinor = 10
    $MaxTestedMinor = 13      # проверенный диапазон 3.10-3.13 (как install.sh)
    $HandshakeTimeoutSec = 180
    $McpNameOpencode = 'camoufox'
    $McpNameClaude = 'camoufox-research'
    $McpModule = 'camoufox_research.camoufox_research'
    # Профиль тулов для клиента: ресёрч + чтение страниц + живая вкладка (скролл, клики, формы) +
    # картинки. На Windows bash-обёртки нет, поэтому профиль кладём прямо в env записи клиента;
    # сузить (например до research,browser) — правкой этой строки или env в конфиге клиента.
    # Тот же дефолт в mcp-station/catalog/camoufox.json и scripts/install_mcp.py.
    $DefaultCaps = 'research,browser,session,vision'

    # --- вывод: ASCII-маркеры (эмодзи в .ps1 ломают кодировку консоли) ------
    function Write-Line {
        param(
            [ValidateSet('INFO', 'OK', 'WARN', 'FAIL', 'STEP')][string]$Level,
            [Parameter(Mandatory)][string]$Message
        )
        $tag = switch ($Level) { 'OK' { '[+]' } 'WARN' { '[*]' } 'FAIL' { '[!]' } 'STEP' { '[>]' } default { '[i]' } }
        $color = switch ($Level) { 'OK' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } 'STEP' { 'Cyan' } default { 'Gray' } }
        Write-Host ("{0} {1}" -f $tag, $Message) -ForegroundColor $color
    }

    # --- общие хелперы -----------------------------------------------------
    function Test-CommandExists {
        param([Parameter(Mandatory)][string]$Name)
        return ($null -ne (Get-Command $Name -ErrorAction SilentlyContinue))
    }

    function Invoke-Checked {
        <# Внешняя команда, ненулевой rc — исключение. $ErrorActionPreference='Stop'
        на нативные процессы НЕ действует: без ручной проверки pip падал бы
        «успешно» и установка продолжалась бы на пустом venv. #>
        param(
            [Parameter(Mandatory)][string]$Exe,
            [string[]]$Arguments = @()
        )
        Write-Verbose ("run: {0} {1}" -f $Exe, ($Arguments -join ' '))
        & $Exe @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw ("{0} вернул код {1}" -f $Exe, $LASTEXITCODE)
        }
    }

    function Get-NativeText {
        <# stdout внешней команды строкой; '' — команды нет/упала/пусто.
        Молчание здесь честнее исключения: это ПРОБА (есть версия? есть пакет?),
        решение принимает вызывающий. #>
        param(
            [Parameter(Mandatory)][string]$Exe,
            [string[]]$Arguments = @()
        )
        try {
            $out = & $Exe @Arguments 2>$null
            return (($out | Out-String).Trim())
        }
        catch {
            return ''
        }
    }

    function Get-NativeTextTimed {
        <# stdout+stderr внешнего процесса С ПОТОЛКОМ ПО ВРЕМЕНИ.
        Нужно ровно для рукопожатия MCP: зависший сервер не должен вешать
        установку. ArgumentList (а не строка) — правильное квотирование путей
        с пробелами без ручной сборки командной строки; чтение асинхронное,
        иначе полный pipe (64 КБ) заклинил бы WaitForExit. #>
        param(
            [Parameter(Mandatory)][string]$Exe,
            [string[]]$Arguments = @(),
            [int]$TimeoutSec = 120
        )
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $Exe
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        foreach ($arg in $Arguments) { $psi.ArgumentList.Add($arg) }
        $proc = [System.Diagnostics.Process]::Start($psi)
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit([int]($TimeoutSec * 1000))) {
            # Убиваем дерево (сервер — дочерний процесс клиента); если он уже
            # умер сам — это не ошибка, но и не пустой catch: причина в verbose.
            try { $proc.Kill($true) }
            catch { Write-Verbose ("kill: {0}" -f $_.Exception.Message) }
            return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Text = '' }
        }
        $text = (($outTask.Result + $errTask.Result) | Out-String).Trim()
        return [pscustomobject]@{ TimedOut = $false; ExitCode = $proc.ExitCode; Text = $text }
    }

    function Invoke-Step {
        <# ЕДИНАЯ точка изменений: под -WhatIf печатает план и не выполняет.
        ShouldProcess даёт штатное «What if: ...», строка WHATIF — что именно
        осталось нетронутым (в т.ч. путь конфига и бэкапа).

        Имена параметров СПЕЦИАЛЬНО с префиксом Step: скриптблок действия
        вызывается из ЭТОЙ функции, а переменные PowerShell ищет по цепочке
        областей, то есть сначала в области Invoke-Step. Параметр $Target
        перебивал переменную $target вызывающего (регистр не важен!), и
        действие падало на «property 'Key' cannot be found» — на строке
        вызова, а не в виновнике (грабля поймана прогоном на Linux-pwsh).

        Гейта может не быть вовсе (режим `irm | iex`: $PSCmdlet там нет) —
        тогда единственный план-режим, который возможен, это PlanMode. #>
        param(
            [Parameter(Mandatory)][string]$StepTitle,
            [Parameter(Mandatory)][string]$StepTarget,
            [Parameter(Mandatory)][scriptblock]$StepAction
        )
        $proceed = $true
        if ($null -ne $Gate) {
            $proceed = $Gate.ShouldProcess($StepTarget, $StepTitle)
        }
        elseif ($PlanMode) {
            $proceed = $false
        }
        if ($proceed) {
            & $StepAction
            return $true
        }
        Write-Host ("  [WHATIF] {0}: {1}" -f $StepTitle, $StepTarget) -ForegroundColor DarkGray
        return $false
    }

    # --- 1/8 репозиторий ----------------------------------------------------
    function Test-RepoLooksLikeClone {
        <# Признак клона — не только имя каталога: pyproject.toml И пакет.
        По этому признаку отличаем «рядом лежит клон» от «рядом лежит что-то
        с таким же именем». #>
        param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
        if (-not $Path) { return $false }
        if (-not (Test-Path -LiteralPath $Path)) { return $false }
        return ((Test-Path -LiteralPath (Join-Path $Path 'pyproject.toml')) -and
                (Test-Path -LiteralPath (Join-Path $Path 'camoufox_research')))
    }

    function Expand-RepoZip {
        <# Клон без git (на свежей Windows git часто нет): zip с codeload.
        Именно этот путь делал бы «в один клик» невозможным, если опираться
        на git — поэтому фолбэк обязателен. #>
        param(
            [Parameter(Mandatory)][string]$Target,
            [Parameter(Mandatory)][string]$Branch
        )
        $tempRoot = [System.IO.Path]::GetTempPath()
        $arc = Join-Path $tempRoot ("camoufox-{0}.zip" -f $Branch)
        $stage = Join-Path $tempRoot ("camoufox-unzip-{0}" -f ([guid]::NewGuid().ToString('N')))
        $url = "https://codeload.github.com/{0}/zip/refs/heads/{1}" -f $GithubRepo, $Branch
        try {
            Invoke-WebRequest -Uri $url -OutFile $arc
            Expand-Archive -LiteralPath $arc -DestinationPath $stage -Force
            $inner = Join-Path $stage ("{0}-{1}" -f $DefaultDirName, $Branch)
            if (-not (Test-Path -LiteralPath $inner)) {
                # имя распакованного каталога зависит от ветки (<repo>-<ref>)
                $dirs = @(Get-ChildItem -LiteralPath $stage -Directory -ErrorAction Stop)
                if ($dirs.Count -eq 0) { throw 'в архиве нет каталога с кодом' }
                $inner = $dirs[0].FullName
            }
            $parent = Split-Path -Parent $Target
            if ($parent -and (-not (Test-Path -LiteralPath $parent))) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            Move-Item -LiteralPath $inner -Destination $Target
        }
        finally {
            foreach ($junk in @($arc, $stage)) {
                Remove-Item -LiteralPath $junk -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    function Install-RepoClone {
        <# Клон в целевой каталог. $true — каталог стал клоном (в -WhatIf —
        «стал бы»). Непустой каталог НЕ трогаем: удалять чужое нельзя. #>
        param(
            [Parameter(Mandatory)][string]$Target,
            [string]$Ref = ''
        )
        if (Test-RepoLooksLikeClone -Path $Target) { return $true }
        if (Test-Path -LiteralPath $Target) {
            $entries = @(Get-ChildItem -LiteralPath $Target -Force -ErrorAction SilentlyContinue)
            if ($entries.Count -gt 0) {
                Write-Line FAIL ("{0} существует и не пуст — не трогаю его; укажи другой -Dir или готовый клон в -Repo" -f $Target)
                return $false
            }
        }
        $branch = $Ref
        if (-not $branch) {
            $branch = if ($env:CAMOUFOX_REF) { $env:CAMOUFOX_REF } else { $DefaultBranch }
        }
        $ok = $true
        if (Test-CommandExists 'git') {
            $ok = Invoke-Step -StepTitle ("git clone --depth 1 --branch {0}" -f $branch) -StepTarget $Target -StepAction {
                # GIT_TERMINAL_PROMPT=0: иначе git спросит логин/пароль и установка
                # «зависнет» — а при пайпе (irm|iex) спрашивать некого. Восстанавливаем
                # значение: в режиме iex переменные среды переживут установку.
                $prevPrompt = $env:GIT_TERMINAL_PROMPT
                $env:GIT_TERMINAL_PROMPT = '0'
                try {
                    Invoke-Checked -Exe 'git' -Arguments @('clone', '--depth', '1', '--branch', $branch, $GitUrl, $Target)
                }
                finally {
                    $env:GIT_TERMINAL_PROMPT = $prevPrompt
                }
            }
        }
        else {
            Write-Line WARN 'git не найден — качаю zip с GitHub (без истории, тот же код ветки)'
            $ok = Invoke-Step -StepTitle ("скачать zip {0}@{1}" -f $GithubRepo, $branch) -StepTarget $Target -StepAction {
                Expand-RepoZip -Target $Target -Branch $branch
            }
        }
        if ($PlanMode) { return $true }   # в плане дальше показываем пути, как будто клон есть
        if ($ok -and (Test-RepoLooksLikeClone -Path $Target)) { return $true }
        Write-Line FAIL ("клон не получился: {0} — проверь сеть/прокси или склонируй сам: git clone {1}" -f $Target, $GitUrl)
        return $false
    }

    function Resolve-Repo {
        <# Где код. Порядок: -Repo → рядом со скриптом → -Dir → текущий каталог
        → клон в -Dir. Возвращает Code (0 — есть Path; 2 — вход невалиден,
        сообщение уже напечатано) и Path (в -WhatIf — предполагаемый). #>
        param(
            [string]$ExplicitRepo,
            [string]$Dir,
            [string]$Ref,
            [string]$ScriptPath,
            [bool]$AllowClone = $true
        )
        if (-not $Dir) { $Dir = Join-Path $HOME $DefaultDirName }
        if ($ExplicitRepo) {
            if (-not (Test-RepoLooksLikeClone -Path $ExplicitRepo)) {
                Write-Line FAIL ("-Repo: {0} не похож на клон camoufox-research (нужны pyproject.toml и папка camoufox_research)" -f $ExplicitRepo)
                return [pscustomobject]@{ Code = 2; Path = '' }
            }
            return [pscustomobject]@{ Code = 0; Path = (Resolve-Path -LiteralPath $ExplicitRepo).Path }
        }
        $candidates = @()
        if ($ScriptPath) {
            $candidates += [pscustomobject]@{ Path = (Split-Path -Parent (Split-Path -Parent $ScriptPath)); Why = 'рядом со скриптом' }
        }
        $candidates += [pscustomobject]@{ Path = $Dir; Why = 'каталог -Dir' }
        if ($PWD) { $candidates += [pscustomobject]@{ Path = $PWD.Path; Why = 'текущий каталог' } }
        foreach ($cand in $candidates) {
            if (Test-RepoLooksLikeClone -Path $cand.Path) {
                Write-Line OK ("клон найден ({0}): {1}" -f $cand.Why, $cand.Path)
                return [pscustomobject]@{ Code = 0; Path = (Resolve-Path -LiteralPath $cand.Path).Path }
            }
        }
        if (-not $AllowClone) {
            Write-Line INFO 'клона рядом нет — продолжаю без репозитория (пути беру из параметров)'
            return [pscustomobject]@{ Code = 0; Path = '' }
        }
        Write-Line INFO ("клона рядом нет: беру {0} в {1}" -f $GitUrl, $Dir)
        if (Install-RepoClone -Target $Dir -Ref $Ref) {
            return [pscustomobject]@{ Code = 0; Path = $Dir }
        }
        return [pscustomobject]@{ Code = 2; Path = '' }
    }

    # --- 2/8 python --------------------------------------------------------
    function Get-PythonVersion {
        <# Версия интерпретатора объектом или $null. -c без -I/-P: изолированный
        режим добавлен разными версиями по-разному, а нам нужна лишь версия. #>
        param(
            [Parameter(Mandatory)][string]$Exe,
            [string[]]$Arguments = @()
        )
        $code = 'import sys; print("%d.%d.%d" % sys.version_info[:3])'
        $out = Get-NativeText -Exe $Exe -Arguments ($Arguments + @('-c', $code))
        if ($out -match '^(\d+)\.(\d+)\.(\d+)$') {
            return [pscustomobject]@{ Text = $Matches[0]; Major = [int]$Matches[1]; Minor = [int]$Matches[2] }
        }
        return $null
    }

    function Get-PythonCandidates {
        <# Кандидаты в порядке предпочтения: явный -Python, CAMOUFOX_PYTHON,
        py-лаунчер (на Windows рядом живут несколько версий), python, python3.
        py-лаунчер — первым среди автоматических: он умеет выбрать версию, а
        `python` из PATH на Windows легко оказывается заглушкой MS Store. #>
        $list = @()
        if ($OptPython) { $list += [pscustomobject]@{ Exe = $OptPython; Args = @(); Note = 'параметр -Python' } }
        if ($env:CAMOUFOX_PYTHON) {
            $list += [pscustomobject]@{ Exe = $env:CAMOUFOX_PYTHON; Args = @(); Note = 'env CAMOUFOX_PYTHON' }
        }
        if (Test-CommandExists 'py') {
            foreach ($v in @('3.13', '3.12', '3.11', '3.10', '3')) {
                $list += [pscustomobject]@{ Exe = 'py'; Args = @("-$v"); Note = "py -$v" }
            }
        }
        foreach ($name in @('python', 'python3')) {
            if (Test-CommandExists $name) {
                $list += [pscustomobject]@{ Exe = $name; Args = @(); Note = $name }
            }
        }
        return $list
    }

    function Select-Python {
        param(
            # Не Mandatory: кандидатов может не быть ВООБЩЕ (нет ни py, ни python) —
            # и это нормальный ответ «подходящего нет», а не ошибка привязки
            # параметра (грабля: пустой массив в позиции Mandatory даёт
            # «Cannot bind argument to parameter because it is null» и ронял
            # скрипт до плана).
            [object[]]$Candidates = @(),
            [Parameter(Mandatory)][int]$MinMinor
        )
        if ($null -eq $Candidates) { $Candidates = @() }
        foreach ($cand in $Candidates) {
            $ver = Get-PythonVersion -Exe $cand.Exe -Arguments $cand.Args
            if ($null -eq $ver) {
                Write-Line WARN ("{0}: не запустился — пропускаю" -f $cand.Note)
                continue
            }
            if (($ver.Major -ne 3) -or ($ver.Minor -lt $MinMinor)) {
                Write-Line WARN ("{0}: python {1} — не подходит (нужен >= 3.{2})" -f $cand.Note, $ver.Text, $MinMinor)
                continue
            }
            if ($ver.Minor -gt $MaxTestedMinor) {
                Write-Line WARN ("{0}: python {1} вне проверенного диапазона 3.10-3.13 — колёс зависимостей может не быть" -f $cand.Note, $ver.Text)
            }
            return [pscustomobject]@{ Exe = $cand.Exe; Args = $cand.Args; Note = $cand.Note; Version = $ver.Text }
        }
        return $null
    }

    # --- 3/8 системные зависимости -----------------------------------------
    function Invoke-DepsStep {
        <# Windows-специфика: Firefox-стек (Camoufox) без VC++ Redistributable
        2015-2022 x64 не стартует, и падает он не на установке, а на первом
        запуске — поэтому проверяем здесь. Реестровый ключ — то, чем сам
        Microsoft определяет наличие рантайма. #>
        if (-not $OnWindows) {
            Write-Line INFO 'не Windows: системные библиотеки Firefox-стека здесь не нужны — пропускаю'
            return
        }
        if ($FlagSkipDeps) {
            Write-Line WARN '-SkipDeps: зависимости не проверяю и не ставлю (VC++ Redistributable 2015-2022 x64 — на тебе)'
            return
        }
        $key = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
        $installed = $false
        $version = ''
        try {
            if (Test-Path -LiteralPath $key) {
                $value = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).Version
                if ($value) {
                    $installed = $true
                    $version = [string]$value
                }
            }
        }
        catch {
            Write-Line WARN ("реестр недоступен ({0}) — проверь VC++ Redistributable вручную" -f $_.Exception.Message)
        }
        if ($installed) {
            Write-Line OK ("VC++ Redistributable x64: {0}" -f $version)
            return
        }
        Write-Line WARN 'VC++ Redistributable 2015-2022 x64 не найден — Firefox-стек без него не стартует'
        if (Test-CommandExists 'winget') {
            Invoke-Step -StepTitle 'winget install Microsoft.VCRedist.2015+.x64' -StepTarget 'VC++ Redistributable x64' -StepAction {
                Invoke-Checked -Exe 'winget' -Arguments @(
                    'install', '--id', 'Microsoft.VCRedist.2015+.x64', '-e', '--source', 'winget',
                    '--accept-package-agreements', '--accept-source-agreements')
            } | Out-Null
            Write-Line INFO 'поставлен (проверка ключа — при следующем прогоне: установщик не обновляет состояние в текущем окне)'
        }
        else {
            Write-Line WARN 'winget нет: поставь вручную — https://aka.ms/vs/17/release/vc_redist.x64.exe'
        }
    }

    # --- 4/8 venv ----------------------------------------------------------
    function Get-VenvPaths {
        <# Пути внутри venv. Windows — Scripts\python.exe, Linux/macOS — bin/python
        (проверочные прогоны и -RegisterOnly). Только то, что реально
        используется: pip зовём как `-m pip` (не по пути), site-packages —
        лишь в тексте документации. #>
        param([Parameter(Mandatory)][string]$VenvPath)
        $binName = if ($OnWindows) { 'Scripts' } else { 'bin' }
        $exeSuffix = if ($OnWindows) { '.exe' } else { '' }
        $bin = Join-Path $VenvPath $binName
        return [pscustomobject]@{
            Path   = $VenvPath
            Bin    = $bin
            Python = (Join-Path $bin ("python{0}" -f $exeSuffix))
            Entry  = (Join-Path $bin ("camoufox-research{0}" -f $exeSuffix))
        }
    }

    function Test-PackageInstalled {
        <# Установлен ли пакет В VENV. Обязательно из нейтрального каталога: в
        корне репо лежит папка camoufox_research, и `python -c "import ..."` оттуда
        импортирует ИСХОДНИКИ, подтверждая установку, которой нет (та же грабля,
        что у install.sh с проверкой импорта). #>
        param(
            [Parameter(Mandatory)][string]$VenvPython,
            [Parameter(Mandatory)][AllowEmptyString()][string]$RepoPath
        )
        $neutral = [System.IO.Path]::GetTempPath()
        Push-Location -LiteralPath $neutral
        try {
            $out = Get-NativeText -Exe $VenvPython -Arguments @('-c', 'import camoufox_research as m; print(m.__file__)')
        }
        finally {
            Pop-Location
        }
        if (-not $out) { return $null }
        if ($RepoPath) {
            # StartsWith, а не -like "$RepoPath*": в пути могут быть символы шаблона
            # ([ ] ? *), и -like сравнил бы не то, что нужно. OrdinalIgnoreCase —
            # Windows-пути регистронезависимы.
            if ($out.StartsWith($RepoPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $null   # исходники, а не установка
            }
        }
        return $out
    }

    function Test-BrowserInstalled {
        param([Parameter(Mandatory)][string]$VenvPython)
        return (Get-NativeText -Exe $VenvPython -Arguments @(
                '-c', 'from camoufox.pkgman import installed_verstr; print(installed_verstr())'))
    }

    function Get-BrowserDir {
        <# Каталог браузера спрашиваем у самого пакета (platformdirs: Unix
        ~/.cache/camoufox, Windows %LOCALAPPDATA%\camoufox\camoufox\Cache) —
        угадывать путь в двух местах нельзя. #>
        param([Parameter(Mandatory)][string]$VenvPython)
        return (Get-NativeText -Exe $VenvPython -Arguments @(
                '-c', 'from camoufox.pkgman import INSTALL_DIR; print(INSTALL_DIR)'))
    }

    # --- 7/8 конфиг клиента ------------------------------------------------
    function Get-ClientTargets {
        <# Что регистрируем и где. auto — только НАЙДЕННЫЕ клиенты: создавать
        конфиг клиенту, которого на машине нет, — самовольство (явно хочется —
        -Client opencode/claude/both). #>
        param(
            [Parameter(Mandatory)][string]$Client,
            [string]$OpencodeExplicit = '',
            [string]$ClaudeExplicit = ''
        )
        $opencodeDefault = Join-Path $HOME '.config/opencode/opencode.json'
        $claudeDefault = ''
        if ($env:APPDATA) { $claudeDefault = Join-Path $env:APPDATA 'Claude/claude_desktop_config.json' }

        $wantOpencode = $false
        $wantClaude = $false
        switch ($Client) {
            'opencode' { $wantOpencode = $true }
            'claude' { $wantClaude = $true }
            'both' { $wantOpencode = $true; $wantClaude = $true }
            'none' { }
            'auto' {
                $wantOpencode = (Test-Path -LiteralPath $opencodeDefault) -or (Test-CommandExists 'opencode2') -or (Test-CommandExists 'opencode')
                if ($claudeDefault) { $wantClaude = Test-Path -LiteralPath $claudeDefault }
                if (-not $wantOpencode) { $wantOpencode = -not [string]::IsNullOrEmpty($OpencodeExplicit) }
                if (-not $wantClaude) { $wantClaude = -not [string]::IsNullOrEmpty($ClaudeExplicit) }
            }
        }

        $targets = @()
        if ($wantOpencode) {
            $path = if ($OpencodeExplicit) { $OpencodeExplicit } else { $opencodeDefault }
            $targets += [pscustomobject]@{ Flavor = 'opencode'; Path = $path; Container = 'mcp'; Key = $McpNameOpencode }
        }
        if ($wantClaude) {
            if (-not $ClaudeExplicit -and -not $claudeDefault) {
                throw ('Claude Desktop: нет %APPDATA% — укажи -ClaudePath явно')
            }
            $path = if ($ClaudeExplicit) { $ClaudeExplicit } else { $claudeDefault }
            $targets += [pscustomobject]@{ Flavor = 'claude'; Path = $path; Container = 'mcpServers'; Key = $McpNameClaude }
        }
        return $targets
    }

    function Read-JsonConfig {
        <# JSON клиента объектом или $null (файла нет/пуст). Битый JSON — не
        глотаем: перезапись конфига клиента стирает чужие настройки. #>
        param([Parameter(Mandatory)][string]$Path)
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    }

    function Backup-ConfigFile {
        <# Бэкап ПЕРЕД любой правкой конфига клиента — единственная защита от
        потери чужих настроек. Имя со штампом: два прогона в одну секунду не
        редкость (идемпотентность проверяется тем же файлом), а «бэкап уже
        есть — не перезаписываю» потеряло бы состояние ПЕРЕД второй правкой.
        Чужой бэкап всё равно не затираем: берём следующее свободное имя. #>
        param([Parameter(Mandatory)][string]$Path)
        if (-not (Test-Path -LiteralPath $Path)) { return '' }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "{0}.bak-{1}" -f $Path, $stamp
        $suffix = 1
        while ((Test-Path -LiteralPath $backup) -and ($suffix -lt 100)) {
            $suffix++
            $backup = "{0}.bak-{1}-{2}" -f $Path, $stamp, $suffix
        }
        Copy-Item -LiteralPath $Path -Destination $backup
        Write-Line INFO ("бэкап: {0}" -f $backup)
        return $backup
    }

    function Get-McpCommand {
        <# Команда запуска сервера массивом. Консольный скрипт venv — канон
        (как в mcp/config/*.example); если его нет (например -RegisterOnly),
        зовём модуль напрямую, но именно ЗАПУСКАЮЩИЙ модуль — у пакетного
        элемента нет __main__.py, `-m camoufox_research` молча ничего не выведет. #>
        param([Parameter(Mandatory)][string]$VenvPath)
        $paths = Get-VenvPaths -VenvPath $VenvPath
        if (Test-Path -LiteralPath $paths.Entry) { return , @($paths.Entry) }
        return , @($paths.Python, '-m', $McpModule)
    }

    function New-McpEntry {
        param(
            [Parameter(Mandatory)][ValidateSet('opencode', 'claude')][string]$Flavor,
            [Parameter(Mandatory)][string[]]$Command
        )
        # Профиль тулов едет в записи клиента: на Windows bash-обёртки, которая задала бы
        # CAMOUFOX_CAPS, нет — без env сервер отдал бы свой узкий дефолт (34 тула) без сессии.
        if ($Flavor -eq 'opencode') {
            return [pscustomobject][ordered]@{
                type        = 'local'
                command     = $Command
                environment = [pscustomobject][ordered]@{ CAMOUFOX_CAPS = $DefaultCaps }
                enabled     = $true
            }
        }
        # Claude Desktop: своя схема — command строкой, остальное в args, переменные в env.
        return [pscustomobject][ordered]@{
            command = $Command[0]
            args    = @($Command | Select-Object -Skip 1)
            env     = [pscustomobject][ordered]@{ CAMOUFOX_CAPS = $DefaultCaps }
        }
    }

    function Test-McpEntryMatches {
        <# Совпадает ли УЖЕ записанная команда с нужной. Сравниваем команду
        (и args для Claude) посимвольно, а не JSON целиком: порядок ключей у
        клиента может быть свой, и это не повод переписывать файл. #>
        param(
            [Parameter(Mandatory)][object]$Existing,
            [Parameter(Mandatory)][string[]]$Command,
            [Parameter(Mandatory)][string]$Flavor
        )
        if ($null -eq $Existing -or $Existing -is [string]) { return $false }
        $have = @()
        $cmdProp = $Existing.PSObject.Properties['command']
        if ($null -ne $cmdProp -and $null -ne $cmdProp.Value) {
            if ($cmdProp.Value -is [string]) { $have += $cmdProp.Value } else { $have += @($cmdProp.Value) }
        }
        if ($Flavor -eq 'claude') {
            $argsProp = $Existing.PSObject.Properties['args']
            if ($null -ne $argsProp -and $null -ne $argsProp.Value) { $have += @($argsProp.Value) }
            # args пустой у обеих сторон — @() и отсутствие ключа равнозначны
        }
        return (($have -join "`0") -eq ($Command -join "`0"))
    }

    function Get-McpRegistrationState {
        <# ЧТО БУДЕТ с конфигом — без записи. Поля: State = new-file|add|update|same,
        а также Already (что там лежит сейчас) — план и решение об изменениях
        берутся отсюда, поэтому -WhatIf и реальный прогон видят одно и то же. #>
        param(
            [Parameter(Mandatory)][object]$Target,
            [Parameter(Mandatory)][string]$VenvPath
        )
        $command = (Get-McpCommand -VenvPath $VenvPath)
        $entry = New-McpEntry -Flavor $Target.Flavor -Command $command
        $config = Read-JsonConfig -Path $Target.Path   # битый JSON бросит исключение
        $state = 'new-file'
        $already = ''
        if ($null -ne $config) {
            $state = 'add'
            $containerProp = $config.PSObject.Properties[$Target.Container]
            if ($null -ne $containerProp) {
                $container = $containerProp.Value
                if ($null -ne $container -and -not ($container -is [pscustomobject])) {
                    throw ("{0}: ключ '{1}' не объект — правлю руками: {2}" -f $Target.Path, $Target.Container, $container.GetType().Name)
                }
                if ($null -ne $container) {
                    $entryProp = $container.PSObject.Properties[$Target.Key]
                    if ($null -ne $entryProp) {
                        $state = 'update'
                        $already = ($entryProp.Value | ConvertTo-Json -Depth 10 -Compress)
                        if (Test-McpEntryMatches -Existing $entryProp.Value -Command $command -Flavor $Target.Flavor) {
                            $state = 'same'
                        }
                    }
                }
            }
        }
        return [pscustomobject]@{
            Flavor    = $Target.Flavor
            Path      = $Target.Path
            Container = $Target.Container
            Key       = $Target.Key
            Command   = $command
            Entry     = $entry
            State     = $state
            Already   = $already
        }
    }

    function Set-McpRegistration {
        <# ЗАПИСЬ: бэкап рядом с конфигом -> правка -> запись UTF-8 без BOM
        (как install_mcp.py). Порядок «сначала бэкап» — единственная защита от
        потери чужих настроек клиента при правке JSON. #>
        param(
            [Parameter(Mandatory)][object]$Plan
        )
        Backup-ConfigFile -Path $Plan.Path | Out-Null
        $config = Read-JsonConfig -Path $Plan.Path
        if ($null -eq $config) { $config = [pscustomobject][ordered]@{} }
        $containerProp = $config.PSObject.Properties[$Plan.Container]
        $container = $null
        if ($null -eq $containerProp) {
            $container = [pscustomobject][ordered]@{}
            $config | Add-Member -NotePropertyName $Plan.Container -NotePropertyValue $container
        }
        else {
            $container = $containerProp.Value
            if ($null -eq $container) {
                $container = [pscustomobject][ordered]@{}
                $containerProp.Value = $container
            }
        }
        if ($null -ne $container.PSObject.Properties[$Plan.Key]) {
            $container.PSObject.Properties[$Plan.Key].Value = $Plan.Entry
        }
        else {
            $container | Add-Member -NotePropertyName $Plan.Key -NotePropertyValue $Plan.Entry
        }
        $dir = Split-Path -Parent $Plan.Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        Set-Content -LiteralPath $Plan.Path -Value ($config | ConvertTo-Json -Depth 10) -Encoding utf8
    }

    function Get-McpEntryState {
        <# Есть ли НАША запись в конфиге (для -Uninstall). Чужие ключи не
        трогаем никогда. #>
        param([Parameter(Mandatory)][object]$Target)
        $config = Read-JsonConfig -Path $Target.Path   # битый JSON бросит исключение
        if ($null -eq $config) { return [pscustomobject]@{ Exists = $false; Already = '' } }
        $containerProp = $config.PSObject.Properties[$Target.Container]
        if ($null -eq $containerProp -or $null -eq $containerProp.Value) {
            return [pscustomobject]@{ Exists = $false; Already = '' }
        }
        $entryProp = $containerProp.Value.PSObject.Properties[$Target.Key]
        if ($null -eq $entryProp) { return [pscustomobject]@{ Exists = $false; Already = '' } }
        return [pscustomobject]@{
            Exists  = $true
            Already = ($entryProp.Value | ConvertTo-Json -Depth 10 -Compress)
        }
    }

    function Remove-McpRegistration {
        <# Удаление ТОЛЬКО своей записи; контейнер (mcp/mcpServers) оставляем —
        там живут другие серверы. Пустой контейнер безвреден. #>
        param([Parameter(Mandatory)][object]$Plan)
        Backup-ConfigFile -Path $Plan.Path | Out-Null
        $config = Read-JsonConfig -Path $Plan.Path
        if ($null -eq $config) { return }
        $containerProp = $config.PSObject.Properties[$Plan.Container]
        if ($null -eq $containerProp -or $null -eq $containerProp.Value) { return }
        $container = $containerProp.Value
        if ($null -eq $container.PSObject.Properties[$Plan.Key]) { return }
        $container.PSObject.Properties.Remove($Plan.Key) | Out-Null
        Set-Content -LiteralPath $Plan.Path -Value ($config | ConvertTo-Json -Depth 10) -Encoding utf8
    }

    function Write-McpSection {
        <# Шаг 7: план по каждому клиенту + запись, если не «уже совпадает».
        Возвращает 0 — отработали, 2 — вход невалиден (нет клиента/битый JSON:
        чужой конфиг важнее автопочинки — сообщение уже напечатано). #>
        param([Parameter(Mandatory)][string]$VenvPath)
        if ($OptClient -eq 'none') {
            Write-Line INFO '-Client none: конфиг клиента не трогаю'
            return 0
        }
        try {
            $targets = Get-ClientTargets -Client $OptClient -OpencodeExplicit $OptOpencodePath -ClaudeExplicit $OptClaudePath
        }
        catch {
            Write-Line FAIL $_.Exception.Message
            return 2
        }
        if (@($targets).Count -eq 0) {
            Write-Line WARN 'клиентов не нашли (auto): прописываю вручную — см. mcp/config/ и docs/install-windows.md'
            return 0
        }
        foreach ($clientTarget in $targets) {
            try {
                $plan = Get-McpRegistrationState -Target $clientTarget -VenvPath $VenvPath
            }
            catch {
                Write-Line FAIL $_.Exception.Message
                return 2
            }
            $entryJson = ($plan.Entry | ConvertTo-Json -Depth 10 -Compress)
            switch ($plan.State) {
                'same' {
                    Write-Line OK ("{0}: MCP '{1}' уже прописан и совпадает — не трогаю ({2})" -f $plan.Flavor, $clientTarget.Key, $plan.Path)
                }
                'update' {
                    Write-Line WARN ("{0}: MCP '{1}' есть, но команда другая — обновлю с бэкапом" -f $plan.Flavor, $clientTarget.Key)
                    Write-Line INFO ("  было: {0}" -f $plan.Already)
                    Write-Line INFO ("  будет: {0}" -f $entryJson)
                }
                default {
                    Write-Line INFO ("{0}: добавить в {1}" -f $plan.Flavor, $plan.Path)
                    Write-Line INFO ("  запись: {0}" -f $entryJson)
                }
            }
            if ($plan.State -ne 'same') {
                # Действие исполняется внутри Invoke-Step — переменные сюда
                # приходят по цепочке областей, поэтому `$clientTarget` (а не
                # `$target`: имя занято параметром функции, регистр не важен).
                Invoke-Step -StepTitle 'правка конфига клиента' -StepTarget $plan.Path -StepAction {
                    Set-McpRegistration -Plan $plan
                    Write-Line OK ("MCP '{0}' записан: {1}" -f $clientTarget.Key, $plan.Path)
                } | Out-Null
            }
        }
        return 0
    }

    # --- 8/8 проверка ------------------------------------------------------
    function Test-McpHandshake {
        <# РУКОПОЖАТИЕ: реальный stdio-клиент (scripts/mcp_drive.py) поднимает
        сервер, делает initialize и tools/list. Это единственная проверка,
        которая доказывает, что клиент получит тулы, а не просто «модуль
        импортируется»: битый __main__, чужой python или падение на старте
        видны здесь и больше нигде. #>
        param(
            [Parameter(Mandatory)][string]$VenvPython,
            [Parameter(Mandatory)][AllowEmptyString()][string]$RepoPath
        )
        if (-not $RepoPath) {
            Write-Line WARN 'клон неизвестен — рукопожатие не проверить (нужен scripts/mcp_drive.py из клона)'
            return $false
        }
        $drive = Join-Path $RepoPath 'scripts/mcp_drive.py'
        if (-not (Test-Path -LiteralPath $drive)) {
            Write-Line WARN ("нет {0} — рукопожатие не проверить (проверяю тулы импортом)" -f $drive)
            return $false
        }
        $res = Get-NativeTextTimed -Exe $VenvPython -Arguments @(
            $drive, $RepoPath, '[{"op":"tools"}]') -TimeoutSec $HandshakeTimeoutSec
        if ($res.TimedOut) {
            Write-Line FAIL ("рукопожатие MCP: сервер не ответил за {0} с" -f $HandshakeTimeoutSec)
            return $false
        }
        $lines = @($res.Text -split "`r?`n" | Where-Object { $_ -match '\S' })
        foreach ($line in $lines) {
            if ($line -match '^(BOOT|TOOLS)\b') { Write-Line INFO ("  {0}" -f $line) }
        }
        if ($res.Text -match 'TOOLS n=(\d+)') {
            $count = [int]$Matches[1]
            if ($count -gt 0) {
                Write-Line OK ("рукопожатие MCP: сервер поднялся и отдал {0} тулов" -f $count)
                return $true
            }
            Write-Line FAIL 'рукопожатие MCP: сервер ответил, но тулов 0 — проверь CAMOUFOX_CAPS в env клиента'
            return $false
        }
        Write-Line FAIL 'рукопожатие MCP: initialize/tools/list не подтвердились'
        foreach ($line in @($lines | Select-Object -Last 5)) { Write-Line INFO ("  {0}" -f $line) }
        return $false
    }

    # --- информационный режим (-Version) -----------------------------------
    function Show-SetupInfo {
        <# Ничего не меняет: только чтение (пробы интерпретаторов и путей). #>
        $modeName = if ($Inline) { 'iex (пайп, без файла)' } else { 'файл' }
        Write-Host ("install.ps1 v{0} · PowerShell {1} · {2}" -f `
                $InstallerVersion, $PSVersionTable.PSVersion, [System.Environment]::OSVersion.VersionString)
        Write-Line INFO ("режим запуска: {0}{1}" -f $modeName, $(if ($PlanMode) { ', план (-WhatIf)' } else { '' }))

        $dirDefault = if ($OptDir) { $OptDir } else { Join-Path $HOME $DefaultDirName }
        $repoInfo = Resolve-Repo -ExplicitRepo $OptRepo -Dir $OptDir -Ref $OptRef -ScriptPath $ScriptPath -AllowClone $false
        if ($repoInfo.Code -eq 0 -and $repoInfo.Path) {
            Write-Line INFO ("репозиторий: {0}" -f $repoInfo.Path)
            $codeVersion = Get-PyprojectVersion -RepoPath $repoInfo.Path
            if ($codeVersion) { Write-Line INFO ("  версия кода (pyproject.toml): {0}" -f $codeVersion) }
        }
        else {
            Write-Line INFO ("репозиторий: рядом нет (установка склонирует {0} в {1})" -f $GitUrl, $dirDefault)
        }

        $venvPath = if ($OptVenv) { $OptVenv } else { if ($env:CAMOUFOX_VENV) { $env:CAMOUFOX_VENV } else { Join-Path $HOME '.venvs/camoufox-research' } }
        $venvPaths = Get-VenvPaths -VenvPath $venvPath
        if (Test-Path -LiteralPath $venvPaths.Python) {
            $pyVersion = Get-PythonVersion -Exe $venvPaths.Python
            $pyText = if ($null -ne $pyVersion) { $pyVersion.Text } else { 'версия неизвестна' }
            Write-Line INFO ("venv: {0} (python {1})" -f $venvPaths.Path, $pyText)
            $pkgVersion = Get-NativeText -Exe $venvPaths.Python -Arguments @(
                '-c', "import importlib.metadata as m; print(m.version('camoufox-research'))")
            if ($pkgVersion) { Write-Line INFO ("  пакет в venv: {0}" -f $pkgVersion) }
            $legacyVenv = if ($repoInfo.Path) { Join-Path $repoInfo.Path '.venv' } else { '' }
            if ($legacyVenv -and (Test-Path -LiteralPath $legacyVenv)) {
                Write-Line WARN ("  в клоне лежит venv ({0}) — он не используется: окружение живёт в {1}" -f $legacyVenv, $venvPath)
            }
            $browser = Test-BrowserInstalled -VenvPython $venvPaths.Python
            $browserDir = Get-BrowserDir -VenvPython $venvPaths.Python
            if ($browser) {
                Write-Line INFO ("браузер: {0} в {1}" -f $browser, $browserDir)
            }
            else {
                Write-Line INFO ("браузер: не скачан (каталог определится как {0})" -f $browserDir)
            }
        }
        else {
            Write-Line INFO ("venv: {0} (нет — создастся при установке)" -f $venvPath)
        }

        $cacheDir = if ($env:CAMOUFOX_CACHE_DIR) { $env:CAMOUFOX_CACHE_DIR } else { Join-Path $HOME '.cache/camoufox-research' }
        Write-Line INFO ("кэш (cache.db, отчёты, логи пульса): {0}" -f $cacheDir)
        Write-Line INFO ("кэши гейтов: {0}" -f (Join-Path $cacheDir 'gates'))
        Write-Line INFO ("однострочник установки: irm {0} | iex" -f $RawUrl)
        Write-Line INFO 'ничего не менял: это справка о состоянии (rc=0)'
    }

    function Get-PyprojectVersion {
        param([Parameter(Mandatory)][string]$RepoPath)
        $file = Join-Path $RepoPath 'pyproject.toml'
        if (-not (Test-Path -LiteralPath $file)) { return '' }
        try {
            $found = Select-String -LiteralPath $file -Pattern '^\s*version\s*=\s*"([0-9][^"]*)"' -List -ErrorAction Stop
            if ($found -and $found.Matches.Count -gt 0) { return $found.Matches[0].Groups[1].Value }
        }
        catch {
            return ''
        }
        return ''
    }

    # --- -Uninstall --------------------------------------------------------
    function Assert-Confirmed {
        <# Подтверждение на разрушительное. В неинтерактивном запуске (пайп,
        CI) вопроса НЕ задаём — иначе установка «зависла» бы на невидимой
        подсказке: требуем -Yes и говорим об этом прямо. #>
        param([Parameter(Mandatory)][string]$Question)
        if ($FlagYes -or $PlanMode) { return $true }
        if (-not $Interactive) {
            Write-Line FAIL '-Uninstall в неинтерактивном запуске: подтверждения спросить не у кого — добавь -Yes'
            return $false
        }
        try {
            $choices = [System.Collections.ObjectModel.Collection[System.Management.Automation.Host.ChoiceDescription]]::new()
            $choices.Add([System.Management.Automation.Host.ChoiceDescription]::new('&Да, удалить'))
            $choices.Add([System.Management.Automation.Host.ChoiceDescription]::new('&Нет, ничего не менять'))
            return ($Host.UI.PromptForChoice('camoufox-research', $Question, $choices, 1) -eq 0)
        }
        catch {
            Write-Line WARN ("подтверждение получить не удалось ({0}) — нужен -Yes" -f $_.Exception.Message)
            return $false
        }
    }

    function Invoke-UninstallFlow {
        <# Что снимает: venv + запись MCP. Что НЕ трогает: кэш
        ($HOME\.cache\camoufox-research — там cache.db, отчёты, логи), браузер
        (200+ МБ бинарников) и сам клон (код). Пути и команды для ручного
        удаления печатаются. #>
        $venvPath = if ($OptVenv) { $OptVenv } else { if ($env:CAMOUFOX_VENV) { $env:CAMOUFOX_VENV } else { Join-Path $HOME '.venvs/camoufox-research' } }
        $cacheDir = if ($env:CAMOUFOX_CACHE_DIR) { $env:CAMOUFOX_CACHE_DIR } else { Join-Path $HOME '.cache/camoufox-research' }
        $confirmed = Assert-Confirmed -Question ("Убрать venv {0} и запись MCP из конфига клиента? Кэш и браузер останутся." -f $venvPath)
        if (-not $confirmed) {
            Write-Line INFO 'ничего не удаляю'
            return 0
        }

        Write-Line STEP '1/3 запись MCP в конфиге клиента'
        if ($OptClient -eq 'none') {
            Write-Line INFO '-Client none: конфиг клиента не трогаю'
        }
        else {
            try {
                $targets = Get-ClientTargets -Client $OptClient -OpencodeExplicit $OptOpencodePath -ClaudeExplicit $OptClaudePath
            }
            catch {
                Write-Line FAIL $_.Exception.Message
                return 2
            }
            if (@($targets).Count -eq 0) {
                Write-Line INFO 'клиентов не нашли (auto) — в конфигах править нечего'
            }
            foreach ($clientTarget in $targets) {
                try {
                    $state = Get-McpEntryState -Target $clientTarget
                }
                catch {
                    Write-Line FAIL $_.Exception.Message
                    return 2
                }
                if (-not $state.Exists) {
                    Write-Line OK ("{0}: записи '{1}' нет — не трогаю ({2})" -f $clientTarget.Flavor, $clientTarget.Key, $clientTarget.Path)
                    continue
                }
                Write-Line INFO ("{0}: удалить '{1}' из {2}" -f $clientTarget.Flavor, $clientTarget.Key, $clientTarget.Path)
                Write-Line INFO ("  было: {0}" -f $state.Already)
                Invoke-Step -StepTitle "удаление MCP '{0}'" -StepTarget $clientTarget.Path -StepAction {
                    Remove-McpRegistration -Plan $clientTarget
                    Write-Line OK ("{0}: запись '{1}' удалена (бэкап рядом)" -f $clientTarget.Flavor, $clientTarget.Key)
                } | Out-Null
            }
        }

        Write-Line STEP '2/3 venv в рантайме'
        if (Test-Path -LiteralPath $venvPath) {
            Invoke-Step -StepTitle 'удаление venv' -StepTarget $venvPath -StepAction {
                Remove-Item -LiteralPath $venvPath -Recurse -Force
                Write-Line OK ("venv удалён: {0}" -f $venvPath)
            } | Out-Null
        }
        else {
            Write-Line INFO ("venv уже нет: {0}" -f $venvPath)
        }

        Write-Line STEP '3/3 что осталось (и как убрать руками, если нужно)'
        Write-Line INFO ("кэш добычи НЕ тронут: {0}" -f $cacheDir)
        Write-Line INFO ("  убрать: Remove-Item -Recurse -Force '{0}'" -f $cacheDir)
        Write-Line INFO ("браузер НЕ тронут (каталог печатает -Version, Unix-канон ~/.cache/camoufox)")
        Write-Line INFO 'клон репозитория НЕ тронут (код и скрипты остаются на месте)'
        Write-Line INFO 'расписание (Task Scheduler) снимается отдельно: schtasks /Delete /TN "camoufox-pulse" /F'
        if ($PlanMode) {
            Write-Host ''
            Write-Line INFO 'это был план: ни venv, ни конфиг, ни бэкапы не менялись'
        }
        return 0
    }

    # --- основной сценарий установки ---------------------------------------
    function Invoke-InstallFlow {
        # --- 1/8 репозиторий ------------------------------------------------
        Write-Line STEP '1/8 репозиторий (готовый клон рядом, иначе клон в -Dir)'
        $allowClone = -not $FlagRegisterOnly    # -RegisterOnly не качает код: ставим только запись
        $repoInfo = Resolve-Repo -ExplicitRepo $OptRepo -Dir $OptDir -Ref $OptRef -ScriptPath $ScriptPath -AllowClone $allowClone
        if ($repoInfo.Code -ne 0) { return $repoInfo.Code }
        $RepoPath = $repoInfo.Path

        # --- 2/8 python -----------------------------------------------------
        Write-Line STEP '2/8 python >= 3.10'
        $uv = Get-Command uv -ErrorAction SilentlyContinue
        $selected = $null
        $canVenv = $true      # есть ЧЕМ создавать venv (python или uv)
        if (-not $FlagRegisterOnly) {
            $selected = Select-Python -Candidates (Get-PythonCandidates) -MinMinor $MinPythonMinor
            if ($null -ne $selected) {
                Write-Line OK ("интерпретатор: {0} -> python {1}" -f $selected.Note, $selected.Version)
            }
            elseif ($null -ne $uv) {
                Write-Line WARN ("подходящего python нет, но есть uv ({0}) — venv создаст uv (он скачает 3.13)" -f $uv.Source)
            }
            elseif ($FlagBootstrap -and -not $FlagSkipDeps) {
                Write-Line WARN 'подходящего python нет — ставлю через winget (Python.Python.3.13)'
                if (Test-CommandExists 'winget') {
                    Invoke-Step -StepTitle 'winget install Python.Python.3.13' -StepTarget 'winget' -StepAction {
                        Invoke-Checked -Exe 'winget' -Arguments @(
                            'install', '--id', 'Python.Python.3.13', '-e', '--source', 'winget',
                            '--accept-package-agreements', '--accept-source-agreements')
                    } | Out-Null
                    if (-not $PlanMode) {
                        # PATH текущей сессии winget не обновляет — ищем заново
                        $selected = Select-Python -Candidates (Get-PythonCandidates) -MinMinor $MinPythonMinor
                        if ($null -eq $selected) {
                            Write-Line WARN 'python поставлен, но в этом окне ещё не виден: открой НОВОЕ окно PowerShell и повтори install.ps1'
                        }
                    }
                }
                else {
                    Write-Line FAIL 'winget не найден: поставь python с python.org (не MS Store) или winget из App Installer'
                    return 1
                }
            }
            else {
                if ($FlagBootstrap -and $FlagSkipDeps) {
                    Write-Line WARN '-SkipDeps: winget не зову, даже с -BootstrapPython (поставь python сам)'
                }
                $canVenv = $false
                Write-Line FAIL ("нет python >= 3.{0}: поставь с python.org (галочка Add to PATH), либо -BootstrapPython, либо uv (winget install astral-sh.uv)" -f $MinPythonMinor)
                if (-not $PlanMode) {
                    Write-Line FAIL 'без python установка невозможна — шаги 4-6 зависят от него'
                    return 1
                }
                # В -WhatIf не выходим: человеку нужен ВЕСЬ план (шаги 3-8) сразу,
                # помеченный «невозможно без python», а не обрыв на втором шаге.
                Write-Line WARN 'это -WhatIf: показываю остаток плана, но шаги 4-6 без python/uv невозможны'
            }
        }
        else {
            Write-Line INFO '-RegisterOnly: шаги 2-6 пропущены (окружение считаем готовым)'
        }

        # --- 3/8 системные зависимости --------------------------------------
        Write-Line STEP '3/8 системные зависимости (Windows: VC++ Redistributable x64)'
        Invoke-DepsStep

        # --- 4/8 venv (рантайм) ---------------------------------------------
        Write-Line STEP '4/8 venv в рантайме (вне клона)'
        $venvPath = if ($OptVenv) { $OptVenv } else { if ($env:CAMOUFOX_VENV) { $env:CAMOUFOX_VENV } else { Join-Path $HOME '.venvs/camoufox-research' } }
        $venvPaths = Get-VenvPaths -VenvPath $venvPath
        Write-Line INFO ("venv: {0}" -f $venvPaths.Path)
        if ($RepoPath) {
            $legacyVenv = Join-Path $RepoPath '.venv'
            if (Test-Path -LiteralPath $legacyVenv) {
                Write-Line WARN ("в клоне лежит venv ({0}) — не использую и не удаляю: канон — {1}" -f $legacyVenv, $venvPath)
            }
        }
        $venvReady = Test-Path -LiteralPath $venvPaths.Python
        if (-not $canVenv) {
            Write-Line FAIL ("создавать venv нечем (нет ни python, ни uv): {0}" -f $venvPaths.Path)
        }
        elseif ($venvReady) {
            Write-Line OK ("venv уже есть: {0}" -f $venvPaths.Python)
        }
        elseif ($FlagRegisterOnly) {
            Write-Line WARN ("-RegisterOnly: venv нет ({0}) — беру путь как есть, клиент получит несуществующий путь" -f $venvPaths.Python)
        }
        else {
            # Заголовок шага — ЧЕМ именно будет создан venv: в плане (-WhatIf) человек
            # видит либо `python -m venv`, либо `uv venv`, а не один на оба случая.
            $venvTitle = if ($null -ne $selected) { 'python -m venv' } else { 'uv venv --python 3.13 --seed' }
            Invoke-Step -StepTitle $venvTitle -StepTarget $venvPaths.Path -StepAction {
                # Каталог venv создаём сами: `python -m venv` умеет только
                # несуществующий путь или пустой каталог, а uv — тоже (родителя
                # создаёт, но не всегда: явный New-Item дешевле сюрприза).
                $venvParent = Split-Path -Parent $venvPaths.Path
                if ($venvParent -and (-not (Test-Path -LiteralPath $venvParent))) {
                    New-Item -ItemType Directory -Path $venvParent -Force | Out-Null
                }
                if ($null -ne $selected) {
                    $venvArgs = @($selected.Args) + @('-m', 'venv', $venvPaths.Path)
                    Invoke-Checked -Exe $selected.Exe -Arguments $venvArgs
                }
                else {
                    Invoke-Checked -Exe 'uv' -Arguments @('venv', '--python', '3.13', '--seed', $venvPaths.Path)
                }
            } | Out-Null
            # venv мог быть создан (или -WhatIf его не создавал) — дальше проверяем факт
            $venvReady = Test-Path -LiteralPath $venvPaths.Python
            if ($venvReady) { Write-Line OK ("venv готов: {0}" -f $venvPaths.Python) }
            elseif (-not $PlanMode) {
                Write-Line FAIL ("venv не создался: {0}" -f $venvPaths.Python)
                return 1
            }
        }

        # --- 5/8 pip install . ----------------------------------------------
        Write-Line STEP '5/8 pip install . (из клона)'
        $installedFrom = $null
        if ($venvReady) { $installedFrom = Test-PackageInstalled -VenvPython $venvPaths.Python -RepoPath $RepoPath }
        if (-not $canVenv) {
            Write-Line FAIL 'пропущено: нечем создавать venv (нужен python или uv)'
        }
        elseif ($FlagRegisterOnly) {
            Write-Line INFO '-RegisterOnly: пакет не переставляю'
        }
        elseif (-not $RepoPath) {
            Write-Line FAIL 'пропущено: нет клона — нечего ставить'
        }
        elseif ($installedFrom -and -not $FlagReinstall) {
            Write-Line OK ("пакет уже импортируется из venv: {0}" -f $installedFrom)
        }
        else {
            $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check')
            if ($FlagReinstall) { $pipArgs += @('--force-reinstall', '--no-deps') }
            $pipArgs += $RepoPath
            Invoke-Step -StepTitle 'pip install .' -StepTarget $RepoPath -StepAction {
                Invoke-Checked -Exe $venvPaths.Python -Arguments $pipArgs
            } | Out-Null
        }

        # --- 6/8 браузер ----------------------------------------------------
        Write-Line STEP '6/8 браузер (python -m camoufox fetch)'
        if (-not $canVenv) {
            Write-Line FAIL 'пропущено: нет интерпретатора venv'
        }
        elseif ($FlagRegisterOnly) {
            Write-Line INFO '-RegisterOnly: браузер не трогаю'
        }
        elseif ($FlagSkipBrowser) {
            Write-Line WARN '-SkipBrowser: браузер не качаю (research без него не работает)'
        }
        else {
            Invoke-Step -StepTitle 'camoufox fetch' -StepTarget 'кэш браузера' -StepAction {
                # Ненулевой rc не смертелен: браузер мог быть скачан раньше, а
                # сеть отвалиться сейчас. Жёсткая проверка — ниже (версия).
                & $venvPaths.Python -m camoufox fetch
                if ($LASTEXITCODE -ne 0) {
                    Write-Line WARN ("fetch вернул код {0} — проверю, установлен ли браузер" -f $LASTEXITCODE)
                }
            } | Out-Null
        }

        # --- 7/8 MCP --------------------------------------------------------
        Write-Line STEP '7/8 секция MCP в конфиге клиента'
        $mcpCode = [int](@(Write-McpSection -VenvPath $venvPaths.Path)[-1])
        if ($mcpCode -ne 0) { return $mcpCode }

        # --- 8/8 проверка ---------------------------------------------------
        Write-Line STEP '8/8 проверка (импорт, скрипт, браузер, рукопожатие MCP)'
        $ok = $true
        if ($FlagRegisterOnly) {
            Write-Line INFO '-RegisterOnly: шаги 2-6 пропущены — проверять нечего'
        }
        elseif ($PlanMode) {
            Write-Line INFO 'проверять нечего: -WhatIf ничего не менял'
        }
        elseif (-not $venvReady) {
            Write-Line FAIL ("нет интерпретатора venv: {0}" -f $venvPaths.Python)
            $ok = $false
        }
        else {
            $installedFrom = Test-PackageInstalled -VenvPython $venvPaths.Python -RepoPath $RepoPath
            if ($installedFrom) {
                Write-Line OK ("пакет импортируется из venv: {0}" -f $installedFrom)
            }
            else {
                Write-Line FAIL 'пакет не импортируется из venv — смотри вывод pip выше'
                $ok = $false
            }
            if (Test-Path -LiteralPath $venvPaths.Entry) {
                Write-Line OK ("консольный скрипт: {0}" -f $venvPaths.Entry)
            }
            else {
                Write-Line WARN ("консольного скрипта нет: {0} (клиенту пойдёт python -m {1})" -f $venvPaths.Entry, $McpModule)
            }
            if ($FlagSkipBrowser) {
                Write-Line WARN 'браузер не проверяю (-SkipBrowser)'
            }
            else {
                $browser = Test-BrowserInstalled -VenvPython $venvPaths.Python
                if ($browser) {
                    Write-Line OK ("браузер Camoufox: {0}" -f $browser)
                }
                else {
                    Write-Line FAIL 'браузер не установлен: проверь сеть/прокси и повтори; без браузера research не работает'
                    $ok = $false
                }
            }
            if (-not (Test-McpHandshake -VenvPython $venvPaths.Python -RepoPath $RepoPath)) {
                $tools = Get-NativeText -Exe $venvPaths.Python -Arguments @(
                    '-c', ("import {0} as s; print(len(s.mcp._tool_manager._tools))" -f $McpModule))
                if ($tools -match '^\d+$') {
                    Write-Line WARN ("рукопожатие не подтвердилось, но тулы видны импортом: {0}" -f $tools)
                }
                $ok = $false
            }
        }

        # --- итог и честная граница Windows ---------------------------------
        $cacheDir = if ($env:CAMOUFOX_CACHE_DIR) { $env:CAMOUFOX_CACHE_DIR } else { Join-Path $HOME '.cache/camoufox-research' }
        Write-Host ''
        Write-Line INFO 'что дальше:'
        if ($RepoPath) {
            $driveHint = Join-Path $RepoPath 'scripts/mcp_drive.py'
            $planHint = '[{"op":"tools"}]'
            Write-Line INFO ("  · рукопожатие вручную: {0} {1} '{2}'" -f $venvPaths.Python, $driveHint, $planHint)
        }
        Write-Line INFO ("  · smoke: {0} (stdio-сервер, ждёт ввод)" -f $venvPaths.Entry)
        Write-Line INFO '  · opencode после смены кода: opencode2 api post /api/mcp/camoufox/disconnect'
        Write-Line INFO '                             opencode2 api post /api/mcp/camoufox/connect'
        if ($RepoPath) {
            Write-Line INFO ("  · Claude Desktop / Cursor: примеры — {0}" -f (Join-Path $RepoPath 'mcp/config'))
        }
        Write-Line INFO ("  · пульс здоровья: {0} (Windows-версия: scripts/health_pulse.ps1)" -f (Join-Path $cacheDir 'health-pulse.log'))
        Write-Line INFO ("  · снести venv и запись MCP: install.ps1 -Uninstall (кэш и браузер останутся)")
        Write-Host ''
        Write-Line WARN 'Windows vs Unix (честно, подробнее — docs/install-windows.md):'
        Write-Line WARN '  · cron (install_cron.sh) и systemd-таймеры (install_timers.sh) — Unix-only;'
        Write-Line WARN '    расписание на Windows = Task Scheduler (пример в docs/install-windows.md)'
        Write-Line WARN '  · bash-стражи (guard-all.sh, git-pre-*.sh) и git-хук gitleaks не ставятся:'
        Write-Line WARN '    секрет-скан остаётся CI (GitHub Actions, gitleaks.yml)'
        Write-Line WARN '  · обёртка caps (scripts/update_mcp.sh) — bash: профиль тулов на Windows'
        Write-Line WARN ("    установщик кладёт в env записи клиента (CAMOUFOX_CAPS = {0})" -f $DefaultCaps)
        Write-Line WARN '  · config.env пишет install_mcp.py (Unix): на Windows пути задают'
        Write-Line WARN '    переменные CAMOUFOX_REPO/CAMOUFOX_CACHE_DIR в env клиента'

        if ($PlanMode) {
            Write-Host ''
            Write-Line INFO 'это был план: ни клон, ни venv, ни конфиг, ни бэкапы не создавались'
            return 0
        }
        if ($ok) {
            Write-Line OK 'установка OK'
            return 0
        }
        Write-Line FAIL 'установка завершилась с ошибкой (см. [!] выше)'
        return 1
    }

    function Invoke-Main {
        <# Единственная точка «что делаем»: справка (-Version), снятие
        (-Uninstall) или установка. Все ранние выходы — `return N` ЗДЕСЬ:
        вызывающий ждёт код последним значением функции. #>
        if ($FlagVersion) {
            Show-SetupInfo
            return 0
        }
        if ($FlagUninstall) {
            return (Invoke-UninstallFlow)
        }
        return (Invoke-InstallFlow)
    }

    # --- запуск ------------------------------------------------------------
    function Exit-Code {
        param([Parameter(Mandatory)][int]$Code)
        if ($Inline) {
            # iex: `exit` убил бы консоль пользователя (проверено прогоном) —
            # поэтому сбой виден исключением, а сессия остаётся живой.
            if ($Code -ne 0) {
                throw ("camoufox-research: установка не завершилась (код {0}) — подробности выше" -f $Code)
            }
            return
        }
        exit $Code
    }

    $exitCode = 1
    try {
        $exitCode = [int](@(Invoke-Main)[-1])
    }
    catch {
        $inv = $_.InvocationInfo
        $line = [string]$inv.Line          # [string]: у части исключений Line пуст, а .Trim() на $null — сбой уже в catch
        $where = if ($inv.ScriptName) { "{0}:{1}" -f $inv.ScriptName, $inv.ScriptLineNumber } else { 'строка {0}' -f $inv.ScriptLineNumber }
        Write-Line FAIL ("сбой установки: {0} ({1}: {2})" -f $_.Exception.Message, $where, $line.Trim())
        # Трассировка: без неё «property not found» в чужой функции переводит
        # человека на строку вызова, а не на виновника (грабля этого файла).
        Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
        $exitCode = 1
    }
    Exit-Code -Code $exitCode
} $PSBoundParameters `
    ([string]$PSCommandPath) `
    ([string]::IsNullOrEmpty($PSCommandPath)) `
    ((Get-Variable -Name PSCmdlet -ErrorAction SilentlyContinue).Value) `
    ([bool]$PSBoundParameters['WhatIf'])
