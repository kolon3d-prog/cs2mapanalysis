#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Session-режим: инфраструктура (вырезано из camoufox_session_core.py,
canon FILE-SIZE.md): регистрация живого браузера, вкладки, наблюдение
сети/консоли, фокусная страница. Действия (session_*) — в _b."""

import time
from collections import deque
from contextlib import suppress
from typing import Any

try:
    from camoufox_research.camoufox_browser import (
        _click_checked,
        _click_ref,
        _goto,
        _page_links,
        _som_overlay,
        _text,
        _wait_content,
    )
except ImportError:
    from camoufox_browser import (
        _goto,
    )

_LIVE_PROVIDER = None

def init_session(live_provider):
    """Воркер регистрирует доступ к живому браузеру (serve-режим)."""
    global _LIVE_PROVIDER
    _LIVE_PROVIDER = live_provider

def get_session_page():
    """Текущая страница сессии (или None) — для _close_pages воркера:
    страницу сессии НЕ закрывать между командами."""
    return _SESSION

_SESSION = None  # активная страница сессии (serve-режим)
_SESSION_URL = None  # последний URL сессии (восстановление упавшей вкладки)
_TABS: dict[str, Any] = {}  # вкладки сессии: {tab_id(str): page} — session_tabs
_NEXT_TAB = 1  # счётчик id вкладок

# Наблюдение страницы (сеть + консоль): {id(page): {...}} — ЕДИНЫЙ источник
# правды для session_network/session_console/session_block (читатели живут
# в camoufox_session_ext и берут состояние ТОЛЬКО через watch_state()).
# Паттерны stealth-browser-mcp (network inspection) и Playwright MCP
# (console messages) — агент видит AJAX-запросы и ошибки JS.
#
# Почему события page.on, а не page.route/CDP Fetch: события пассивны —
# трафик НЕ переписывается через Python, значит нет ни задержки на каждый
# запрос, ни смены фингерпринта, ни отключения кэша браузера (page.route
# даёт всё три сразу). Цена наблюдателя: два колбэка на запрос плюс кольцо
# памяти на 200 записей — она и есть аргумент против route. Запись идёт с
# МОМЕНТА открытия вкладки (_watch_page зовётся в _session_page ДО первого
# goto), отдельного «включить наблюдение» агенту не нужно.
#
# Канон ключей — "network"/"console"/"blocked". Урок 21.09.2026: писатель
# клал "net", читатель брал w["network"] — session_network падал
# KeyError на КАЖДОЙ вкладке, то есть HTTP-статус навигации (200/403/429)
# агенту не был виден вообще, и «страница пустая» оставалось догадкой.
_WATCH: dict[int, dict[str, Any]] = {}
_NET_LIMIT = 200  # кольцо последних запросов (старые вытесняются)
_CONSOLE_LIMIT = 100  # кольцо последних сообщений консоли

def watch_state(page):
    """Состояние наблюдения вкладки (None — вкладку не наблюдают).

    Читатели обязаны ходить сюда, а не в _WATCH напрямую: session_reset()
    пересоздаёт словарь, а фасад camoufox_session_core копирует имена по
    значению — прямая ссылка у читателя осталась бы на старом словаре и
    после сброса отдавала бы чужие запросы."""
    return _WATCH.get(id(page))

def _watch_page(page):
    """Навесить наблюдателей сети/консоли на страницу сессии (идемпотентно).
    Возвращает состояние наблюдения — тот же словарь, что отдаёт
    watch_state(page).

    Запрос пишется СРАЗУ (запрос без ответа — тоже факт: так видно
    оборванное), а ответ/ошибка дописывают статус в ту же запись — иначе
    один URL попадал бы в список дважды: «голый» запрос и ответ на него."""
    pid = id(page)
    if pid in _WATCH:
        return _WATCH[pid]
    state: dict[str, Any] = {
        "network": deque(maxlen=_NET_LIMIT),  # кольцо: агент видит последние
        "console": deque(maxlen=_CONSOLE_LIMIT),  # запросы, а не первые 200
        "blocked": [],  # реестр паттернов session_block (см. его докстринг)
    }
    _WATCH[pid] = state

    def _pending(row: dict[str, Any], url: str, method: str) -> bool:
        # Поиск записи идёт с КОНЦА и по url+method, а не по id(request):
        # между запросом и ответом объект request может быть собран GC, и
        # его id() переиспользуется другим запросом (тогда статус уехал бы
        # чужой строке).
        return (
            row["status"] is None
            and not row["error"]
            and row["url"] == url
            and row["method"] == method
        )

    def on_request(req: Any) -> None:
        state["network"].append(
            {
                "url": req.url,
                "method": req.method,
                "type": getattr(req, "resource_type", ""),
                "status": None,  # ответ ещё не пришёл
                "error": "",
                "ts": time.time(),
            }
        )

    def on_response(resp: Any) -> None:
        req = resp.request
        for row in reversed(state["network"]):
            if _pending(row, resp.url, req.method):
                row["status"] = resp.status
                row["type"] = getattr(req, "resource_type", row["type"])
                return
        # Ответ без виденного запроса (наблюдатель навесили в полёте) —
        # не теряем факт, пишем отдельной строкой.
        state["network"].append(
            {
                "url": resp.url,
                "method": req.method,
                "type": getattr(req, "resource_type", ""),
                "status": resp.status,
                "error": "",
                "ts": time.time(),
            }
        )

    def on_failed(req: Any) -> None:
        # Оборванный запрос: у нас это ещё и норма (в _goto стоит route,
        # который режет картинки/шрифты/стили) — агент должен видеть, что
        # ресурс не «висит», а срезан, иначе «пустой блок» снова догадка.
        err = str(getattr(req, "failure", "") or "оборван")
        for row in reversed(state["network"]):
            if _pending(row, req.url, req.method):
                row["error"] = err
                return

    def on_console(msg: Any) -> None:
        state["console"].append({"type": msg.type, "text": msg.text, "ts": time.time()})

    with suppress(Exception):  # навеска для живой страницы не критична
        page.on("request", on_request)
        page.on("response", on_response)
        page.on("requestfailed", on_failed)
        page.on("console", on_console)
    return state

def _unwatch_page(page):
    """Снять наблюдение: живую ссылку на вкладку никто больше не держит,
    значит id(page) может достаться другой вкладке — старое состояние
    отдало бы ей чужую сеть/консоль."""
    _WATCH.pop(id(page), None)

def get_session_pages():
    """Все живые вкладки сессии — _close_pages воркера их НЕ закрывает."""
    pages = set(_TABS.values())
    if _SESSION is not None:
        pages.add(_SESSION)
    return pages

def _session_page():
    """Фокусная страница сессии; создаёт/восстанавливает. Паттерны:
    agent-browser tab_gone + browser-use focus recovery — упавшая
    вкладка восстанавливается на последнем URL, а не теряется молча."""
    global _SESSION, _SESSION_URL, _NEXT_TAB
    live = _LIVE_PROVIDER() if _LIVE_PROVIDER else None
    if live is None:
        raise RuntimeError("session_* требует --serve (живой воркер)")
    if _SESSION is None:
        _SESSION = live[1].new_page()
        _watch_page(_SESSION)
        tid = str(_NEXT_TAB)
        _NEXT_TAB += 1
        _TABS[tid] = _SESSION
    elif _SESSION.is_closed():
        url = _SESSION_URL
        # Упавшую вкладку убираем из наблюдения и из _TABS: состояние
        # (сеть/консоль) мёртвой страницы осталось бы висеть под её id(), а
        # id() переиспользуется — чужая сеть досталась бы новой вкладке.
        _unwatch_page(_SESSION)
        for tid, page in list(_TABS.items()):
            if page is _SESSION:
                del _TABS[tid]
        _SESSION = live[1].new_page()
        _watch_page(_SESSION)
        tid = str(_NEXT_TAB)
        _NEXT_TAB += 1
        _TABS[tid] = _SESSION
        if url:
            with suppress(Exception):  # восстановление на последнем URL
                _goto(_SESSION, url)
    return _SESSION
