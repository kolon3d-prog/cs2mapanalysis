#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Кампании ресёрча: цель по РАЗНЫМ источникам, счётчик прогресса, отчёт.

Паттерн индустрии (gpt-researcher state, LangGraph checkpointing): агент
думает — сервер ПОМНИТ (сколько уникальных доменов прочитано, что осталось).
Состояние в том же sqlite, что кэш; фон — отдельный процесс (campaign_runner,
лог + маркер done_file). Тексты страниц не тащим — синтез читает batch_fetch.
"""
import json
import os
import contextlib
import sqlite3
import time
from pathlib import Path

try:
    from camoufox_research import camoufox_paths as _paths
except ImportError:
    import camoufox_paths as _paths

# Override для тестов: временная база вместо домашнего кэша.
# `_DB_PATH` — значение НА МОМЕНТ ИМПОРТА (его патчат тесты атрибутом);
# `_db()` дополнительно смотрит env НА КАЖДОМ вызове: иначе база
# фиксировалась тем, кто первым импортировал core, и соседний тест-модуль,
# выставивший CAMOUFOX_CAMPAIGN_DB в setUpClass, писал в чужую базу
# («нет кампании cmp_test» — ловится при прогоне нескольких модулей в
# одном процессе, порядок файлов решает; 21.09).
_DB_PATH = os.environ.get("CAMOUFOX_CAMPAIGN_DB", str(_paths.cache_db()))

_RUNNER = Path(__file__).resolve().parent / "campaign_runner.py"
_EXPORT_DIR = Path(_paths.export_dir())  # legacy-алиас; код использует _export_dir()


def _export_dir() -> Path:
    """Каталог экспорта кампаний (лениво: env CAMOUFOX_CACHE_DIR читается тут)."""
    return _paths.export_dir()

# Углы второй волны (STORM-lite: разные точки зрения без LLM).
_ANGLE_SUFFIXES = (" best practices", " how it works", " problems",
                   " alternatives")

# Очередь углов РЕСЬЮМА: каждый заход доборки берёт СВОЙ набор —
# повторять уже сработавшие суффиксы = собирать те же домены (нулевая
# волна). Очередь кончилась → честный partial, не блеф.
_RESUME_ROUNDS = (
    (" tutorial", " example"),
    (" comparison 2026", " vs"),
    (" case study", " release notes"),
)

_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        queries TEXT NOT NULL,
        target_sources INTEGER NOT NULL,
        domains_limit INTEGER DEFAULT 2,
        feeds TEXT DEFAULT '[]',
        status TEXT DEFAULT 'running',
        error TEXT DEFAULT '',
        created_ts REAL, updated_ts REAL);
    CREATE TABLE IF NOT EXISTS campaign_sources (
        camp_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT DEFAULT '',
        domain TEXT DEFAULT '',
        tier INTEGER DEFAULT 2,
        tier_label TEXT DEFAULT '',
        snippet TEXT DEFAULT '',
        added_ts REAL,
        UNIQUE(camp_id, url));""")

_DDL_DONE = False

def _ensure_search_calls(con):
    """Миграция 28.08: search_calls (бюджет в БД, кросстаблично)."""
    with contextlib.suppress(Exception):
        con.execute("ALTER TABLE campaigns ADD COLUMN search_calls INTEGER DEFAULT 0")



def _db():
    """Соединение к базе (+мягкая миграция feeds для старых баз).

    Путь: CAMOUFOX_CAMPAIGN_DB (env, читается ЗДЕСЬ — см. комментарий
    у _DB_PATH) → _DB_PATH (патчат тесты).
    """
    global _DDL_DONE
    con = sqlite3.connect(os.environ.get("CAMOUFOX_CAMPAIGN_DB") or _DB_PATH)
    if not _DDL_DONE:
        con.executescript(_SCHEMA)
        cols = {r[1] for r in con.execute("PRAGMA table_info(campaigns)")}
        if "feeds" not in cols:
            con.execute("ALTER TABLE campaigns ADD COLUMN feeds TEXT "
                        "DEFAULT '[]'")
        scol = {r[1] for r in con.execute(
            "PRAGMA table_info(campaign_sources)")}
        if "digest" not in scol:  # выжимка (пост-обработка охоты)
            con.execute("ALTER TABLE campaign_sources ADD COLUMN "
                        "digest TEXT DEFAULT ''")
        if "live" not in scol:  # verified: -1/1/0 (жив-или-кэш/битый)
            con.execute("ALTER TABLE campaign_sources ADD COLUMN "
                        "live INTEGER DEFAULT -1")
        vts = {r[1] for r in con.execute(
            "PRAGMA table_info(campaign_sources)")}
        if "verified_ts" not in vts:  # TTL-кэш верификации (28.08):
            con.execute("ALTER TABLE campaign_sources ADD COLUMN "
                        "verified_ts REAL DEFAULT 0")  # повторная проверка не ждёт сети
        _DDL_DONE = True
    _ensure_search_calls(con)
    return con


def _search_budget():
    """Лимит поисковых ВЫЗОВОВ на кампанию (CAMOUFOX_SEARCH_BUDGET).

    Единица — вызов (запрос в DDG + запрос в академический канал), НЕ
    волна: аудит 21.09 — кампания писала в search_calls «+1 за волну»
    против лимита в вызовах, и «5/40» в статусе означало 5 волн
    (реально до ~200 вызовов за кампанию).
    """
    try:
        return max(1, int(os.environ.get("CAMOUFOX_SEARCH_BUDGET", "40")))
    except ValueError:
        return 40


def _spent_calls(camp_id):
    """Сколько вызовов кампания уже сделала (campaigns.search_calls)."""
    with _db() as con:
        row = con.execute("SELECT COALESCE(search_calls,0) FROM campaigns "
                          "WHERE id=?", (camp_id,)).fetchone()
    return int(row[0]) if row else 0


def _charge_calls(camp_id, calls):
    """Списать УШЕДШИЕ вызовы волны в campaigns.search_calls (та же единица)."""
    calls = int(calls)
    if calls <= 0:
        return
    with _db() as con:
        con.execute("UPDATE campaigns SET search_calls = "
                    "COALESCE(search_calls,0)+? WHERE id=?", (calls, camp_id))


def _acad_cost(academic):
    """Цена академической ноги для ОДНОГО запроса (0 при academic=False).

    Академия шла мимо бюджета, хотя каждый её запрос — до 4 сетевых
    каналов (arXiv/S2/Crossref/Wiki): число каналов спрашиваем у самой
    ноги, чтобы цена не разошлась с кодом (acad_call_cost).
    """
    if not academic:
        return 0
    try:
        from camoufox_research.camoufox_academic import acad_call_cost
    except ImportError:
        from camoufox_academic import acad_call_cost
    return acad_call_cost()


def _wave_plan(camp_id, wq, academic):
    """Волна по ОСТАТКУ бюджета: (запросы, цена одного запроса в вызовах).

    Остаток меньше цены одного запроса → пустой список: крутить волну
    нулевой длины = писать в лог «волна 0 запросов» и жечь круг впустую.
    """
    cost = 1 + _acad_cost(academic)
    left = _search_budget() - _spent_calls(camp_id)
    if not wq or left < cost:
        return [], cost
    return list(wq)[:max(1, left // cost)], cost


def _budget_stop_note(camp_id, cost):
    """Строка причины для _finish/лога: остаток не покрывает запрос.

    Числа тут те же, что у лимита (вызовы), и та же арифметика, что в
    _wave_plan: агент видит, СКОЛЬКО осталось и почему волны больше нет.
    """
    left = _search_budget() - _spent_calls(camp_id)
    return (f"бюджет: остаток {left}/{_search_budget()} вызовов не покрывает "
            f"запрос (цена {cost}) — стоп")

def _reg_domain(url):
    """Регистрируемый домен (единый счётчик «разные сайты» — sources.py)."""
    try:
        from camoufox_research.camoufox_sources import _reg_domain as reg
    except ImportError:
        from camoufox_sources import _reg_domain as reg
    return reg(url)

def _log(log_path, msg):
    """Строка прогресса в лог: таймштамп + сообщение (свежесть видна сразу)."""
    try:
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except Exception:
        pass

def _ingest(camp_id, payload):
    """Источники из research(as_json=True) → база. Возвращает (новые, всего, уникальных_доменов).

    tier 3 (реклама/поисковые редиректы) НЕ ingested: живая проба поймала
    duckduckgo.com/y.js?ad_domain=... — реклама в отчёте = мусор в цитатах.
    """
    fresh = skipped = 0
    with _db() as con:
        for row in payload.get("sources", []):
            if row.get("tier") == 3:
                skipped += 1
                continue
            # ЯВНЫЕ колонки: у соседей таблица растёт (digest, live) —
            # позиционный INSERT падал «10 columns but 8 values» (27.08).
            cur = con.execute(
                "INSERT OR IGNORE INTO campaign_sources "
                "(camp_id, url, title, domain, tier, tier_label, snippet, "
                "added_ts) VALUES (?,?,?,?,?,?,?,?)",
                (camp_id, row.get("url", ""), row.get("title", ""),
                 row.get("domain") or _reg_domain(row.get("url", "")),
                 row.get("tier", 2), row.get("tier_label", ""),
                 (row.get("snippet") or "")[:200], time.time()))
            fresh += cur.rowcount
        total, uniq = con.execute(
            "SELECT COUNT(*), COUNT(DISTINCT domain) FROM campaign_sources "
            "WHERE camp_id=?", (camp_id,)).fetchone()
    return fresh, total, uniq, skipped

def _finish(camp_id, topic, status, total, uniq, target, notes, done_path):
    """Единый финал: строка в базе + маркер done_file (ЖДУТ ЕГО, не лог)."""
    with _db() as con:
        # error-пометка: ПРИЧИНА в НАЧАЛО (28.08: notes длинные —
        # «авто-стоп» в конце утонул бы в обрезке [:200]).
        _err = "; ".join(notes)
        _cause = next((n for n in notes
                       if n.startswith(("авто-стоп", "нулевая волна", "бюджет"))), "")
        _err = (_cause + " | " + _err if _cause else _err)[:200]
        con.execute(
            "UPDATE campaigns SET status=?, updated_ts=?, error=? WHERE id=?",
            (status, time.time(), _err or "", camp_id))
    marker = {"id": camp_id, "topic": topic, "status": status,
              "sources": total, "unique_domains": uniq,
              "target": target, "notes": notes,
              "done_ts": time.strftime("%d.%m %H:%M:%S")}
    Path(done_path).write_text(
        json.dumps(marker, ensure_ascii=False, indent=1), encoding="utf-8")
    # автоархив отчёта + путь в маркер (housekeep: хоз-функции кампании)
    try:
        from camoufox_research.camoufox_housekeep import marker_update, save_report
    except ImportError:
        from camoufox_housekeep import marker_update, save_report
    try:
        from camoufox_research.camoufox_campaign_ext import report as _report
    except ImportError:
        from camoufox_campaign_ext import report as _report
    saved = save_report(camp_id, topic, status, notes, _report(camp_id))
    if saved:
        marker_update(done_path, "report", saved)

def _feed_leg(camp_id, feeds, notes):
    """Нога-фиды (RSS/sitemap): источники без поисковика (DDG мёртв —
    фиды живут). Форматы rss()/sitemap() детерминированы — парсим их."""
    if not feeds:
        return
    try:
        from camoufox_research.camoufox_crawl import rss, sitemap
    except ImportError:
        from camoufox_crawl import rss, sitemap
    try:
        from camoufox_research.camoufox_sources import _reg_domain, domain_tier
    except ImportError:
        from camoufox_sources import _reg_domain, domain_tier
    rows = []
    for f in feeds:
        try:
            if "sitemap" in f.lower() or f.lower().endswith(".xml"):
                for u in (sitemap(f) or "").splitlines():
                    u = u.strip()
                    if u.startswith("http"):
                        rows.append({"title": "", "url": u})
            else:
                lines = (rss(f) or "").splitlines()
                for i in range(len(lines) - 1):
                    if lines[i].startswith("[") and "] " in lines[i]:
                        title = lines[i].split("] ", 1)[1].strip()
                        link = lines[i + 1].strip()
                        if link.startswith("http"):
                            rows.append({"title": title, "url": link})
        except Exception:
            continue
    if not rows:
        notes.append("фиды: пусто/не прочитались")
        return
    for r in rows:
        r["domain"] = _reg_domain(r["url"])
        r["tier"], r["tier_label"] = domain_tier(r["url"])
        r.setdefault("snippet", "")
    fresh, _total, uniq, skipped = _ingest(camp_id, {"sources": rows})
    notes.append(f"фиды:+{fresh} новых ({uniq} доменов)")
    if skipped:
        notes[-1] += f", реклама отсеяна: {skipped}"

def hunt(camp_id, topic, queries, target, dl, log_path, done_path,
         feeds=None, llm_planner=False, terms_wave=True, academic=False):
    """Механическая охота: фиды → волны research() до цели. Недобор =
    честный partial: БЛЕФ «готово» ЗАПРЕЩЁН.

    terms_wave/academic приходят от research_start (или фон-раннера):
    термовая волна добора и академический канал — переключаемые,
    потому что на неакадемической теме академический канал тянет
    мусор, а не «первоисточники» (урок 21.09)."""
    try:
        from camoufox_research.camoufox_fetch import research  # поздний импорт: тянет браузер
    except ImportError:
        from camoufox_fetch import research  # поздний импорт: тянет браузер
    notes = []
    waves = [[*queries]]
    # Фиды-кампании с пустыми queries: waves[0] = [] → все волны
    # пропускаются «если not wq» (проверено 27.08: partial 3/12 доменов,
    # фиды дали 40 источников, поиск не сработал). Тема — база запросов.
    if not waves[0]:
        waves[0] = [(topic or "web research")[:80]]
    waves.append([q + s for q in waves[0] for s in _ANGLE_SUFFIXES])
    try:
        if feeds:
            _log(log_path, f"нога-фиды: {len(feeds)} фидов")
            _feed_leg(camp_id, feeds, notes)
            _log(log_path, notes[-1])
        _dead_waves = 0  # счётчик подряд идущих мусорных волн — ДО цикла:
        # внутри цикла он обнулялся на каждой итерации, и авто-стоп
        # «2+ волны подряд с +0 новых» не срабатывал НИКОГДА (21.09)
        for i, wq in enumerate(waves, 1):
            if not wq:  # кормились фидами — поисковая нога не нужна
                continue
            with _db() as con:
                total, uniq = con.execute(
                    "SELECT COUNT(*), COUNT(DISTINCT domain) FROM "
                    "campaign_sources WHERE camp_id=?",
                    (camp_id,)).fetchone()
            if uniq >= target:
                break
            # БЮДЖЕТ (единица — ВЫЗОВ): волну пускаем только на остаток,
            # иначе DDG+академия уходят в перерасход (аудит 21.09).
            dispatch, cost = _wave_plan(camp_id, wq, academic)
            if not dispatch:
                notes.append(_budget_stop_note(camp_id, cost))
                _log(log_path, notes[-1])
                break
            _log(log_path, f"волна {i}: {len(dispatch)} запросов "
                           f"(уже {uniq}/{target}) · бюджет "
                           f"{_spent_calls(camp_id)}/{_search_budget()} вызовов")
            use_llm = llm_planner or bool(__import__('os').environ.get('CAMOUFOX_LLM_PLANNER'))
            raw = research(queries=dispatch, max_results_per_query=10,
                           target_domains=target, domains_limit=dl,
                           terms_wave=terms_wave, quality_first=True,
                           academic=academic, fetch_all=False, as_json=True,
                           llm_planner=use_llm)
            # Вызовы УШЛИ в сеть — списываем сразу (ответ мог и не
            # распарситься, но бюджет уже потрачен): len(dispatch)
            # запросов × (DDG + академические каналы).
            _charge_calls(camp_id, len(dispatch) * cost)
            payload = json.loads(raw) if isinstance(raw, str) else {}
            fresh, total, uniq, skipped = _ingest(camp_id, payload)
            notes.append(f"волна{i}:+{fresh} новых ({uniq}/{target} доменов)"
                         + (f", реклама отсеяна: {skipped}" if skipped else ""))
            _log(log_path, notes[-1])
            # АВТО-СТОП ПРИ МУСОРЕ (28.08, индустрия strict_budget):
            # 2+ волны подряд с +0 новых = охота впустую (другие углы
            # не дают доменов) — завершаем честно (partial), не жжём
            # бюджет. Ранее только писали в лог, теперь — стоп.
            if fresh == 0:
                _dead_waves += 1
                if _dead_waves >= 2:
                    notes.append("авто-стоп: 2+ мусорные волны подряд — "
                                 "охота впустую, завершаем честно")
                    _log(log_path, notes[-1])
                    break
            else:
                _dead_waves = 0
        with _db() as con:
            total, uniq = con.execute(
                "SELECT COUNT(*), COUNT(DISTINCT domain) FROM "
                "campaign_sources WHERE camp_id=?", (camp_id,)).fetchone()
        status = "done" if uniq >= target else "partial"
        _finish(camp_id, topic, status, total, uniq, target, notes, done_path)
        _log(log_path, f"финал: {status}, {uniq}/{target} доменов · бюджет "
                       f"{_spent_calls(camp_id)}/{_search_budget()} вызовов")
        try:
            from camoufox_research.camoufox_housekeep import post_pack
        except ImportError:
            from camoufox_housekeep import post_pack
        post_pack(camp_id, log_path, done_path)
    except Exception as e:
        _log(log_path, f"падение: {type(e).__name__}: {e}")
        total, uniq = _counts(camp_id)
        _finish(camp_id, topic, "failed", total, uniq,
                _target_of(camp_id), [f"{type(e).__name__}: {e}"],
                done_path)

def _counts(camp_id):
    with _db() as con:
        return con.execute(
            "SELECT COUNT(*), COUNT(DISTINCT domain) FROM campaign_sources "
            "WHERE camp_id=?", (camp_id,)).fetchone()

def _target_of(camp_id):
    with _db() as con:
        row = con.execute("SELECT target_sources FROM campaigns WHERE id=?",
                          (camp_id,)).fetchone()
    return row[0] if row else 0

