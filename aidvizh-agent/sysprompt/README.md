# sysprompt

Команда `/prompt` — вброс текста в системный контекст текущей сессии. Контракт фичи в SPEC.md,
каждый харнес реализует его своим адаптером.

## Структура

    install.sh             диспетчер установки: auto | opencode-dev | omp
    install.ps1            то же на PowerShell (любая ОС с pwsh: Linux/macOS/Windows):
                           ссылки родными средствами ОС, бэкапы чужих конфигов, проверка результата
    SPEC.md                контракт: интерфейс, маркер, семантика буфера
    opencode/
      dev/                 opencode dev-сборки (plugin API v2)
        plugin/sysprompt.ts
        command/prompt.md
      skill/SKILL.md       runbook для агента: диагностика и обслуживание
    omp/
      dev/extension/sysprompt.ts   oh-my-pi: ExtensionAPI + before_provider_request
    pi/
      dev/extension/sysprompt.ts   pi: тот же ExtensionAPI, событие то же (before_provider_request)

## Установка

    ./install.sh              # авто: определит сборку по версии opencode2
    ./install.sh opencode-dev # явно
    ./install.sh omp          # oh-my-pi (уважает PI_CODING_AGENT_DIR, если задан)
    ./install.sh pi           # pi (тот же PI_CODING_AGENT_DIR, свой каталог ~/.pi/agent)
    ./install.sh all          # все три клиента

Ставит симлинки:

- `~/.config/opencode/plugins/sysprompt.ts` -> `opencode/dev/plugin/sysprompt.ts`
- `~/.config/opencode/commands/prompt.md` -> `opencode/dev/command/prompt.md`
- `~/.agents/skills/sysprompt` -> `opencode/skill`
- `~/.config/opencode/skills/sysprompt` -> `~/.agents/skills/sysprompt`
- `~/.omp/agent/extensions/sysprompt.ts` -> `omp/dev/extension/sysprompt.ts`
- `~/.pi/agent/extensions/sysprompt.ts` -> `pi/dev/extension/sysprompt.ts`

После установки: `opencode2 service restart` (opencode) или перезапуск omp.

## Windows

`install.sh` на Windows не работает как надо: в Git Bash `ln -s` по умолчанию создаёт **копии**, а не ссылки — правки в проекте перестают доходить до клиента. Поэтому скрипт сам отказывается в MSYS/Cygwin и отправляет в PowerShell-установщик (обойти можно, но осознанно: `SYSPROMPT_ALLOW_MSYS=1`):

    pwsh -File install.ps1
    pwsh -File install.ps1 omp -AgentHome $env:USERPROFILE  # первый позиционный аргумент — Target
    pwsh -File install.ps1 -Target omp -AgentHome $env:USERPROFILE

что он делает: файлы (плагин, команда, расширение) линкует симлинком, а без прав — жёсткой ссылкой, а если и это не вышло (разные диски) — копирует и честно предупреждает, что правки не подхватятся; каталог скилла — симлинком или junction'ом. Чужой файл на месте ссылки **не удаляется**, а откладывается рядом как `<имя>.bak-<штамп>`. В конце установщик **проверяет результат** (каждый адрес должен указывать на файл проекта — иначе код возврата 1), повторный запуск ничего не меняет, `-WhatIf` показывает план и не трогает диск. Путь к конфигу opencode по умолчанию `$XDG_CONFIG_HOME/opencode` или `%USERPROFILE%\.config\opencode`, к агенту omp — `$env:PI_CODING_AGENT_DIR` или `%USERPROFILE%\.omp\agent`. Тот же скрипт работает и на Linux/macOS-pwsh: ссылки делаются родными средствами ОС.

## Тесты

    sudo dnf install bats        # федора; на других системах пакет bats-core
    bats tests/install.bats

тринадцать тестов: bash-установщик ставит симлинки в plugins/commands/skills/extensions, на MSYS отказывается и уходит в PowerShell, `SYSPROMPT_ALLOW_MSYS=1` ставит копиями; PowerShell-установщик ставит связи в omp/pi/opencode, идемпотентен, уважает `-Target` и `-WhatIf`; отдельный тест гоняет pi-расширение под bun с заглушкой ExtensionAPI и проверяет, что текст попадает в системный канал. HOME/XDG подменяются на временные — реальные конфиги не трогаются.

Сторож дрейфа близнецов: `omp/dev/extension/sysprompt.ts` и `pi/dev/extension/sysprompt.ts` — один и тот же файл с разной первой строкой (импорт типа `ExtensionAPI`: пакеты клиентов разные). Тест сравнивает файлы без строк импорта и падает с diff'ом, если они разъехались больше, чем на эти строки.

## Использование

- `/prompt <текст>` — добавить. Текст уезжает в system-роль на каждом запросе, пока жив буфер сессии.
- `/prompt clear` (алиас `--clear`) — сбросить буфер сессии.
- `/prompt` без текста — подсказка по формату.

Отличия адаптеров:

- **opencode dev**: команда раскрывается маркером `<sysprompt>...</sysprompt>`, адаптер режет обёртку;
  текст остаётся в истории как твоё сообщение. Буфер — в памяти серверного процесса.
- **pi**: та же механика, что у omp (общий `ExtensionAPI`, событие `before_provider_request`); буфер в памяти процесса, ключ — session id, инжект отдельным system-сообщением. Проверено на pi 0.86.1: `pi --mode rpc` отдаёт команду `prompt` из нашего расширения.
- **omp**: буфер в памяти процесса omp, ключ — session id; инжект идёт отдельным system-сообщением
  (обёртка `<system-reminder>`) на событии `before_provider_request`, история не засоряется — только
  уведомление. Расширения читаются на старте сессии, хот-релоада нет.

Проверено на opencode 0.0.0-dev-19545 и omp, модель opencode-go/deepseek-v4.1-flash.

---

**AGGG [Distro] Firmware** · автор и владелец — **@hilartem** (Telegram), разработчик и CEO — AGGG-omp.
Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
Сделано для AGGG [Distro] Firmware. Запрещено распространять. Максимальная эффективность — в сообществе AGGG [Distro] Firmware и INSIDER AGGG (с чатом) или при личном общении: без знания системы и опыта это лишь референс. Полный текст — `NOTICE.md`.
