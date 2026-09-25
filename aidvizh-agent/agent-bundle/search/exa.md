# exa

Семантический веб-поиск, чтение страниц и многошаговый research через хостед MCP.

## Источник

- Канон по MCP: https://docs.exa.ai/reference/exa-mcp
- Хостед-сервер: `https://mcp.exa.ai/mcp`; локальная версия и исходники: https://github.com/exa-labs/exa-mcp-server (npm `exa-mcp-server`)
- Кабинет и ключи: https://dashboard.exa.ai/api-keys
- Статус: https://status.exa.ai

## Установка

Скиллов у exa нет — только MCP. Сниппет для `~/.config/opencode/opencode.json` (opencode использует `type: remote` и ключ `url`):

    "exa": {
      "type": "remote",
      "url": "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run",
      "headers": { "x-api-key": "YOUR_EXA_API_KEY" }
    }

Если клиент не умеет remote MCP — мост `mcp-remote`:

    "command": "npx",
    "args": ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"]

## Ключи

- API-ключ передаётся заголовком `x-api-key` (`YOUR_EXA_API_KEY` из кабинета exa.ai).
- Без ключа хостед работает keyless с урезанными лимитами (при исчерпании — 429); `agent_run` без ключа или OAuth недоступен.
- Есть OAuth-вход для клиентов с MCP OAuth: `https://mcp.exa.ai/mcp?login`.

## Что даёт (зачем нам)

- `web_search_exa` — поиск с чистым контентом (включён по умолчанию).
- `web_fetch_exa` — чтение страниц в markdown (включён по умолчанию).
- `web_search_advanced_exa` — фильтры: категории, домены, даты, highlights, subpage crawl (opt-in).
- `agent_run` — многошаговый research, списки, обогащение, `outputSchema`, продолжение по `runId` (нужен ключ или OAuth).

## Скиллы

Не ставили: exa подключён только как MCP. В доке есть портативные agent skills — отдельная установка, если понадобится.

## Проверка

- `initialize` + `tools/list` по URL → 4 тула: `web_search_exa`, `web_fetch_exa`, `web_search_advanced_exa`, `agent_run`.
- В сессии opencode видны тулы `exa.*`; живой вызов `web_search_exa` возвращает результаты.

## Грабли

- Параметр `tools=` заменяет дефолтный набор целиком: перечислять всё нужное, включая search и fetch.
- `agent_run` и `web_search_advanced_exa` по умолчанию не включены.
- 429 или зависший поиск без результата — лимит free-плана исчерпан: подставить ключ в `x-api-key`.
- Некоторым клиентам нужен полный рестарт, чтобы увидеть новые тулы.
