# tavily

Быстрый веб-поиск, чистый экстракт страниц и цитируемый research.

## Источник

- Скиллы: https://github.com/tavily-ai/skills (в локе source `tavily-ai/skills`)
- Установочный SKILL.md от Tavily: https://tavily.com/agent-setup/SKILL.md
- CLI: PyPI-пакет `tavily-cli`, установщик https://cli.tavily.com/install.sh (предпочитает uv → pipx → pip)
- MCP-сервер: npm `tavily-mcp`

## Установка

CLI (у нас через uv, бинарь `~/.local/bin/tvly`):

    curl -fsSL https://cli.tavily.com/install.sh | bash
    tvly login --api-key YOUR_TAVILY_API_KEY

Скиллы:

    npx -y skills add tavily-ai/skills -s '*' -a opencode -g -y

MCP в `~/.config/opencode/opencode.json` (рабочий у нас):

    "tavily": {
      "type": "local",
      "command": ["npx", "-y", "tavily-mcp"],
      "environment": { "TAVILY_API_KEY": "YOUR_TAVILY_API_KEY" }
    }

## Ключи

- `TAVILY_API_KEY` (`tvly-...`) из кабинета tavily.com; хранится в `~/.tavily/config.json` (chmod 600) и в env MCP-сервера.
- Search и Extract работают keyless с лимитами; Map, Crawl, Research требуют ключ.
- Браузерный OAuth (`tvly login` без флагов) на headless-сервере может не пройти — при готовом ключе использовать `--api-key`.

## Что даёт (зачем нам)

- `tvly search` — быстрый поиск с LLM-оптимизированными сниппетами.
- `tvly extract` — чистый markdown из известных URL.
- `tvly map` / `tvly crawl` — структура сайта и массовая выкачка.
- `tvly research` — многоисточниковый отчёт с цитатами (30–120 сек).
- Всё доступно и как CLI для агента, и как MCP-тулы.

## Скиллы (8, стоят в ~/.agents/skills)

- tavily-cli — входная точка: установка, авторизация, обновление, выбор команды.
- tavily-search — поиск в вебе.
- tavily-extract — контент конкретных URL в markdown/text.
- tavily-map — список URL сайта.
- tavily-crawl — выкачка многих страниц раздела.
- tavily-research — research с цитатами.
- tavily-dynamic-search — программный поиск с изоляцией контекста (крупные результаты фильтруются до входа в контекст).
- tavily-best-practices — как встраивать Tavily в код приложения (SDK/REST).

## Проверка

- `tvly auth --json` → `authenticated: true`.
- `tvly search "test" --json` → непустой `results`.
- MCP: тулы `tavily_search`, `tavily_extract`, `tavily_crawl`, `tavily_map`, `tavily_research`.
- Скиллы: `npx -y skills ls | grep tavily` — 8 записей, Agents: OpenCode.

## Грабли

- Node 18 ломает браузерный login (внутри вызывается `npx mcp-remote`) — нужен Node 20+.
- Установщик CLI при первом запуске может звать интерактивный `init`, если есть дисплей; в headless просто поставить и залогиниться `--api-key`.
- Ключ не коммитить и не тащить в бандл.
