# skills-station

Станция скиллов: коллекция копий сторонних скиллов плюс раскладка по слоям. Кастомные скиллы не
копируются — они живут в своих проектах.

## Что где лежит

- `collection/` — копии скиллов из маркетов (92 штук), источник каждого в `collection/catalog.json`;
- слои: `global` → `~/.agents/skills`, `project` → `./.agents/skills`,
  `opencode` → `$XDG_CONFIG_HOME/opencode/skills` или `~/.config/opencode/skills`, `claude` → `~/.claude/skills`,
  плюс `--dir` для любого своего пути.

## Установка

    "$S"/bin/skills-station.sh install <имена|all> [--layer ...] [--dir ...] [--mode link|copy]
    "$S"/bin/skills-station.sh status [--layer ...]
    "$S"/bin/skills-station.sh remove <имена|all> [--layer ...]

Windows — `pwsh -File bin/skills-station.ps1 ...` или двойной щелчок `bin/skills-station.cmd`.
Ссылки на Windows делаются junction'ами (без прав администратора), копии — обычным копированием.

## Проверка

    bin/skills-station.sh verify     # у каждого скилла коллекции есть SKILL.md с name/description
    bin/skills-station.sh status     # что стоит в слое, что вне коллекции, сколько битых ссылок
    bats tests/station.bats          # 26 тестов, дом и коллекция подменяются

## Грабли

- Коллекция — снимок: обновил скилл через `../skills-hub`, скопируй его в `collection/`, иначе станция
  поставит старую версию.
- `--mode link` (по умолчанию) зависит от диска, `--mode copy` от него независим, но расходится с
  коллекцией при обновлении.
- Скиллы видны не всем клиентам одинаково: `omp`/`pi` читают `~/.agents/skills`, `opencode` — свой каталог.
