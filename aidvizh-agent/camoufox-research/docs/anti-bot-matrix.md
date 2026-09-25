# Anti-bot matrix — что стек проходит, измерено 21.09.2026

> **Правило замера.** Меряем СВОЙ стек, его дефолтное поведение, на публичных
> тест-страницах, которые для этого и сделаны (`bot.sannysoft.com` — таблица
> детекта, `nowsecure.nl`, демо-страница челленджа NopeCHA). Никаких солверов
> капчи, ротации прокси, обхода авторизации и «дожимов»: по канону
> `skill/web-scraping` челлендж/403 — сигнал СТОП, а не приглашение
> эскалировать. Всё в таблицах — вывод команд, а не оценка «должно работать».
> Ограничения, которые видно в замерах, вынесены в раздел «Пределы» — без
> обещаний «обойдём всё».

## Как измеряли (воспроизводимо)

Драйвер MCP по stdio, пакет из репозитория (`PYTHONPATH=<repo>`), proto 2025-11-25,
`camoufox-research 0.19.0`, реестр 62 тула (`CAMOUFOX_CAPS=all`; на момент замеров
пустой `CAMOUFOX_CAPS` отдавал тот же полный реестр — дефолт сужен до
`research,browser` = 34 тула позже, см. п. 6 «Пределов»).

```bash
cd /run/media/admin1/DATA/AGGG/camoufox-research
DRIVE_OUT=matrix_a.json ~/.venvs/camoufox-research/bin/python scripts/mcp_drive.py \
  /run/media/admin1/DATA/AGGG/camoufox-research "$(cat /tmp/plan_a.json)"
```

План — JSON-массив шагов; `{"tool": …, "args": …}` или `{"op":"tools"}`/`{"op":"sleep","sec":N}`.
`scripts/mcp_drive.py` печатает на каждый шаг секунды, `isError` и текст, а `DRIVE_OUT` кладёт
всё в JSON (относительный путь — в ~/.cache/camoufox-research/dev, не рядом с репо).

**Кэш 24 ч.** `fetch_page` читает `~/.cache/camoufox-research/cache.db` (TTL 86400 с).
Чтобы мерить сеть, а не кэш, брали вариант URL без записи в кэше — в таблице это
помечено (`example.com` = кэш, `example.com/` = сеть). `session_*` кэш не читает.

**Контекст машины:** GTX 1660 SUPER, 6 ядер, egress `109.227.67.148`
(McLaut, Cherkasy, UA, жилой). Во время прогонов на машине параллельно шёл чужой
тяжёлый прогон (`ps`: `/tmp/cf-clean/camoufox_research/camoufox_worker.py --serve`) —
по грабле 18 это запрещено; на **вердикты** (они по содержимому и заголовку) это не влияет,
на **времена** — завышает.

**Рабочее дерево жило под чужой правкой.** Ветка `local-fixes` не коммичена целиком:
в 14:40:34 другой агент переписал `camoufox_research/camoufox_worker_ext.py` (полосы
`heavy`/`light`), и все прогоны в окне 14:40:34–14:47:35 падали greenlet-ошибкой —
подробно в «Пределах», п. 3 (в 14:47:35 правка исправлена). Таблица снята прогонами
A (14:38) и C (14:40:19), то есть на состоянии до правки; сравнивать их времена
с прогонами D–G нельзя.

## Таблица: цель · что вернулось · вердикт · время

| Цель (класс защиты) | Что вернулось | Вердикт | Время |
|---|---|---|---|
| `https://example.com` — простая страница, кэш | «Example Domain …», 129 симв. | **прошло** (кэш, не сеть) | 2.37 с |
| `https://example.com/` — та же страница, сеть | «Example Domain …», 129 симв. | **прошло** | 9.89 с |
| `https://example.com` — живая навигация (`session_start`) | «Example Domain …», 129 симв. | **прошло** | 3.03 с |
| `https://bot.sannysoft.com/` — анти-бот на своём стеке | таблица детекта целиком (1.5 КБ текста + 11.5 КБ в `session_eval`) | **прошло**, 12/13 строк passed (см. ниже) | 4.62 с |
| `https://bot.sannysoft.com` — тот же сайт, `fetch_page`, другой фингерпринт | та же таблица, но UA macOS / WebGL «Apple M1» | **прошло** | 7.40 с |
| `https://nowsecure.nl/` — JS-рендер + челлендж (`session_navigate`) | заголовок `NOWSECURE`, текст «NOWSECURE / BY NODRIVER», 43 симв. | **прошло** (интерстишла нет) | 8.13 с |
| `https://nowsecure.nl` — тот же сайт, `fetch_page` | тот же текст, 43 симв. | **прошло** (подтверждено 2-м путём) | 6.68 с |
| `https://nopecha.com/demo/cloudflare` — интерстишл Cloudflare (`session_navigate`) | «Performing security verification … Ray ID: a3e8c8b70ba824ed … Performance and Security by Cloudflare», 259 симв. | **интерстишл** (не прошло) | 4.98 с |
| `https://nopecha.com/demo/cloudflare/` — тот же челлендж, `fetch_page` | реальная страница демо («CAPTCHA Demo / Cloudflare Turnstile / hCaptcha …»), 600+ симв. | **прошло** (челлендж отдался сам, но позже 8 с) | 22.70 с |
| `https://www.g2.com/products` — WAF-челлендж, `fetch_page` | реальная страница G2: «Home / Leave a Review / Browse / Top Categories …» | **прошло** | 11.10 с |
| `https://www.tripadvisor.com` — WAF-челлендж, `fetch_page` | реальная страница: «Plan with AI / Sign in / Where to? / Find things to do by interest …» | **прошло** | 5.67 с |
| `https://www.zillow.com/` — другой вендор (PerimeterX/DataDome) | — | **не измерено** | — |

`zillow` не измерен: на машине уже шёл чужой тяжёлый прогон, второй браузер по
грабле 18 я не поднимал. Оценки вместо замера тут не будет.

**Главное различие двух строк про nopecha:** один и тот же сайт с одним и тем же
челленджем отдал интерстишл на `session_navigate` (4.98 с) и реальную страницу на
`fetch_page` (22.70 с). Это не «обходимость» и не «настройка» — это разные сессии
(новый браузер/фингерпринт на каждый запуск) и малый бюджет ожидания (см. «Пределы»,
п. 2): челлендж иногда решается сам, но дольше, чем стек готов ждать, и тогда
интерстишл уезжает агенту как «контент страницы».

## Отпечаток: факты из `session_eval`

Запуск A (Windows-личность, `session_eval` на example.com):

```text
webdriver=false                 UA=Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0
platform=Win32                  languages=[en-US, en]     maxTouchPoints=0     plugins=5
cores=8 (в машине 6)            deviceMemory=null         timezone=Europe/Chisinau
screen=[1680,1050,1680,1002,24,1]   window=[1680,1002,1680,951]
webgl=Google Inc. (NVIDIA) | ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar
typeof window.chrome=undefined  pdfViewer=true   токена "Headless" в UA нет
```

Запуск C (тот же сайт, следующий запуск): `UA=… (Macintosh; Intel Mac OS X 10.15; rv:152.0)`,
`WebGL=Apple | Apple M1, or similar`. **Вывод:** фингерпринт ротируется на каждый запуск
(BrowserForge) — последовательные замеры идут «разными людьми», сравнивать их между
собой по цифрам нельзя, только по классу результата.

Несогласованность, которую видно прямо в замере: **TZ `Europe/Chisinau` при egress-IP
в Черкассах (UA)** и `languages=[en-US]`. Фингерпринт внутренне противоречив по гео —
это ровно тот класс признака, который ищут WAF (проверка IP-geo ↔ TZ/локаль), и он
не лечится ничем, кроме прокси/локального IP (см. «Что даст следующий шаг»).

## `bot.sannysoft.com`: 13 строк, 12 passed

Строки таблицы (`session_eval` по `table tr`, 21.09.2026, Windows-личность):

```text
User Agent (Old)              → Mozilla/5.0 (Windows NT 10.0 … rv:152.0) Firefox/152.0   {passed}
WebDriver (New)               → missing (passed)                    {passed}
WebDriver Advanced            → passed                              {passed}
Chrome (New)                  → missing (failed)                    {failed}
Permissions (New)             → prompt                              {passed}
Plugins Length (Old)          → 5                                   {passed}
Plugins is of type PluginArray→ passed                              {passed}
Languages (Old)               → en-US, en                          {passed}
WebGL Vendor                  → Google Inc. (NVIDIA)                {passed}
WebGL Renderer                → ANGLE (NVIDIA, … GTX 980 …)         {passed}
Broken Image Dimensions       → 24x24                               {passed}
PHANTOM_* (ua/properties/etsl 37/language/websocket/screen/overflow) → все ok
MQ_SCREEN / PHANTOM_OVERFLOW  → ok
```

Единственный `failed` — `Chrome (New): missing`: у Firefox нет объекта `window.chrome`
(это следствие движка, а не автоматизации; «Chrome» в UA-строке был бы как раз признаком
лжи). Ни одного следа автоматизации (`webdriver`, `WebDriver Advanced`, PHANTOM_*) таблица
не нашла — то есть **подмена navigator/screen/WebGL/плагинов работает**.

## Пределы (измерено; не мнение)

1. **HTTP-статус навигации (ИСПРАВЛЕНО 21.09).** `fetch_page` и `session_navigate`
   отдают только текст; `session_network` падал `ошибка: KeyError: 'network'`
   (читатель брал `w["network"]` — `camoufox_session_ext.py:175`, писатель клал
   ключ `"net"` — `camoufox_session_core_a.py:56`). Починено (один источник правды,
   тесты + живая проверка: `[200] GET document …`, `[404]` на битом URL).
   Тогда, до фикса, «прошло / 403 / 429» агент
   может определить только по содержимому и заголовку — как в таблице выше.
2. **Бюджет ожидания контента — 8 с** (`_wait_content(page, min_chars=300, max_wait=8)`,
   `camoufox_browser_core.py:90`). Челлендж, который решается дольше, остаётся
   интерстишлом и уезжает в контекст как «страница» (наблюдали на nopecha: 5 с —
   интерстишл, тот же URL другим путём — 22.7 с и реальная страница).
3. **Браузерные тулы через MCP падали `error: Cannot switch to a different thread`
   (greenlet) — но это не свойство ветки, а НЕзакоммиченная правка в рабочем дереве,
   прожившая 7 минут.** Прогоны A и C (данные всей таблицы) сняты до неё и работали;
   начиная с D упали 4 прогона из 4 — и на `session_*`, и на `fetch_page`, и на
   `session_eval`. Совпадение по времени: `camoufox_research/camoufox_worker_ext.py`
   изменён в 14:40:34, `matrix_c.log` закончился в 14:40:19 (успех), `matrix_d.log` —
   в 14:40:38 (все шаги с ошибкой). Суть правки: `_serve()` раздавал действия в
   `ThreadPoolExecutor(thread_name_prefix="heavy"|"light")` (нумерация строк — по
   состоянию 14:40–14:44: 197-201 запуск браузера в главном потоке, 209-213 полосы),
   а Playwright sync API потокопривязан (грабля 14) — в коммите `247ab61` (HEAD на
   момент замеров) действия выполнялись в том же главном потоке
   (`git show 247ab61:camoufox_research/camoufox_worker_ext.py`, цикл
   `for line in sys.stdin`), и такой ошибки быть не может.
   Минимальное воспроизведение (рабочее дерево, без MCP):
   ```bash
   printf '%s\n' '{"action":"session_start","url":"https://example.com","max_chars":150}' \
     | ~/.venvs/camoufox-research/bin/python camoufox_research/camoufox_worker.py --serve
   # 14:43 → {"error": "error: Cannot switch to a different thread …"}
   # 14:48 → {"result": "Example Domain\n\nThis domain is for use in documentation examples…"}
   ```
   **Закрыто в тот же день (14:47:35, автор правки BridgeTimeoutAndLock):** тяжёлые
   действия снова исполняются в потоке-владельце браузера (`heavy_q`), в пуле остались
   только browser-free (`ping`/`stats`/`cache_info`/`research_status`/`research_index`);
   проверено этим же репро 21.09 в 14:48 — страница отдаётся.
   Вывод на будущее: **любая** попытка исполнять браузерные действия в чужом потоке
   возвращает эту ошибку; полосы допустимы только для действий без браузера.
   ⚠️ **На 21.09 ~15:00 фикс НЕ в коммите:** в HEAD `0c65f96` лежит битая полосовая
   версия. Прогон этих планов из HEAD-кода или из установленной копии пакета снова
   даст greenlet-ошибку — сначала дождись коммита фикса и переустановки
   (`uv pip install --python ~/.venvs/camoufox-research/bin/python --reinstall-package camoufox-research .`),
   иначе «регресс вернулся» будет ложной тревогой не про фингерпринт.
4. **`extract` ждёт `schema` строкой, не объектом** (`schema: str` в MCP-схеме;
   в `docs/agent-usage.md` пример показан объектом `{"поле":"css:.price"}`) — вызов
   отбивается валидацией: `Input should be a valid string`. Передавать `'{"поле":"css:.price"}'`.
5. **Дефолты не переключаются без правки кода:** `Camoufox(headless=True)`
   (`camoufox_browser_core.py:82`) — headful/виртуальный дисплей не включаются флагом;
   прокси только через `set_proxy` (группа session, opt-in), и он **перезапускает
   браузер** (`camoufox_worker_core_b.py:181-195`) — вкладки и контексты сессии теряются.
6. **Реестр по факту шире документации:** при пустом `CAMOUFOX_CAPS` поднялись все 62 тула,
   хотя `docs/agent-usage.md` заявляет дефолт `research,browser` (34 тула).
   **Починено 21.09:** пустой `CAMOUFOX_CAPS` теперь и означает дефолт
   `research,browser` — 34 тула (закреплено `tests/test_caps_default.py`), полный
   реестр — только явным `CAMOUFOX_CAPS=all`/`*`.
7. **Ограничения от автора Camoufox** ([camoufox.com/stealth](https://camoufox.com/stealth/), 2026):
   «Camoufox has gone down in performance due to the base Firefox version and newly
   discovered fingerprint inconsistencies»; «fingerprints must also be internally consistent…
   Camoufox doesn't always succeed»; про поведение: «Anti-bot systems also run client-side
   scripts to monitor your behavior… **this isn't perfect. It may still be detected with
   sophisticated enough analysis**». Отдельно: формулировка «часть WAF проверяют поведение
   движка SpiderMonkey (Cloudflare-интерстишл) и это не спуфится» встречается у комьюнити —
   у автора я её не нашёл и первоисточником подтвердить не могу; у автора подтверждены
   «внутренние несогласованности» и «поведенческий анализ» (выше).

## Что даст следующий шаг (с честными оговорками)

- **Прокси** (`set_proxy('user:pass@host:port')`, http/socks5). Единственный рычаг против
  IP-reputation и лимитов; наши 6 целей по IP не блокировали, так что выигрыша на них
  ждать не стоит. Риск прямой: фингерпринт и IP должны совпадать по стране — сейчас у нас
  уже расхождение (TZ `Europe/Chisinau` при IP UA), с прокси из другой страны оно либо
  лечится (совпадение), либо усиливается (несовпадение). Плюс цена: перезапуск браузера и
  потеря сессии.
- **Клик по Turnstile.** Виджет живёт в cross-origin iframe (`challenges.cloudflare.com`) —
  DOM чужой страницы для нас закрыт, а координатного клика мышью в тулсете нет
  (`session_click` работает локаторами по своей странице). Значит либо новый тул с
  `mouse.click` по bbox виджета, либо внешний солвер — второе вне правил
  `skill/web-scraping` (солверы капчи) и без письменной авторизации владельца делаться не
  должно. Не проверяли; и с кликом результат всё равно зависит от фингерпринта и IP.
- **Headful через виртуальный дисплей.** `camoufox 0.5.5` умеет `headless='virtual'`
  (Xvfb; в системе `/usr/bin/Xvfb` есть), репа жёстко ставит `headless=True` — это
  одна строка правки. Что даст: ровно одно — снимает гипотезу «палимся headless-режимом»
  (автор сам пишет, что headless пропатчен под окно, а virtual display — фолбэк).
  Минусы: +память/CPU на Xvfb и новая зависимость в CI. Замеров «headless vs virtual»
  у нас нет, поэтому выигрыша не обещаю.

## Три вывода

1. **Что решает фингерпринт — проходит.** `bot.sannysoft.com` 12/13 (единственный минус —
   отсутствие `window.chrome`, это Firefox, а не автоматизация), `nowsecure.nl`, `g2.com`,
   `tripadvisor.com` отдались полным содержимым за 5–11 с. Подмена navigator/screen/WebGL/
   плагинов и отсутствие `navigator.webdriver` работают.
2. **Что решают время и сессия — не проходит.** Cloudflare-интерстишл на `nopecha.com`
   дошёл до агента как «страница», потому что стек ждёт контент максимум 8 с; на другом
   пути тот же челлендж отдался сам за 22.7 с. Это не про спуфинг, а про политику
   ожидания и одноразовость сессии.
3. **Замер дороже, чем кажется:** агент не видит HTTP-статуса (нет ни у `fetch_page`,
   ни у сломанного `session_network`), фингерпринт ротируется каждый запуск, а рабочее
   дерево меняется под руками — правка полос воркера в 14:40 превратила все браузерные
   тулы в greenlet-ошибку и была откачена через 7 минут; без `ps`, времён файлов
   и двух путей замера вердикт «прошло/не прошло» был бы догадкой.

## Приложение: точные планы

`plan_a.json` (рабочие шаги; в исходном плане было ещё два шага с моим невалидным
селектором `iframe[src*=challenges.cloudflare.com]` — их результат в таблицу не вошёл):

```json
[
 {"op": "tools"},
 {"tool": "fetch_page", "args": {"url": "https://example.com", "max_chars": 300}},
 {"tool": "fetch_page", "args": {"url": "https://example.com/", "max_chars": 300}},
 {"tool": "session_start", "args": {"url": "https://example.com", "max_chars": 400}},
 {"tool": "session_eval", "args": {"expression": "() => ({webdriver: navigator.webdriver, ua: navigator.userAgent, uaPlatform: navigator.platform, languages: navigator.languages, cores: navigator.hardwareConcurrency, plugins: navigator.plugins.length, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth, window.devicePixelRatio], window: [window.outerWidth, window.outerHeight, window.innerWidth, window.innerHeight], webgl: (() => { try { const c = document.createElement('canvas').getContext('webgl'); const d = c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_VENDOR_WEBGL) + ' | ' + c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no-debug-ext'; } catch (e) { return 'err: ' + e.message; } })(), hasChrome: typeof window.chrome, pdfViewer: navigator.pdfViewerEnabled})"}},
 {"tool": "session_navigate", "args": {"url": "https://bot.sannysoft.com/", "max_chars": 1500}},
 {"tool": "session_eval", "args": {"expression": "() => Array.from(document.querySelectorAll('table tr')).map(r => Array.from(r.querySelectorAll('td,th')).map(c => c.innerText.trim() + (c.className ? '{' + c.className + '}' : '')).join(' | ')).filter(s => s.length > 3).slice(0, 40)"}},
 {"tool": "session_navigate", "args": {"url": "https://nowsecure.nl/", "max_chars": 1200}},
 {"tool": "session_navigate", "args": {"url": "https://nopecha.com/demo/cloudflare", "max_chars": 1200}}
]
```

`plan_c.json` (путь `fetch_page` по всем целям; URL без кэша — сравнить с `plan_a`):

```json
[
 {"tool": "fetch_page", "args": {"url": "https://nowsecure.nl", "max_chars": 600}},
 {"tool": "fetch_page", "args": {"url": "https://nopecha.com/demo/cloudflare/", "max_chars": 600}},
 {"tool": "fetch_page", "args": {"url": "https://www.g2.com/products", "max_chars": 600}},
 {"tool": "fetch_page", "args": {"url": "https://bot.sannysoft.com", "max_chars": 600}},
 {"tool": "fetch_page", "args": {"url": "https://www.tripadvisor.com", "max_chars": 600}}
]
```

Чего в этих планах делать **нельзя** (проверено, ломается):

- селектор `iframe[src*=challenges.cloudflare.com]` без кавычек внутри атрибутной
  скобки — Firefox отвечает `… is not a valid selector` и `session_eval` возвращает
  ошибку вместо данных (мой промах в первой версии плана);
- `schema` объектом в `extract` — MCP-схема ждёт строку (`schema: str`), вызов
  отбивается валидацией;
- рассчитывать на `session_network` — он падал `KeyError: 'network'` (уже починено, см. выше);
- исполнять браузерные действия в чужом потоке (полосы воркера): окно
  14:40:34–14:47:35 давало greenlet-ошибку на каждом браузерном шаге; в рабочем дереве
  окно закрыто (см. «Пределы», п. 3), в HEAD `0c65f96` — ещё нет; правило остаётся:
  полосы только для browser-free действий.
