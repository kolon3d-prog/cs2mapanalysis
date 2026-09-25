#!/usr/bin/env python3
# Принадлежит: t.me/aidvizhenie · t.me/hilartem · t.me/aidvizh_hub — ищи в Телеграме

"""Профили тулов (--caps / CAMOUFOX_CAPS): группа → имена тулов.

Это контекст-инженерия, а не удобство: 62 тула в промпте агента = деградация
выбора (индустрия: после ~40 качество выбора падает — archestra.ai, arXiv
2602.18914/2605.05247; Playwright MCP лечит тем же флагом --caps). Профиль
задаёт КЛИЕНТ или обёртка, сервер лишь исполняет:

* ДЕФОЛТ агента — DEFAULT_PROFILE = research+browser (34 тула): весь цикл
  «поиск → чтение → выжимки → цитаты» укладывается в 32 тула групп + 2
  вечных, то есть под порогом деградации. Это же значение ставит консольная
  обёртка (scripts/install_mcp.py, CAMOUFOX_CAPS:-…), и ЕГО ЖЕ применяет сам
  сервер, когда CAMOUFOX_CAPS не задан (camoufox_research._apply_tool_filter)
  — дефолт у агента ОДИН, и он же — предмет документации, а не догадок.
* OPT_IN — session (26 тулов) и vision (2): сессия живёт состоянием вкладки
  (её тулы уместны только тому, кто сессию ведёт), а screenshot жжёт токены
  картинкой. session_eval (JS в странице = максимум прав) лежит внутри
  session → в дефолт не попадает НИКОГДА.
* Полный реестр (62 тула) — ЯВНО: CAMOUFOX_CAPS=all (или *). Аудит 21.09:
  раньше «не задано» = все тулы, и сервер отдавал 62 при документации на 34
  — на полный реестр опираются тесты и гейты, поэтому они и просят all.

ALWAYS_ON (ping/stats) не режется никогда: здоровье и наблюдаемость нужны в
любом профиле. Новый тул БЕЗ группы → tests/test_caps.py краснеет
(fail-fast: тул молча пропал бы из реестра при caps)."""

GROUPS: dict[str, tuple[str, ...]] = {
    "research": (
        "web_search",
        "research",
        "paper_search",
        "research_start",
        "research_status",
        "research_report",
        "research_resume",
        "research_cancel",
        "research_index",
        "research_digest",
        "citation_pack",
        "citation_report",
        "research_critic",
        "tool_hint",
        "service_route",
        "tool_usage",
    ),
    "browser": (
        "fetch_page",
        "batch_fetch",
        "extract_links",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "extract",
        "table_extract",
        "crawl",
        "map_site",
        "sitemap",
        "rss",
        "read_document",
        "check_links",
        "export",
        "page_diff",
    ),
    "session": (
        "session_start",
        "session_navigate",
        "session_click",
        "session_type",
        "session_scroll",
        "session_links",
        "session_text",
        "session_back",
        "session_status",
        "session_end",
        "session_tabs",
        "session_wait_for",
        "session_eval",
        "session_key_press",
        "session_select_option",
        "session_resize",
        "session_network",
        "session_console",
        "session_block",
        "session_unblock",
        "session_download",
        "session_upload",
        "session_form_fill",
        "set_proxy",
        "profile_save",
        "profile_load",
    ),
    "vision": ("snapshot", "screenshot"),
}

# всегда видны агенту и клиенту (здоровье + наблюдаемость)
ALWAYS_ON: tuple[str, ...] = ("ping", "stats")

# Дефолт и opt-in — решение 21.09 (аудит промпт-поверхности): 34 тула вместо
# 62. Смысл дефолта — закрыть весь цикл ресёрча БЕЗ живого браузера; всё, что
# требует состояния вкладки (session) или картинок (vision), — явный opt-in,
# иначе агент видит 26 тулов, которыми не пользуется, и выбирает хуже.
DEFAULT_PROFILE: tuple[str, ...] = ("research", "browser")
OPT_IN_GROUPS: tuple[str, ...] = ("session", "vision")
DEFAULT_CAPS: str = ",".join(DEFAULT_PROFILE)  # канон строки для доков/обёрток

GROUP_HINTS: dict[str, str] = {
    "research": "поиск и кампании (web_search, research_start, выжимки, цитаты)",
    "browser": "чтение и добыча (fetch_page, extract, crawl, rss, документы)",
    "session": "живая вкладка (клики, формы, сеть, файлы, профили, eval)",
    "vision": "картинка (snapshot — структура с ref, screenshot — PNG)",
}


def profile_rows() -> list[tuple[str, int, str]]:
    """Таблица «профиль → сколько тулов → что внутри» для доков и проб.

    Считается из GROUPS, а не пишется руками: docs/agent-usage.md тогда не
    может разойтись с реестром (иначе агент читает устаревшие числа и
    включает не те группы)."""
    rows: list[tuple[str, int, str]] = []
    for label, groups in (
        (f"{DEFAULT_CAPS} (дефолт агента)", DEFAULT_PROFILE),
        (f"{DEFAULT_CAPS},session", (*DEFAULT_PROFILE, "session")),
        (f"{DEFAULT_CAPS},vision", (*DEFAULT_PROFILE, "vision")),
        ("all = все тулы (явно)", tuple(GROUPS)),
    ):
        uniq = list(dict.fromkeys(groups))
        names: set[str] = set(ALWAYS_ON)
        for g in uniq:
            names.update(GROUPS[g])
        what = "; ".join(GROUP_HINTS[g] for g in uniq)
        rows.append((label, len(names), what))
    return rows


def resolve_caps(caps: str) -> tuple[set[str] | None, list[str]]:
    """caps — 'research,browser'; вернуть (keep-имена, ошибки).

    Пустая строка → (None, []) = «профиль не задан» (чистая функция без
    политики; сам сервер подставляет на этом месте DEFAULT_CAPS, а
    тесты/гейты просят полный реестр явным all).
    Неизвестная группа → ошибка + совет; известные группы всё равно
    применяются (не валим всё из-за опечатки в одной группе).
    ALWAYS_ON добавляется всегда (ping/stats не пропадают)."""
    if not caps.strip():
        return None, []
    keep: set[str] = set()
    errors: list[str] = []
    for g in {x.strip().lower() for x in caps.split(",") if x.strip()}:
        if g in GROUPS:
            keep.update(GROUPS[g])
        else:
            errors.append(f"неизвестная группа «{g}» (есть: {', '.join(sorted(GROUPS))})")
    keep.update(ALWAYS_ON)
    return keep, errors
