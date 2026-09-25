# cli-station

Станция установки CLI: ставит терминальные агенты `omp`, `pi` и `opencode` (в dev-канале — бинарь
`opencode2`) одной командой на linux, macOS и Windows. Методы берутся у вендоров, станция только
выбирает подходящий под ОС и наличие инструментов, показывает команду и проверяет результат.

## Источник

Свой каталог на том же сменном диске. Путь не запоминаем — считается от скрипта:

    CLI="$(dirname "$(readlink -f ~/.agents/skills/skills-ops)")/../cli-station"

## Установка

    "$CLI"/bin/cli-station.sh              # linux/macOS/git-bash: весь каталог
    "$CLI"/bin/cli-station.sh status       # что стоит: путь и версия
    "$CLI"/bin/cli-station.sh doctor       # инструменты и доступные методы

Windows — без Git Bash, обёртка на PowerShell:

    pwsh -File bin/cli-station.ps1
    double-click bin/cli-station.cmd

## Что ставится

| CLI | способы | примечание |
|---|---|---|
| `omp` | скрипт `omp.sh` (sh / `install.ps1`), bun, brew, mise | офтоп-скрипт вендора сам выбирает бинарь под архитектуру |
| `pi` | npm (`@earendil-works/pi-coding-agent`), `pi.dev/install.sh`, bun | на Windows работает через Git Bash |
| `opencode` / `opencode2` | npm `@opencode/cli@dev` или `@latest`, релизный скрипт | `opencode2` и `opencode` — один файл; dev даёт plugin API v2 |

авто-выбор идёт по `requires` каждого метода: нет `curl` — возьмёт `bun`, нет `npm` — скрипт вендора.

## Проверка

    bin/cli-station.sh status      # путь + версия, код 1 если чего-то нет
    bin/cli-station.sh doctor      # какие инструменты есть и что отсюда следует
    bats tests/station.bats        # 21 тестов, оффлайновые (npm/bun/curl подменены заглушками)

автопроверка диска (`../skills-hub/contrib/skills-hub-check.sh` и её systemd-таймер) гоняет этот набор
вместе с остальными — отдельный таймер не нужен.

## Грабли

- **После установки проверяем, а не верим.** Если установщик положил бинарь вне PATH, станция скажет
  об этом и вернёт 1 — молчаливого «успеха» не бывает.
- **npm без root не пишет в глобальный префикс.** На Fedora он `/usr/local` (`npm config get prefix`),
  и `npm install -g` падает с `EACCES`. Станция проверяет префикс и, если он недоступен на запись,
  ставит с `npm_config_prefix=~/.local` (бинарь в `~/.local/bin`); `doctor` показывает состояние префикса.
- **`opencode2 service restart`** после обновления opencode: сервис держит старую сборку в памяти.
- **`pi` и `omp` ставятся независимо** и не делят конфиги (`~/.pi/agent` против `~/.omp/agent`):
  обновил один — второй остался каким был.
- **Каталог меняется вместе с вендорами.** Команды установки переезжают (`omp.sh`, `@earendil-works`),
  поэтому у каждого метода в каталоге есть ссылка на источник — при смене правится каталог, а не код.
