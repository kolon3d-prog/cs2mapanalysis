#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Батч-фетч и research (вынесено из camoufox_worker.py, canon/FILE-SIZE.md):
параллельный пул по ресурсам машины, rate-limit, deep-поиск одним вызовом."""

import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

try:
    from camoufox_research.camoufox_browser import (
        _browser_ctx,
        _goto,
        _launch,
        _search_results,
        _text,
        extract_retry,
    )
except ImportError:
    from camoufox_browser import (
        _browser_ctx,
        _goto,
        _launch,
        _text,
        extract_retry,
    )
try:
    from camoufox_research.camoufox_cache import (
        _CACHE_DB,
        _CACHE_TTL,
        _LEGACY_FETCH_LIMIT,
        fetch_limit,
        _cache_get,
        _cache_set,
        _prefetch_text,
    )
except ImportError:
    from camoufox_cache import (
        _LEGACY_FETCH_LIMIT,
        fetch_limit,
        _cache_get,
        _cache_set,
        _prefetch_text,
    )


# --- Полнота по умолчанию (замер 21.09.2026, цель «победить tavily/exa») ----
# Дефолт тулов был 4000 символов на страницу — это МЕНЬШЕ, чем отдают конкуренты
# (tavily 7-30k на страницу), и на обычной доковой странице 4000 = ~15% текста.
# Замер, 8 URL с разных доменов (docs.python.org, playwright.dev, MDN, wikipedia,
# sqlite.org, fastapi, docs.docker.com, kubernetes), холодный кэш:
#   max_chars=4000,  авто(2 воркера) →  32 598 симв. за 36.4с (все 8 уперлись в 4000)
#   max_chars=20000, авто(2 воркера) → 154 449 симв. за 85.2с (7 из 8 по 20000,
#                                       одна страница честно кончилась на 14 089)
#   max_chars=20000, 4 воркера       → 154 460 симв. за 37.7с (тот же контент, 2.3x)
# Ключевое: max_chars НЕ удорожает фетч — страница и так читается до потолка
# fetch_limit() (100k) и в кэш кладётся ЦЕЛИКОМ, max_chars режет только ответ.
# 12000 — компромисс: ~3k токенов на страницу при 30 URL ≈ 360k симв. (~90k токенов).
# Хочешь абсолютный максимум — max_chars=20000..100000 (потолок хранения 100k).
DEFAULT_CONTENT_CHARS = 12_000
# С какого размера батча включаем пул потоков. До порога дешевле ОДИН браузер
# на все URL (старт браузера ~0.5-1с + память на инстанс), после — выигрыш сети
# перекрывает старты. Замер на 8 URL: авто-2 воркера — 37.2 / 45.9 / 30.3с,
# 4 воркера — 29.6 / 31.0 / 37.7с (в двух прогонах из трёх выигрыш 1.5-2.3x,
# в третьем паритет: сетевые ожидания тут доминируют над CPU). Явный
# max_parallel порог отменяет — это прямой заказ клиента, см. _workers_for.
_PARALLEL_MIN_URLS = 8


_SAVE_SKILLS_WARNED = False   # «почему не сохранилось» — один раз на процесс


def _save_to_internet(url, text):
    """Persist fetched context without making persistence a fetch failure.

    Скрытый побочный эффект выключен по умолчанию — включается только
    при CAMOUFOX_SAVE_SKILLS=1 (оп-in, чтобы pip-пакет не писал в
    чужие skills без спроса).

    ФИЧА ВНЕШНЯЯ и сейчас МЁРТВАЯ (аудит 22.09): приёмник — модуль
    `skills_search` в каталоге <набор>/scripts/tools/skills; его нет ни в репо,
    ни в наборе, где репо стоит (проверено поиском по обоим). Раньше это
    (как и любую ошибку импорта/вызова) глушил `except Exception: pass`:
    `CAMOUFOX_SAVE_SKILLS=1` молча не делал НИЧЕГО. Теперь причина видна в
    stderr — «пропущено», а не «сохранено». Почему не «починить путь»: чинить
    тут нечего — модуля не существует, а придумывать за владельца, куда
    сохранять чужие скиллы, значит писать в чужой каталог наугад. Опт-ин
    оставлен как точка подключения: положит рядом skills_search.py — заработает.
    Ошибка печатается один раз на процесс: это диагноз конфигурации, а не
    событие на каждую выкачанную страницу.
    """
    if os.environ.get("CAMOUFOX_SAVE_SKILLS", "") != "1":
        return
    global _SAVE_SKILLS_WARNED
    skills_dir = Path(__file__).resolve().parents[2] / "scripts" / "tools" / "skills"
    if not (skills_dir / "skills_search.py").is_file():
        if not _SAVE_SKILLS_WARNED:
            _SAVE_SKILLS_WARNED = True
            print(
                f"CAMOUFOX_SAVE_SKILLS=1, но приёмника {skills_dir}/skills_search.py нет — "
                "страницы отдаю БЕЗ записи в skills (фича рассчитана на набор, где этот "
                "каталог есть)",
                file=sys.stderr,
            )
        return
    try:
        if str(skills_dir) not in sys.path:
            sys.path.insert(0, str(skills_dir))
        from skills_search import save_to_internet

        save_to_internet(url, url, text, "")
    except Exception as exc:  # noqa: BLE001 — побочка НЕ имеет права ронять fetch
        if not _SAVE_SKILLS_WARNED:
            _SAVE_SKILLS_WARNED = True
            print(
                f"CAMOUFOX_SAVE_SKILLS: сохранение не удалось "
                f"({type(exc).__name__}: {exc}) — страница отдана без записи в skills",
                file=sys.stderr,
            )


def _auto_workers():
    """Автоопределение числа параллельных браузеров по ресурсам машины.
    Паттерн индустрии Crawlee AutoscaledPool: concurrency масштабируется
    по CPU/памяти до потолка ресурсов, а не фиксирован — слабый ПК
    (2-4 ядра, 4-8GB) получит 1-2 воркера, мощный (16+ ядер, 32+GB) — 8.
    Бюджеты: ~1GB RAM на инстанс браузера (Camoufox ~400-700MB RSS),
    резерв 1.5GB системе; CPU: браузер ≈ 2 потока (рендер + IPC).
    Кроссплатформенно (stdlib): Linux — /proc/meminfo (MemAvailable);
    Windows — GlobalMemoryStatusEx (ullAvailPhys); macOS — vm_stat
    (SC_PHYS_PAGES даёт ВСЮ память, а не доступную — только fallback).
    Ничего не определилось — консервативно 2. Результат кэшируется."""
    try:
        cpus = os.cpu_count() or 4
        cpu_w = max(1, cpus // 2)
        mem_bytes = None
        if sys.platform == "linux" and os.path.exists("/proc/meminfo"):
            with open("/proc/meminfo", encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("MemAvailable:"):
                        mem_bytes = int(line.split()[1]) * 1024
                        break
        elif sys.platform == "darwin":
            try:
                # vm_stat: Pages free + inactive + speculative ≈ доступная
                out = subprocess.check_output(["vm_stat"], text=True, timeout=10).splitlines()
                vals = {}
                for ln in out:
                    m = re.match(r"\s*(.+?):\s+(\d+)", ln)
                    if m:
                        vals[m.group(1).lower()] = int(m.group(2)) * 4096
                free = vals.get("pages free", 0)
                inactive = vals.get("pages inactive", 0)
                spec = vals.get("pages speculative", 0)
                mem_bytes = free + inactive + spec or None
            except Exception:
                mem_bytes = None
            if not mem_bytes:
                # Fallback: SC_PHYS_PAGES — вся физическая память
                mem_bytes = (os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")) // 2
        elif sys.platform == "win32":
            try:
                import ctypes

                class _MemStat(ctypes.Structure):
                    _fields_ = [
                        ("dwLength", ctypes.c_ulong),
                        ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                    ]

                ms = _MemStat()
                ms.dwLength = ctypes.sizeof(_MemStat)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
                    mem_bytes = ms.ullAvailPhys
            except Exception:
                pass
        mem_w = max(1, int((mem_bytes - 1.5 * 1024**3) // (1024**3))) if mem_bytes else 4
        return min(cpu_w, mem_w, 8)
    except Exception:
        return 2


def _workers_for(n_todo, max_parallel=None):
    """Сколько воркеров пула нужно на n_todo URL (края важны, замер 21.09).

    Явный max_parallel — ЗАКАЗ клиента: уважаем как есть, но не больше задач
    (0/отрицательное = 1 = последовательный путь, «не распараллеливай»).
    Без него — авто по ресурсам машины (_auto_workers: тут 2 при 6 CPU и
    ~4GB MemAvailable) и тоже не больше задач. 0 задач → 0 воркеров.

    Ловушка прежней версии: порог «>=8 URL» отменял явную просьбу — на 6 URL
    max_parallel=4 не включал пул вовсе (замер: 32.4с и 47.8с — разница только
    в разбросе сети, воркер был один).
    """
    n = max(0, int(n_todo))
    if n <= 1:
        return n
    if max_parallel is not None:
        return max(1, min(int(max_parallel), n))
    return max(1, min(_auto_workers(), n))


def _fetch_one(url, max_chars, article_only):
    """Фетч одного URL ОТДЕЛЬНЫМ браузером — для параллельного батча
    (sync API не потокобезопасен: свой инстанс на поток, паттерн
    invisible_playwright). Ошибки не роняют пул."""
    suffix = ":article" if article_only else ""
    try:
        pre = _prefetch_text(url)
        if pre is not None:
            t = pre[:fetch_limit()]
            _cache_set(url, t, suffix)
            return url, t[:max_chars]
        with _launch() as browser:
            page = browser.new_page()
            _goto(page, url)
            t = extract_retry(page, url, article_only, fetch_limit())
        _cache_set(url, t, suffix)
        return url, t
    except Exception as e:
        return url, f"[ошибка: {type(e).__name__}: {e}]"


def batch_fetch(urls, max_chars=DEFAULT_CONTENT_CHARS, article_only=False, max_parallel=None):
    """Открывает НЕСКОЛЬКО URL в ОДНОМ браузере (один старт на все).

    Для глубокого ресёрча: 30-50 источников одним вызовом вместо
    30-50 холодных стартов. Кэш: уже посещённые URL — мгновенно, без
    браузера. Rate limit между переходами — чтобы не словить капчу.
    article_only=True — текст статьи (Trafilatura), без меню/баннеров.
    Батч >= 8 URL — параллельно: пул потоков, свой браузер на поток
    (сетевые ожидания перекрываются, throughput ~2-3x). Число воркеров
    АВТОМАТИЧЕСКИ подстраивается под ресурсы машины (_auto_workers:
    слабый ПК — 1-2, мощный — 3-4); явный max_parallel включает пул и на
    коротком батче (замер 21.09: 8 URL — 29.6-37.7с на 4 воркерах против
    30.3-85.2с на авто-2 при одинаковом контенте; на 6 URL max_parallel
    раньше вообще игнорировался — порог >=8 отменял просьбу).
    Возвращает тексты с разделителями --- URL: ...

    ХОЧУ ПОЛНОТУ (дефолт уже 12000 симв. на страницу — больше, чем у
    tavily/exa): max_chars=20000..100000 (потолок хранения — fetch_limit(),
    100k; время фетча от max_chars НЕ зависит, страница читается целиком и
    кладётся в кэш, режется только ответ), article_only=True (без меню и
    баннеров — на доковой странице это +20-40% полезного текста),
    max_parallel=4. ХОЧУ ЭКОНОМИЮ КОНТЕКСТА: max_chars=4000 и 30+ URL.
    """
    if not urls:
        return "ошибка: пустой список URL"
    suffix = ":article" if article_only else ""
    texts = {}
    todo = []
    for u in urls:
        cached = _cache_get(u, suffix)
        # Тот же страж, что в fetch_page: кэш, снятый под НИЗКИЙ потолок
        # (легаси 12k или CAMOUFOX_FETCH_LIMIT=12000), не должен запирать
        # «дай больше» на сутки. Замер 21.09: article-кэш en.wikipedia.org
        # (Web_scraping) — 12000 симв., и batch_fetch(max_chars=20000) отдал
        # РОВНО 11999 за 0.0с (из БД), хотя страница длиннее; после правки —
        # перечитка и полный текст на 34199 симв.
        if (cached is not None and max_chars > len(cached)
                and len(cached) >= _LEGACY_FETCH_LIMIT):
            cached = None
        if cached is not None:
            texts[u] = cached
        else:
            todo.append(u)
    if todo:
        workers = _workers_for(len(todo), max_parallel)
        # Пул поднимаем либо на большом батче, либо по прямой просьбе клиента:
        # на 2-3 URL выигрыш сети меньше цены старта своего браузера на поток.
        if workers > 1 and (len(todo) >= _PARALLEL_MIN_URLS or max_parallel):
            # Per-host bounded concurrency (паттерн proxiesapi/Crawlee):
            # сколько бы ни было воркеров, на ОДИН домен — не больше 2
            # параллельных запросов (иначе мощная машина словит капчу
            # собственным рвением). Разные домены — до workers штук.
            _domain_sems = {}
            _sems_guard = threading.Lock()

            def _run(u):
                with _sems_guard:
                    sem = _domain_sems.setdefault(urlparse(u).netloc, threading.Semaphore(2))
                with sem:
                    time.sleep(0.4)  # rate limit между запросами
                    result = _fetch_one(u, max_chars, article_only)
                    _save_to_internet(u, result[1])
                    return result

            with ThreadPoolExecutor(max_workers=workers) as ex:
                futures = [ex.submit(_run, u) for u in todo]
                for f in futures:
                    u, t = f.result(timeout=300)
                    texts[u] = t
        else:
            with _browser_ctx() as browser:
                page = browser.new_page()
                for i, u in enumerate(todo):
                    try:
                        _goto(page, u)
                        # extract_retry, а не голый _text: у короткого батча
                        # была ХУДШАЯ полнота, чем у параллельного (там ретрай
                        # «пустой страницы» со скроллом/перезаходом), хотя это
                        # одна и та же добыча — просто на другом пути (21.09).
                        t = extract_retry(page, u, article_only, fetch_limit())
                        _cache_set(u, t, suffix)
                        texts[u] = t
                        _save_to_internet(u, t)
                    except Exception as e:
                        texts[u] = f"[ошибка: {type(e).__name__}: {e}]"
                    if i < len(todo) - 1:
                        time.sleep(0.4)  # rate limit между переходами
    out = []
    for u in urls:
        t = texts.get(u, "[ошибка: URL не обработан]")
        out.append(f"--- URL: {u}\n{t[:max_chars]}")
    return "\n\n".join(out)


def extract(url, schema, llm=False):
    """Извлечение по схеме (паттерн Firecrawl extract):
    без llm (по умолчанию) — селекторы CSS/XPath:
    schema — JSON: {"поле": "css:.price"} или
    {"поле": {"selector": ".price", "attr": "text|href|src"}}.
    llm=True — LLM-извлечение ИЗ ТЕКСТА страницы (структура неизвестна/
    меняется, селекторы не сходятся): schema — {"поле": подсказка}
    или {"поле": {"hint": "..."}}; требует LLM (DeepSeek/Ollama).
    Возвращает JSON: поле → значение/список (до 5 совпадений)."""
    try:
        spec = json.loads(schema) if isinstance(schema, str) else schema
    except Exception:
        return 'ошибка: schema не JSON — нужен объект {"поле": "селектор"}'
    if not isinstance(spec, dict) or not spec:
        return "ошибка: schema должна быть непустым JSON-объектом"
    with _browser_ctx() as browser:
        page = browser.new_page()
        _goto(page, url)
        if llm:
            from camoufox_research.camoufox_llm import llm_extract_fields

            return llm_extract_fields(_text(page, 15000), spec)
        out = {}
        for field, rule in spec.items():
            if isinstance(rule, dict):
                sel = rule.get("selector", "")
                attr = rule.get("attr", "text")
            else:
                sel, attr = rule, "text"
            if not sel:
                out[field] = "ошибка: пустой селектор"
                continue
            sel = sel.removeprefix("css:")  # Firecrawl-стиль "css:.price" → Playwright
            if sel.startswith("//"):
                sel = "xpath=" + sel  # XPath: "//div[@class='x']" (Crawl4AI/Playwright)
            try:
                n = page.locator(sel).count()
                if n == 0:
                    out[field] = None
                    continue
                vals = []
                for i in range(min(n, 5)):
                    loc = page.locator(sel).nth(i)
                    if attr == "text":
                        vals.append(loc.inner_text(timeout=2000).strip())
                    else:
                        vals.append(loc.get_attribute(attr))
                out[field] = vals[0] if len(vals) == 1 else vals
            except Exception as e:
                out[field] = f"[ошибка: {type(e).__name__}: {e}]"
    return json.dumps(out, ensure_ascii=False, indent=2)


# Шаблоны расширения запросов: переформулировки добавляют ДРУГИЕ домены
# (паттерн query expansion, agentlist.top: 80% качества = запросы).
_EXPAND_SUFFIXES = (" comparison", " documentation")
