# Agent usage — как агенту работать с Camoufox Research

> Это руководство для **агента** (не для человека-разработчика): какие тулы
> видны в каком профиле, в каком порядке их звать, что считается ошибкой и
> чего не делать. Для установки/обслуживания — README и `docs/mcp-v2.md`;
> для граблей — `docs/landmines.md`.

## Что это

Camoufox Research — MCP-сервер веб-ресёрча на анти-детект Firefox (спека MCP
2026-07-28, SDK 2.1.1). Агенту даёт **реальный браузер**: поиск, чтение
JS/SPA, клики/формы, извлечение по схемам, мониторинг, обход сайтов, работа с
документами. Всё — через MCP-тулы; каждый тул сам объясняет себя в описании
по схеме **КОГДА / ЧТО / НЕ** (первая строка описания — когда звать).

## Профили: сколько тулов видит агент

62 тула в промпте = деградация выбора (индустрия: после ~40 качество выбора
падает). Поэтому профиль задаётся группы через запятую (`--caps` или
`CAMOUFOX_CAPS`), а не «всё сразу». Канон живёт в `camoufox_caps.py`
(`DEFAULT_PROFILE`, `DEFAULT_CAPS`), таблица ниже посчитана из `GROUPS`:

| Профиль (`CAMOUFOX_CAPS`) | Тулов | Что внутри |
|---|---|---|
| `research,browser` — **дефолт агента** | **34** | поиск и кампании (web_search, research_start, выжимки, цитаты) + чтение и добыча (fetch_page, extract, crawl, rss, документы) + ping/stats |
| `research,browser,session` | 60 | + живая вкладка: клики, формы, сеть, файлы, профили, `session_eval` |
| `research,browser,vision` | 36 | + `snapshot` (структура с ref) и `screenshot` (PNG) |
| `CAMOUFOX_CAPS=all` (или `*`) | 62 | всё; полный реестр — только ЯВНО (диагностика, тесты, гейты) |
| не задано | 34 | то же, что `research,browser`: сервер сам применяет `DEFAULT_CAPS` (аудит 21.09: раньше отдавал «всё», расходясь с этой таблицей) |

Правила профиля:

- **`ping`/`stats` есть всегда** (ALWAYS_ON): здоровье и аудит не прячутся.
- **Дефолт агента — `research,browser`**: его применяет САМ сервер, когда
  `CAMOUFOX_CAPS` не задан (`_apply_tool_filter` → `DEFAULT_CAPS`) — 34 тула.
  Установщики и запись MCP ставят шире: `research,browser,session,vision` — это
  все группы разом (62 тула: ресёрч, чтение страниц, живая вкладка, картинки),
  чтобы у агента не было «запись есть, а тулов нет» (см. `mcp-station/README.md`,
  `camoufox-research/README.md`). Профиль, заданный снаружи (`CAMOUFOX_CAPS` в
  конфиге клиента или в окружении), не перетирается. Свой профиль — в конфиге
  MCP-клиента (`env: {"CAMOUFOX_CAPS": "..."}`) или флагом `--caps`;
  полный реестр — только явный `all`.
- **`session` и `vision` — opt-in**: сессия живёт состоянием вкладки и стоит
  дороже по вызовам, `screenshot` жжёт токены картинкой. `session_eval` (JS в
  странице = максимум прав) лежит внутри `session` → в дефолт НЕ попадает.
- **Группа есть у каждого тула** — новый тул без группы роняет
  `tests/test_caps.py` (fail-fast: тул не должен молча исчезать при caps).
- **Порядок тулов заморожен** (сортировка по имени на старте) — стабильный
  префикс промпта и prompt-кэш.
- Не видишь нужный тул — он в opt-in группе: включи профиль, а не ищи обход.

## Рабочий цикл: поиск → чтение → сессия → выжимки → цитаты

Шаги 0–2, 4, 5 целиком живут в дефолтном профиле (34 тула); шаг 3 — opt-in.

**0. Роутер (дефолт).** `tool_hint(what="цены/таблицы/мониторинг…")` —
скажет, каким тулом и почему; `service_route(goal=...)` — сразу вызовет нужный.

**1. Поиск (дефолт).**
`web_search` — топ выдачи по запросу; `research(queries=[...])` — синхронная
многозапросная выжимка; `paper_search` — arXiv/Semantic Scholar (tier 0);
`research_start(topic, queries=[...], target_sources=10-20, domains_limit=2,
background=True)` — кампания «N РАЗНЫХ сайтов» в фоне.

**2. Чтение (дефолт).**
`fetch_page(url)` — одна страница текстом (кэш 24 ч, `delta=True` — повтор
почти бесплатен); `batch_fetch(urls=[...])` — 10–50 URL одним вызовом;
`extract(url, schema)` — поля по CSS/XPath; схема — СТРОКА JSON
(`'{"цена":"css:.price"}'`: MCP-схема объявляет `schema: str`, объект
отбивается валидацией «Input should be a valid string»); `llm=True` — из текста;
`table_extract` — таблицы в CSV; `map_site` → `sitemap` → `crawl` — карта и
обход сайта; `rss` — фиды; `read_document` — PDF/DOCX/XLSX; `page_diff` —
что изменилось с прошлого чтения.

**3. Сессия (opt-in: `--caps research,browser,session`; для картинок ещё
`vision`).** `session_start(url)` → `snapshot` (ref'ы) → `session_click(ref=…)`
/ `session_type` / `session_form_fill` / `session_scroll` / `session_text` →
`session_end`. Состояние живёт между командами; `session_tabs` — несколько
вкладок; `session_network`/`session_console` — AJAX и ошибки JS;
`session_download`/`session_upload` — файлы; `set_proxy` + `profile_save/load`
— прокси и логины. Все `session_*` требуют `session_start`: без сессии вызов
**падает** (в описании это первая строка, а не хвост абзаца).

**4. Выжимки (дефолт).** Кампания в фоне пишет маркер
`~/.cache/camoufox-research/exports/<camp_id>.json` — **жди файл, не полль**.
`research_status(id)` — счётчик сайтов; `research_report(id)` — список
источников; `research_digest(id)` — короткие выжимки + ✅/❌ живость.

**5. Цитаты (дефолт).** `citation_pack(id)` — ТОЛЬКО verified ✅, номера
`[1..N]` для отчёта; `citation_report(id)` — готовый MD-файл на диск.
FACT (доля живых цитат) пишется в маркер/лог, цель ≥ 90%.

## Контракт ошибок: ошибка = `isError=true`

- Сбой тула приезжает как MCP-ошибка (`isError=true`) с текстом причины —
  это **не ответ**, а отказ: не пересказывай текст ошибки как результат.
- Ошибка не подменяется «успешной строкой» ни у обычных тулов, ни в
  `tool_hint`/`service_route` (историю см. `camoufox_research_bridge.py`).
- Тулы с побочными эффектами (`session_*`, `research_start`, `research_resume`,
  `set_proxy`, `profile_save/load`) мост **не переигрывает** — повторный вызов
  сделает вторую вкладку/кампанию. Ошибку смотри и решай сам.

## Зависшая кампания: `research_cancel`

Если кампания `running`, но счётчик сайтов не растёт, а воркер мёртв
(spawn упал, SIGKILL), очередь заперта «законом одного инстанса»:
`research_status(id)` (покажет 0 источников) → `research_cancel(id)` —
помечает кампанию `failed` и снимает блокировку. Только после этого
`research_start` заводит новую.

## Границы выбора (коротко)

- `web_search` = топ; `research*` = глубокая охота на домены.
- `fetch_page` = 1 страница; `batch_fetch` = много; `crawl` = весь сайт.
- `extract` = поля по схеме; `table_extract` = таблицы; `snapshot` — ref'ы.
- `session_*` = интерактив (opt-in); `browser_*` = разовый «открыл-кликнул».
- `screenshot` — картинка (дорого по токенам: сначала `snapshot`/`fetch_page`).
- `stats` = счётчики этого запуска; `tool_usage` = персистентная метрика тулов.

## Ловушки (проверено вживую)

- **Кэш 24 ч**: повторный fetch мгновенный, но СТАРЫЙ → `delta=True`/`page_diff`.
- **Рети встроена**: пустой/короткий ответ (<200 симв.) → скролл+перезаход уже
  сделаны; стены логина/видео вернут честное «что есть».
- **Капча/rate limit**: батч идёт параллельно, но ≤2 запроса на домен.
- **Один воркер = один браузер**: параллельные кампании = гонки (EPIPE).
- **`profile_load` ПОСЛЕ `set_proxy`** (перезапуск браузера сбрасывает контексты).
- **`check_links` идёт последовательно** (`timeout` — на КАЖДУЮ ссылку, 15с;
  50 × 15с ≈ 12 мин) — бюджет вызова мост поднимает сам, таймаут MCP-клиента
  ставь ≥900с; `crawl` тоже длинный.
- **Старые .doc/.xls** → `libreoffice --convert-to docx/xlsx` (не читаются).

## Диагностика «сервер молчит»

```bash
python scripts/mcp_probe.py            # рукопожатие + сколько тулов + сторож
python scripts/mcp_probe.py --json     # машинно
```

Проверить, что профиль реально режет реестр (три случая — три числа):

```bash
DRIVE_ENV='{}' \
  ~/.venvs/camoufox-research/bin/python scripts/mcp_drive.py . '[{"op":"tools"}]'   # TOOLS n=34 (дефолт)
DRIVE_ENV='{"CAMOUFOX_CAPS":"research,browser,session"}' \
  ~/.venvs/camoufox-research/bin/python scripts/mcp_drive.py . '[{"op":"tools"}]'   # TOOLS n=60
DRIVE_ENV='{"CAMOUFOX_CAPS":"all"}' \
  ~/.venvs/camoufox-research/bin/python scripts/mcp_drive.py . '[{"op":"tools"}]'    # TOOLS n=62
```

`Unknown tool` = процесс не пересоздан после смены кода. Лечение:
переустановка (force-reinstall против pip-кэша) → reconnect (API, не kill).
Глубже — MCP Inspector (`npx @modelcontextprotocol/inspector`).

## Быстрые рецепты (копипаст)

```python
# Итог по теме одним вызовом (20+ доменов, JSON для синтеза):
research(queries=["тема"], target_domains=20, domains_limit=2, expand=True,
         terms_wave=True, quality_first=True, academic=True, as_json=True)
# Кампания → цитированный отчёт:
research_start(topic="тема", queries=["тема", "тема comparison"], background=True)
# (маркер) → research_report → batch_fetch → citation_pack → citation_report
# Мониторинг: fetch_page(url) → page_diff(url)
# Зависла: research_status(id) → research_cancel(id) → research_start(...)
```

## Куда дальше (если нужно больше)

- Грабля и фиксы: `docs/landmines.md`.
- Параметры/паттерны: README («Need a tool?», «Deep research mode»).
- Скиллы для агента: шаблон `docs/skills-template.md` (стандарт Agent Skills).

---

**AGGG [Distro] Firmware** · автор — **@hilartem** (Telegram). Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
