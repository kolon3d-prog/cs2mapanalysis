# skills-hub

Хаб маркетов агентских скиллов: поиск, просмотр и установка из skills.sh, GitHub, ClawHub и
индекса SkillsMP, плюс MCP-сервер для клиентов без shell.

## Источник

Свой каталог на сменном диске. Путь не запоминаем и не хардкодим — он уже переезжал
(`DATA/11` → `DATA/AGGG`), и на новой машине будет другим. Вычисляется из живого симлинка скилла:

    HUB="$(readlink -f ~/.agents/skills/skills-ops)"

Если симлинка нет — спросить человека, где лежит каталог `skills-hub`: угадывать путь нельзя.

## Установка

Первый симлинк даёт команду в PATH, второй регистрирует скилл `skills-ops` для агента:

    HUB="$(readlink -f ~/.agents/skills/skills-ops)"    # или путь, названный человеком
    ln -sfn "$HUB/skills-manager.sh" ~/.local/bin/skills-manager
    ln -sfn "$HUB" ~/.agents/skills/skills-ops

MCP-регистрацию держать через симлинк скилла, а не абсолютным путём диска — иначе переезд папки
ломает MCP молча. Для opencode в `~/.config/opencode/opencode.json`, секция `mcp`:

    "skills-hub": {
      "type": "local",
      "command": ["bash", "-lc", "exec node \"$HOME/.agents/skills/skills-ops/mcp/server.mjs\""]
    }

Для omp в `~/.omp/agent/mcp.json`, секция `mcpServers`:

    "skills-hub": {
      "command": "bash",
      "args": ["-lc", "exec node \"$HOME/.agents/skills/skills-ops/mcp/server.mjs\""]
    }

## Гейты подтверждения

Скиллы исполняются с полными правами агента, поэтому установку закрываем подтверждением — иначе
агент ставит чужой код без спроса. Разные клиенты, разные ключи:

- opencode (`opencode.json`): `"skills-hub_skills_install": "ask"` в настройках тулов.
- omp (`~/.omp/agent/config.yml`): политика на имя тула в клиенте.

```
tools:
  approval:
    mcp__skills_hub_skills_install: prompt
```

В omp дефолт `tools.approvalMode` — `yolo` (авто-одобрение всего), так что без этой строки установка
по MCP пройдёт молча.

## Автопроверка

Юниты лежат в `$HUB/contrib` шаблонами (`*.in` с `@HUB@`), ставит их скрипт:

    "$HUB"/contrib/install-units.sh
    systemctl --user enable --now skills-hub-check.timer
    systemctl --user start skills-hub-check.service
    journalctl --user -u skills-hub-check -n 20

Что делает: `doctor` (зависимости, оба симлинка, пути MCP, `gh auth`), спеку коллекции скиллов и наборы
bats хаба и соседних станций (18 файлов, среди них `bats tests/hub.bats` — в нём же `shellcheck -S warning`
по всем скриптам хаба и проверка, что в скриптах не завелись абсолютные пути), плюс логику драйвера
режимов `modes-station` (node или bun, вне bats), а в конце — живую проверку
MCP одной строкой. Наборы `camoufox-research/tests/bats/*` в прогон не входят: они поднимают браузер, их
строки лежат в `command-center/check-coverage-exceptions.txt`. Диск отключён — юнит пропускается по
`ConditionPathExists` (успешный пропуск, не падение: `Result=success`, код 0). Работает без логина, если
у пользователя включён linger (`loginctl enable-linger $USER`). Если же диск на месте, а движка рядом нет (`skills-manager.sh` не найден) —
это сломанная установка, а не отсутствующий диск: прогон печатает «skills-hub не на месте: <путь>» и
падает с кодом 1 (тихого выхода 0 больше нет).

## Windows

На Windows CLI хаба — это те же bash-скрипты, поэтому нужен bash в PATH: **Git for Windows** (идёт с
Git) либо WSL. Установка одним скриптом:

    pwsh -File windows/install.ps1                                  # Hub = каталог скрипта
    pwsh -File windows/install.ps1 -Hub D:\AGGG\skills-hub -AgentHome $HOME

Скрипт создаёт `%USERPROFILE%\.agents\skills\skills-ops` (symlink, а без прав — junction), кладёт
`skills-manager.cmd` в `%USERPROFILE%\.local\bin`, дописывает MCP-регистрацию в оба конфига и ставит
гейт подтверждения. Повторный запуск ничего не дублирует, JSON правит `windows/set-mcp-entry.mjs`
(с копией `.bak`, без перезаписи, если значения уже на месте). MCP-команда та же, что на Linux:
`bash -lc 'exec node "$HOME/..."'` — под Git Bash работает без правок.

Нативная PowerShell-версия логики есть: `skills-manager.ps1` повторяет команды
(search/inspect/install/list/doctor/sources) на HTTP-API маркетов и через `npx skills`/`gh skill`;
единственная оставшаяся bash-зависимость — `--source clawhub`. Что работает на Windows нативно,
что требует Git Bash и что Unix-only — таблица «Что где работает» в README хаба.

## Проверка

    skills-manager doctor                       # должно закончиться "doctor: ok"
    skills-manager sources                      # четыре маркета
    skills-manager search pdf --limit 2         # поиск живой
    bats "$HUB/tests/hub.bats"                  # оффлайн-набор, 33 теста
    systemctl --user list-timers skills-hub-check.timer

## Грабли

- **Всё держится на симлинках в домашней папке.** Переименование каталога на диске (`11` → `AGGG`)
  убивает команду молча, а MCP-конфиги продолжают смотреть в старый путь. Признак: `skills-manager`
  не найден. Лечение: `readlink -f ~/.agents/skills/skills-ops` даёт живой корень, дальше симлинки
  пересоздать по установке выше, `doctor` подтверждает.
- **Path-юнит на `PathExists` зацикливается.** Проверено: `skills-hub-check.path` с
  `PathExists=.../skills-manager.sh` перезапускал сервис каждые три секунды, пока путь существует.
  В бандле только таймер (`OnCalendar=hourly` + `ConditionPathExists` в сервисе).
- **`bats` ставится отдельно** (`sudo dnf install bats`), в поставке его нет; без него автопроверка
  сообщит «набор пропущен» и вернёт 1.
- **`jq` может оказаться не jq.** В оболочке агента команда `jq` иногда подменена встроенной
  реализацией (`jaq`), а скрипты хаба вызывают системный `/usr/bin/jq` — поведение `scan`/regex
  у них разное. Правя адаптеры, проверяй набором, а не только интерактивной командой.
- **`npx` и `gh` на Windows — это обёртки.** В Git Bash короткие имена обычно находятся, но если Node
  и GitHub CLI поставлены только с `.cmd`/`.exe`, адаптеры ищут и их; когда нет ни одного — падают с
  «не найден npx…», а не с ENOENT.
- **Link на Windows без прав делается junction'ом.** Симлинк требует Developer Mode или админских
  прав; установщик сам откатывается на junction, для клиентов разницы нет.
