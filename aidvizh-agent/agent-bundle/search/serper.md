# serper — Google SERP и скрапинг через API

## Источник

- Сервис: https://serper.dev (аккаунт, ключ в кабинете).
- MCP-сервер: npm `serper-search-scrape-mcp-server` (github.com/marcopesani/mcp-server-serper, MIT).
- Тулы: `google_search` (органика, People Also Ask, related, knowledge graph; фильтры gl/hl/location/num/tbs/page/autocorrect) и `scrape` (текст + опционально markdown, JSON-LD, head-метаданные).

## Установка

Локальный MCP в `~/.config/opencode/opencode.json`, секция `mcp.servers`:

```json
"serper": {
  "type": "local",
  "command": ["npx", "-y", "serper-search-scrape-mcp-server"],
  "environment": {
    "SERPER_API_KEY": "YOUR_SERPER_API_KEY"
  }
}
```

## Ключи

`SERPER_API_KEY` — из кабинета serper.dev. В бандле только плейсхолдер; реальный ключ живёт в локальном конфиге opencode (права 600) или env.

## Что даёт

- Обычный Google SERP в JSON: органика, PAA, related searches, knowledge graph.
- Временные фильтры через `tbs`: `qdr:h` час, `qdr:d` день, `qdr:w` неделя, `qdr:m` месяц, `qdr:y` год.
- `scrape` — вытащить страницу текстом или markdown без отдельного скрапер-провайдера.
- 2 500 бесплатных запросов на старте, без карты; дальше платно (~$50 за 50k у Serper Pro, точные цены — в кабинете).

## Скиллы

Скиллов нет. Только MCP.

## Проверка

```bash
SERPER_API_KEY=YOUR_SERPER_API_KEY npx -y serper-search-scrape-mcp-server
```

В opencode проверить вызовом тула `serper.google_search` (q, gl, hl обязательны).

## Грабли

- `gl` и `hl` в схеме помечены обязательными — без них вызов падает.
- Каждый вызов жжёт кредиты: `google_search` и `scrape` тратят по одному запросу, аккуратно с циклами и ретраями.
- `deep_research` у соседних serper-пакетов требует отдельного LLM-ключа; этот сервер обходится двумя тулами и без LLM.
