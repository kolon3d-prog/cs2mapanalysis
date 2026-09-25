---
name: camoufox-research-ops
description: >-
  Операторский скилл MCP-сервера camoufox-research (в репозитории и докладах —
  «кауфми»): поставить сервер
  (из клона на диске; GitHub-строка — фолбэк), переустановить пакет после правок, оживить MCP, разобрать
  «Unknown tool», пропажу ВСЕХ тулов, ошибки запуска, зомби,
  мусор на диске. Установка, обновление, диагностика, чистка. Берись за него,
  когда просят: поставь сервер, обнови MCP, не работает тул, нет тулов, ошибка
  запуска, починить браузерный MCP, переустановить, диагностика, логи, зомби,
  мусор на диске; install camoufox mcp, update mcp, reinstall mcp server,
  troubleshoot, server won't start, missing tools, setup on Windows/macOS,
  Docker. Также когда слово «camoufox» не названо, но речь про этот сервер:
  кауфми молчит, кауфми не работает, MCP-сервер с браузером, browser MCP.
  Пропали только session-тулы — это не сюда, а в camoufox-research-automation.
metadata:
  opencode/autoinvoke: true
---

# camoufox-research-ops — поставить, обновить, починить

Здесь только операторская половина: что делать руками на машине. Как искать —
в соседних скиллах («Рядом» ниже).

Главное правило, из которого растёт всё остальное: MCP поднимает **установленную
копию пакета**, а не каталог клона. Пока пакет не переустановлен, любой диагноз
относится к старому коду — поэтому «поправил, а баг на месте» и «тулы пропали»
в большинстве случаев лечатся переустановкой (§2), а не чтением кода.

## 1. Установка — из клона, если он есть; GitHub — фолбэк

**Основной путь — клон на диске:** каталог репо ищется рядом со скриптом, сеть
и GitHub не нужны — ставится код клона, включая рабочую ветку с правками.

```sh
# Linux / macOS / MSYS — из каталога репо
bash <каталог-репо>/scripts/install.sh             # установка
bash <каталог-репо>/scripts/install.sh --dry-run   # сначала план
# Windows (pwsh 7+)
pwsh -NoProfile -File <репо>\scripts\install.ps1 [-WhatIf]
```

Клон в стороне от скрипта — укажи явно: `--repo ПУТЬ` / `-Repo ПУТЬ` / env `CAMOUFOX_REPO`.

**Фолбэк — GitHub, только если клона на машине нет** (другая машина,
одноразовый сервер): сам склонирует в `~/camoufox-research` (шаг 0).

```sh
# Linux / macOS / MSYS
curl -fsSL https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.sh | bash
# Windows (pwsh 7+)
irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1 | iex
```

Оба входа дают одно и то же (venv в рантайме, пакет, браузер, MCP, проверка) —
разница ровно в шаге 0 «клонировать». Идемпотентен: уже стоящее не трогает.

Полезные флаги (полный список — `bash <каталог-репо>/scripts/install.sh --help`):

| флаг | зачем |
|---|---|
| `--dry-run` | план для ЭТОЙ машины и выход, ничего не меняет — первым делом на незнакомой системе |
| `--version` | версия репо и целевые пути (venv / кэш / браузер / конфиг клиента) |
| `--yes` (`-y`) | без вопросов; в пайпе вопросов и так нет |
| `--skip-deps` | не ставить системные пакеты (нет прав / уже стоят) |
| `--skip-browser` | не качать браузер (663 МБ) и не проверять его — CI/тесты |
| `--reinstall` | переустановить пакет принудительно (см. §2) |
| `--venv ПУТЬ`, `--dir ПУТЬ`, `--repo ПУТЬ` | переопределить venv / каталог клона |
| `--uninstall` | снять venv и запись MCP; кэш, браузер и `config.env` НЕ трогаются |
| `--os linux\|macos\|windows` | форсировать ОС для плана (проверка чужих веток) |

У Windows-установщика те же ручки в pwsh-виде: `-WhatIf` (аналог `--dry-run`),
`-Yes`, `-Uninstall`, `-SkipBrowser`, `-SkipDeps`, `-Reinstall`, `-Version`, `-Client`.

Docker — когда на хосте не хочется ничего ставить:

```bash
bash scripts/run_in_docker.sh --build --run     # собрать образ и поднять сервер (stdio)
bash scripts/run_in_docker.sh --self-test       # рукопожатие MCP внутри образа
bash scripts/run_in_docker.sh --http 8833 --json  # http-транспорт + конфиг клиента
```

Ставится **в рантайм**, а не в клон: после установки в клоне остаётся только код.

| куда | что |
|---|---|
| клон (каталог репо при локальном запуске; `~/camoufox-research` — при `curl\|bash`) | только код: ни venv, ни состояния |
| `~/.venvs/camoufox-research` | venv и установленный пакет (`bin/` на Unix, `Scripts\` на Windows) |
| `~/.cache/camoufox-research` | состояние: `cache.db`, `exports/`, `research/`, `config.env`, логи |
| `~/.cache/camoufox` | браузер Camoufox (скачать 663 МБ, на диске ~1.3 ГБ), качается один раз, общий на машину |
| `~/.config/opencode/opencode.json` | запись MCP-секции в клиенте |

Сверить на конкретной машине (замер этой сессии: 0.19.0, venv и кэш — как в таблице):

```bash
bash <каталог-репо>/scripts/install.sh --version
```

## 2. Обновление после правок (обязательная переустановка)

`git pull` и правка файла в клоне **не меняют** то, что запускает MCP: в
`site-packages` лежит прошлая сборка. Переустановка из корня клона:

```bash
bash <каталог-репо>/scripts/install.sh --reinstall --skip-deps
```

Почему именно так, а не «просто pip install»: pip/uv отдаёт колесо из кэша,
пишет «Successfully installed» и оставляет старый код. `install.sh --reinstall`
сносит и ставит пакет заново, а заодно прогоняет проверки (§3).

Ручной эквивалент, если нужен контроль над каждым шагом:

```bash
~/.venvs/camoufox-research/bin/python -m pip install --force-reinstall --no-cache-dir .
```

Обновление из git одной командой (pull → установка с гита → reconnect → ping),
с честным планом наперёд:

```bash
bash scripts/update_mcp.sh --dry-run    # план, ничего не выполняет
bash scripts/update_mcp.sh              # выполнить
```

Доказать, что доехало, надо **по файлу, а не по выводу установщика**:

```bash
python scripts/mcp_probe.py --json | grep -E 'package_version|tools_count'
grep -rc "<строка-из-правки>" ~/.venvs/camoufox-research/lib/*/site-packages/camoufox_research/
```

Первая команда отвечает сразу на два вопроса: какая версия пакета реально
установлена и сколько тулов отдаёт сервер. Числа не совпали с ожиданием —
переустановка не доехала или сервер не переподключён.

**Reconnect — только штатный.** После подмены кода клиент должен пересоздать
сервер: у opencode это `opencode2 api post /api/mcp/camoufox/disconnect`, затем
`.../connect` (ровно это делает `update_mcp.sh`). Убитый руками MCP-процесс сам
не пересоздаётся — тулы просто исчезают у всех клиентов.

## 3. Диагностика: чем задавать вопросы

Прогонять по порядку от дешёвого к дорогому: сначала рукопожатие, потом живые
вызовы, и только затем нагрузка.

| скрипт | вопрос | вызов |
|---|---|---|
| `scripts/mcp_probe.py` | сервер вообще отдаёт тулы? | `python scripts/mcp_probe.py [--json]` — read-only, ~1 с |
| `scripts/mcp_drive.py` | живое рукопожатие и вызовы с таймингом | `<venv>/bin/python scripts/mcp_drive.py <репо> '[{"op":"tools"},{"tool":"ping"}]'` |
| `scripts/soak_probe.py` | зомби, сироты, зависания, RSS-утечка | `python scripts/soak_probe.py 3` — поднимает браузер |
| `scripts/campaign_audit.py` | сколько мусора в кампании (по домену и заголовку) | `python scripts/campaign_audit.py <camp_id\|last>` |
| `scripts/gates.sh` | все гейты репозитория одной командой | `bash scripts/gates.sh [--quick]` |
| `scripts/health_pulse.py` | пульс: сервер / сторож / кэш / бэкап | `python scripts/health_pulse.py` (Windows: `pwsh -NoProfile -File scripts\health_pulse.ps1 [-DryRun]`) |

Замеры этой сессии, чтобы было с чем сравнивать: `mcp_probe.py --json` →
`ok=true`, `protocol=2025-11-25`, `tools_count=34`, `package_version=0.19.0`,
время ~1.0 с. `mcp_drive.py` → `BOOT 0.83s`, `tools n=34`, `ping` → `pong`
(`isError=False`). `soak_probe.py` и `campaign_audit.py` поднимают браузер и
читают боевой кэш — их гоняй по одному, не параллельно с чужой работой.

Числа тулов по профилям `CAMOUFOX_CAPS`: пусто = `research,browser` = **34**,
`+session` = 60, `+vision` = 36, `all` = 62; `ping`/`stats` видны всегда.
Маленькое число — не поломка, а профиль; `mcp_probe` показывает действующий
профиль отдельной строкой `caps`.

`mcp_drive.py` берёт питон из венва (запуск системным `python3` даёт
`handshake failed: server closed stdout`): его план — JSON-массив шагов,
`{"op":"tools"}` / `{"op":"sleep","sec":N}` / `{"tool":…,"args":…}`, а `--full`
печатает ответ целиком (`DRIVE_OUT` кладёт отчёт в рантайм-каталог).

## 4. Типовые поломки → что делать

| симптом | причина | действие |
|---|---|---|
| «Unknown tool», тулы пропали, меньше ожидаемого | в venv старый код либо сервер не переподключён | `bash <каталог-репо>/scripts/install.sh --reinstall` → reconnect (§2) → `mcp_probe.py` |
| старт падает на первой секунде, кампания навсегда `running` | каталога `exports/` в кэше не было, а `start()` открывает лог до спавна воркера | `mkdir -p ~/.cache/camoufox-research/exports`; текущая сборка создаёт каталог сама (`_paths.ensure(export_dir())` в `camoufox_campaign_ext`) |
| `research_start` отказывает: кампания уже идёт | закон одного инстанса | `research_cancel(camp_id)` — переводит в `failed`, лог остаётся для разбора; залипшую дольше `CAMOUFOX_CAMPAIGN_STALE_MIN` (30 мин) сервер снимает сам при следующем старте |
| ошибка тула неотличима от ответа, retry не срабатывает | ошибка приходит исключением SDK и флагом `isError=true`, а не текстом | ветвиться по `isError`, а не искать «ошибка:» в тексте |
| `fetch_page` / `check_links` отказывают на своём адресе | страж URL пускает только `http(s)` на публичный адрес (`file://`, `127.0.0.1`, `169.254.169.254` — отказ) | если это осознанно для отладки: `CAMOUFOX_ALLOW_FILE=1` / `CAMOUFOX_ALLOW_PRIVATE=1` |
| `export` / `citation_report` не пишет по указанному пути | запись разрешена только внутрь каталога экспорта (анти-RCE через содержимое страницы) | писать в `~/.cache/camoufox-research/exports`; обход — `CAMOUFOX_ALLOW_ANY_PATH=1` |
| пульс молчит (или спамит уведомлениями) | канал уведомлений — opt-in | `HEALTH_PULSE_NOTIFY=1` включает; повторы гасит `HEALTH_PULSE_NOTIFY_REPEAT_MIN`; на Linux нужны `DISPLAY`/`WAYLAND_DISPLAY`/`DBUS_SESSION_BUS_ADDRESS` |

Вентили выше (`ALLOW_FILE`, `ALLOW_PRIVATE`, `ALLOW_ANY_PATH`) — для отладки,
не «чтобы прошло»: они снимают защиту, а не чинят причину.

## 5. Чистота: артефакты — в рантайм

Правило репозитория: всё, что порождает файлы (отчёты, дампы замеров, кэши
инструментов), живёт в рантайм-каталоге, а не рядом с данными. Вентили:
`CAMOUFOX_DEV_DIR` (по умолчанию `~/.cache/camoufox-research/dev`), кэши гейтов —
`~/.cache/camoufox-research/gates` (`gates.sh` уводит туда mypy/ruff/`__pycache__`,
иначе mypy кладёт ~30 МБ в клон).

Проверка «нет ли мусора рядом с данными» (только чтение, ничего не удаляет):

```bash
node cleanup-station/bin/junk-report.mjs              # отчёт глазами
node cleanup-station/bin/junk-report.mjs --json --top 20
node cleanup-station/bin/junk-report.mjs --strict     # rc≠0, если находки есть — для крона/CI
```

`--strict` считает НАХОДКИ, а не байты: пустой каталог-свалка в корне диска —
уже нарушение. `--all` заглядывает и внутрь `.venv`/`.git` (по умолчанию
пропускает — это не мусор).

Отдельная грабля: разовый прогон `python -c "import camoufox_research…"` или
`python scripts/mcp_drive.py …` ИЗ КОРНЯ КЛОНА (не через `gates.sh`) компилирует
пакет в `camoufox_research/__pycache__` рядом с кодом — сторож показывает это
как десятки находок при нулевых мегабайтах. Лечится от начала, а не после:

```bash
export PYTHONPYCACHEPREFIX=~/.cache/camoufox-research/gates/pycache   # или гоняй через gates.sh
```

## 6. Кросс-платформенность

Коротко: Python-часть и браузер работают на Linux, macOS и Windows; bash-обвязка
(стражи, cron-скрипты, `update_mcp.sh`), `notify-send`, `/proc` — Unix-only;
Docker — универсальный путь. Живых macOS и Windows у проекта нет: ветки для них
доказаны кодом и юнит-пробой с подменённой платформой, а не прогоном на машине.

Подробная таблица «фича × ОС × граница» — `docs/CROSSPLATFORM.md` репозитория
(там же команды-доказательства).

Полезно помнить: раскладка venv различается (`bin/` против `Scripts\`) —
скрипты репозитория решают это через `scripts/_compat.py`; расписание на Linux —
cron или systemd-таймеры (`install_cron.sh` / `install_timers.sh`), на macOS —
только cron, на Windows — Task Scheduler вручную (`install.ps1` подсказывает
строку); `install_mcp.py` знает только `bin/` и на Windows не используется
(регистрацию делает `install.ps1`).

## 7. Рядом

- `camoufox-research-rails` — грабли поведения (кампании, волна термов, страж URL, экспорт); заходи туда, когда вопрос «почему так себя ведёт», а не «как поставить».
- `camoufox-research-deep-research` — как выжимать полноту и качество источников.
- `camoufox-research-automation` — браузерные сценарии и сессии.

## Границы

- Не чистить и не «чинить» живой кэш владельца (`~/.cache/camoufox-research`):
  там `cache.db`, отчёты и `config.env`. Снос данных — не диагноз.
- Не переустанавливать пакет, пока чужой агент или тест работает с тем же venv:
  подмена кода под живым процессом даёт ложные падения.
- Не убивать MCP-процесс руками — только штатный reconnect (§2).
- `--uninstall` не трогает кэш, браузер и `config.env` намеренно: снятие сервера
  не должно стоить добычи.
- Что и чем реально проверено (и что НЕ проверено) — `docs/VERIFICATION.md`,
  инвентарь скриптов — `scripts/README.md`, живая механика — `scripts/mcp_drive.py`.

---

**AGGG [Distro] Firmware** · автор — **@hilartem** (Telegram). Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
