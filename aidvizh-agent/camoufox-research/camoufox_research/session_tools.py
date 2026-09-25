#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Session-тулы MCP (вынесено из camoufox_research.py, canon/FILE-SIZE.md).

Из этого файла регистрируются три группы реестра (см. camoufox_caps.GROUPS):
session — живая вкладка (клики, формы, сеть, файлы, профили), vision —
snapshot/screenshot, и часть browser — чтение документов, карта сайта,
обход, таблицы, мониторинг. Дефолтный профиль агента (research,browser)
видит только browser-часть: 34 тула из 62; session/vision подключают явно.

Докстринги здесь — инструкция АГЕНТУ (её читает модель при выборе тула),
а не описание для человека, и написаны по одной схеме:
1) КОГДА звать — включая то, что должно быть ДО вызова (session_start,
   живой браузер), в ПЕРВОЙ строке, а не в хвосте абзаца;
2) ЧТО получишь — формат ответа, чтобы не звать ради догадки;
3) НЕ — типовая ошибка и куда идти вместо неё.
Причина схемы: формулировка «Требует session_start» в конце абзаца тонула,
и агент звал session_click без сессии (живая проба 21.09: ошибка вместо
текста). КОГДА/ЧТО/НЕ стоят в начале — модель видит их, а не ищет."""


def register(mcp, call):
    @mcp.tool()
    def session_start(url: str = "", max_chars: int = 6000) -> str:
        """КОГДА: интерактив в одной вкладке — клики, формы, скролл, ввод;
        состояние (URL, ввод, скролл) живёт между командами, «как человек».
        ЧТО: открывает url (пусто = пустая вкладка) в постоянной вкладке
        serve-воркера и отдаёт текст страницы (max_chars).
        НЕ: нужен только текст → fetch_page (кэш, дешевле); разовый
        «открыл-кликнул-прочитал» → browser_click; закрывать → session_end."""
        return call("session_start", url=url, max_chars=max_chars)

    @mcp.tool()
    def session_navigate(url: str, max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): перейти по URL в ТОЙ ЖЕ вкладке, не
        теряя состояние — логин, скролл, историю.
        ЧТО: грузит url в текущей вкладке и отдаёт её текст (max_chars).
        НЕ: без session_start упадёт — сначала session_start; новая вкладка →
        session_tabs(op="new"); перечитать без навигации → session_text."""
        return call("session_navigate", url=url, max_chars=max_chars)

    @mcp.tool()
    def session_click(
        selector: str = "", target_text: str = "", ref: str = "", max_chars: int = 6000
    ) -> str:
        """КОГДА (нужен session_start): кликнуть по элементу уже открытой
        страницы — кнопка, ссылка, таб, пункт меню.
        ЧТО: клик по selector (CSS), target_text (текст ссылки) или ref из
        snapshot; возвращает текст ПОСЛЕ клика.
        НЕ: без session_start упадёт — сначала session_start; разовый клик с
        нуля → browser_click; не знаешь, по чему кликать → snapshot (даст ref)."""
        return call(
            "session_click",
            selector=selector,
            target_text=target_text,
            ref=ref,
            max_chars=max_chars,
        )

    @mcp.tool()
    def session_type(selector: str, text: str, max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): ввести текст в поле открытой страницы
        — поиск, логин, фильтр.
        ЧТО: печатает text в поле по CSS-селектору, отдаёт текст страницы.
        НЕ: без session_start упадёт — сначала session_start; ввод с нуля
        (открыть URL и набрать) → browser_type; много полей сразу →
        session_form_fill."""
        return call("session_type", selector=selector, text=text, max_chars=max_chars)

    @mcp.tool()
    def session_scroll(direction: str = "bottom", max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): догрузить lazy-контент (лента,
        отложенные блоки) или вернуться к началу страницы.
        ЧТО: скролл bottom/top/down/up с ожиданием догрузки + текст страницы.
        НЕ: без session_start упадёт — сначала session_start; текст без
        движения → session_text; целиком сайт → crawl."""
        return call("session_scroll", direction=direction, max_chars=max_chars)

    @mcp.tool()
    def session_links(max_links: int = 20) -> str:
        """КОГДА (нужен session_start): собрать ссылки текущей страницы —
        обычно чтобы понять, куда идти дальше.
        ЧТО: нумерованный список ссылок (текст + URL), не более max_links.
        НЕ: без session_start упадёт — сначала session_start; ссылки всего
        сайта → map_site / sitemap; битые ссылки → check_links."""
        return call("session_links", max_links=max_links)

    @mcp.tool()
    def session_text(max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): прочитать текущую страницу сессии,
        НЕ двигая её (страница уже в нужном состоянии после кликов/скролла).
        ЧТО: текст активной вкладки (max_chars — лимит символов).
        НЕ: без session_start упадёт — сначала session_start; страница вне
        сессии → fetch_page (кэш, дешевле); структура/ref → snapshot."""
        return call("session_text", max_chars=max_chars)

    @mcp.tool()
    def session_back(max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): шаг назад по истории вкладки —
        вернуться к списку после карточки, не теряя сессию.
        ЧТО: возвращает вкладку на предыдущую страницу и отдаёт её текст.
        НЕ: без session_start упадёт — сначала session_start; конкретный URL
        → session_navigate (история не нужна)."""
        return call("session_back", max_chars=max_chars)

    @mcp.tool()
    def session_status() -> str:
        """КОГДА: проверить, жива ли вкладка сессии и куда её унесло
        (редирект, попап) — перед серией session_* команд.
        ЧТО: URL, заголовок, признак «жива ли вкладка». session_start НЕ
        требует: это проверка, а не действие.
        НЕ: ждать элемент/текст → session_wait_for; прогресс кампаний →
        research_status (это другой «статус»)."""
        return call("session_status")

    @mcp.tool()
    def session_end() -> str:
        """КОГДА: работа с вкладкой кончена — освободить браузер до следующей
        задачи (воркер один на сервер).
        ЧТО: закрывает вкладку сессии и сбрасывает её состояние, следующий
        session_start даёт чистую вкладку.
        НЕ: оставлять сессию «на потом» — вкладка держит браузер; логин
        нужен в следующий раз → сначала profile_save, потом session_end."""
        return call("session_end")

    @mcp.tool()
    def session_tabs(op: str = "list", url: str = "", tab_id: str = "") -> str:
        """КОГДА (нужен session_start): нужны несколько вкладок — сравнить
        две страницы, не теряя первую.
        ЧТО: op=list (id/url/title всех вкладок), op=new (url или пустая),
        op=switch (tab_id — активной), op=close (tab_id).
        НЕ: без session_start упадёт — сначала session_start; параметр зовётся
        op, а не action (грабли: «action» занят полем RPC)."""
        return call("session_tabs", op=op, url=url, tab_id=tab_id)

    @mcp.tool()
    def session_wait_for(text: str = "", selector: str = "", timeout: int = 15) -> str:
        """КОГДА (нужен session_start): странице нужно время — дождаться
        текста (text) или элемента (selector) до чтения/клика.
        ЧТО: ждёт до timeout секунд (по умолчанию 15) и честно отвечает
        «дождался»/«не дождался» (без исключения при неудаче).
        НЕ: без session_start упадёт — сначала session_start; lazy-контент
        догружают скроллом → session_scroll."""
        return call("session_wait_for", text=text, selector=selector, timeout=timeout)

    @mcp.tool()
    def session_eval(expression: str) -> str:
        """КОГДА (нужен session_start): страница не отдаёт данные текстом —
        вытащить их JS из живой вкладки (MAIN world).
        ЧТО: выполняет expression, возвращает результат как JSON.
        НЕ: без session_start упадёт — сначала session_start; это МАКСИМУМ
        прав (чужой JS вернётся к тебе) и тул ВНЕ дефолтного профиля: он
        живёт в группе session (--caps research,browser,session); обычные
        поля → extract."""
        return call("session_eval", expression=expression)

    @mcp.tool()
    def snapshot(url: str = "", limit: int = 30) -> str:
        """КОГДА: нужна структура страницы и ref для клика, а селекторов ты
        не знаешь (YAML ~2-5KB вместо HTML 100KB+).
        ЧТО: aria-подобное дерево интерактивных элементов с ref (до limit);
        без url — активная вкладка сессии (тогда нужен session_start), с
        url — открыть страницу и снять её.
        НЕ: нужен текст → fetch_page / session_text; вид глазами →
        screenshot(som=True) — там номера совпадают с ref. Тул в профиле
        vision: с дефолтным caps его не видно."""
        return call("snapshot", url=url, limit=limit)

    @mcp.tool()
    def screenshot(
        url: str = "", selector: str = "", som: bool = False, full_page: bool = True
    ) -> str:
        """КОГДА: нужна визуальная проверка — вёрстка, canvas, капча,
        картинки (то, чего текст не покажет).
        ЧТО: PNG-файл активной вкладки сессии (без url, нужен session_start)
        или страницы по url; selector — только элемент; som=True — красные
        рамки с номерами, совпадающими с ref из snapshot; отдаёт путь.
        НЕ: сначала не проверять текстом — snapshot / fetch_page дают то же
        в разы дешевле по токенам; тул в профиле vision (opt-in)."""
        return call("screenshot", url=url, selector=selector, som=som, full_page=full_page)

    @mcp.tool()
    def map_site(url: str, max_links: int = 50, pattern: str = "") -> str:
        """КОГДА: понять структуру сайта — какие разделы и страницы есть,
        без чтения содержимого.
        ЧТО: ссылки того же домена со стартовой страницы (до max_links),
        pattern — фильтр по URL.
        НЕ: нужны тексты → crawl; есть sitemap.xml → sitemap (полнее и
        дешевле); одна страница → fetch_page."""
        return call("map_site", url=url, max_links=max_links, pattern=pattern)

    @mcp.tool()
    def crawl(
        url: str,
        max_pages: int = 10,
        max_depth: int = 2,
        pattern: str = "",
        article_only: bool = True,
        max_chars: int = 4000,
    ) -> str:
        """КОГДА: собрать содержимое САЙТА целиком (BFS по внутренним
        ссылкам) для синтеза, а не одну страницу.
        ЧТО: тексты страниц (depth ≤ max_depth, всего ≤ max_pages) с
        разделителями '--- URL:'; кэш делает повторный обход дешёвым. Идёт
        долго (десятки переходов) — таймаут MCP-клиента ставь ≥900с.
        НЕ: нужны только URL → map_site / sitemap; сайт огромный → sitemap +
        pattern и уже потом crawl нужного раздела; одна страница →
        fetch_page."""
        return call(
            "crawl",
            url=url,
            max_pages=max_pages,
            max_depth=max_depth,
            pattern=pattern,
            article_only=article_only,
            max_chars=max_chars,
        )

    @mcp.tool()
    def extract(url: str, schema: str, llm: bool = False) -> str:
        """КОГДА: нужны конкретные поля страницы — при стабильной вёрстке
        селекторами (CSS/XPath) или из текста через llm=True, когда вёрстка
        хрупкая и селекторы отваливаются.
        ЧТО: schema — СТРОКА с JSON (не объект! MCP-параметр объявлен как
        str, объект отбивается валидацией): '{"поле": "css:.price"}' или
        '{"поле": {"selector": ".price", "attr": "text|href|src"}}';
        llm=True — строка '{"поле": "подсказка"}' и нужен LLM
        (DeepSeek/Ollama), иначе честный ответ «недоступен».
        НЕ: нужен сплошной текст → fetch_page / batch_fetch; таблицы →
        table_extract; не знаешь селектор → сначала snapshot."""
        return call("extract", url=url, schema=schema, llm=llm)

    @mcp.tool()
    def set_proxy(proxy: str = "") -> str:
        """КОГДА: сайту нужен другой выход (страна, прокси), или пора
        выключить прокси — без ручного перезапуска сервера.
        ЧТО: 'host:port', 'user:pass@host:port', 'socks5://host:port'; пустая
        строка — выключить. В serve-режиме браузер перезапускается с новым
        прокси.
        НЕ: делать это ПОСЛЕ profile_load — перезапуск сбросит контексты
        (канон: сначала set_proxy, потом profile_load); тул в группе session
        (opt-in), в дефолтном профиле его нет."""
        return call("set_proxy", proxy=proxy)

    @mcp.tool()
    def profile_save(name: str = "default") -> str:
        """КОГДА: залогинился — сохранить куки и localStorage, чтобы в
        следующий раз не логиниться заново.
        ЧТО: профиль <name> из живого браузера в
        ~/.cache/camoufox-research/profiles/<name>.json.
        НЕ: вызывать без живого браузера — сохранять нечего (сначала
        session_start/session_navigate); тул в группе session (opt-in)."""
        return call("profile_save", name=name)

    @mcp.tool()
    def profile_load(name: str = "default") -> str:
        """КОГДА: войти на сайт с сохранённым логином — в начале работы, до
        интерактива.
        ЧТО: куки и localStorage профиля <name> в живой браузер.
        НЕ: грузить ДО set_proxy — перезапуск браузера сбросит профиль
        (грабли: профиль поднимать последним); тул в группе session
        (opt-in)."""
        return call("profile_load", name=name)

    @mcp.tool()
    def session_key_press(key: str, max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): нажать клавишу без ввода текста —
        Enter отправить, Escape закрыть попап, Tab/ArrowDown в меню.
        ЧТО: нажатие по имени клавиши Playwright ('Enter', 'Escape', 'Tab',
        'ArrowDown', 'F5') + текст страницы после.
        НЕ: без session_start упадёт — сначала session_start; текст в поле →
        session_type."""
        return call("session_key_press", key=key, max_chars=max_chars)

    @mcp.tool()
    def session_select_option(selector: str, value: str, max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): выбрать вариант в выпадающем списке
        <select> — значение, метка или индекс.
        ЧТО: выбор value в <select> по CSS-селектору + текст страницы после.
        НЕ: без session_start упадёт — сначала session_start; кастомный
        список (не <select>, а div-меню) → session_click по пункту."""
        return call("session_select_option", selector=selector, value=value, max_chars=max_chars)

    @mcp.tool()
    def session_resize(width: int, height: int, max_chars: int = 2000) -> str:
        """КОГДА (нужен session_start): проверить адаптивность — как страница
        выглядит на мобильном/узком экране.
        ЧТО: меняет viewport активной вкладки на width×height и отдаёт текст
        страницы (max_chars).
        НЕ: без session_start упадёт — сначала session_start; вёрстку глазами
        смотреть через screenshot, а не текстом."""
        return call("session_resize", width=width, height=height, max_chars=max_chars)

    @mcp.tool()
    def session_network(limit: int = 50) -> str:
        """КОГДА (нужен session_start): данных нет в HTML — найти, чем
        страница тянет их по AJAX (или почему блок пустой).
        ЧТО: последние запросы вкладки: status, method, type, url (до limit).
        НЕ: без session_start упадёт — сначала session_start; ошибки JS →
        session_console; резать запросы → session_block."""
        return call("session_network", limit=limit)

    @mcp.tool()
    def session_console(limit: int = 50) -> str:
        """КОГДА (нужен session_start): страница ведёт себя странно — упал
        скрипт, CORS, пустой блок на месте данных.
        ЧТО: сообщения консоли вкладки: error/warning/log (до limit).
        НЕ: без session_start упадёт — сначала session_start; сетевые статусы
        → session_network."""
        return call("session_console", limit=limit)

    @mcp.tool()
    def session_block(pattern: str) -> str:
        """КОГДА (нужен session_start): пометить шумные запросы страницы —
        аналитику/картинки по подстроке URL.
        ЧТО: паттерн запоминается для активной вкладки и виден в
        session_network как «заблокирован», НО трафик сейчас НЕ режется:
        свой page.route переводит весь трафик через Python (задержка,
        выключенный http-кэш, след в отпечатке) — обоснование в коде
        camoufox_session_ext.session_block. Не рассчитывай на экономию
        трафика: это разметка для наблюдателя, а не фильтр.
        НЕ: без session_start упадёт — сначала session_start; снимать
        блокировку → session_unblock, сама она держится до конца вкладки."""
        return call("session_block", pattern=pattern)

    @mcp.tool()
    def session_unblock(pattern: str = "") -> str:
        """КОГДА (нужен session_start): вернуть запросы, которые резал
        session_block (частый след — «страница пустая»).
        ЧТО: снимает блокировку по pattern или все (пустая строка).
        НЕ: без session_start упадёт — сначала session_start; не ждать, что
        блокировки переживут session_end — они живут на вкладке."""
        return call("session_unblock", pattern=pattern)

    @mcp.tool()
    def session_download(url: str = "", selector: str = "", timeout: int = 30) -> str:
        """КОГДА: получить файл — прямая ссылка (url) или клик по кнопке
        «Скачать» (selector, тогда нужен session_start).
        ЧТО: файл в ~/.cache/camoufox-research/downloads/, в ответе путь к
        нему; timeout — сколько секунд ждать загрузку.
        НЕ: читать скачанное ещё одним тулом — read_document берёт локальный
        путь; брать прямые ссылки с чужих сайтов без нужды."""
        return call("session_download", url=url, selector=selector, timeout=timeout)

    @mcp.tool()
    def read_document(source: str, max_chars: int = 6000) -> str:
        """КОГДА: нужен документ (PDF/DOCX/XLSX) — отчёт, прайс,
        спецификация; такие файлы часто попадаются ссылками с сайтов.
        ЧТО: текст документа; source — URL или локальный путь (pypdf /
        python-docx / openpyxl, до max_chars).
        НЕ: HTML-страница → fetch_page (дешевле); старые .doc/.xls не
        читаются — сначала libreoffice --convert-to docx/xlsx."""
        return call("read_document", source=source, max_chars=max_chars)

    @mcp.tool()
    def session_form_fill(fields: str, submit: str = "", max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): заполнить форму целиком — логин,
        фильтры, заявка (много полей за один вызов).
        ЧТО: fields — JSON {"селектор": "значение"} в поля страницы; submit —
        селектор кнопки отправки (кликнет, если задан) + текст после.
        НЕ: без session_start упадёт — сначала session_start; одно поле →
        session_type; перед отправкой стоит глянуть поля через snapshot."""
        return call("session_form_fill", fields=fields, submit=submit, max_chars=max_chars)

    @mcp.tool()
    def session_upload(selector: str, path: str, max_chars: int = 6000) -> str:
        """КОГДА (нужен session_start): приложить файл на странице —
        input[type=file]: резюме, картинка, документ.
        ЧТО: загружает локальный path в поле selector + текст страницы после.
        НЕ: без session_start упадёт — сначала session_start; получить файл
        вместо отдать → session_download."""
        return call("session_upload", selector=selector, path=path, max_chars=max_chars)

    @mcp.tool()
    def stats(limit: int = 20) -> str:
        """КОГДА: понять, какие тулы реально работают и что падает — аудит
        вызовов и отладка клиента.
        ЧТО: по каждому тулу счётчик вызовов, среднее время, ошибки, плюс
        последние вызовы (секреты замаскированы). В реестре ВСЕГДА
        (ALWAYS_ON), даже при caps.
        НЕ: это не метрика «какими тулами пользуются» (её даёт tool_usage) и
        не здоровье сервера (его даёт ping)."""
        return call("stats", limit=limit)

    @mcp.tool()
    def sitemap(url: str, max_links: int = 200) -> str:
        """КОГДА: нужен полный список страниц сайта — фид для crawl или
        проверка «что вообще есть на домене».
        ЧТО: URL из sitemap.xml (+ .xml.gz и вложенные sitemapindex), до
        max_links.
        НЕ: у сайта нет sitemap → map_site (ссылки со страницы); тексты →
        crawl."""
        return call("sitemap", url=url, max_links=max_links)

    @mcp.tool()
    def rss(url: str, limit: int = 20) -> str:
        """КОГДА: следить за обновлениями — новости, блог, changelog, релизы
        (лента отдаёт даты одним вызовом).
        ЧТО: посты RSS/Atom: title, link, дата (до limit).
        НЕ: у URL обычная HTML-страница → fetch_page; поставить ленту на
        регулярный обход → research_start(feeds=[...])."""
        return call("rss", url=url, limit=limit)

    @mcp.tool()
    def check_links(
        url: str, max_links: int = 50, internal_only: bool = True, timeout: int = 15
    ) -> str:
        """КОГДА: перед публикацией или после редизайна — найти битые ссылки
        на странице.
        ЧТО: HTTP-статусы собранных ссылок, отчёт вида «[404] URL». Проверка
        последовательная: timeout — срок НА КАЖДУЮ ссылку (15с), 50 ссылок ≈
        до 12 минут; бюджет вызова мост поднимает сам (900с) — таймаут
        MCP-клиента ставь ≥900с.
        НЕ: ждать параллельности — Playwright sync не потокобезопасен
        (грабли: 4 потока → 15/15 error); внешние ссылки → internal_only=False."""
        return call(
            "check_links",
            url=url,
            max_links=max_links,
            internal_only=internal_only,
            timeout=timeout,
        )

    @mcp.tool()
    def export(data: str, format: str = "json", path: str = "") -> str:
        """КОГДА: результат нужен файлом на диске — CSV для таблиц, JSON для
        автоматизации, MD для отчёта.
        ЧТО: файл (json/csv/md) по своему path или авто в
        ~/.cache/camoufox-research/exports/.
        НЕ: результат идёт в разговор и синтез → отдай текст как есть;
        готовый отчёт кампании → citation_report."""
        return call("export", data=data, format=format, path=path)

    @mcp.tool()
    def table_extract(url: str, selector: str = "table", max_tables: int = 5) -> str:
        """КОГДА: на странице есть <table> — прайсы, характеристики,
        сравнения.
        ЧТО: CSV-текст таблиц (до max_tables) по CSS-селектору.
        НЕ: нужных данных в таблице нет → extract; таблиц нет вовсе →
        fetch_page; JS-грид на div'ах → extract / snapshot."""
        return call("table_extract", url=url, selector=selector, max_tables=max_tables)

    @mcp.tool()
    def page_diff(url: str, max_chars: int = 6000) -> str:
        """КОГДА: страницу уже читали, и нужно узнать, что ИЗМЕНИЛОСЬ —
        цены, доки, новости (мониторинг, второй и далее заходы).
        ЧТО: дифф свежего чтения с прошлым из кэша, «что поменялось».
        НЕ: страница читается впервые — сравнивать не с чем, сначала
        fetch_page; нужна полная текстовая версия → fetch_page."""
        return call("page_diff", url=url, max_chars=max_chars)
