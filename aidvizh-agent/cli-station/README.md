# cli-station

Станция установки CLI: одна команда ставит нужные терминальные агенты — `omp`, `pi`, `opencode`
(в dev-канале это бинарь `opencode2`). Методы взяты у самих вендоров: станция не придумывает свою
установку, а выбирает подходящую под ОС и наличия в системе, показывает команду и после запуска
проверяет, что бинарь действительно появился и какую версию отдаёт.

## В один клик

    bin/cli-station.sh              # linux/macOS/git-bash: весь каталог
    bin/cli-station.cmd             # Windows: двойной щелчок
    pwsh -File bin/cli-station.ps1  # Windows: то же из терминала

## Команды

    cli-station                     поставить всё из каталога
    cli-station install [имена...]  выбранные CLI (--method ID, --channel dev|latest)
    cli-station status              что стоит: путь и версия
    cli-station doctor              инструменты и какие методы доступны
    cli-station list                что есть в каталоге

флаги: `--method <id>`, `--channel <имя>`, `--dry-run`, `--json`.

## Что и откуда ставится

| CLI | linux | macOS | Windows | источник |
|---|---|---|---|---|
| `omp` (oh-my-pi) | `npm i -g @oh-my-pi/pi-coding-agent@18.3.0`, bun с той же версией | то же | npm/bun с той же версией | [omp.sh](https://omp.sh) / [README oh-my-pi](https://github.com/can1357/oh-my-pi#install) |
| `pi` | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1`, bun с той же версией | то же | npm/bun (работает через Git Bash) | [pi.dev/docs](https://pi.dev/docs/latest) |
| `opencode` / `opencode2` | `npm i -g @opencode/cli@0.0.0-dev-20122` (или `@2.0.16`) | то же | npm с той же версией | [opencode.ai](https://opencode.ai) |

- **omp** ставится скриптом вендора (он сам разбирается с архитектурой и бинарём) либо через bun; каталог хранит оба пути.
- **pi** на Windows работает через Git Bash (проверяет `C:\Program Files\Git\bin\bash.exe`, потом `bash.exe` из PATH; путь переопределяется `shellPath` в `~/.pi/agent/settings.json`).
- **opencode2** — не отдельный продукт: в пакете `@opencode/cli` объявлены оба имени (`opencode` и `opencode2`, один и тот же файл), а dev-сборка даёт plugin API v2. Поэтому канал `dev` — выбор по умолчанию, `latest` — по флагу.
- Каждый метод объявляет свои зависимости (`requires`), и авто-выбор берёт первый доступный: нет `curl` — пойдёт `bun`, нет `npm` — скрипт вендора.

## Проверка

    bin/cli-station.sh status        # путь + версия каждого CLI, код 1 если чего-то нет
    bin/cli-station.sh doctor        # какие инструменты есть и что из этого следует
    bats tests/station.bats          # 21 тестов: каталог покрывает три ОС, выбор метода по requires, каналы, dry-run, префикс npm, PS-обёртка, win32-ветки движка

тесты оффлайновые: `npm`, `bun`, `curl` подменены заглушками, которые пишут вызванные аргументы в
лог, а PATH для движка сужен — реальные установки не запускаются. Win32-ветки проверяются там же
подменой платформы (`CLI_STATION_PLATFORM=win32`), PATH с разделителем `;`, своим `PATHEXT` и
подложенными `npm.cmd`/`pi.cmd`/`psi.ps1` — логика разбора путей и ветвлений, без живой Windows.

## На каких ОС проверено

| ОС | чем | статус |
|---|---|---|
| Linux | `bin/cli-station.sh` | проверено: 21 тестов, живой `status`/`doctor`/`--dry-run`, автопроверка диска |
| Windows | `bin/cli-station.ps1`, `bin/cli-station.cmd`, win32-ветки `bin/cli-station.mjs` | движок ищет команды сам: PATH по `;`, расширения из `PATHEXT` (регистр не важен), WSL/сторонние заглушки в `WindowsApps` пропускает, но Store-алиас `pwsh` допускается, `.cmd`/`.bat` запускает через `cmd.exe /c`, `.ps1` — через `pwsh`/`powershell.exe`; npm-префикс спрашивает у резолвнутого `npm.cmd`. Проверено тестами на Linux под `CLI_STATION_PLATFORM=win32` и PS-обёрткой под PowerShell 7 на Linux; **на настоящей Windows не запускалось** |
| macOS | `bin/cli-station.sh` | не проверялось (машины нет): в скриптах нет GNU-специфики, но это `[INFERENCE]` |

## Грабли

- **Каталог — источник правды про способы установки.** Вендоры меняют команды (omp уже переехал на `omp.sh`, pi — на `@earendil-works`), поэтому у каждого метода в каталоге лежит `home` и заметка, где он описан; при смене — править каталог, а не скрипт.
- **npm без root не пишет в свой глобальный префикс.** На Fedora пакетный npm держит его в `/usr/local` (`npm config get prefix`), и `npm install -g` падает с `EACCES`. Станция проверяет префикс до запуска и, если он недоступен на запись, ставит с `npm_config_prefix=~/.local` (бинарь ложится в `~/.local/bin`); `cli-station doctor` показывает состояние префикса.
- **Проверка после установки обязательна.** Скрипты вендоров иногда ставят бинарь в каталог вне PATH: станция честно говорит «установщик отработал, но в PATH не найден» и возвращает 1, а не делает вид, что всё хорошо.
- **Windows: файл в PATH — ещё не установленный CLI.** Движок разрешает команды нативно (PATH по `;`, `PATHEXT`, регистр не важен), каталоги `WindowsApps` пропускает — там алиасы-заглушки, в том числе WSL-баш, который печатает «поставь дистрибутив» и выходит с нулём. `.cmd`/`.bat` запускаются через `cmd.exe /c` (node не спавнит их напрямую), `.ps1` — через `pwsh`/`powershell.exe`. Если запуск не удался, `status --json` кладёт в `error` текст команды и код/`ENOENT`; пустого `error` при `version: null` не бывает.
- **`opencode2 service restart`** нужен после установки/обновления opencode, иначе сервис работает со старой сборкой.
- **`pi` и `omp` — разные проекты**: pi минимальный и без MCP, omp — форк pi с батарейками (MCP, расширения, гейты). Ставятся независимо, конфиги у них разные (`~/.pi/agent` и `~/.omp/agent`).

---

**AGGG [Distro] Firmware** · автор и владелец — **@hilartem** (Telegram), разработчик и CEO — AGGG-omp.
Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
Сделано для AGGG [Distro] Firmware. Запрещено распространять. Максимальная эффективность — в сообществе AGGG [Distro] Firmware и INSIDER AGGG (с чатом) или при личном общении: без знания системы и опыта это лишь референс. Полный текст — `NOTICE.md`.
