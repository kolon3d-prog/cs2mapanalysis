---
name: camoufox-research-automation
description: >-
  Живая браузерная сессия MCP-сервера camoufox-research: залогиниться, заполнить и
  отправить форму, кликнуть, проскроллить ленивую ленту, собрать XHR, скачать файл,
  посмотреть сеть и ошибки JS. Нужно состояние МЕЖДУ шагами в одной вкладке
  (куки, скролл, ввод, история) — чего fetch_page не даёт. Триггеры RU:
  залогинься, заполни форму, отправь форму, нажми кнопку,
  проскролль, ленивая загрузка, бесконечная лента, браузерная автоматизация, сессия,
  как человек в одной вкладке, что ушло в сеть, страница пустая, ошибки в консоли,
  скачай файл, адаптив. Триггеры EN: login flow, sign in, form fill, submit, click,
  scroll, lazy load, infinite scroll, browser session automation, XHR,
  download, session_start,
  session_click, session_eval, CAMOUFOX_CAPS. Не про чтение текстом (fetch_page)
  и корпус. Пропал session_start из списка тулов — это профиль, не переустановка:
  CAMOUFOX_CAPS=research,browser,session.
metadata:
  opencode/autoinvoke: true
---

# camoufox-research — живая сессия

Один вызов — один шаг, а состояние (вкладка, куки, скролл, ввод, история) живёт МЕЖДУ вызовами. Ровно этим сессия отличается от `fetch_page`, который открывает страницу заново: «как человек в одной вкладке» — здесь. Проверено живьём 21.09.2026: логин формой и вход в `/secure` той же вкладкой, куки доехали.

## Главное правило: session-тулов нет в дефолтном профиле

Дефолт — 34 тула (`research,browser`), а живая вкладка это 26 тулов группы `session`. Не видишь `session_start` или `session_form_fill` в списке тулов — профиль не тот:

- в конфиге MCP-клиента: `env` у сервера `CAMOUFOX_CAPS=research,browser,session` → 60 тулов; добавить `vision` (`snapshot`/`screenshot`) → `all`, 62;
- в своих прогонах через драйвер: `DRIVE_ENV='{"CAMOUFOX_CAPS":"research,browser,session"}'`;
- проверка, что профиль действительно применился: шаг `{"op":"tools"}` в плане драйвера печатает `TOOLS n=60`.

Почему так: 62 тула в промпте ухудшают выбор, поэтому сервер сам отдаёт урезанный дефолт, а всё, что требует живой вкладки, — явный opt-in. `session_eval` (исполнение JS в странице) лежит внутри `session` — в дефолт не попадает никогда.

## Жизненный цикл

`session_start(url)` → действия → `session_end()`. Любой другой `session_*` требует живой вкладки: без неё вызов падает ошибкой, а не возвращает пустоту. `session_status` не требует ничего — это дешёвая проверка «куда унесло вкладку и жива ли она».

`session_end` закрывает вкладку: воркер и браузер одни на сервер, поэтому «оставлю на потом» = держу браузер занятым. Нужен тот же логин в следующий раз — сначала `profile_save(name)`, потом `session_end`, а в начале следующей работы `profile_load(name)`.

## Тулы: имена, аргументы, когда

| Тул | Аргументы | Зачем |
|---|---|---|
| `session_start(url="", max_chars=6000)` | пусто = пустая вкладка | открыть и получить текст |
| `session_navigate(url, max_chars)` | только АБСОЛЮТНЫЙ URL | переход в той же вкладке, состояние цело |
| `session_click(selector="", target_text="", ref="", max_chars)` | один из трёх | клик; `ref` берётся из `snapshot` |
| `session_type(selector, text, max_chars)` | одно поле | ввод текста |
| `session_form_fill(fields, submit="", max_chars)` | `fields` — JSON-СТРОКА | много полей за раз, `submit` отправляет |
| `session_select_option(selector, value, max_chars)` | значение, метка или индекс | `<select>` |
| `session_key_press(key, max_chars)` | Playwright-имя: `Enter`, `Escape`, `Tab`, `ArrowDown` | отправить без ввода, закрыть попап |
| `session_scroll(direction="bottom", max_chars)` | `bottom`/`top`/`down`/`up` | ленивая подгрузка |
| `session_wait_for(text="", selector="", timeout=15)` | текст ИЛИ селектор | честно «дождался/не дождался» без исключения |
| `session_text` / `session_links(max_links=20)` / `session_back` | — | чтение без движения, ссылки, шаг по истории |
| `snapshot(url="", limit=30)` / `screenshot(som=True)` | группа `vision` | структура с `ref` / картинка, номера совпадают с `ref` |
| `session_tabs(op="list", url="", tab_id="")` | `list`/`new`/`switch`/`close` | несколько вкладок; параметр `op`, не `action` |
| `session_network(limit=50)` / `session_console(limit=50)` | — | статусы запросов / ошибки JS |
| `session_download(url="", selector="", timeout=30)` / `session_upload(selector, path)` | — | файлы в `~/.cache/camoufox-research/downloads/` |
| `session_resize(width, height, max_chars=2000)` | — | адаптив |
| `session_eval(expression)` | JS в MAIN world | когда данные не отдаются текстом |
| `session_block(pattern)` / `session_unblock(pattern="")` | — | пометить шумные запросы |
| `set_proxy(proxy)` / `profile_save(name="default")` / `profile_load(name="default")` | — | выход в сеть / логины |

## Рецепты (замеры этой сессии, 21.09.2026)

### Логин формой и вход в закрытую зону

```json
[{"tool":"session_start","args":{"url":"https://the-internet.herokuapp.com/login","max_chars":600}},
 {"tool":"session_form_fill","args":{"fields":"{\"#username\":\"tomsmith\",\"#password\":\"SuperSecretPassword!\"}","submit":"button[type=submit]","max_chars":600}},
 {"tool":"session_navigate","args":{"url":"https://the-internet.herokuapp.com/secure","max_chars":600}},
 {"tool":"session_status","args":{}},
 {"tool":"session_end","args":{}}]
```

Замер: старт вкладки 15.0 с, форма 4.2 с, переход 3.5 с, `session_status` 0.01 с. На шаге `session_form_fill` уже пришло «You logged into a secure area!» — `submit` сам отправил форму, отдельный `session_click` по кнопке не нужен. `fields` — строка JSON, а не объект: MCP-схема объявляет `str` (та же грабля, что у `extract.schema`). Если поля не нашлись, в ответе стоит «НЕ НАЙДЕН» — это отказ сценария, а не «нет текста про логин».

### Бесконечная лента

```
session_start(url=…/infinite_scroll) → session_eval("document.querySelectorAll('.jscroll-added').length")
→ session_scroll(direction="bottom") ×N → тот же session_eval → session_text(max_chars=40000)
```

Замер: 34 блока → 63 после одного скролла (в репозитории зафиксировано 32 → 61, стенд шумит — важно не число, а прирост); скролл 18.3 с при старте 24.8 с. Судить по счётчику, а не по «ответ непустой»: пустой ответ — норма для страницы-заглушки. `direction="down"` — 0.8 экрана плюс ожидание стабилизации, `bottom` — сразу в низ; крути цикл, пока прирост не исчезнет.

### Проверка «что ушло в сеть» и почему блок пустой

`session_network(limit=50)` отдаёт status/method/type/url последних запросов, `session_console(limit=50)` — error/warning/log. HTTP-статус навигации виден только здесь (`session_navigate` и `fetch_page` отдают текст без кода ответа). Статус может прийти как `[—]`, а причина — как `NS_ERROR_FAILURE`, `NS_ERROR_UNKNOWN_HOST` или `CORS request did not succeed` в консоли: это ответы браузера, а не отказ тула (живой замер этой сессии на стенде с частью недоступных ресурсов). Пустой блок на месте данных почти всегда AJAX: сначала сеть, потом `session_eval`, а не наоборот.

### Сбор XHR в данные

`session_eval` с функцией вида `() => Array.from(document.querySelectorAll('table tr')).map(r => r.innerText)` возвращает результат как JSON. Это MAIN world и максимум прав: чужой JS исполняется, а его вывод приходит тебе — зови осознанно и только там, где `session_text`/`table_extract`/`extract` данных не дали.

### Скачивание и отправка файла

`session_download(selector="a.download", timeout=30)` (нужна живая вкладка) кладёт файл в `~/.cache/camoufox-research/downloads/` и возвращает путь — читать его тем же `read_document`. Обратное направление — `session_upload(selector="input[type=file]", path=…)`.

### Адаптив

`session_resize(width=390, height=844)` меняет viewport живой вкладки, дальше `screenshot(som=False)` (группа `vision`): вёрстку смотрят картинкой, текст подтвердит лишь «страница есть».

### Как повторить прогон

```bash
DRIVE_ENV='{"CAMOUFOX_CAPS":"research,browser,session"}' \
  ~/.venvs/camoufox-research/bin/python <repo>/scripts/mcp_drive.py <repo> \
  '[{"op":"tools"},{"tool":"session_start","args":{"url":"https://…","max_chars":600}}]'
```

`<repo>` — клон сервера; относительный `DRIVE_OUT` драйвер кладёт в `~/.cache/camoufox-research/dev`. `session_*` кэш не читает — сеть настоящая.

## Чего не умеет (проверено, а не предположено)

- **Cloudflare-интерстишл не решается.** Наш стек отдаёт «Performing security verification» (замер в `docs/anti-bot-matrix.md`), сторонний nodriver-стек — тоже (проверка владельца). Челлендж, который решается сам, иногда доезжает реальной страницей — бюджет ожидания контента 8 с, поэтому ответ может быть интерстишлом под видом «страницы».
- **Клик по Turnstile-виджету невозможен.** Виджет живёт в кросс-доменном iframe (`challenges.cloudflare.com`), а координатного клика мышью в тулсете нет: `session_click` работает локаторами по своей странице.
- **Скролл внутри iframe не работает** по той же причине — `session_scroll` и `session_eval` смотрят основную страницу, не чужой фрейм.
- **`session_block` НЕ режет трафик.** Паттерн только помечается и виден в `session_network` как «заблокирован»; экономии трафика ждать не надо (свой `page.route` замедлил бы всё и оставил след в отпечатке — обоснование в коде тула).
- **Скачивание не начинается само и без разрешения браузера.** `session_download(selector=…)` ждёт настоящего download-события: если сайт открывает просмотрщик или диалог вместо загрузки, вернётся «скачивание не началось».
- **`session_navigate` не принимает относительный URL.** `/secure` даёт `isError` с текстом `ошибка: нет схемы в URL (нужен http:// или https://)` (проверено этой сессией) — склеивай адрес сам.

## Границы и соседи

- Одна страница текстом, кэш 24 ч, повтор со `delta=True` → `fetch_page`/`extract`: дешевле, и сессия им не нужна.
- Корпус, кампании, цитаты → скилл `camoufox-research-deep-research`.
- Правка кода сервера, зависшая кампания, «тул не появился после правки» → `camoufox-research-rails`.
- Окружение и установка (`~/.venvs/camoufox-research`, браузер `~/.cache/camoufox`) → `camoufox-research-ops`.
- Один браузер на машину: параллельный прогон в тот же воркер возвращает `EPIPE`/`Cannot switch to a different thread`. Ждать и переигрывать сценарий с начала: после перезапуска вкладки и логин-куки не существуют, поэтому повтор отдельного шага был бы враньём.
- `set_proxy` перезапускает браузер и теряет вкладки: порядок — сначала `set_proxy`, потом `profile_load`, потом интерактив.

## Дальше (прогрессивное раскрытие)

- `docs/RESEARCH-PLAYBOOK.md` — ленивый контент, документы, токен-бюджет страниц.
- `docs/agent-usage.md` — реестр тулов по профилям, рабочий цикл, контракт ошибок.
- `docs/testing-live-flows.md` — живые сценарии и как их гонять (`CAMOUFOX_LIVE_TESTS=1`).
- `docs/anti-bot-matrix.md` — что стек проходит, а что нет; `docs/landmines.md` — проверенные грабли.

Всё это лежит в репозитории сервера: код — в клоне, состояние — в `~/.cache/camoufox-research` (`downloads/`, `profiles/`, `shots/`).

---

**AGGG [Distro] Firmware** · автор — **@hilartem** (Telegram). Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
