# Кроссплатформенность: реестр с доказательствами

Ответ на вопрос «точно везде кроссплатформенность?» — таблица, а не обещание.
В каждой строке: **чем доказано** (файл+функция или воспроизводимая команда) и
**где ограничение**. Где живую ОС взять нечем — так и написано («не проверено
на живой ОС»), потому что иначе это не доказательство, а вера.

Срез: **21.09.2026, 16:58** (после переезда venv в рантайм). Пакет и скрипты
цитируются «файл:строка»; установщики (`install.sh`, `install.ps1`) — **по
символу/маркеру**, без номеров: их правят параллельно, и строка поедет раньше,
чем реестр прочитают (`grep -n '<маркер>' scripts/install.sh`).

Механическая проверка статики — `python -m unittest tests.test_crossplatform`
(или `tests/test_crossplatform.py`; 7 тестов: Unix-only вызовы, `/proc` под
стражем, склейка путей, точки входа установщиков).

## Мастер-таблица

| Фича | Linux | macOS | Windows | Чем доказано | Где ограничение |
|---|---|---|---|---|---|
| Браузерный слой | ✅ headless | ✅ headless | ✅ headless → headed+`windows_hide` | `camoufox_research/camoufox_browser_core.py:24` (`IS_NT`), `:73-87` (`_launch`, баг #614) | Windows-headless падает `STATUS_BREAKPOINT` на части билдов — лечим fallback'ом; на живой Windows не прогонялось |
| Ресурсы машины (воркеры) | ✅ `/proc/meminfo` | ✅ `vm_stat` | ✅ `GlobalMemoryStatusEx` | `camoufox_fetch_core.py:113/119/137` (`_auto_workers`) | macOS-ветка не проверена на живой macOS; `sysconf`-fallback даёт «половину всей памяти», а не доступную |
| Путь к браузеру | ✅ `~/.cache/camoufox` | ✅ `~/Library/Caches/camoufox` | ✅ `%LOCALAPPDATA%\camoufox\Cache` | измерено на Linux: `python -c "from camoufox.pkgman import INSTALL_DIR"` → `~/.cache/camoufox`; остальные ОС — зеркало `install.sh: browser_cache_dir()` | путь считает САМ camoufox (platformdirs) — наш код его только зеркалит для подсказок; значения macOS/Windows на живой ОС не измерены, а прочитаны из зеркала |
| Путь состояния (`CAMOUFOX_CACHE_DIR`) | ✅ | ✅ | ✅ | `camoufox_paths.py` (единственный источник), на него переведены `camoufox_cache.py`, `camoufox_export.py`, `camoufox_campaign_core.py`, `camoufox_housekeep.py`, `camoufox_browser_ext.py`, `camoufox_session_ext.py`, `camoufox_worker_core_a.py`, `camoufox_research_bridge.py`, `camoufox_critic.py`; проверка — `tests/test_paths_env.py` | **F1 закрыт (21.09):** `camoufox_research/camoufox_paths.py` — единственный источник путей; 10 модулей пакета переведены, инвариант держит `tests/test_paths_env.py` |
| Раскладка `~/.cache` | ✅ канон | ✅ `~/Library/Caches` | ✅ `%LOCALAPPDATA%\Cache` | `os.path.expanduser("~")/".cache"` работает везде | **F2 закрыт (21.09):** дефолт каталога состояния платформенный (`camoufox_paths.py`); `Dockerfile:156` остаётся для контейнера |
| Уведомления пульса | ✅ `notify-send` | ✅ `osascript` | ✅ toast (`Windows.UI.Notifications`), BurntToast если есть | `scripts/health_pulse.py:247` (`_notify_cmd`), `:290` (`_notify_allowed`); `health_pulse.ps1:328` (`Get-NotifyMechanism`) | «механизма нет» возвращается честно; по умолчанию канал ВЫКЛ (`HEALTH_PULSE_NOTIFY=1`); живой macOS/Windows не пробован |
| Пульс: проверки и вердикты | ✅ python | ✅ python | ✅ pwsh | словарь совпадает: `mcp=`, `watchdog=ok/no-data/stale(machine-was-off)/stale(uptime-unknown)/STALE-FAIL`, `cache=ok/MISSING`, `backup=ok/stale/no-data` (`health_pulse.py:129-170` ↔ `health_pulse.ps1:450-497`) | два независимых поддержания = дрейф возможен; ловится сравнением словарей, не тестом |
| venv: где лежит | ✅ `~/.venvs/camoufox-research` | ✅ там же | ✅ `$HOME\.venvs\camoufox-research` | `install.sh: DEFAULT_VENV_DIR`, `install.ps1: Join-Path $HOME '.venvs/camoufox-research'` | — |
| venv: `bin/` vs `Scripts/` | ✅ `bin/` | ✅ `bin/` | ✅ `Scripts\` | `install.sh: VENV_BIN` (Scripts либо bin), `install.ps1: $binName`, `scripts/_compat.py: venv_python()` | `scripts/install_mcp.py` знает только `bin/` (`:78/86/107`) — на Windows не используется (F3) |
| Консольный скрипт | ✅ `bin/camoufox-research` | ✅ `bin/camoufox-research` | ✅ `Scripts\camoufox-research.exe` | рукопожатие MCP: 2 строки в stdout, 0 не-JSON, `tools: 34` (команда ниже) | на живом Windows не запускался |
| Обвязка (стражи, хуки) | ✅ bash | ✅ bash | ❌ Unix-only | `scripts/guard-all.sh`, `git-pre-*.sh`, `gitleaks-precommit.sh` | F4: на Windows — только CI-скан (`gitleaks.yml`), локального хука нет |
| Расписание | ✅ cron **или** systemd | ⚠️ только cron | ❌ Task Scheduler (вручную) | `install_cron.sh:55` (отказ без `crontab`), `install_timers.sh:36` (отказ без `systemctl`); `install.ps1: подсказка schtasks` | systemd-таймеров на macOS/BSD нет вовсе; на Windows автопостановки нет |
| Docker (универсальный путь) | ✅ | ✅ | ✅ | `Dockerfile`, `docker/entrypoint.sh:28` (`>&2`), `scripts/run_in_docker.sh` | образ собирается под арх хоста; внутрь тома данные, браузер — в образе |
| Логи/кодировки | ✅ UTF-8 | ✅ UTF-8 | ✅ UTF-8 через `reconfigure` | `camoufox_research.py:24-25`, `camoufox_worker_core_a.py:18-19`, `campaign_runner.py:20-21`, `scripts/_compat.py:fix_encoding/run` (`PYTHONUTF8=1` детям) | Windows-консоль по умолчанию cp1251 — на живой Windows не проверено |
| Чистота stdout для stdio | ✅ | ✅ | ✅ | рукопожатие ниже: не-JSON строк 0; диагностика старта — `file=sys.stderr` (`camoufox_research.py:161-166/309-315`); `Dockerfile:21` | `camoufox_rpc.py`/`camoufox_worker_ext.py` печатают в свой stdout — это CLI и протокол воркера, не stdout клиента |

## Команды-доказательства

Все команды — из корня клона (при установке в один клик это
`~/camoufox-research`, `install.sh: DEFAULT_REPO_DIR`), окружение — рантайм
`~/.venvs/camoufox-research`.

```bash
# 0. Статический реестр переносимости (Unix-only, /proc, склейка путей, входы)
~/.venvs/camoufox-research/bin/python -m unittest tests/test_crossplatform.py -v

# 1. venv и консольный скрипт (какая раскладка реально на этой машине)
ls ~/.venvs/camoufox-research/bin/camoufox-research      # Scripts/ был бы на Windows
~/.venvs/camoufox-research/bin/python -V                 # Python 3.13.15

# 2. Путь к браузеру считает camoufox, а не мы
~/.venvs/camoufox-research/bin/python -c \
  "from camoufox.pkgman import INSTALL_DIR; print(INSTALL_DIR)"   # ~/.cache/camoufox

# 3. CAMOUFOX_CACHE_DIR переносит ВСЁ состояние (F1 закрыт 21.09)
CAMOUFOX_CACHE_DIR=/tmp/cp-cache-proof ~/.venvs/camoufox-research/bin/python - <<'EOF'
import os, sys; sys.path.insert(0, ".")
from camoufox_research import camoufox_cache as cc, camoufox_critic as cr
from camoufox_research import camoufox_paths as paths
print(cc._CACHE_DIR)      # /tmp/cp-cache-proof/...  ← env прочитан
print(cr._CRITIC_FILE)    # /tmp/cp-cache-proof/...  ← env прочитан
print(paths.cache_dir())  # /tmp/cp-cache-proof/...  ← один источник на всех
EOF

# 4. Словарь вердиктов пульса: python ↔ pwsh (паритет)
grep -oh 'watchdog=[a-zA-Z()_-]*' scripts/health_pulse.py | sort -u

# 5. Чистота stdout для stdio: рукопожатие MCP, разбор каждой строки
#    (печатает «stdout строк: 2, не-JSON: 0»; tools: 34 = дефолтный профиль)
{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cp","version":"1"}}}';
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}';
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 10; } \
| ~/.venvs/camoufox-research/bin/camoufox-research 2>/tmp/err.txt \
| ~/.venvs/camoufox-research/bin/python -c "
import json, sys
rows = [l for l in sys.stdin if l.strip()]
bad = 0
for l in rows:
    try: json.loads(l)
    except Exception: bad += 1
print(f'stdout строк: {len(rows)}, не-JSON: {bad}')
"
```

## Найденные реальные непереносимости

- **F1 — ЗАКРЫТ 21.09.** Было: `CAMOUFOX_CACHE_DIR` читал 1 модуль пакета из 9,
  остальные восемь брали `~/.cache/camoufox-research` жёстко, поэтому переменная
  переключала часть состояния. Стало: `camoufox_research/camoufox_paths.py` —
  единственный источник путей (ленивый резолв, чтобы env читался после импорта);
  на него переведены 10 модулей пакета, инвариант «всё состояние внутри заданного
  каталога» держит `tests/test_paths_env.py`. Симлинк в контейнере
  (`Dockerfile:156`) оставлен как совместимость.
- **F2 — ЗАКРЫТ 21.09.** Было: каталог состояния по умолчанию всегда `~/.cache`,
  на macOS/Windows это чужой для ОС путь. Стало: `camoufox_paths.py` считает дефолт
  платформенно — Linux `~/.cache`, macOS `~/Library/Caches`, Windows
  `%LOCALAPPDATA%\Cache`; явный `CAMOUFOX_CACHE_DIR` по-прежнему сильнее дефолта.
- **F3. `scripts/install_mcp.py` знает только `bin/`** (`:78/86/107/131/148/206`).
  На Windows не используется вовсе (`install.ps1` делает регистрацию сам),
  но остаётся ловушкой для того, кто позовёт его в MSYS/Git-Bash.
- **F4. bash-обвязка на Windows отсутствует.** Стражи (`.sh`), `install_cron.sh`,
  `install_timers.sh`, `update_mcp.sh` — Unix-only; на Windows расписание —
  Task Scheduler вручную. Это документировано в `install.ps1`, но остаётся
  разрывом «один вход на всех».
- **F5. `start_new_session=True` — POSIX-only семантика**
  (`camoufox_campaign_ext.py:205/309`). В CPython 3.13 на Windows это не
  исключение (проверено чтением `subprocess.Popen.__init__`: `ValueError`
  только для `preexec_fn`/`startupinfo`/`creationflags`), но и не отсоединение:
  фоновая кампания не переживёт родителя.
- **F6. Нет `creationflags=CREATE_NO_WINDOW`** при спавне python-детей
  (`camoufox_research_bridge.py:122`, `camoufox_campaign_ext.py:200/304`):
  из GUI-клиента на Windows может мигнуть консольное окно.
- **F7. CI гоняет только Linux.** Все workflow — `runs-on: ubuntu-latest`
  (`.github/workflows/*.yml`), macOS/Windows-ветки держатся статикой
  (`tests/test_crossplatform.py`) и документами, а не машиной.

## Чего здесь НЕ проверено (и почему)

- **Живой macOS и живой Windows.** Ни прогонов установщика, ни браузера, ни
  уведомлений, ни пульса. Всё, что выше помечено ✅ для этих ОС, доказано
  **кодом** (ветки по ОС существуют и стерегутся) и юнит-пробой подменённой
  платформы (`tests/test_notify_platform.py`, `tests/test_health_portable.py`),
  а не запуском. Это честная граница реестра.
- **Windows-headless Camoufox** (баг #614) — fallback написан по описанию бага,
  воспроизвести на своей машине нечем.
- **pwsh-разбор `install.ps1`/`health_pulse.ps1`** локально не гонялся: pwsh в
  системе нет (проверяется в контейнере `mcr.microsoft.com/powershell`).
- **Docker-путь** проверен по конфигурации и self-test'у в
  `scripts/run_in_docker.sh`, а не полным прогоном образа в этом заходе.
