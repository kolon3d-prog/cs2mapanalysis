# Скиллы

Два инструмента и одно хранилище:

- `skills-hub` — поиск и установка из четырёх маркетов (skills.sh, GitHub, ClawHub, индекс SkillsMP) плюс MCP-сервер;
- `skills-station` — коллекция **копий** сторонних скиллов (`collection/`, источник каждого в `catalog.json`)
  и раскладка по слоям: `global` (`~/.agents/skills`), `project` (`./.agents/skills`),
  `opencode` (`~/.config/opencode/skills`), `claude` (`~/.claude/skills`) или `--dir`;
- свои скиллы (`skills-ops` из `../skills-hub`, `sysprompt`, `fedora-windows-look`, `memory`, `wiki`)
  в коллекцию не копируются: они живут в своих проектах на диске и подключаются симлинками, а личные
  (`data-vault-ops`, `design-refs`) лежат прямо в `~/.agents/skills`.

Исключение — два своих скилла, которым коллекция даёт место рядом с остальными: `camoufox-research-*`
(ссылка на `.md` в своём репозитории) и `spec-mode` из `spec-station` (ссылка на каталог `skill/` целиком).
Оба записаны в `catalog.json` с источником `своё: …`, `verify` видит их наравне с чужими.

Третий инструмент рядом — `spec-station`: сам **спек-режим** (скилл `spec-mode` плюс слэш-команды `/spec*`).
Скилл ставится по слоям тем же способом, а команды идут в `commands/` каждого клиента — этого ни
`skills-hub`, ни `skills-station` не делают, поэтому у режима своя станция. Подробности —
`../spec-station/README.md`.

Типичные действия:

    skills-manager search pdf --limit 5           # найти
    skills-manager inspect <pkg> --full           # прочитать перед установкой
    skills-manager install <pkg>                  # поставить глобально
    skills-station install mcp-builder --layer project --mode link
    skills-station status                          # что стоит в слое и что вне коллекции

`--mode link` (по умолчанию) отдаёт всегда свежую версию, но зависит от диска; `--mode copy` независим,
но расходится с коллекцией при обновлении. Коллекция — снимок: обновил скилл через хаб — скопируй в
`collection/`.

## Скиллы памяти и вики

Кроме коллекции маркетов, у своих станций есть рукописи-правила: `memory` (когда искать и когда писать
в память) и `wiki` (как принять пост в библиотеку, где искать знание, как обновлять индекс и журнал).
Плюс из маркетов стоят `karpathy-llm-wiki` и `llm-wiki` — схема Karpathy LLM Wiki + OKF, по которой
собран `Wiki VibeCoding`.
