#!/usr/bin/env python3
# Принадлежит: t.me/aidvizhenie · t.me/hilartem · t.me/aidvizh_hub — ищи в Телеграме

"""MCP-сервер веб-ресёрча на Camoufox (анти-детект Firefox). Тонкий каркас
(canon/FILE-SIZE.md): мост к воркеру — camoufox_research_bridge, тулы —
camoufox_research_tools (вестб-поиск/ресёрч) и session_tools (сессии/вижн).

Свой вместо готового camoufox-mcp: тот стартует браузер с headless=False
и без дисплея виснет. Здесь — headless=True, браузер в отдельном процессе
(camoufox_worker.py), тулы СИНХРОННЫЕ: FastMCP сам выполняет их в thread
pool, а async-тулы с subprocess в этой связке (mcp 1.x + python 3.14)
дедлочат event loop — проверено экспериментально.

Подключение (через scripts/install/install_mcp.py) в opencode/claude/codex/deepcode.
"""

import contextlib
import os
import sys
import time

# Windows-консоль по умолчанию cp1251 — переключаем на UTF-8 (Python 3.7+).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from mcp.server.caching import CacheHint
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

# Запуск как скрипт из подпапки (camoufox_worker спавнит именно так):
# sys.path[0] = каталог camoufox_research, где лежит ФАЙЛ camoufox_research.py
# — Python грузит его как «модуль camoufox_research» вместо пакета, и
# `from camoufox_research.X import` падает («is not a package»).
# Корень репо В ПЕРВУЮ ОЧЕРЕДЬ → пакет грузится из корня (хак оригинала).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from camoufox_research.camoufox_research_bridge import (
    _AUTH_KEY,
    _RATE_LIMIT,
    _RATE_LIMIT_MAX,
    _START_TIME,
    _call,
    tool_call,
)
from camoufox_research.camoufox_caps import ALWAYS_ON, DEFAULT_CAPS, resolve_caps
from camoufox_research.camoufox_research_tools import register as register_research
from camoufox_research.session_tools import register as register_session

# MCP v2 (SDK 2.1.1, спека 2026-07-28): FastMCP → MCPServer.
# ttlMs/cacheScope на tools/list: список тулов стабилен на жизнь сессии —
# клиент может кэшировать сутки (CacheHint, SEP-2549).
mcp = MCPServer(
    "camoufox-research",
    version="0.19.0",
    cache_hints={"tools/list": CacheHint(ttl_ms=86_400_000, scope="public")},
)


@mcp.tool()
def ping() -> str:
    """Проверка связи: возвращает pong."""
    return "pong"


# Тулы получают ОБЁРТКУ, а не голый _call: иначе ошибка воркера уезжает
# клиенту строкой с isError=false (см. tool_call в мосте).
register_research(mcp, tool_call)
register_session(mcp, tool_call)


# --- Заморозка порядка тулов (prompt-кэш гигиена, 28.08) ---
# Детерминированный порядок: по имени, один раз на старте. Стабильный
# список = стабильный префикс промпта (dev.to: смена порядка внутри
# разговора = инвалидация prompt-кэша; сортировка убирает зависимость
# от порядка вставки в коде). ttlMs/cacheScope — только в спеке
# 2026-07-28, в mcp 1.29 типов нет (проверено) — план на SDK 2.0.
def _freeze_tool_order() -> None:
    mcp._tool_manager._tools = dict(sorted(mcp._tool_manager._tools.items(), key=lambda kv: kv[0]))


_freeze_tool_order()


# --- Аннотации тулов (ToolAnnotations): что тул делает с миром (21.09) ---
# Зачем агенту: без hints все 60+ тулов для него одинаково опасны — он либо
# переспрашивает на каждом чтении, либо молча жмёт destructive-действие.
# Hints — ПРАВДА о туле, поэтому смысл берём из ОПЕРАЦИИ, а не из грозности
# имени, и у не-read-only тулов пишем destructive ЯВНО (дефолт спеки — true:
# «аддитивный» тул без явного false выглядел бы разрушительным).
#   read_only   — наблюдаемое состояние не меняется (кэш, TTL-артефакты и
#                 скриншот в свой каталог за изменение среды не считаем:
#                 чужого они не переписывают);
#   idempotent  — повтор с теми же аргументами не добавляет эффекта;
#   destructive — может затереть/сломать существующее: файл по указанному
#                 пути, состояние вкладки сессии, чужую running-кампанию
#                 (research_start при занятой очереди снимает зависшую);
#   open_world  — выход во внешний мир (сеть/браузер/LLM), а не локальные
#                 данные: ответ может отличаться от вызова к вызову.
#
# Ставим ЦЕНТРАЛИЗОВАННО после register, а не @mcp.tool(annotations=...):
# декоратор с kwargs ломает тесты, где MCP подменён заглушкой без
# параметров (@mcp.tool() в tests/test_tool_action_contract.py::_CollectingMCP
# и tests/test_caps.py::_FakeMCP) — там тулы регистрируются как раньше.
_READ_ONLY = frozenset({
    "ping", "web_search", "paper_search", "research", "research_status",
    "research_report", "research_index", "research_critic", "tool_hint",
    "tool_usage", "fetch_page", "batch_fetch", "extract_links",
    "browser_navigate", "check_links", "crawl", "map_site", "sitemap", "rss",
    "extract", "table_extract", "page_diff", "read_document", "snapshot",
    "screenshot", "session_status", "session_text", "session_links",
    "session_console", "session_network", "session_wait_for", "stats",
})

_OPEN_WORLD = frozenset({
    "web_search", "paper_search", "research", "research_digest",
    "citation_pack", "research_start", "research_resume", "research_critic",
    "service_route", "fetch_page", "batch_fetch", "extract_links",
    "browser_navigate", "browser_click", "browser_type", "check_links",
    "crawl", "map_site", "sitemap", "rss", "extract", "table_extract",
    "page_diff", "read_document", "snapshot", "screenshot", "session_start",
    "session_navigate", "session_back", "session_click", "session_type",
    "session_scroll", "session_links", "session_text", "session_status",
    "session_console", "session_network", "session_tabs", "session_wait_for",
    "session_eval", "session_key_press", "session_select_option",
    "session_resize", "session_form_fill", "session_upload",
    "session_download", "session_block", "session_unblock", "session_end",
})

# Может затереть/сломать уже существующее (см. шапку). service_route —
# роутер: наследует риск того, что дёргает (умеет стартовать сессию).
_DESTRUCTIVE = frozenset({
    "research_start", "research_cancel", "citation_report", "service_route",
    "browser_click", "browser_type", "export", "session_start", "session_end",
    "session_navigate", "session_click", "session_type", "session_key_press",
    "session_select_option", "session_form_fill", "session_eval",
    "session_download", "session_upload", "session_block", "session_unblock",
    "session_tabs", "set_proxy", "profile_load", "profile_save",
})

# Повтор с теми же аргументами НЕ добавляет эффекта. Это не «чтение»,
# поэтому read_only у них false — иначе спека игнорировала бы idempotent.
_IDEMPOTENT_WRITE = frozenset({
    "research_cancel", "session_block", "session_unblock", "session_end",
    "set_proxy",
})


def _apply_annotations() -> None:
    """Проставить hints тулам, классифицированным в таблицах выше (после register).

    Неклассифицированный тул (новая фича) остаётся БЕЗ hints: дефолты спеки
    (destructive=true, read_only=false) честнее выдуманного «аддитивный».
    Дрейф таблиц виден в stderr при старте, а не молча.
    """
    tools = mcp._tool_manager._tools
    known = _READ_ONLY | _OPEN_WORLD | _DESTRUCTIVE | _IDEMPOTENT_WRITE
    if known - set(tools):
        print(
            "annotations: имена без тула:", ", ".join(sorted(known - set(tools))), file=sys.stderr
        )
    if set(tools) - known:
        print(
            "annotations: тулы без классификации:",
            ", ".join(sorted(set(tools) - known)),
            file=sys.stderr,
        )
    for name, tool in tools.items():
        if name not in known:
            continue
        ro = name in _READ_ONLY
        tool.annotations = ToolAnnotations(
            read_only_hint=ro,
            # чистое чтение повторяется без последствий; у записи — явно
            idempotent_hint=ro or name in _IDEMPOTENT_WRITE,
            destructive_hint=not ro and name in _DESTRUCTIVE,
            open_world_hint=name in _OPEN_WORLD,
        )


_apply_annotations()

# --- MCP Resources: данные для чтения «как файлы» (4-й примитив
# протокола, MCP-канон 2026: tools + resources + prompts) ---


@mcp.resource("camoufox://stats")
def _res_stats() -> str:
    """Статистика вызовов тулов (audit, секреты замаскированы)."""
    return _call("stats", limit=50)


@mcp.resource("camoufox://cache")
def _res_cache() -> str:
    """Инфо о кэше: размер БД, записи (pages/searches/deltas), TTL."""
    return _call("cache_info")


@mcp.resource("camoufox://session")
def _res_session() -> str:
    """Состояние живой сессии: URL, заголовок, жива ли вкладка."""
    return _call("session_status")


@mcp.resource("camoufox://info")
def _res_info() -> str:
    """Инфо о сервере: имя, число тулов, список."""
    tools = sorted(mcp._tool_manager._tools.keys())
    return f"camoufox-research MCP-сервер\nтулов: {len(tools)}\n" + " ".join(tools)


@mcp.resource("camoufox://health")
def _res_health() -> str:
    """Healthcheck для production (MCP Best Practices 9,11): uptime, версия, rate-limit, auth."""
    uptime = int(time.monotonic() - _START_TIME)
    try:
        import importlib.metadata

        ver = importlib.metadata.version("camoufox-research")
    except Exception:
        ver = "0.19.0"
    tools = len(mcp._tool_manager._tools)
    total_calls = sum(len(v) for v in _RATE_LIMIT.values())
    auth_status = "включён (CAMOUFOX_API_KEY)" if _AUTH_KEY else "выключен"
    # health обязан называть ДЕЙСТВУЮЩИЙ профиль: пустой env — это уже не
    # «all» (аудит 21.09: подпись врала о 62 тулах при 34 в реестре).
    caps_status = os.environ.get("CAMOUFOX_CAPS", "").strip() or f"{DEFAULT_CAPS} (дефолт)"
    return (
        f'{{"status":"ok","version":"{ver}","uptime_s":{uptime},'
        f'"tools":{tools},"calls_last_min":{total_calls},'
        f'"rate_limit_max_per_min":{_RATE_LIMIT_MAX},"auth":"{auth_status}",'
        f'"caps":"{caps_status}"}}'
    )


# --- MCP Prompts: готовые рецепты для агента (шаблоны рабочих циклов) ---


@mcp.prompt()
def research_plan(topic: str) -> str:
    """Глубокий ресёрч темы: план «20+ источников, не топы»."""
    return (
        f"Тема: {topic}\n\n"
        "1. Разбей тему на 3-5 подзапросов (разные формулировки).\n"
        "2. Вызови research(queries=[...], max_results_per_query=6, "
        "target_domains=20, domains_limit=2, expand=True,\n"
        "   terms_wave=True, quality_first=True, fetch_all=True, "
        "as_json=True, max_chars=4000) — цель двадцать РАЗНЫХ\n"
        "   доменов; доки/код/arXiv первыми; вторая волна из "
        "термов первой; JSON для синтеза.\n"
        "3. Сопоставь источники: общее, противоречия, пробелы.\n"
        "4. Итог с цитатами источников."
    )


@mcp.prompt()
def extract_schema(url: str, fields: str) -> str:
    """Извлечение полей со страницы: поля → JSON-схема → extract."""
    return (
        f"URL: {url}\nНужные поля: {fields}\n\n"
        '1. Составь JSON-схему: {"поле": "css:.селектор"} '
        "(или xpath=//...).\n"
        "2. extract(url=..., schema=...).\n"
        "3. Если нужно сохранить: export(data=..., format='csv')."
    )


@mcp.prompt()
def monitor_page(url: str) -> str:
    """Мониторинг изменений страницы (delta + page_diff)."""
    return (
        f"URL: {url}\n\n"
        "1. fetch_page(url) — первое чтение (создаст кэш).\n"
        "2. Следующая проверка: page_diff(url) — покажет изменения.\n"
        "3. delta=True — не тратить токены на неизменный контент."
    )


# --- Фильтр тулов: контекст-инженерия (аудит 28.08.2026) ---
# >40 тулов в контексте = деградация выбора агентом (archestra, Merlonix);
# здесь — как в Playwright MCP (--caps): профили-группы поверх allowlist.
# Машина решает, какие тулы ВИДИТ агент:
#   CAMOUFOX_CAPS="research,browser,session,vision" — группы (профили),
#   CAMOUFOX_CAPS=all (или *) — полный реестр (62 тула, явный opt-out),
#   CAMOUFOX_TOOLS_ONLY="a,b,c" — ТОЛЬКО эти имена (allowlist),
#   CAMOUFOX_TOOL_HIDE="x,y" — спрятать эти (поверх всего).
# Приоритет: CAPS > TOOLS_ONLY > HIDE.
# НЕ ЗАДАНО = ДЕФОЛТ АГЕНТА (DEFAULT_CAPS = research,browser, 34 тула), а не
# «все тулы». Аудит 21.09: сервер без переменной отдавал 62, тогда как доки
# (docs/agent-usage.md) и консольная обёртка обещали 34 — агент видел вдвое
# больше поверхности, чем ему документировали, и выбирал хуже. Полный реестр
# теперь ЯВНЫЙ: CAMOUFOX_CAPS=all (или *). Профиль = контракт: одно число и в
# доке, и в реестре.
def _apply_tool_filter() -> None:
    only = os.environ.get("CAMOUFOX_TOOLS_ONLY", "").strip()
    hide = os.environ.get("CAMOUFOX_TOOL_HIDE", "").strip()
    caps = os.environ.get("CAMOUFOX_CAPS", "").strip()
    if caps.lower() in ("all", "*"):
        caps = ""  # явный полный реестр: профиль не режет
    elif not caps and not only:
        # Дефолт агента. Явный CAMOUFOX_TOOLS_ONLY специфичнее дефолта:
        # иначе галка «оставь только эти тулы» молча получила бы 34 чужих.
        caps = DEFAULT_CAPS
    if caps:
        keep, errors = resolve_caps(caps)
        if errors:
            print("caps:", "; ".join(errors), file=sys.stderr)
            if not keep.difference(ALWAYS_ON):
                # Опечатка не оставила ни одной известной группы: ping/stats
                # вместо всего цикла ресёрча — ХУЖЕ дефолта (агент теряет
                # поиск и чтение), поэтому при пустом профиле берём дефолт.
                keep = resolve_caps(DEFAULT_CAPS)[0] or set()
                print(f"caps: беру дефолт {DEFAULT_CAPS}", file=sys.stderr)
        only = ",".join(sorted(keep)) if keep else ""
    if not only and not hide:
        return

    keep = {x.strip() for x in only.split(",") if x.strip()}
    drop = {x.strip() for x in hide.split(",") if x.strip()}
    # list_tools() асинхронная и в v1, и в v2 (проверено интроспекцией 2.1.1)
    import asyncio

    for t in asyncio.run(mcp.list_tools()):
        if (only and t.name not in keep) or t.name in drop:
            # повторный прогон фильтра: тул уже удалён — не страшно
            with contextlib.suppress(Exception):
                mcp.remove_tool(t.name)


_apply_tool_filter()


def main():
    """Точка входа MCP-сервера (entry point: `camoufox-research`).
    Транспорты: stdio (по умолчанию), http (streamable), sse.
    Пример: camoufox-research --transport http --port 8833"""
    import argparse

    ap = argparse.ArgumentParser(description="camoufox-research MCP-сервер")
    ap.add_argument(
        "--transport",
        choices=["stdio", "http", "sse"],
        default="stdio",
        help="транспорт MCP (по умолчанию stdio); 'http' = streamable-http (v2)",
    )
    ap.add_argument(
        "--host", default="127.0.0.1", help="адрес для http/sse (по умолчанию 127.0.0.1)"
    )
    ap.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("CAMOUFOX_PORT", "8833")),
        help="порт для http/sse (или env CAMOUFOX_PORT)",
    )
    ap.add_argument(
        "--caps",
        default=os.environ.get("CAMOUFOX_CAPS", ""),
        help="профили тулов через запятую: research,browser,session,vision "
        "(не задано = дефолт research,browser; all = все тулы)",
    )
    args = ap.parse_args()
    # Второй прогон — только если CLI-значение ОТЛИЧАЕТСЯ от того, что уже
    # применил импорт (иначе предупреждения caps печатались дважды: env
    # подхватывается как default аргумента, см. аудит 21.09).
    if args.caps.strip() and args.caps.strip() != os.environ.get("CAMOUFOX_CAPS", "").strip():
        os.environ["CAMOUFOX_CAPS"] = args.caps.strip()
        _apply_tool_filter()  # второй прогон безопасен (guard в фильтре)
    # TTL-уборка кэша при старте (паттерн cleanupPeriodDays, см. housekeep):
    # страницы/диффы/поиск > 30 дней, отчёты exports > 90 дней. Ошибки
    # уборки не роняют сервер (бонус, не охота).
    try:
        from camoufox_research.camoufox_campaign import _DB_PATH
        from camoufox_research.camoufox_housekeep import cleanup

        cleanup(_DB_PATH)
    except Exception:
        pass
    if args.transport == "stdio":
        mcp.run()
    elif args.transport == "http":
        # MCP v2: транспорт переименован http → streamable-http (stateless)
        mcp.run(transport="streamable-http", host=args.host, port=args.port)
    else:
        # SSE-only транспорт deprecated в спеке 2026-07-28 (12 мес окно) —
        # оставлен для совместимости, новые клиенты → streamable-http
        mcp.run(transport="sse", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
