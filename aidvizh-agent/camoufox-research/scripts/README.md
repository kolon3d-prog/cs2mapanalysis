# scripts/ — что здесь лежит

Каждый скрипт с одной строкой «зачем». Всё, что пишет артефакты (отчёты, дампы),
складывает их в кэш-каталог `~/.cache/camoufox-research/dev/` (вентиль
`CAMOUFOX_DEV_DIR`), **а не рядом с репозиторием**: рабочий диск — не свалка
(урок 21.09: наши же дампы замера оказались в корне боевого каталога).

## Один клик

Клон уже есть на диске — ставим из него, сеть не нужна:

```bash
# Linux / macOS / MSYS — из каталога клона
bash scripts/install.sh                 # сначала --dry-run, если хочется посмотреть план
bash scripts/install.sh --uninstall     # снять (кэш и браузер не трогает)
```

```powershell
# Windows (pwsh) — из каталога клона
pwsh -NoProfile -File scripts\install.ps1            # -WhatIf — план
```

На другой машине, где клона нет, — однострочники (установщик сам склонирует):

```bash
# Linux / macOS / MSYS
curl -fsSL https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.sh | bash

# Windows (pwsh)
irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1 | iex
```

Универсальный путь, если на хосте вообще не хочется ничего ставить:

```bash
bash scripts/run_in_docker.sh --build --run
```
Окружение и состояние ставятся В РАНТАЙМ (`~/.venvs/camoufox-research`, `~/.cache/camoufox-research`,
браузер `~/.cache/camoufox`) — в клоне после установки остаётся только код. Запись MCP в клиент
ставит и сам установщик (имя `camoufox` в opencode), и станция MCP: `mcp-station install camoufox`.

## Установка и запуск

| файл | зачем |
|---|---|
| `install.sh` | установка на Linux/macOS/MSYS одной командой (в т.ч. без клона: `curl … \| bash`), ОС→пакетный менеджер→python→venv В РАНТАЙМЕ→`uv sync --frozen`→браузер→MCP→рукопожатие; `--dry-run` ничего не меняет |
| `install.ps1` | то же нативно на Windows (pwsh): venv в рантайме (`~/.venvs/…/Scripts`), регистрация MCP с бэкапами, `-WhatIf`, `-Yes`, `-Uninstall`, `-SkipBrowser`, `-Version` |
| `install_mcp.py` | регистрация MCP в opencode/Claude + `config.env`; функции переиспользует `install.sh` |
| `install_cron.sh` / `install_timers.sh` | cron-строки и systemd-таймеры (только Unix; на Windows их нет — так и написано в докax) |
| `run_in_docker.sh` | запуск сервера в docker/podman: `--build/--run/--self-test/--http/--json`; печатает готовый конфиг клиента |
| `update_mcp.sh` / `update_mcp.ps1` | обновление из гита одной командой: `git pull` → `pip install --upgrade git+…@main` → reconnect MCP → проверка живости сервера; `--dry-run` / `-DryRun` — план без действий (скан процесса: `ps -Ao` на Unix, Win32_Process на Windows) |
| `publish_report.sh` / `publish_report.ps1` | публикация отчёта на витрину: скан секретов → копия в `research/public/` → пересборка INDEX и `_site`; пуш только по флагу (`--push` / `-Push`), `--dry` / `-DryRun` — план |

## Диагностика и живые проверки

| файл | зачем |
|---|---|
| `mcp_probe.py` | «сервер вообще отдаёт тулы?»: рукопожатие + `tools/list` + подпись профиля; гейт CI |
| `mcp_drive.py` | драйвер MCP по stdio: план — JSON-массив шагов (`{"tool":…,"args":…,"full":true}`), печатает время/isError/текст, `DRIVE_OUT` кладёт отчёт; `{op:"tools"}` — реестр |
| `soak_probe.py` | нагрузочная проба: зомби, сироты, зависания, RSS по итерациям; отчёт `~/.cache/camoufox-research/dev/soak_report.json` |
| `campaign_audit.py` | «сколько мусора в кампании»: раскладывает источники на по теме/мимо и показывает след волн (счётчик доменов врёт — смотри состав) |
| `health_pulse.py` | пульс: сервер/сторож/кэш/бэкап; уведомления **opt-in** (`HEALTH_PULSE_NOTIFY=1`), дедуп по состоянию |
| `health_pulse.ps1` | тот же пульс для Windows (pwsh): те же проверки, те же вердикты |
| `budget_review.py`, `tool_usage_stats.py`, `reports_index.py` | бюджет кампаний, кто какими тулами пользуется, индекс отчётов |

## Гейты

| файл | зачем |
|---|---|
| `gates.sh` | все проверки одной командой: ruff + mypy + bandit + semgrep + bats + unittest (`--quick` — без semgrep/bats). **Кэши инструментов уводит в `~/.cache/camoufox-research/gates`** (`MYPY_CACHE_DIR`, `RUFF_CACHE_DIR`, `PYTHONPYCACHEPREFIX`), иначе mypy кладёт ~30 МБ в репозиторий, а репозиторий лежит на диске данных (урок 21.09) |
| `gates.ps1` | тот же гейт для pwsh (Windows и Linux/macOS): переносимая часть — ruff + mypy + bandit + semgrep (если есть) + pytest (а без него unittest) из того же venv и с теми же кэшами. Unix-only гейты (bats, git-хуки, docker, cron/таймеры) печатаются строками `[skip]` с причиной — не молча; `-Quick` — без semgrep |

## Платформы: скрипт × ОС

Правило набора: у каждого `*.sh` либо есть **соседний** `*.ps1`, либо путь стоит в
`command-center/platform-exceptions.txt` с причиной (гейт центра проверяет это в обе стороны —
и что каждый `.sh` объяснён, и что объяснение не протухло). Файлы, которые есть только на
Unix, здесь помечены честно: поддельных `.ps1` у них нет.

| скрипт | Linux | macOS | Windows | почему так |
|---|---|---|---|---|
| `install.sh` | да | да | MSYS/Git-Bash — да, нативно нет | bash-обвязка; нативная установка на Windows — `install.ps1` (venv `Scripts\`, MCP с бэкапом конфига) |
| `install.ps1` | да (pwsh) | да (pwsh) | да | один установщик на все ОС: раскладка venv выбирается по ОС, на не-Windows пропускает winget/VC++ |
| `gates.sh` | да | да | нет | bash + bats: Unix-версия гейта; на Windows переносимую часть гоняет `gates.ps1` (`docs/install-windows.md`) |
| `gates.ps1` | да (pwsh) | да (pwsh) | да | ruff + mypy + bandit + semgrep + pytest через venv; Unix-only гейты — строкой `[skip]` с причиной |
| `health_pulse.py` | да | да | да | чистый python, механизм уведомлений выбирается по ОС |
| `health_pulse.ps1` | да (pwsh) | да (pwsh) | да | тот же пульс на PowerShell, словарь вердиктов совпадает с python-версией |
| `install_mcp.py` | да | да | нет | знает только раскладку `venv/bin` (F3 в `docs/CROSSPLATFORM.md`); на Windows MCP прописывает `install.ps1` |
| `install_cron.sh` | да | да (cron есть; демон просит Full Disk Access) | нет | cron — расписание на Windows задаёт Task Scheduler |
| `map_metric_cron.sh` | да | да | нет | cron-строка (ставится `install_cron.sh`) |
| `pre-commit_autoupdate.sh` | да | да | нет | cron (месячное обновление пинов через `install_cron.sh`) |
| `install_timers.sh` | да | нет | нет | systemd-user: на macOS/BSD systemd нет вовсе, на Windows его роль играет Task Scheduler |
| `sd-run.sh` | да | нет | нет | запускается из systemd-user юнитов (`install_timers.sh`) |
| `run_bats.sh` | да | да | нет | bats (bash) — на Windows локального прогона тестов стражей нет |
| `run_in_docker.sh` | да | да | через WSL2/Git-Bash | сам контейнерный путь переносим (образ один для всех), обёртка — bash с `docker`/`podman` CLI |
| `guard-all.sh`, `guard_selftest.sh` | да | да | нет | git-хук (единый pre-commit-страж + матрица правил): git зовёт их как sh |
| `git-pre-commit.sh`, `git-pre-push.sh`, `gitleaks-precommit.sh` | да | да | нет | git-хуки: на Windows остаётся двухслойная оборона через CI (`gitleaks.yml`) |
| `publish_report.sh` / `publish_report.ps1` | да (pwsh) | да (pwsh) | да (pwsh) | пуш витрины с обеих сторон: `.ps1` — тот же порядок шагов (скан секретов → копия → INDEX → `_site`), скан на .NET-регексе, префикс коммита `publish(showcase)` |
| `update_mcp.sh` / `update_mcp.ps1` | да (pwsh) | да (pwsh) | да (pwsh) | `.ps1` повторяет ритуал и берёт раскладку venv `Scripts\` по ОС; процесс ищется `ps -Ao` на Unix и Win32_Process на Windows (`pgrep -a` в BSD печатает только pid) |
| `docker/entrypoint.sh` | да | да | нет | точка входа ВНУТРИ linux-образа (POSIX sh, `exec` на процесс №1) — вне контейнера не исполняется |
| `*.py` (диагностика: `mcp_probe`, `mcp_drive`, `soak_probe`, `campaign_audit`, `budget_review`, …) | да | да | да | чистый python, пути через `pathlib`/`os.path` (`tests/test_crossplatform.py`) |

## Хранители репозитория

| файл | зачем |
|---|---|
| `guard-all.sh` | прогон всех стражей одной командой |
| `git-pre-push.sh` | перед push: что именно уходит публично (витрина/метрики vs приватное) |
| `gitleaks-precommit.sh` | секрет-скан staged с пробросом rc (падение = стоп коммита) |
| `guard_selftest.sh` | проверка, что сами стражи работают |
| `skill_lint.py` | валидатор `SKILL.md` (frontmatter, длина, личные пути) |

## Документация по теме

- `docs/RESEARCH-PLAYBOOK.md` — как выжимать полноту (рецепты + замеры);
- `docs/VERIFICATION.md` — что и чем проверено, что не проверено, как воспроизвести;
- `docs/testing-live-flows.md` — живые тесты (`CAMOUFOX_LIVE_TESTS=1`) и почему не в CI;
- `docs/install-crossplatform.md`, `docs/install-windows.md` — установка по ОС.

---

**AGGG [Distro] Firmware** · автор — **@hilartem** (Telegram). Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
