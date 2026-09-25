# wiki-station

Центр вики: одна или несколько библиотек знаний в схеме **Karpathy LLM Wiki + OKF-frontmatter**
(как `Wiki VibeCoding`), с поиском, каталогом, журналом и доступом для агента — и через CLI, и через MCP.

    bin/wiki-station.sh list                     что за вики, сколько постов, собрана ли база
    bin/wiki-station.sh open <вика> [страница]   показать пост, index или log
    bin/wiki-station.sh search "запрос"          поиск: база FTS5, фолбэк — grep
    bin/wiki-station.sh build [вика]             пересобрать базу поиска (db/wiki.db)
    bin/wiki-station.sh index [вика]             пересобрать каталог index.md из frontmatter
                                                 (не изменился — файл и log.md не трогаются)
    bin/wiki-station.sh log [вика] [N]           хвост журнала
    bin/wiki-station.sh lint [вика]              обязательные поля, теги, расхождения строк index.md с постами
    bin/wiki-station.sh new "Wiki Название"      новая вика (index.md, log.md, _templates/post.md)
    bin/wiki-station.sh add <папка>              подключить существующую вику
    bin/wiki-station.sh install                  скилл + база + MCP-проект в basic-memory
    bin/wiki-station.sh status | check | doctor

На Windows — `bin/wiki-station.cmd` или `pwsh -File bin/wiki-station.ps1`; движок один (`bin/wiki.mjs`).
Каталоги скилла ставятся junction-ом; если symlink/junction запрещён, станция честно переходит на копию.

## Реестр вики

Библиотека лежит внутри станции (`wiki/<название>`), реестр `wikis.json` — какие папки считаются вики и под каким именем видно их в MCP:

```json
{ "wikis": [ { "name": "Wiki VibeCoding", "path": "Wiki VibeCoding", "project": "wiki-vibecoding", "created": "2026-09-20" } ] }
```

Вики расширяется двумя способами: `new` заводит новую папку **внутри станции** (`wiki-station/wiki/<имя>`,
переопределяется `--path=`), `add` подключает уже существующую. Ограничений на число вики нет — `list` и `search` работают по всем сразу.

## Что такое вика (конвенции, которые станция проверяет)

- посты — `<тема>/<slug>.md`, обязательный frontmatter: `type`, `title`, `description`, `date`, `tags`;
- теги — нижний регистр, без пробелов, первый тег — категория (`ai`, `coding`, `tools`, …);
- `index.md` — таблица `| Пост | Тема | Теги | Дата | Папка |` (Тема = description);
- `log.md` — append-only строки `- YYYY-MM-DD HH:MM — действие — файл — что сделано`;
- `_templates/post.md` — шаблон поста;
- `db-tools/build.py` + `db-tools/search.py` — поисковая база (SQLite + FTS5), контракт из README вики.

## Два доступа: человеку и агенту

| кому | чем | что даёт |
|---|---|---|
| человеку | `wiki-station open/search/log` | читать и искать из терминала, без клиентов и MCP |
| человеку | `python3 db-tools/search.py -r <вики> "запрос"` | поиск по базе с тегами и сниппетами |
| агенту | **MCP-инструменты вики** (эта станция) | `wiki_find` — поиск + тела постов одним вызовом; `wiki_stats`, `wiki_search`, `wiki_read`, `wiki_index`, `wiki_add_post`, `wiki_build`, `wiki_log`, `wiki_lint`, `wiki_list` |
| агенту | MCP `basic-memory` (`search_notes`, `read_note`, `write_note`, `build_context`) | вика подключена как проект `wiki-...`, семантический поиск и запись из любого клиента |
| агенту | скилл `wiki` | правила: где искать, как добавить пост, как не наплодить дублей |

`install` собирает базу и заводит MCP-проект для каждой вики — после этого `search_notes(..., project="wiki-...")`
работает в omp, pi и opencode.

## MCP-сервер: один вопрос — один вызов

`mcp/server.mjs` — stdio-сервер без зависимостей (`initialize` → `tools/list` → `tools/call`).
Он рассчитан на то, что типовой вопрос «что у меня есть про X» закрывается **одним** вызовом,
а не цепочкой «поиск → чтение → ещё поиск»:

- **`wiki_find`** — главный инструмент: поиск и топ-N постов **с телом** (по умолчанию 1200 символов),
  описанием, тегами и сниппетом. Пачку формулировок можно отдать сразу (`queries: [...]`) — всё ещё один вызов.
- **`wiki_stats`** — вся картина библиотеки: список вики (дефолтная помечена), посты по темам, топ тегов,
  покрытие `index.md`, возраст базы. Дефолт — первая вика в реестре, поэтому в ответе всегда видно, где искали.
- **`wiki_search`** — машинный ответ ровно в контракте `search.py --json` (`mode`, `wiki`, `root`, `queries`,
  `count`, `index`, `results`, `suggestions`, `notes`).
- **`wiki_index`** — пересобрать `index.md` из frontmatter (то же, что `wiki-station index`, но из агента).
- **`wiki_read`** — полный текст поста; при промахе показывает ближайшие похожие названия.
- **`wiki_add_post`** — пост по конвенциям, с проверкой тегов и `type`, предупреждением о **дубле по заголовку**
  и пересборкой базы. **`wiki_build`**, **`wiki_log`**, **`wiki_lint`**, **`wiki_list`** — обслуживание.

Договорённости, которые сервер соблюдает:

- **пустой результат — это ответ, не ошибка**: `count: 0` плюс `suggestions` и `notes` (что близко и где искали);
- **ошибка** — `isError: true`, одна человеческая строка и что делать дальше, без сырого stdout движка;
- **каждый ответ несёт контекст**: `wiki` (имя), `root`, `mode` (`db` или `files`), `posts`, `index_age`, `stale`;
- **свежесть**: если база старше самого нового поста, сервер пересобирает её сам один раз; не вышло —
  честно отвечает `stale: true` и ищет по файлам;
- разбор frontmatter в сервере понимает блоки `>`/`|`/`>-`, многострочные кавычечные описания, свёрнутые
  plain-скаляры (так basic-memory переписывает `description:`/`title:` на несколько строк), инлайн-и списки
  строк и не портит верхние поля вложенными блоками (`generated:`). Разбор один и тот же у CLI, MCP и `db-tools`.

Проверить руками (JSON-RPC построчно в stdin):

    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wiki_find","arguments":{"query":"vpn клиент"}}}' \
      | node mcp/server.mjs

## Проверено на этой машине

- `Wiki VibeCoding`: **324 поста** в темах ai/coding/design/privacy/tools, индекс 324 записи, база собрана ✓;
- поиск по базе находит по описанию и тегам, не только по телу поста ✓;
- свёрнутый скаляр basic-memory читается целиком: у `design/ui-reference-matrix.md` описание в `index.md`
  совпадает с постом (раньше обрывалось на «…Stripe») — и в CLI, и в MCP ✓;
- `wiki_find` с запросом `сеть tunnel vpn клиент` за ОДИН вызов возвращает `tools/clash-plus.md` в топе вместе с телом поста;
- пустой запрос — `count: 0` и подсказки, без `isError` ✓;
- `lint` сверяет строки `index.md` с frontmatter постов (описание, теги, дата) и называет расхождение
  строкой «index.md разошёлся с постом по «description»»; после пересборки каталога — `lint чистый` ✓.

## Грабли

- `db/` (база) и `index.md` — производные от постов: в архив не кладутся. Потерял `db/wiki.db` —
  `wiki-station build`; потерял `index.md` — `wiki-station index`. Источник правды — только посты,
  из них восстанавливается всё остальное;
- `index` пересобирает каталог **целиком** из frontmatter: ручные правки строк в `index.md` пропадут,
  порядок станет по дате (свежие сверху). Ведущий frontmatter `index.md` при этом сохраняется (и в CLI,
  и в `wiki_index` MCP), многострочные описания не обрываются, «|» в описании экранируется. Каталог
  не изменился — файл и `log.md` не трогаются вовсе (`index.md уже актуален: N записей`): строка
  в журнале значит «пересобрано», а не «команду позвали», и повторный прогон не плодит дубли;
- `lint` — гейт каталога: сверяет строки `index.md` с frontmatter постов по описанию, тегам и дате
  и падает замечанием «index.md разошёлся с постом по «<поле>»» — лечится `wiki-station index`;
- теги сравниваются строго: `AI` и `ai` — разные, `machine learning` и `machine-learning` тоже.

---

**AGGG [Distro] Firmware** · автор и владелец — **@hilartem** (Telegram), разработчик и CEO — AGGG-omp.
Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
Сделано для AGGG [Distro] Firmware. Запрещено распространять. Максимальная эффективность — в сообществе AGGG [Distro] Firmware и INSIDER AGGG (с чатом) или при личном общении: без знания системы и опыта это лишь референс. Полный текст — `NOTICE.md`.
