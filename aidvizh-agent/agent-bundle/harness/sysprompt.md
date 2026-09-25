# sysprompt

Команда `/prompt` — вброс текста в системную роль текущей сессии. Один проект, два адаптера:
плагин opencode (`opencode/dev`) и расширение omp (`omp/dev`). Контракт фичи — в `SPEC.md`.

## Клиенты

`/prompt` реализован тремя адаптерами: opencode (плагин + команда-маркер), omp и pi (расширения с
общим `ExtensionAPI` и событием `before_provider_request`). Ставится в каждый свой каталог:

    "$P"/install.sh opencode-dev     # ~/.config/opencode
    "$P"/install.sh omp              # ~/.omp/agent/extensions
    "$P"/install.sh pi               # ~/.pi/agent/extensions
    "$P"/install.sh all

## Источник

Каталог проекта на том же сменном диске, что и хаб. Путь не запоминаем: он вычисляется из живого
симлинка скилла, который ставит установщик:

    readlink -f ~/.agents/skills/sysprompt      # -> <проект>/opencode/skill

Симлинка нет — спросить человека, не угадывать путь.

## Установка (linux/macOS)

    ./install.sh                 # авто: определит dev-сборку opencode
    ./install.sh opencode-dev    # явно
    ./install.sh omp             # только расширение omp

ставятся симлинки в `~/.config/opencode/plugins`, `~/.config/opencode/commands`,
`~/.agents/skills/sysprompt`, `~/.config/opencode/skills/sysprompt` и `~/.omp/agent/extensions`.
Потом: `opencode2 service restart` для opencode, перезапуск сессии для omp (расширения читаются на старте).

## Установка (Windows)

`install.sh` в Git Bash не годится: там `ln -s` по умолчанию создаёт копии, и правки в проекте
перестают доходить до клиента — скрипт сам отказывается в MSYS/Cygwin. Ставит PowerShell:

    pwsh -File install.ps1
    pwsh -File install.ps1 -Target omp -AgentHome $env:USERPROFILE

файлы линкуются симлинком, без прав — жёсткой ссылкой, при разных дисках — копией с предупреждением;
каталог скилла — симлинком или junction'ом; чужой файл на месте ссылки не удаляется, а откладывается
как `<имя>.bak-<штамп>`; в конце установщик проверяет, что каждый адрес указывает на файл проекта.
Идемпотентно, `-WhatIf` показывает план. Тот же скрипт работает и на Linux/macOS-pwsh.
Пути по умолчанию: конфиг opencode — `$XDG_CONFIG_HOME/opencode` или `%USERPROFILE%\.config\opencode`,
агент omp — `$env:PI_CODING_AGENT_DIR` или `%USERPROFILE%\.omp\agent` (переопределяются `-ConfigDir`, `-AgentHome`).

## Проверка

    bats tests/install.bats        # 13 тестов: симлинки по трём клиентам, MSYS-отказ, PowerShell-установщик, -WhatIf, инжект pi-расширения под bun, сторож дрейфа близнецов omp/pi
    readlink -f ~/.omp/agent/extensions/sysprompt.ts
    readlink -f ~/.config/opencode/plugins/sysprompt.ts

после установки в клиенте: `/prompt тестовый маркер`, затем обычное сообщение — текст должен уехать
в системную роль; `/prompt clear` чистит буфер. Как убедиться, что он реально в системной роли
(а не в истории) — в скилле `sysprompt`, раздел про зонд.

## Грабли

- **Git Bash и симлинки.** `ln -s` в MSYS по умолчанию делает копии; поэтому на Windows только
  PowerShell-установщик, а `install.sh` там падает с объяснением. Обход для тех, кому копии ок:
  `SYSPROMPT_ALLOW_MSYS=1 ./install.sh omp`.
- **Буфер живёт в памяти процесса.** `/prompt clear` и рестарт его чистят, но текст, уже осевший
  в истории диалога, остаётся — для полного сброса нужна новая сессия.
- **Расширения omp читаются на старте сессии**, hot-reload нет: после правок — рестарт, а не надежда.
- Наборы тестов этого проекта гоняются автопроверкой хаба (`../skills-hub/contrib/skills-hub-check.sh`)
  вместе с его собственными — отдельный таймер не нужен.
