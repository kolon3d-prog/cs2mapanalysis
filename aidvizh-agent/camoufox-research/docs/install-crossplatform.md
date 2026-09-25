# Кроссплатформенная установка: Linux / macOS / Windows

> Один вход вместо ручных шагов README — `scripts/install.sh`. Основной путь —
> запуск **из клона на диске** (`bash <каталог-репо>/scripts/install.sh`), сеть
> не нужна; строка с GitHub — фолбэк для машины, где клона ещё нет.
> Проверено: `bash -n` и `shellcheck -S warning` чисто; `--help`, `--version` и
> `--dry-run` (ветки linux/macOS/Windows) не меняют систему — хэши `config.env`,
> `opencode.json`, `crontab` и venv до/после идентичны.
> «Один клик» проверен пайпом БЕЗ клона в песочнице (`HOME=$(mktemp -d)`, фейковый
> клиентский `opencode.json`): `curl … | bash -s -- --dir … --yes --skip-deps
> --skip-browser` → клон в `--dir`, venv в рантайме, установка, абсолютный путь
> MCP из этого venv, rc=0; повторный запуск пропускает клон/venv/пакет; `--uninstall`
> снимает venv и MCP-запись, кэш/браузер/`config.env` остаются.
> Рукопожатие шага 7 (`initialize` + `tools/list` → 34 тула, proto 2025-11-25)
> проверено на клоне с `scripts/mcp_drive.py`; после установки `junk-report` по
> клону даёт 0 находок (`build/` и `__pycache__` убираются, байткод-кэш — в рантайм).

## Откуда ставим: клон / GitHub / Docker

| Откуда | Когда нужен | Команда |
|---|---|---|
| **Клон на диске** — основной путь | репо уже лежит на машине (свой диск, ветка с правками): сеть не нужна, шага «клонировать» нет — ставится код клона | `bash <каталог-репо>/scripts/install.sh` (Windows: `pwsh -File <репо>\scripts\install.ps1`) |
| **GitHub** — фолбэк | ДРУГАЯ машина, где клона нет (одноразовый сервер, чистый хост): шаг 0 склонирует сам в `--dir` | `curl -fsSL …/scripts/install.sh \| bash` (Windows: `irm …/install.ps1 \| iex`) |
| **Docker** | на хосте не хочется ставить вообще ничего (любая ОС с Docker): venv, библиотеки Firefox-стека и браузер уже в образе | `bash scripts/run_in_docker.sh --build --run` (ниже) |

Разница между первыми двумя ровно одна — шаг 0 «клонировать»; дальше шаги те же,
и результат одинаковый (venv в рантайме, пакет, браузер, MCP, проверка). Выбор
не про «что новее», а про то, есть ли код на диске: если есть — GitHub не нужен.

## Быстрый старт

### Основной путь — из клона (сеть не нужна)

```bash
git clone https://github.com/aidvizhhub/camoufox-research.git   # только если клона ещё нет
cd camoufox-research
bash scripts/install.sh            # установка
bash scripts/install.sh --dry-run  # сначала посмотреть план для ЭТОЙ машины
bash scripts/install.sh --version  # версия + целевые пути (venv/кэш/браузер/конфиг)
```

Каталог репо скрипт ищет **рядом с собой** — из корня клона или по полному пути
`bash /путь/к/репо/scripts/install.sh` одинаково. Клон в стороне от скрипта —
`--repo ПУТЬ` или `CAMOUFOX_REPO=/путь/к/клону bash install.sh`; другой venv —
`--venv ПУТЬ` / `CAMOUFOX_VENV`. Локальный запуск ставит именно код клона
(в том числе рабочую ветку), на GitHub не ходит вовсе.

### Фолбэк — одной строкой с GitHub (клона нет)

Linux / macOS (и MSYS/Git-Bash на Windows):

```bash
curl -fsSL https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.sh | bash
```

Windows (PowerShell 7+) — своя точка входа, тот же результат:

```powershell
irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1 | iex
# с флагами (в режиме iex их не передать):
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1))) -Yes -SkipDeps -SkipBrowser
```

Флаги в bash-форме идут после `--`; например CI-прогон без системных пакетов и
без 663 МБ браузера:

```bash
curl -fsSL …/scripts/install.sh | bash -s -- --yes --skip-deps --skip-browser
```

> `raw.githubusercontent.com/.../main/...` отдаёт файлы ВЕТКИ `main`: если
> `scripts/install.sh` в ней ещё не лежит (свежая разработка идёт в другой
> ветке), one-liner ответит 404 — тогда возьмите ветку, где файл есть
> (`.../<ветка>/scripts/install.sh`), или запустите из готового клона.

Что происходит при запуске «в один клик» (клона рядом нет):

1. репо клонируется в `--dir` (по умолчанию `~/camoufox-research`);
2. venv создаётся **в рантайме** (`~/.venvs/camoufox-research`) — в клоне
   остаётся только код;
3. пакет ставится по `uv.lock` (`uv sync --frozen --no-editable`), фолбэк —
   `pip install .`;
4. далее шаги 1–7 таблицы ниже.

Без tty (то есть внутри пайпа) вопросов не задаётся вообще: `read()` съел бы
следующие строки самого скрипта, поэтому установщик автоматически ведёт себя как
`--yes`. Интерактивный вопрос есть ровно один — подтверждение `--uninstall`.

Рукопожатие MCP (шаг 7) делает драйвер из самого клона
(`scripts/mcp_drive.py`); если в клоне его нет (старая ветка), шаг честно
предупреждает и пропускается — профиль тулов до этого уже проверил чипсет
(`install_mcp.py:verify`).

Установка из готового клона показана выше (первый раздел «Быстрого старта») — это
и есть основной путь; ниже про фолбэк-вход и общие для обоих шаги.

## Что делает (7 шагов, идемпотентно, с логом и временем)

Каждый шаг печатает свой номер, время старта и длительность — видно, где
установка идёт минутами (браузер, сборка колёс), а не «висит ли оно вообще».

| Шаг | Действие | Повторный запуск |
|---|---|---|
| 0 | клон в `--dir` — только при запуске без клона | клон есть → не клонируем |
| 1 | системные библиотеки Firefox-стека (только Linux) | `dnf`/`apt`-запрос: уже стоят → пропуск |
| 2 | python ≥ 3.10 (uv, если есть, иначе `python3 -m venv`) | — |
| 3 | venv **в рантайме** `~/.venvs/camoufox-research` (uv: `--seed`, чтобы внутри был pip) | venv есть → не пересоздаём |
| 4 | пакет: `uv sync --frozen` по `uv.lock` (`--no-editable`), иначе `pip install .` | пакет импортируется → установку пропускаем |
| 5 | `python -m camoufox fetch` — браузер | браузер скачан → fetch сам пропустит; `--skip-browser` пропускает шаг целиком |
| 6 | MCP в `opencode.json` + `config.env` | секция есть → не дублируется |
| 7 | проверка: импорт, консольный скрипт, версия браузера и **рукопожатие MCP** (`initialize` + `tools/list` через `scripts/mcp_drive.py`) | идемпотентна |

Флаги: `--dir`, `--repo`, `--venv`, `--yes`/`-y`, `--uninstall`, `--version`,
`--skip-deps`, `--skip-browser`, `--reinstall`, `--bootstrap-uv`, `--with-cron`,
`--dry-run`, `--os linux|macos|windows`, `--help`.
Код возврата: `0` — ок, `1` — ошибка установки, `2` — неверный флаг.

Почему `uv sync --frozen`, а не всегда `pip install .`: лок-файл — источник истины
(та же сборка, что в CI, без резолва и дрейфа версий), и в исходниках не
остаётся `build/`. `pip install .` остаётся фолбэком (нет uv / нет lock / lock
разошёлся с pyproject / sync упал). После установки установщик убирает из клона
byproduct'ы сборки (`build/`, `__pycache__`) и держит `PYTHONPYCACHEPREFIX` в
рантайм-каталоге — клон на диске данных остаётся чистым (те же кэши уводит
`scripts/gates.sh`).

Снятие (venv + запись MCP; **кэш, `config.env` и браузер не трогаются**):

```bash
bash scripts/install.sh --uninstall            # спросит подтверждение
curl -fsSL …/scripts/install.sh | bash -s -- --uninstall --yes
# старый venv-в-клоне снимается явным указанием:
bash scripts/install.sh --uninstall --venv /путь/к/клону/.venv
```

## Платформенная матрица (честно)

| Возможность | Linux | macOS | Windows (MSYS/Git-Bash) | WSL2 |
|---|---|---|---|---|
| установка «в один клик» (curl/irm, без клона) | ✅ `curl … install.sh \| bash` | ✅ то же | ✅ `irm … install.ps1 \| iex` | ✅ как Linux |
| системные библиотеки через ПМ | ✅ apt/dnf/yum/pacman/zypper/apk | — (не нужны: браузер самодостаточен) | ❌ (вне bash) | ✅ как Linux |
| venv + пакет + `camoufox fetch` | ✅ | ✅ | ✅ (`venv/Scripts/…`) | ✅ |
| MCP в `opencode.json` + `config.env` | ✅ (через `install_mcp.py`) | ✅ | ❌ вручную (JSON ниже) | ✅ |
| bash-обёртка caps, cron (`install_cron.sh`) | ✅ | ✅ (cron есть) | ❌ | ✅ |
| systemd-таймеры (`install_timers.sh`) | ✅ | ❌ (systemd нет) | ❌ | ⚠️ нужен `systemd=true` в `/etc/wsl.conf` |

Windows: обвязка репо (`install_mcp.py` с путями `venv/bin`, обёртка caps,
cron, таймеры, стражи) — Unix-only; для полного пути используйте WSL2, для
нативного — впишите секцию в `opencode.json` руками:

```json
{ "mcp": { "camoufox": { "type": "local",
  "command": ["C:\\путь\\к\\venv\\Scripts\\camoufox-research.exe"], "enabled": true } } }
```

## Пути по умолчанию (код отдельно, окружение отдельно)

| что | путь | переопределение |
|---|---|---|
| репозиторий (код) | клон рядом со скриптом, иначе `~/camoufox-research` | `CAMOUFOX_REPO` / `--repo`; куда клонировать — `CAMOUFOX_REPO_DIR` / `--dir` |
| venv (окружение) | `~/.venvs/camoufox-research` | `CAMOUFOX_VENV` / `--venv` |
| кэш/состояние | `~/.cache/camoufox-research` (`config.env`, `cache.db`, отчёты) | `CAMOUFOX_CACHE_DIR` |
| браузер Camoufox | `~/.cache/camoufox` (macOS: `~/Library/Caches/camoufox`) | — (путь задаёт пакет `camoufox`) |
| байткод-кэш | `~/.cache/camoufox-research/gates/pycache` | `PYTHONPYCACHEPREFIX`, `CAMOUFOX_GATES_CACHE` |

`config.env` пишет **только** `install_mcp.py` (единый источник путей для
крон-скриптов). venv в клоне (`<repo>/.venv`) — не дефолт: он мешает переносить
клон и плодит второе окружение (гонки за `cache.db`); если он остался от старой
установки, снимите его явно: `--uninstall --venv <repo>/.venv`.

`install.sh` ставит **клон на диске** (`uv sync --frozen` / `pip install .`),
`scripts/update_mcp.sh` — наоборот, тянет `git-main`; это разные сценарии
(локальная ветка против обновления с гита).

## Проверка установки

```bash
bash -n scripts/install.sh && shellcheck -S warning scripts/install.sh
bash scripts/install.sh --version          # версия + все целевые пути
bash scripts/install.sh --dry-run          # план без изменений в системе
bash scripts/install.sh --dry-run --os macos
bash scripts/install.sh --dry-run --os windows
~/.venvs/camoufox-research/bin/python -c 'import camoufox_research'      # импорт
~/.venvs/camoufox-research/bin/python -m camoufox fetch                  # браузер
~/.venvs/camoufox-research/bin/python scripts/mcp_drive.py "$PWD" '[{"op":"tools"}]'
opencode2 mcp list                                                       # camoufox: connected
```

`mcp_drive.py` — та же проверка, что делает шаг 7 установки (живое рукопожатие
`initialize` + `tools/list`), без Node/npx в цепочке.

## Траблшутинг

- «нет python ≥ 3.10 и нет uv» → `--bootstrap-uv` (поставит uv с astral.sh) или python3.12+.
- Системный python 3.14 (вне проверенных 3.10–3.13) и uv нет → предупреждение:
  колёс запиненных зависимостей может не быть; поставьте uv (он возьмёт 3.13).
- Пакетный менеджер не распознан → поставьте библиотеки Firefox-стека сами и
  запустите с `--skip-deps`; нет sudo → то же самое или root.
- Браузер не скачался (`fetch` без сети) → установка падает с явным сообщением:
  без браузера research не работает, повторите при рабочей сети.
- MCP «не connected» после установки — переподключение (не убивать процессы руками):
  `opencode2 api post /api/mcp/camoufox/disconnect` → `.../connect`.
- Разные venv у клиентов = гонки за кэш: держите один (`config.env` — источник истины).
- One-liner 404 (`curl: (22) … 404`) → файла нет в ветке из URL; возьмите ветку с
  `scripts/install.sh` или запустите из клона.
- В `opencode.json` уже была секция `camoufox` со СТАРЫМ путём (`<клон>/.venv/bin/…`):
  чипсет не перезаписывает чужую секцию — установщик печатает
  `[WARN] MCP в конфиге → …, а этот venv ставит → …`; поправьте путь руками либо
  снесите старую установку (`--uninstall --venv <клон>/.venv`) и поставьте заново.
- В пайпе нет вопросов — это не «проглотил подтверждение», а осознанный дефолт
  (`--yes`): stdin занят самим скриптом.
- `uv sync` не пошёл (лок разошёлся, uv старый) → установщик сам падает на
  `pip install .`; принудительно — уберите `uv.lock` из клона или `--reinstall`.
- `--dry-run` для другой ОС использует раскладку путей этой ОС (`Scripts/` против
  `bin/`), поэтому в плане «venv создам» на чужой ОС — это нормально.

## Docker: та же установка одной командой (любая ОС, где есть Docker)

Образ `camoufox-research:dev` поднимает MCP-сервер целиком в контейнере: python,
venv, библиотеки Firefox-стека и сам браузер уже внутри. Хосту нужен только
рантайм контейнеров — ни venv, ни `fetch`, ни системных пакетов. Это и есть
ответ на «работает на любой ОС без вопросов» (Dockerfile есть у большинства
аналогов MCP-серверов). Цена — размер, и знать её лучше заранее:

| что | сколько |
|---|---|
| `docker images camoufox-research:dev` (занято на диске) | 2,89 ГБ |
| `docker image inspect --format '{{.Size}}'` (сжатые слои) | ≈908 МБ (908 193 834 Б на 21.09; дрейфует с кодом пакета) |
| из них браузер Camoufox (`/home/camoufox/.cache/camoufox`) | 1,3 ГБ распакованного (дистрибутив 663,5 МБ) |

### Сборка и проверка

```bash
cd camoufox-research
docker build -t camoufox-research:dev .      # холодная сборка 5,5-6 мин (≈1,5 мин — браузер, 11 МБ/с)
                                            # повторная (браузер в кэше слоёв) — 2 мин 15 с
docker images camoufox-research:dev          # 2.89GB — вот эти цифры в таблице выше
bash scripts/run_in_docker.sh --self-test    # рукопожатие MCP ВНУТРИ образа
```

`--self-test` — гейт, а не украшение: гоняет `initialize` + `tools/list` по stdin
и проверяет три вещи — версия протокола пришла, тулов ≥ 30, и в stdout НЕТ
не-JSON строки (одна посторонняя строка в stdout = сломанный клиент у агента).
Живой вывод (проверено 21.09):

```
== рукопожатие MCP в контейнере: docker run -i --rm -v camoufox-research-data:/data camoufox-research:dev ==
  сервер ответил: 2 строк JSON, protocolVersion=2025-11-25, тулов=34
  полное время прогона (docker run + 3 с удержания stdin): 4 с (rc=0)
  строк НЕ-JSON в stdout (должно быть 0): 0
РЕЗУЛЬТАТ: PASS — образ поднимает MCP и отдаёт 34 тулов (порог 30)
```

### Конфигурация клиента

`bash scripts/run_in_docker.sh` без флагов печатает готовые JSON (и объясняет
флаги). Для `opencode.json`:

```json
{"mcp":{"camoufox":{"type":"local","command":["docker","run","-i","--rm","-v","camoufox-research-data:/data","camoufox-research:dev"],"enabled":true}}}
```

**`-i` обязателен, `-t` запрещён.** MCP по умолчанию работает по stdio — stdin
и stdout это сам протокол: без `-i` сервер получит EOF и выйдет (клиент покажет
«server disconnected»), с `-t` в поток попадут CR и эхо, и JSON-RPC рассыпется.
`-d`/`--restart` тоже нельзя: сервер — дочерний процесс клиента и живёт столько,
сколько сессия агента.

### Данные и профиль тулов

- `/data` (VOLUME) — sqlite-кэш страниц/поиска, БД кампаний, память: переживает
  `--rm` (проверено: после прогона драйвера там `cache.db`, `tool_usage.json`).
  Named volume создаётся с владельцем uid 1000; для bind-mount (`--data /путь`)
  нужен `sudo chown 1000:1000 /путь` — контейнер работает НЕ от root.
- `~/.cache/camoufox-research` в образе — симлинк на `/data`: ядро кэша исторически
  берёт этот путь жёстко (`camoufox_cache._CACHE_DIR`), а `CAMOUFOX_CACHE_DIR`
  читают лишь часть модулей — так том гарантированно забирает всё.
- Браузер в том НЕ попадает: он часть образа (том хранит только данные).
- В образе `CAMOUFOX_CAPS=research,browser` (34 тула) — дефолт агента; полный
  реестр (62) — `--caps all` или `-e CAMOUFOX_CAPS=all`, группы `session,vision`
  остаются opt-in.

### http-транспорт (когда нужен порт, а не stdio)

```bash
bash scripts/run_in_docker.sh --http 8833 --run   # -p 8833:8833 + --transport http --host 0.0.0.0
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8833/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Проверено 21.09: `POST /mcp` → `200` + `event: message` с `serverInfo`
(`camoufox-research 0.19.0`); `GET /` → `404` (роут только `POST /mcp`, это не
«сервер не встал»).

### Почему у образа НЕТ HEALTHCHECK

Осознанно, а не забыто. У stdio-сервера нет порта и нет HTTP-ручки, а
единственный живой канал проверки — stdin/stdout, то есть поток, которым владеет
клиент: наш пинг украл бы у него строку ответа. `pgrep camoufox` тоже бессмыслен:
сервер и есть PID 1 контейнера, «жив процесс» ≡ «жив контейнер», и смерть сервера
Docker покажет как `Exited` (это и есть healthcheck клиента). Зелёный всегда
индикатор хуже, чем никакого. Для http-транспорта проверка возможна и дана выше.

### Границы (честно, что не проверено)

- Собрано и проверено на x86_64 (Linux, Docker 29.7.2). arm64 и podman не гонялись:
  `scripts/run_in_docker.sh --runtime podman` поддержан по API, но это не проверка.
- Windows: Docker Desktop (бэкенд WSL2) тянет этот linux/amd64-образ; нативный
  Windows-контейнер невозможен — для «Windows без WSL2» остаётся ветка MSYS выше.
- `--read-only` не подойдёт: браузер пишет в свой каталог в `$HOME` (Camoufox
  генерирует шрифты при первом запуске).
- Движок проверен загрузкой (`camoufox-bin --version` → XPCOM грузится, libxul
  без «not found»); живой прогон страницы в контейнере не делался — это отдельная
  задача про live-flow, а не про упаковку.
- Урок в Dockerfile: `libasound2` в образе обязателен, хотя `install.sh` держит
  его опциональным. Без него `camoufox-bin` падает с `XPCOMGlueLoad error:
  libasound.so.2: cannot open shared object file` — libxul.so линкуется с alsa
  жёстко. На хосте пакет доставит пользователь, в закрытом образе — нечем.
