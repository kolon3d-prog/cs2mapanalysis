# Клиенты: omp, pi, opencode2

| клиент | конфиг | заметка |
|---|---|---|
| omp (oh-my-pi) | `~/.omp/agent/` | `$PI_CODING_AGENT_DIR` переопределяет каталог; MCP — `mcp.json`, расширения — `extensions/*.ts` |
| pi | `~/.pi/agent/` | тот же `PI_CODING_AGENT_DIR`; MCP работает только с расширением `pi-mcp-adapter` |
| opencode / opencode2 | `~/.config/opencode/` | `$XDG_CONFIG_HOME` переопределяет; MCP — `opencode.json` → `mcp`, плагины — `plugins/`, команды — `commands/` |

`opencode` и `opencode2` — один и тот же файл: в пакете `@opencode/cli` объявлены оба имени, dev-сборка даёт
`opencode2` и plugin API v2. Ставится и обновляется через `cli-station`.

Что где включается: `mcp-station` пишет MCP-регистрации, `prompt-station` — персону и расширение смены
на ходу, `sysprompt` — команду `/prompt`, `skills-station`/`skills-hub` — скиллы, `spec-station` — скилл
спек-режима и команды `/spec*`, `pi-plugins-station` — сторонние плагины pi (ставит их сам `pi`),
`modes-station` — режимы `/goal` и `/loop` плагином в opencode2,
`omp-zen-free` —
расширение для omp/pi, снимающее `403` бесплатного тарифа OpenCode Go/Zen вне клиента OpenCode, и
команду `/keys` в omp (мультиключи: list/add/check/disable/enable/remove; ключ клиент берёт сам —
`/login` или `/keys add` в omp, `~/.pi/agent/auth.json` у pi). Ключи и логины —
на стороне клиентов (см. 05-mcp).

После установки/правок конфигов: opencode — `opencode2 service restart`, omp/pi — новый сеанс
(расширения читаются на старте; у pi есть `/reload` для расширений).
