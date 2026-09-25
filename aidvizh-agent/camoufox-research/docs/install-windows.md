# Нативная установка на Windows (без WSL и без Git-Bash)

> Два скрипта заменяют Unix-обвязку: `scripts\install.ps1` (установка,
> регистрация MCP, снятие) и `scripts\health_pulse.ps1` (пульс здоровья).
> Общая кроссплатформенная картина — `docs/install-crossplatform.md`.

## Откуда ставим: клон / GitHub / Docker

| Откуда | Когда нужен | Команда |
|---|---|---|
| **Клон на диске** — основной путь | репо уже на машине: сеть не нужна, шага «клонировать» нет — ставится код клона (в т.ч. своя ветка) | `pwsh -NoProfile -File <репо>\scripts\install.ps1` |
| **GitHub** — фолбэк | ДРУГАЯ машина, где клона нет: шаг 1/8 склонирует сам (`git clone --depth 1` в `-Dir`, а без git — zip с GitHub) | `irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1 \| iex` |
| **Docker** | на Windows-хост не ставим вообще ничего: образ linux/amd64 через Docker Desktop (бэкенд WSL2) — venv, библиотеки и браузер уже внутри | `bash scripts/run_in_docker.sh --build --run` (из клона; подробно — `docs/install-crossplatform.md`) |

Разница между первыми двумя ровно в шаге 1/8 «репозиторий»; дальше шаги те же.

## Установка из клона (основной путь)

```powershell
pwsh -NoProfile -File <репо>\scripts\install.ps1 -WhatIf   # план, ничего не меняет
pwsh -NoProfile -File <репо>\scripts\install.ps1           # установка
```

Каталог репо ищется рядом со скриптом (и в текущем каталоге); клон в стороне —
`-Repo ПУТЬ` или env `CAMOUFOX_REPO`. В режиме `-File` флаги передаются как
обычно; в режиме `iex` (ниже) — нет.

## Установка одним кликом (клона нет — склонирует сам)

```powershell
irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1 | iex
```

Что произойдёт: репозиторий склонируется в `%USERPROFILE%\camoufox-research`,
venv поднимется в `%USERPROFILE%\.venvs\camoufox-research` (вне репозитория),
скачается браузер, MCP пропишется в найденный клиент, в конце — проверка с
**рукопожатием MCP** (`scripts\mcp_drive.py`: initialize + tools/list).

Почему это безопасно запускать пайпом: скрипт не зовёт `exit` (в `iex` это
убило бы окно PowerShell) и выполняет всё тело в дочерней области — свои
функции и `$ErrorActionPreference` в сессии пользователя он не оставляет.
Сбой виден исключением, окно остаётся живым; кода возврата в этом режиме нет.

Флаги в режиме `iex` не передать. Нужны флаги или план — скачай файл:

```powershell
$u = 'https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1'
iwr $u -OutFile $env:TEMP\camoufox-install.ps1
pwsh -NoProfile -File $env:TEMP\camoufox-install.ps1 -WhatIf     # план, ничего не меняет
pwsh -NoProfile -File $env:TEMP\camoufox-install.ps1             # установка
```

Либо сразу с флагами (сессия тоже остаётся чистой):

```powershell
& ([scriptblock]::Create((irm $u))) -BootstrapPython -Client both
```

## Что где лежит (рантайм — вне репозитория)

| Что | Путь по умолчанию | Как переопределить |
|---|---|---|
| клон репозитория | `%USERPROFILE%\camoufox-research` | `-Dir`, `-Repo`, env `CAMOUFOX_REPO` |
| venv (рантайм) | `%USERPROFILE%\.venvs\camoufox-research` | `-Venv`, env `CAMOUFOX_VENV` |
| кэш добычи (`cache.db`, отчёты, логи) | `%USERPROFILE%\.cache\camoufox-research` | env `CAMOUFOX_CACHE_DIR` |
| кэши гейтов | `%USERPROFILE%\.cache\camoufox-research\gates` | env `CAMOUFOX_GATES_CACHE` |
| браузер Camoufox | `%LOCALAPPDATA%\camoufox\camoufox\Cache` | задаёт сам пакет (platformdirs) |

Репозиторий — **только код**: venv в клоне не создаётся (так же, как в каноне
`~/.venvs/camoufox-research` у `install_mcp.py`/`update_mcp.sh` и в
`CONTRIBUTING.md`). Точный путь браузера не угадывается, а спрашивается у
пакета: `pwsh -NoProfile -File scripts\install.ps1 -Version` печатает все пути
и версии, ничего не меняя.

## Требования

| Что | Зачем | Как поставить |
|---|---|---|
| Windows 10/11 x64 | браузер Camoufox — сборка под x64 | — |
| **PowerShell 7** (`pwsh`) | скрипты требуют 7+: `#Requires -Version 7.0`; 5.1 не поддерживается | `winget install --id Microsoft.PowerShell -e` |
| **Python 3.10–3.13 с python.org** | `venv` + `pip install .`; диапазон проверенный | `winget install --id Python.Python.3.13 -e` или установщик с python.org |
| **VC++ Redistributable 2015–2022 x64** | без него Firefox-стек (Camoufox) не стартует | ставит сам скрипт (шаг 3/8) через winget, если ключа реестра нет; `-SkipDeps` — не трогать |
| git (по желанию) | клонировать репозиторий | `winget install --id Git.Git -e`; без git скрипт скачает zip |
| сеть | `python -m camoufox fetch` скачивает браузер (~200 МБ) | — |

**Важно:** Python — **с python.org, не из MS Store**. Store-версия живёт в
песочнице (`WindowsApps`), её `venv` ломается на путях и на правах записи.
Заглушка-алиас Store в PATH версии не отдаёт, поэтому `install.ps1` пропускает
её с пометкой «не запустился» и идёт дальше (`py`-лаунчер → `python` → `python3`).

## Что делает install.ps1 (8 шагов, идемпотентно)

| Шаг | Действие | Повторный запуск |
|---|---|---|
| 1 | репозиторий: готовый клон рядом (скрипт/`-Dir`/текущий каталог) либо `git clone --depth 1` в `-Dir`; нет git — zip с GitHub | клон найден → ничего не качает |
| 2 | Python ≥ 3.10: `py -3.13…3.10`, `python`, `python3`, `uv`; иначе winget (`-BootstrapPython`) | находит тот же, ничего не ставит |
| 3 | системные зависимости: VC++ Redistributable 2015–2022 x64 (ключ реестра, при отсутствии — winget) | ключ есть → пропуск |
| 4 | venv **в рантайме**: `%USERPROFILE%\.venvs\camoufox-research\Scripts\python.exe` | venv есть → не пересоздаём |
| 5 | `pip install .` из **клона** (не git+https) | пакет импортируется из venv → пропуск |
| 6 | `python -m camoufox fetch` (браузер, один раз) | браузер скачан → fetch сам пропускает |
| 7 | секция MCP в `opencode.json` / `claude_desktop_config.json` + **бэкап** | та же команда → «не трогаю»; другая → обновление с бэкапом |
| 8 | проверка: импорт из venv, консольный скрипт, версия браузера и **рукопожатие MCP** (`mcp_drive.py`: initialize + tools/list) | то же; сервер не поднялся → rc=1 |

Проверка импорта идёт **из нейтрального каталога** (temp): в корне клона лежит
папка `camoufox_research`, и `python -c "import camoufox_research"` оттуда
подтвердил бы «установку» источников, которой нет.

Флаги: `-WhatIf`, `-Dir <куда клонировать>`, `-Repo <готовый клон>`,
`-Ref <ветка/тег клона>`, `-Venv <путь>`, `-Client auto|opencode|claude|both|none`,
`-OpencodePath <json>`, `-ClaudePath <json>`, `-Python <exe>`, `-BootstrapPython`,
`-SkipDeps` (не проверять/не ставить VC++), `-RegisterOnly` (окружение уже
готово — только прописать MCP), `-SkipBrowser`, `-Reinstall`, `-Uninstall`,
`-Yes` (не задавать вопросов), `-Version` (пути и версии, ничего не меняя).
Коды возврата: `0` — ок, `1` — ошибка установки, `2` — неверные входные данные
(клон не найден/не клон, битый JSON клиента, неизвестный клиент).

Регистрация MCP (`-Client auto` — только найденные клиенты):

```jsonc
// opencode: %USERPROFILE%\.config\opencode\opencode.json
{ "mcp": { "camoufox": { "type": "local",
  "command": ["C:\\Users\\me\\.venvs\\camoufox-research\\Scripts\\camoufox-research.exe"],
  "enabled": true } } }

// Claude Desktop: %APPDATA%\Claude\claude_desktop_config.json
{ "mcpServers": { "camoufox-research": {
  "command": "C:\\Users\\me\\.venvs\\camoufox-research\\Scripts\\camoufox-research.exe",
  "args": [], "env": {} } } }
```

Консольного скрипта нет (запуск из исходников) — в команду пойдёт
`<venv>\Scripts\python.exe -m camoufox_research.camoufox_research` (именно
`camoufox_research.camoufox_research`: у пакетного `__init__.py` нет
`__main__`, поэтому `-m camoufox_research` не выводит ничего).

Бэкап конфига — рядом: `opencode.json.bak-20260921-130115` (если имя занято,
добавляется `-2`, `-3`: два прогона в одну секунду не должны терять состояние
ПЕРЕД правкой). Битый JSON клиента скрипт **не** переписывает: сообщает и
выходит с кодом `2` — чужие настройки важнее автопочинки.

## Снятие (-Uninstall)

```powershell
pwsh -NoProfile -File scripts\install.ps1 -Uninstall            # спросит подтверждение
pwsh -NoProfile -File scripts\install.ps1 -Uninstall -Yes       # без вопросов (CI, пайп)
```

Убирает **venv** и **запись MCP** (с бэкапом конфига), печатает, что осталось
и как это снять руками. НЕ трогает: кэш добычи (`cache.db`, отчёты, логи),
браузер (200+ МБ бинарников) и сам клон — там ваши данные и код. В
неинтерактивном запуске (пайп, CI) без флага `-Yes` скрипт отказывается
работать и говорит об этом: спрашивать некого, а «молча удалить» — недопустимо.

## Что НЕ работает на Windows (честно)

| Возможность | Windows | Почему |
|---|---|---|
| `scripts\install.ps1`, `scripts\health_pulse.ps1` | ✅ | эти файлы и есть Windows-путь |
| venv + `pip install .` + `camoufox fetch` | ✅ | чистый Python |
| MCP в `opencode.json` / Claude | ✅ | `install.ps1` (с бэкапом) |
| cron-строки: `scripts/install_cron.sh` | ❌ | `crontab` — Unix; расписание делает Task Scheduler |
| systemd-таймеры с догоном: `scripts/install_timers.sh` | ❌ | systemd — только Linux |
| bash-стражи: `guard-all.sh`, `git-pre-*.sh`, `gitleaks-precommit.sh` | ❌ | bash + git-хуки репо; секрет-скан остаётся CI (`gitleaks.yml`) |
| обёртка caps: `scripts/update_mcp.sh` | ❌ | bash; группу тулов задаёт `CAMOUFOX_CAPS` в env клиента |
| `scripts/install_mcp.py` (пути `venv/bin`, `config.env`) | ❌ | Unix-пути; заменён на `install.ps1`. `config.env` на Windows не пишется |
| Python-скрипты репо (`watchdog_search.py`, `backup_cache.py`, …) | ⚠️ | это обычный Python — запускаются venv-интерпретатором, но **расписание** им ставит Task Scheduler (мы его не ставим) |

## Расписание: Task Scheduler

Пульс — раз в день в 08:00 (как `health_pulse` в `install_cron.sh`):

```powershell
schtasks /Create /TN "camoufox-pulse" /SC DAILY /ST 08:00 /F /TR `
  "\"C:\Program Files\PowerShell\7\pwsh.exe\" -NoProfile -File \"C:\src\camoufox-research\scripts\health_pulse.ps1\""
schtasks /Query /TN "camoufox-pulse" /V /FO LIST   # проверка
schtasks /Delete /TN "camoufox-pulse" /F           # снять
```

Логи пишутся туда же, где у Unix-версии: `%USERPROFILE%\.cache\camoufox-research\health-pulse.log`.
Другие Python-джобы репо заводятся так же — меняется только последний аргумент
(`-File ...\scripts\watchdog_search.py` и т.п.).

## Пульс здоровья: health_pulse.ps1

Те же четыре артерии и **тот же формат строки**, что у `scripts/health_pulse.py`
(файлы общие — обе версии читают и пишут один лог):

| Артерия | Как проверяется на Windows |
|---|---|
| MCP-сервер жив | пидфайл `%TEMP%\camoufox-mcp.pid` → `Get-Process`; `/proc` нет → скан `Win32_Process` (командная строка содержит `camoufox_research` ИЛИ `camoufox-research`) |
| сторож поиска свеж | последний `ok:` в `watchdog.log` ≤ 48ч; загрузка < 20ч → `WARN stale(machine-was-off)`, время загрузки неизвестно → `WARN stale(uptime-unknown)`, иначе `FAIL STALE-FAIL` |
| добыча | `cache.db` существует и не пуст |
| бэкап | `backup_cache.log` моложе 36ч |

`FAIL` → файл `health-pulse_ALERT` (снимается при первом PASS), строка в
`health-pulse.log`. Коды возврата: `0` — PASS/WARN, `1` — FAIL, `2` — сбой
самого пульса. Флаги: `-Cache`, `-PidFile`, `-StaleHours`, `-BootGraceHours`,
`-BackupStaleHours`, `-DryRun`, `-TestNotify`. Переменные те же, что в Python:
`CAMOUFOX_CACHE_DIR`, `CAMOUFOX_PIDFILE`, `HEALTH_PULSE_STALE_H`,
`HEALTH_PULSE_BOOT_GRACE_H`, `HEALTH_PULSE_BACKUP_STALE_H`,
`HEALTH_PULSE_NOTIFY`, `HEALTH_PULSE_NOTIFY_REPEAT_MIN` (параметр сильнее env).

```powershell
pwsh -NoProfile -File scripts\health_pulse.ps1 -DryRun      # вердикт без записей
pwsh -NoProfile -File scripts\health_pulse.ps1 -TestNotify  # проверить канал уведомлений
```

**Уведомления выключены по умолчанию** (как в Unix-версии: пульс не спамит).
Включение — `HEALTH_PULSE_NOTIFY=1` в переменных среды пользователя; механизм
выбирается сам: модуль **BurntToast** (`New-BurntToastNotification`), иначе
штатный `Windows.UI.Notifications` через Windows PowerShell 5.1 (есть в любой
Windows 10/11). Если нет ни того, ни другого — пульс честно говорит, что
механизма нет, и вердикт остаётся в логе/ALERT. Дедуп состояния — файл
`health-pulse_notify.state` (формат общий с Python-версией: обе читают запись
друг друга).

Отличия от Unix-версии, которые надо знать: срочность в Windows-toast не
различима (в macOS — звук; здесь `ToastText02` без звукового сценария);
`displays`/`DBUS` не проверяются (их на Windows нет).

## Проверка установки

```powershell
pwsh -NoProfile -File scripts\install.ps1 -Version     # версии и пути, без изменений
pwsh -NoProfile -File scripts\install.ps1 -WhatIf      # план: rc=0, изменений нет
& "$env:USERPROFILE\.venvs\camoufox-research\Scripts\python.exe" -c "import camoufox_research; print(camoufox_research.__file__)"
& "$env:USERPROFILE\.venvs\camoufox-research\Scripts\python.exe" -m camoufox fetch   # браузер на месте
& "$env:USERPROFILE\.venvs\camoufox-research\Scripts\python.exe" scripts\mcp_drive.py . '[{"op":"tools"}]'   # рукопожатие: BOOT + TOOLS n=NN
& "$env:USERPROFILE\.venvs\camoufox-research\Scripts\camoufox-research.exe"          # smoke: stdio-сервер, ждёт ввод (Ctrl+C)
opencode2 mcp list                                                                    # camoufox: connected
```

MCP «не connected» после смены кода — переподключение (не убивать процессы руками):

```powershell
opencode2 api post /api/mcp/camoufox/disconnect
opencode2 api post /api/mcp/camoufox/connect
```

## Как это проверялось (и что НЕ проверено)

Windows-машины у репозитория нет, поэтому проверялось на Linux-pwsh в
контейнерах `mcr.microsoft.com/powershell` (парсинг — на `lts` = 7.2,
анализ — на 7.4, потому что PSScriptAnalyzer требует PS ≥ 7.4.6):

```bash
# 1) разбор без ошибок
docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/powershell:lts pwsh -NoProfile -Command \
  '$e=$null; $t=$null
   [System.Management.Automation.Language.Parser]::ParseFile("/w/scripts/install.ps1", [ref]$t, [ref]$e)
   @($e).Count'                       # → 0 (то же для health_pulse.ps1)
# 2) линтер: 0 находок (подавления — только с обоснованием, см. шапку файла)
docker run --rm -v "$PWD/scripts/install.ps1":/w/install.ps1:ro \
  mcr.microsoft.com/powershell:7.4-ubuntu-22.04 pwsh -NoProfile -Command \
  'Install-Module PSScriptAnalyzer -Scope CurrentUser -Force; Invoke-ScriptAnalyzer -Path /w/install.ps1'
# 3) план и справка (скрипт смонтирован ОДНИМ файлом — как в ветке «клона нет»)
docker run --rm -v "$PWD/scripts/install.ps1":/w/install.ps1:ro \
  mcr.microsoft.com/powershell:lts pwsh -NoProfile -File /w/install.ps1 -WhatIf
docker run --rm -v "$PWD/scripts/install.ps1":/w/install.ps1:ro \
  mcr.microsoft.com/powershell:lts pwsh -NoProfile -File /w/install.ps1 -Version
```

Проверено прогоном (стенд с заглушками `git`/`python` и временным `HOME` —
настоящего python в контейнере pwsh нет):

* **ветка «клона нет»** — `git clone --depth 1 --branch main … <$HOME>\camoufox-research`
  выполнена, дальше все шаги работают на этом клоне;
* **рантайм-канон** — venv создан в `$HOME/.venvs/camoufox-research`, в клоне
  `.venv` не появился;
* **порядок установки** — журнал внешних вызовов: `venv` → `pip install . <клон>`
  → `camoufox fetch` → `mcp_drive.py <клон> '[{"op":"tools"}]'` (импорт пакета
  подтверждается только ПОСЛЕ pip — так проверялся шаг 5);
* **один клик в iex** — `Get-Content -Raw install.ps1 | iex` без параметров:
  rc=0, «установка OK», рукопожатие «сервер поднялся и отдал 34 тулов»,
  сессия после `iex` жива, утечек функций/`$ErrorActionPreference` нет;
* **идемпотентность** — второй прогон: «venv уже есть», «пакет уже
  импортируется», «MCP … уже прописан и совпадает — не трогаю», новых бэкапов
  конфига не появилось;
* **-WhatIf** — 5 строк `[WHATIF]` (клон, venv, pip, fetch, правка конфига),
  rc=0, md5 конфига до/после совпал, ни клона, ни venv не появилось, внешних
  команд изменения не вызывалось;
* **регистрация MCP** — три пути (`add`, повтор → «не трогаю», изменившаяся
  команда → обновление с бэкапом) + обе схемы клиентов (`mcp` с массивом
  `command` и `mcpServers` с `command`+`args`+`env`), чужие ключи конфига
  сохраняются; битый JSON → rc=2, файл не перезаписан;
* **-Uninstall** — venv удалён, наша запись MCP снята (бэкап положен), а кэш,
  браузер и клон целы (сверено md5); без `-Yes` в неинтерактивном запуске —
  отказ, ничего не удалено;
* **входные данные** — `-Repo` не-клон → rc=2; `-Dir` с чужими файлами → rc=2,
  каталог не тронут.

**НЕ проверено на Windows (причина — нет Windows-машины в этой сессии):**
`winget install` (Python и VC++ Redistributable), чтение ключа реестра
`HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64`, создание venv в
`Scripts\python.exe`, путь браузера `%LOCALAPPDATA%\camoufox\camoufox\Cache`,
`schtasks`, вывод тостов, `Get-CimInstance`/`Win32_Process` в пульсе, живой
`opencode2 mcp list`. Эти ветки написаны по документации и защищены
`try/catch` + честными сообщениями, но первый прогон на Windows стоит делать
с `-WhatIf` (и `-DryRun` для пульса).

## Траблшутинг

- `#Requires -Version 7.0` ругается → поставь PowerShell 7 (`winget install --id Microsoft.PowerShell -e`), запускай `pwsh`, а не `powershell.exe`.
- «нет python ≥ 3.10» → `python.org` (галочка *Add python.exe to PATH*) или `-BootstrapPython`; проверь, что `py -3.13 -V` отвечает в **новом** окне.
- Не хочется ставить VC++ Redistributable автоматически → `-SkipDeps`; помни: без рантайма браузер не запустится (ошибка вылезет на первом research, а не на установке).
- pip ставит, но пакет «не импортируется» → почти всегда чужой python в PATH: смотри строку `пакет импортируется из venv: …\site-packages\…` в шаге 8.
- Рукопожатие MCP упало (`initialize/tools/list не подтвердились`) → сервер не стартует: смотри хвост его stderr в выводе шага 8, проверь `CAMOUFOX_CAPS` и что `Scripts\camoufox-research.exe` на месте.
- Браузер не скачался (`fetch` без сети/прокси) → установка падает с явным сообщением: без браузера research не работает; повтори при рабочей сети или добавь прокси `CAMOUFOX_PROXY`.
- MCP в клиенте есть, но сервер молчит → проверь команду запуска в JSON (должен быть **существующий** `…\.venvs\camoufox-research\Scripts\camoufox-research.exe`) и `-WhatIf`-вывод шага 7.
- Установка просит подтверждение (не пайп, а CI) → добавь `-Yes`; в интерактивном окне подтверждение спрашивается нормально.
- В клоне лежит старый `.venv` → скрипт его **не** использует и не удаляет (говорит об этом предупреждением): окружение живёт в `%USERPROFILE%\.venvs\camoufox-research`; старый каталог можно снести руками.
- Нужен профиль тулов поменьше → допиши в конфиг клиента env: `"env": {"CAMOUFOX_CAPS": "research,browser"}` (env-ключ схемы клиента; в Claude Desktop — `"env"` внутри описания сервера).
- Разные venv у клиентов = гонки за `cache.db`: держи один venv (по умолчанию `%USERPROFILE%\.venvs\camoufox-research`).

## Откат

```powershell
# 1. снять venv и запись MCP (кэш и браузер останутся)
pwsh -NoProfile -File scripts\install.ps1 -Uninstall -Yes
# 2. если нужно — снять расписание
schtasks /Delete /TN "camoufox-pulse" /F
# 3. если нужно — кэш и браузер отдельно (это ДАННЫЕ и 200+ МБ бинарников)
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\camoufox-research"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\camoufox"
```

Кэш добычи (`%USERPROFILE%\.cache\camoufox-research`) не удаляем вместе с
venv — там `cache.db` и отчёты кампаний; бэкапы туда же кладёт
`scripts/backup_cache.py`. Клон репозитория (код) `-Uninstall` тоже не трогает.
