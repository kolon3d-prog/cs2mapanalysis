# memory-station

Центр памяти агента: одна память на omp, pi и opencode. Заметки — обычный **markdown** на диске,
индекс — SQLite, поиск — полнотекстовый + локальные эмбеддинги. Ни ключей, ни облака, ни докера.

    bin/memory-station.sh install     поставить и подключить (uv + basic-memory + MCP в клиенты;
                                      --bootstrap-uv — поставить uv с astral.sh, если его ещё нет)
    bin/memory-station.sh status      что лежит, сколько заметок, подключена ли память
    bin/memory-station.sh check       проверка связей (падает с кодом 1 и объясняет, чего нет)
    bin/memory-station.sh doctor      basic-memory doctor + те же проверки
    bin/memory-station.sh note "текст" --folder=code|life|projects --title="заголовок"
    bin/memory-station.sh search "запрос"

На Windows — `bin/memory-station.cmd` или `pwsh -File bin/memory-station.ps1`; движок один (`bin/memory.mjs`).

## Что где лежит

| что | где | чем подменить |
|---|---|---|
| заметки (источник правды) | `~/basic-memory/{code,life,projects}` | `BASIC_MEMORY_HOME` |
| индекс и конфиг | `~/.basic-memory` | `BASIC_MEMORY_CONFIG_DIR` |
| MCP-сервер | каталог `mcp-station` (`catalog/basic-memory.json`) | — |
| скилл-руководство | `skills/memory` → `~/.agents/skills/memory` | junction; без symlink-прав — копия с пометкой |

Заметки читаются руками, Obsidian видит папку как хранилище, git и бэкап работают как с текстом.
Связи между заметками — ссылки `[[такая-то заметка]]`; `build_context` ходит по ним как по графу.

## Почему basic-memory, а не «топ по звёздам»

Смотрели на звёзды, требования и то, реально ли это работает **без ключей и без сервера** — на этой машине
(15 ГБ ОЗУ, без ollama, ключи только OpenRouter/Firecrawl/Tavily/Serper/Exa).

| система | ★ | вес и зависимости | нужны ключи | автоматика | почему не взяли |
|---|---|---|---|---|---|
| `thedotmack/claude-mem` | 94 332 | SQLite + Chroma, Bun + uv | **да** (их хост, либо OpenRouter/Anthropic) | хуки 5 фаз — но у Claude Code и opencode; omp/pi не поддержаны | упирается в LLM-ключ, а на omp не работает |
| `volcengine/OpenViking` | 38 182 | python + embedding-модель + VLM | да (или локальный Ollama, которого нет) | хуки/плагин + MCP | каждый запрос памяти — облачный вызов |
| `getzep/graphiti` | 31 032 | нужен Neo4j/FalkorDB | LLM | MCP | граф ценой отдельной базы |
| `TencentCloud/TencentDB-Agent-Memory` | 27 036 | сервер + база | да | MCP | это командный хаб, а не личная память |
| `letta-ai/letta` | 24 809 | платформа-сервер | да | API | целый фреймворк агентов, не память |
| `vectorize-io/hindsight` | 24 061 | docker-сервер (или embedded) | LLM-провайдер | MCP | сервер + модель = тяжело |
| `mem0ai/mem0` | 65 711 | SaaS/SDK; self-host через docker | да | API | облако или докер |
| **`basicmachines-co/basic-memory`** | **4 009** | **uv-пакет, SQLite + fastembed локально** | **нет** | скилл + MCP | **взяли** |
| `tigerless-labs/agent-memory` | 959 | markdown | нет | MCP | по духу то же, но проект мелкий и свежий |

Отдельно есть публичный замер — Agent Memory Leaderboard (треки «Textual» и «Coding»), но он требует,
чтобы система отдавала наружу Add/Search-API, поэтому большинство локальных инструментов туда не попадает:
мериться звёздами и требованиями оказалось полезнее, чем смотреть таблицу чужих серверов.

**Граница, которую надо знать**: автоматической памяти «само собой» без модели не бывает — любая
авто-выжимка сессий это LLM-вызов. Здесь автоматика сделана иначе: скилл `memory` говорит агенту,
когда искать (в начале задачи) и когда писать (решение с причиной, состояние работы, личное),
а MCP-инструменты делают это одним вызовом. Платим — дисциплиной, а не ключами.

## Проверено на этой машине

- запись → индексация → поиск: заметка `проверка/Проверка памяти.md`, поиск нашёл её со score 1.21;
- заметка — обычный файл (`~/basic-memory/projects/Центр памяти.md`), правится руками;
- MCP виден всем трём клиентам (`mcp-station status` → `basic-memory` у omp/pi/opencode);
- станция отвечает: `check` «проверка пройдена», `doctor` — basic-memory doctor + связи.

## Грабли

- **`.bmignore` глушит сам индекс**: `*.db`, `*.db-shm`, `*.db-wal`, `*.db-journal` — иначе SQLite-журнал
  (в том числе `db/wiki.db-journal` подключённой вики) попадает в индексацию как заметка. Файл лежит
  в `~/.basic-memory/.bmignore`, синтаксис — gitignore;
- **Свежий конфиг лжёт**: в `config.json` проект `main` объявлен, но в базе его нет — `project add main`
  отвечает «уже существует», а записи падают с «no projects are set up». Станция это лечит: заводит
  проект `memory` и делает его дефолтным (нашлось тестами).
- Эмбеддинги (fastembed) качаются при первом семантическом поиске — первый запрос дольше обычного.
- Память **не** шифруется: если в заметках будут секреты — это твоя ответственность, для секретов есть vault.

---

**AGGG [Distro] Firmware** · автор и владелец — **@hilartem** (Telegram), разработчик и CEO — AGGG-omp.
Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
Сделано для AGGG [Distro] Firmware. Запрещено распространять. Максимальная эффективность — в сообществе AGGG [Distro] Firmware и INSIDER AGGG (с чатом) или при личном общении: без знания системы и опыта это лишь референс. Полный текст — `NOTICE.md`.
