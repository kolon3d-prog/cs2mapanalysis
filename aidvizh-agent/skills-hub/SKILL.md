---
name: skills-ops
description: Поиск, просмотр и установка скиллов из маркетов (skills.sh, GitHub/gh skill, ClawHub, индекс SkillsMP) через skills-manager. Использовать, когда нужно найти новый скилл, прочитать чужой SKILL.md перед установкой или поставить скилл в ~/.agents/skills.
---

# skills-ops

Единственный вход — команда `skills-manager` в PATH. Если команды нет — симлинк не установлен: спросить человека, где лежит каталог `skills-hub`, и пересоздать симлинк по README проекта. Пути хоста не угадывать. Когда команда есть, но что-то не отвечает — `skills-manager doctor`: он проверяет зависимости, оба симлинка, пути в MCP-конфигах и `gh auth`.

В клиентах с MCP те же четыре операции видны тулами (`skills_search`, `skills_inspect`, `skills_list`, `skills_install`) — это тот же роутер, не отдельный путь.

Рядом с ними два тула про УСТАНОВЛЕННОЕ, а не про маркеты: `skills_find(query, limit?)` — поиск по имени, описанию и телу скиллов во всех слоях (`./.agents/skills`, `~/.agents/skills`, opencode, claude) и по коллекции станции скиллов; `skills_show(name)` — описание, первые строки тела и путь. Ни сети, ни БД: список скиллов в контексте сессии фиксируется на старте, поэтому скилл, поставленный или поправленный посреди сессии, виден только так. Движок тот же, что у `skills-station find`/`show` в терминале.

Внутри проекта роутер `skills-manager.sh` + автономные адаптеры `markets/<source>.sh`, каждый можно дёргать напрямую.

## Команды

    skills-manager search <query> [--source NAME|all] [--limit N] [--owner O] [--json]
    skills-manager inspect <pkg> [--source NAME|auto] [--full]
    skills-manager install <pkg> [--source NAME|auto] [--project]
    skills-manager list [--source NAME]
    skills-manager doctor
    skills-manager sources

Маркеты:
- `skills-sh` (по умолчанию) — skills.sh, `<pkg>` = `owner/repo@skill`;
- `github` — GitHub через `gh skill`, `<pkg>` = `owner/repo@skill`;
- `clawhub` — ClawHub, `<pkg>` = slug (`puppeteer`, `@owner/slug`, `skills-sh:owner/repo/skill`);
- `skillsmp` — только поиск (индекс), `<pkg>` = `owner/repo@skill`, ставить через `--source auto` или явный `--source skills-sh|github`.

`--source auto` снимает выбор источника: форма пакета решает — `owner/repo@skill` сначала в skills-sh, при неудаче в github; слаг без слэша — в clawhub. Работает только с `inspect` и `install`: у `search` и `list` на входе запрос, а не пакет.
`list` без флагов показывает глобальные скиллы (`~/.agents/skills`) — туда же ставит `install`; таймаут npx-адаптеров 180с (`SKILLS_TIMEOUT`), HTTP-запросов к индексам — 30с (`SKILLS_HTTP_TIMEOUT`).
`search --source all` схлопывает одинаковые скиллы из разных маркетов в одну строку; `skillsmp` вдобавок пересортирован по совпадению слов запроса с именем, репозиторием и описанием и не повторяет один ref.
Правки в хабе проверяются набором `bats tests/hub.bats` (оффлайновый, подменяет curl/npx/gh): после любой правки адаптеров или роутера гоняй его, а не только ручные вызовы. Тот же набор плюс `doctor` крутится сам раз в час через `skills-hub-check.timer`; посмотреть, что он видел — `journalctl --user -u skills-hub-check -n 30`.
На Windows команда живёт в Git Bash (нужен bash в PATH) и ставится скриптом `windows/install.ps1`; MCP-регистрация там та же (`bash -lc 'exec node "$HOME/..."'`). Если npx/gh не находятся, адаптеры ищут их Windows-обёртки (`npx.cmd`, `gh.exe`).
Пути в скриптах не хардкодим: всё считается от `$BASH_SOURCE`/`$PSScriptRoot`, юниты systemd лежат шаблонами `@HUB@`. Это проверяется набором — два теста ловят shellcheck-замечания и абсолютные пути, так что хардкод не проскочит молча.

## Правила

- Поиск по умолчанию — узкий: `search <query>` (skills-sh). Широкий `--source all` — только когда по основному маркету пусто/слабо или нужно сравнить популярность между маркетами; он медленнее и шумнее: github ловит rate-limit, clawhub без установок почти мусор, skillsmp — индекс без установки.
- `github` ищет через code search API: квота 10 запросов/мин на аккаунт, `gh skill search` тратит 3 запроса на вызов (варианты формулировки). не гоняй github дважды в минуту; при «GitHub API rate limit exceeded» подожди ~минуту, токен тут ни при чём.
- Перед установкой чужого скилла сначала `inspect` (по умолчанию выжимка: meta + зависимости/права; `--full` весь текст).
- Установка только после подтверждения человеком: скиллы исполняются с полными правами агента.
- Ставить строго через `skills-manager install` (внутри официальные CLI маркетов + контроль lock-файлов). Свои curl-обвязки поверх маркетов не писать.
- По умолчанию установка глобальная в `~/.agents/skills`; `--project` — в `./.agents/skills`.
- Если адаптер упал (реестр недоступен) — сказать человеку, не выдумывать результаты. Не поддерживаются: agentskill.sh и skild (лежат), LobeHub (логин), agent-skills-cli (TUI), ctx7 (deprecated), Tencent (`curl | bash`).
- Удаление: skills-sh — `npx skills remove <skill> -g -y`; clawhub — `npx clawhub uninstall <slug> --workdir ~ --yes`; github — снести папку.

## Грабли (проверено на поиске opencode-плагинов, 2026-09-20)

- Скиллы про версионируемые API пишут «production-quality», а учат формам прошлых версий: три топовых скилла по плагинам opencode учили двум мёртвым формам, живой оказалась ни одна из их примеров. Перед установкой — `inspect --full` и спайк на своей версии инструмента; если примеры не запускаются у тебя, скилл мёртв, сколько бы установок у него ни было.
- `npx skills` отдаёт битые имена: поиск вернул `different-ai/openwork@opencode-primitives`, а реально скилл называется `@create-plugin`; при failed fetch смотреть список доступных скиллов прямо в ответе ошибки.
- Фильтровать выдачу до инспекции: агрегаторы-склады (звёзды репозитория — это звёзды склада, не скилла), clawhub с нулём установок, skillsmp — индекс без установки и с шумом. Популярность ≠ актуальность.
- Если под задачу уже есть свой проверенный скилл (например `opencode-plugin-dev`), маркетные аналоги по этой теме не ставить: свой писан под текущую версию и с граблями, чужие — под чужую сборку.
- Хаб живёт на сменном диске, и всё внешнее держится на симлинках: переименование папки диска (`11` → `AGGG`) убивает команду молча — `skills-manager` просто пропадает из PATH, а MCP-конфиги продолжают смотреть в старый путь. Лечится так: `readlink -f ~/.agents/skills/skills-ops` даёт живой корень, `ln -sfn "$ROOT/skills-manager.sh" ~/.local/bin/skills-manager` возвращает команду, `skills-manager doctor` показывает, что ещё смотрит мимо (в MCP-конфигах путь держать через `$HOME/.agents/skills/skills-ops`, а не напрямую на диск).
