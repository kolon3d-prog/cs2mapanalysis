# mcp-station

Станция поставки MCP: каталог серверов и одна команда, которая ставит их в клиентов — omp/pi и opencode.
Нужна, чтобы после переезда диска или на новой машине не собирать `mcp.json` и `opencode.json` руками:
каталог — источник правды, у каждого клиента свой формат, но описание сервера одно.

## Источник

Свой каталог рядом с хабом. Путь не запоминаем — он вычисляется от самого скрипта:

    STATION="$(dirname "$(readlink -f ~/.agents/skills/skills-ops)")/../mcp-station"

## Установка (linux/macOS/git-bash)

    "$STATION"/bin/mcp-station.sh              # весь каталог в оба клиента
    "$STATION"/bin/mcp-station.sh list
    "$STATION"/bin/mcp-station.sh status

## Установка (Windows)

Git Bash не нужен: движок — node, обёртка — PowerShell.

    pwsh -File bin/mcp-station.ps1             # то же, что и на linux
    double-click bin/mcp-station.cmd           # «в один клик»

Записи при этом нативные: у каждой stdio-записи каталога есть `argvWindows` — та же команда без bash
(исключения — три Unix-only отладочные записи: `bpftrace`, `lldb`, `radare2`).
`$HOME` и `$STATION` раскрывает станция на момент установки; серверы с ключами идут через
`bin/entryenv.mjs` (читает файл ключей целиком и запускает то, что после `--` — эквивалент
`set -a; . file`), `npx`-серверы — через `cmd.exe /c npx …` (node не спавнит `.cmd`-шим напрямую),
`camoufox` получает профиль из `envWindows`. Запись без `argvWindows` ставится только при настоящем
Git Bash (абсолютный путь к `bash.exe`), а заглушка WSL не считается башем нигде — ни в `check`,
ни в `verify`: вместо мусора заглушки `verify` говорит `spawn-failed` с причиной. Пустой файл ключей
станция создаёт при установке, старые `.bak` конфигов держит по пять рядом, остальные уносит в
`~/.local/state/mcp-station/dump/`. Ветка Windows прогоняется на Linux: `MCP_STATION_PLATFORM=win32`.

## Отладочные рантаймы

Пять записей каталога требуют локальных рантаймов (`frida-mcp`, `wireshark-mcp`, `mitmproxy-mcp`,
`bpftrace`, `lldb`) — собирает их один скрипт, системные пакеты он не ставит, а называет:

    "$STATION"/bin/debug-setup.sh     # venv'ы (uv), bpftrace-mcp-server (cargo), мост lldb в ~/.local/bin

`gdb` — это `npx -y mcp-gdb`: сборки нет, нужны только `gdb` в PATH и node. `radare2` (r2mcp) — отдельно:
upstream radare2 6.x из git (`sys/install.sh`, потом `r2pm -Uci r2mcp`), в Fedora его нет. Пока рантайма
нет, клиент получает строку «… не собран: запусти mcp-station/bin/debug-setup.sh», а не молчание.
Разбор — что проверено живьём, чем и какие кандидаты не проверены — в `$STATION/docs/DEBUG-RE-GAPS.md`.

## pi

У самого pi (pi.dev) MCP нет: серверы читает расширение `pi-mcp-adapter` из `<agent dir>/mcp.json`
(по умолчанию `~/.pi/agent/mcp.json`).

    npm install -g --ignore-scripts @earendil-works/pi-coding-agent
    pi install npm:pi-mcp-adapter
    bin/mcp-station.sh install --client pi

формат записей для pi — как у omp (stdlib `command`+`args`, http `url`+`headers` без `type`). Заголовки
с ключом на Unix идут через подстановку `!set -a; . "$HOME/.../env"; set +a; printf …` (в конфиге ключей
нет); на Windows `!`-подстановка не работает — там omp и pi получают литерал из файла ключей, а
`{env:VAR}` включается переменными `MCP_STATION_OMP_HEADERS=env` и `MCP_STATION_PI_HEADERS=env`.

## Секреты

Ключи лежат в одном файле `~/.config/opencode/secrets/env` (права 600), значения не печатаются:
`bin/keys.sh list|add|remove` (на Windows — `bin/keys.ps1`, двойной щелчок по `bin/keys.cmd`).
Ключей на провайдера может быть сколько угодно: `VAR`, `VAR_2`, `VAR_3`… — добавлять можно потом.

Для omp подстановка идёт внутрь записи сервера (`bash -lc` со чтением файла ключей), так что в конфиге
ключа нет. opencode для http-серверов по умолчанию получает значение из того же файла при установке
(`--opencode-headers env` переключает на `{env:VAR}`, но тогда процесс opencode должен сам видеть
переменные — сейчас не видит). Пока ключа в файле нет, установка не падает: opencode получает заглушку
`{env:VAR}` с сохранением формата (`Bearer {env:VAR}`), а уже стоящие записи не перетираются — после
`bin/keys.sh import` повтори `bin/mcp-station.sh install`, и значения подставятся из файла.

Пул ключей с переключением при отказе — `--pool`: http-сервер ставится не напрямую, а через шим
`$HOME/.local/bin/mcp-keypool`, который перебирает ключи на 401/403/429/5xx и запоминает рабочий.

## Проверка

    bin/mcp-station.sh check      # файлы серверов, файл ключей, нужные переменные
    bin/mcp-station.sh status     # что стоит в клиентах против каталога
    bats tests/station.bats       # 68 тестов, изолированный HOME

автопроверка диска (`../skills-hub/contrib/skills-hub-check.sh` и её systemd-таймер) гоняет этот набор
вместе с хаба и sysprompt — отдельный таймер не нужен.

## Грабли

- **opencode хранит ключи в конфиге.** Так сложилось до станции; по умолчанию она это повторяет, чтобы
  ничего не сломать. Чистый вариант (`{env:VAR}`) требует, чтобы переменные были в окружении процесса
  opencode.
- **Секрет должен быть ровно один раз** — в `secrets/env`. Если ключ появится и в каталоге, и в конфиге,
  `status` расхождений не покажет, а клиенты начнут расходиться в поведении.
