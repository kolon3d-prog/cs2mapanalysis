# search — стек поиска и выкачки веба

Зачем секция: агенту нужен веб без капч и браузерных танцев — поиск, чтение страниц, краул, глубокий ресёрч.
Три провайдера дополняют друг друга:

- tavily — быстрый поиск и research: CLI `tvly`, 8 скиллов, MCP с 5 тулами.
- firecrawl — выкачка и работа с сайтами: scrape/crawl/map/monitor/браузерные сценарии, 28 скиллов, MCP.
- exa — семантический поиск и многошаговый research: remote MCP с 4 тулами (ключ или keyless-лимит).
- serper — чистый Google SERP и скрапинг: MCP с 2 тулами (google_search + scrape), 2 500 бесплатных запросов на старте.

Ключи берутся в кабинетах провайдеров; в бандле только плейсхолдеры.

## Провайдеры

| Провайдер | Источник скиллов | Установка скиллов | Ключ |
|---|---|---|---|
| firecrawl | github.com/firecrawl/skills | `npx -y skills add firecrawl/skills -s '*' -a opencode -g -y` | `FIRECRAWL_API_KEY` (firecrawl.dev) |
| tavily | github.com/tavily-ai/skills | `npx -y skills add tavily-ai/skills -s '*' -a opencode -g -y` | `TAVILY_API_KEY` (tavily.com) |
| exa | скиллов нет (только MCP) | сниппет remote MCP в `exa.md` | `x-api-key` (exa.ai), есть keyless-лимит |
| serper | скиллов нет (только MCP) | сниппет local MCP в `serper.md` | `SERPER_API_KEY` (serper.dev), 2 500 запросов free |

Детали, инвентарь скиллов и проверка — в `firecrawl.md`, `tavily.md` и `exa.md`.

## Общее про скиллы

- Канон: `~/.agents/skills`; opencode читает эту папку напрямую (проверено пробником).
- Замки установленного: `~/.agents/.skill-lock.json` (source, skillPath, хэши).
- Обновление: `npx -y skills update -g`; список: `npx -y skills ls`; удаление: `npx -y skills remove <skill>`.
- Скиллы ставятся на агента `opencode` (`-a opencode -g`). Если агентов несколько — перечислить через `--agent` или `'*'`.

## Как добавить провайдера

1. `npx -y skills add <owner/repo> -s '*' -a opencode -g -y` (или MCP/CLI по доке провайдера).
2. Новый файл `<провайдер>.md` по шаблону: Источник, Установка, Ключи, Что даёт, Скиллы, Проверка, Грабли.
3. Строка в таблицу выше.
