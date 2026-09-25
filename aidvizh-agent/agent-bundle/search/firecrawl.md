# firecrawl

Выкачка и разбор сайтов: scrape, crawl, map, search, monitor, браузерные сценарии, специализированные workflow-отчёты.

## Источник

- Скиллы: https://github.com/firecrawl/skills (в локе `~/.agents/.skill-lock.json` source `firecrawl/skills`)
- MCP-сервер: npm `firecrawl-mcp` (запуск `npx -y firecrawl-mcp`)
- CLI: npm `firecrawl-cli`, исходники https://github.com/firecrawl/cli, доки https://docs.firecrawl.dev/sdks/cli
- Правила скилла лежат рядом: `~/.agents/skills/firecrawl/rules/install.md`, `security.md`

## Установка

Скиллы (как у нас):

    npx -y skills add firecrawl/skills -s '*' -a opencode -g -y

CLI (опционально; сейчас на машине не стоит, скиллы умеют дёргать `npx firecrawl-cli`):

    npx -y firecrawl-cli@latest init -y --browser
    # или: npm install -g firecrawl-cli@latest

MCP в `~/.config/opencode/opencode.json` (рабочий у нас):

    "firecrawl": {
      "type": "local",
      "command": ["npx", "-y", "firecrawl-mcp"],
      "environment": { "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY" }
    }

## Ключи

- `FIRECRAWL_API_KEY` со страницы firecrawl.dev (формат `fc-...`), хранится в env MCP-сервера.
- Keyless free tier: `search`, `scrape`, `interact` работают без ключа с лимитами; `crawl`, `map`, `agent`, `monitor` требуют аккаунт.

## Что даёт (зачем нам)

- Чистый markdown из любой страницы, включая JS-рендер.
- Краул и карта сайта, мониторинг изменений, скачивание сайта офлайн.
- Браузерные сценарии (клики/логин/пагинация) там, где обычный HTTP не тянет.
- Готовые процессы: research-отчёты, SEO-аудит, QA, лид-списки, KB/RAG, разбор дизайна, парсинг локальных файлов, поиск по issues/докам и по паперам.

## Скиллы (28, стоят в ~/.agents/skills)

Базовые и выкачка:

- firecrawl — входная точка CLI-скилла: статус, авторизация, выбор команды.
- firecrawl-scrape — извлечь URL в чистый markdown.
- firecrawl-search — поиск с полным контентом страниц.
- firecrawl-map — список URL сайта без выкачки.
- firecrawl-crawl — массовая выкачка страниц раздела/сайта.
- firecrawl-download — сохранить сайт/раздел локально.
- firecrawl-parse — локальные файлы (PDF, DOCX, XLSX, HTML) в markdown.
- firecrawl-interact — живой браузер на странице: клики, формы, логин, пагинация.
- firecrawl-monitor — алерты об изменениях страниц (webhook/email).

Агентные и ресёрч:

- firecrawl-agent — автономный сбор данных со многих страниц в JSON по схеме.
- firecrawl-deep-research — цитируемый аналитический отчёт.
- firecrawl-research-index — поиск по научному индексу Firecrawl.
- firecrawl-research-papers — подборка и синтез научных статей.
- firecrawl-developer-index — issues/PR/README/доки: вопросы про библиотеки и ошибки.
- firecrawl-market-research — рыночные и финансовые метрики.
- firecrawl-competitive-intel — мониторинг цен/фич/ченджлогов конкурентов.
- firecrawl-lead-gen — структурированные лид-листы из каталогов.
- firecrawl-lead-research — брифинг перед встречей по человеку/компании.

Рабочие процессы и отчёты:

- firecrawl-workflows — общий раннер outcome-воркфлоу.
- firecrawl-seo-audit — SEO-аудит сайта.
- firecrawl-qa — QA-тест живого сайта (формы, ссылки, навигация).
- firecrawl-demo-walkthrough — разбор продуктовых флоу (онбординг, прайсинг, фичи).
- firecrawl-dashboard-reporting — метрики из веб-дашбордов.
- firecrawl-knowledge-base — сборка базы знаний/RAG из веба.
- firecrawl-knowledge-ingest — ингест публичных и закрытых док-порталов.
- firecrawl-company-directories — компании из директорий (YC, Crunchbase, Product Hunt, G2).
- firecrawl-shop — подбор товаров и сравнение цен.
- firecrawl-website-design-clone — вытащить дизайн-систему сайта в DESIGN.md.

## Проверка

- Скиллы: `npx -y skills ls | grep firecrawl` — 28 записей, Agents: OpenCode.
- MCP: в сессии доступны тулы `firecrawl_*` (scrape/search/crawl/map/extract/monitor/agent и т.д.).
- CLI (если поставили): `firecrawl --status`, затем `firecrawl scrape "https://firecrawl.dev" -o .firecrawl/install-check.md`.

## Грабли

- Ключ = аккаунт: `Unauthorized` или «кончились кредиты» — терминальная ошибка, ретраи не помогут; проверить `firecrawl --status`.
- MCP-сервер поднимается через `npx` при старте сессии — первый запуск качает пакет.
- CLI и MCP — независимые поверхности; у нас работает MCP, CLI не обязателен.
- Ключ не коммитить и не тащить в бандл.
