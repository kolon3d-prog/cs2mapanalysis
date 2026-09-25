# harness

Секция про сам харнесс агента: как навыки, MCP-серверы и проверки ставятся так, чтобы пережить
переезд диска и новую машину. В отличие от `search`/`Design`, здесь только свои инструменты.

## Что входит

| провайдер | что это | файл |
|---|---|---|
| skills-hub | хаб маркетов скиллов (4 маркета + MCP) и его автопроверка | [skills-hub.md](skills-hub.md) |
| sysprompt | команда `/prompt` — вброс текста в системную роль (плагин opencode + расширение omp) | [sysprompt.md](sysprompt.md) |
| mcp-station | каталог MCP-серверов и одна команда, ставящая их в omp/pi и opencode | [mcp-station.md](mcp-station.md) |
| cli-station | установка самих CLI (omp, pi, opencode/opencode2) на linux, macOS и Windows | [cli-station.md](cli-station.md) |
| prompt-station | прошивка системного промта (персоны) в omp/pi/opencode | [prompt-station.md](prompt-station.md) |
| skills-station | коллекция сторонних скиллов и раскладка их по слоям (global/project/свой путь) | [skills-station.md](skills-station.md) |
| spec-station | спек-режим Kiro: скилл `spec-mode` и команды `/spec*` — требования, дизайн, задачи | [spec-station.md](spec-station.md) |
| pi-plugins-station | сторонние плагины pi: каталог npm-пакетов, ставятся самим `pi` | [pi-plugins-station.md](pi-plugins-station.md) |
| command-center | центр координации: состояние всех проектов, проверка связей, план установки с нуля | [command-center.md](command-center.md) |

## Зачем отдельная секция

`search` и `Design` разворачиваются командами из чужих репозиториев. Здесь наоборот: свои скрипты
на сменном диске, у которых ломается не установка, а *связка* — симлинки в `~/.local/bin`,
`~/.agents/skills` и пути MCP-регистраций в двух клиентах. Такие поломки тихие: команда просто
исчезает из PATH, а MCP-сервер не поднимается. Поэтому в этой секции к каждому провайдеру идёт
не только установка, но и способ проверки.

## Порядок развёртывания

1. Подключить диск и убедиться, что каталог хаба на месте (`readlink -f ~/.agents/skills/skills-ops`).
2. Симлинки и MCP-регистрации — из [skills-hub.md](skills-hub.md), установка своих плагинов — из [sysprompt.md](sysprompt.md).
3. Коллекция скиллов — [skills-station.md](skills-station.md), спек-режим поверх неё — [spec-station.md](spec-station.md).
4. Плагины pi — [pi-plugins-station.md](pi-plugins-station.md) (ставит их сам `pi`, станция только ведёт каталог).
5. Гейты подтверждения на установку скиллов — там же (иначе агент ставит чужой код без спроса).
6. Автопроверка через systemd-юниты — там же; после неё `systemctl --user list-timers skills-hub-check.timer`.
7. Проверка: `skills-manager doctor` должен закончиться `doctor: ok`.
