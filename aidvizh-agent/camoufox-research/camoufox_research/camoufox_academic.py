#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Академический канал: arXiv API + Semantic Scholar API (бесплатные, без ключей).

Индустрия (ресёрч 27.08.2026, 36 источников): Exa vs Tavily — публикации
R@1 63.3% против 31.8%, потому что у Exa СПЕЦИАЛИЗИРОВАННЫЙ индекс;
hajuri07/Agentic-Research-Search-Engine — arxiv-поиск отдельным каналом
рядом с вебом. Здесь то же: vertical-поиск первоисточников (arxiv.org,
semanticscholar.org) = tier 0, которых DDG почти не видит.

Оба API — GET, ответ парсится БЕЗ браузера (urllib): статья не требует
headless-потока. Кэш на сутки — таблица searches (ключ "acad*:...").
ПУСТОЙ ответ — отдельно: негативный кэш на 60с (ключ тот же), иначе
троттл 429 оплачивается заново на каждом запросе канала.
"""

import contextlib
import json
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

try:
    from camoufox_research.camoufox_cache import _search_cache_get, _search_cache_set
except ImportError:
    from camoufox_cache import _search_cache_get, _search_cache_set

try:
    from camoufox_research.camoufox_stopwords import _STOP
except ImportError:
    from camoufox_stopwords import _STOP

_ARXIV_URL = "https://export.arxiv.org/api/query"
_S2_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
_UA = {"User-Agent": "camoufox-research/0.7 (+https://github.com/aidvizhhub/camoufox-research)"}
_NS = {"a": "http://www.w3.org/2005/Atom"}

# Каналы академической ноги: каждый — свой GET в paper_rows. Через
# acad_call_cost() их число спрашивает бюджет кампании (единица — вызов).
_CHANNELS = ("arxiv", "semantic", "crossref", "wiki")
# Негативный кэш пустого ответа: короткий — троттл (429) не вечен, а
# сутки без канала дороже лишнего запроса.
_NEG_TTL = 60


def _cache_read(key):
    """Значение канала из кэша: список статей или None (промах/протух).

    Негативный кэш живёт в ТОМ ЖЕ ключе (аудит 21.09: комментарии
    обещали 60с на пустой ответ, а `_search_cache_set` звался только
    под `if rows:` — пусто не кэшировалось вовсе). Хранилище отдаёт
    запись до суток, поэтому срок негатива проверяем по метке внутри.
    """
    raw = _search_cache_get(key, 1, 1)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    if isinstance(data, dict):  # негативная запись {"neg_ts": ...}
        try:
            age = time.time() - float(data["neg_ts"])
        except (KeyError, TypeError, ValueError):
            return None  # битая запись = промах, а не падение канала
        return [] if age < _NEG_TTL else None
    return data if isinstance(data, list) else None


def _cache_write(key, rows):
    """Запись ответа канала: статьи — на сутки, ПУСТО — на 60с.

    Позитив и негатив не могут жить одновременно — ключ один, вторая
    запись перезаписывает первую (INSERT OR REPLACE).
    """
    payload = rows if rows else {"neg_ts": time.time()}
    _search_cache_set(key, json.dumps(payload, ensure_ascii=False), 1, 1)


def acad_call_cost(sources="arxiv,semantic,crossref,wiki"):
    """Сколько сетевых вызовов стоит ОДИН академический запрос.

    Нужен бюджету кампании (CAMOUFOX_SEARCH_BUDGET, единица — вызов):
    академия раньше шла мимо счёта, хотя каждый канал — отдельный GET.
    """
    src = (sources or "").lower()
    return sum(1 for s in _CHANNELS if s in src)

def _http_get(url, timeout=25):
    """GET с браузерным UA — отдаёт текст (arxiv/S2 отдают API, не HTML).
    28.08: urllib на 429 умирал за 15.6с (таймаут-ретрай), хотя ответ
    мгновенный — ловим HTTPError 429 сразу и поднимаем (негативный кэш
    60с выше гасит повторные троттлы)."""
    req = urllib.request.Request(url, headers=_UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise  # сразу — caller закэширует [] на 60с
        # прочие HTTP-ошибки — тоже не таймаутить, а поднять
        raise

def _arxiv_rows(query, max_results):
    """Статьи arXiv: list[(title, url, snippet)] — точная фраза в кавычках
    (проверено 27.08: all:"фраза" даёт релевантный топ, без кавычек — рой)."""
    q = urllib.parse.quote(f'all:"{query}"')
    url = f"{_ARXIV_URL}?search_query={q}&start=0&max_results={max_results}&sortBy=relevance"
    key = f"acadarxiv:{query}:{max_results}"
    cached = _cache_read(key)
    if cached is not None:
        return cached
    try:
        # timeout=5: arXiv/S2 API отвечают быстро; 25с — тормоз
        # (проверено 28.08: 429 отвечает мгновенно, но urllib ждал
        # весь таймаут при 25с). Быстрый таймаут → негативный кэш 60с.
        root = ET.fromstring(_http_get(url, timeout=5))
    except Exception:
        _cache_write(key, [])  # 429/таймаут: пусто на 60с, а не 8с×N
        return []
    rows = []
    # 28.08: кавычки точной фразы лишние на 2+ словах — arXiv отдал
    # ПУСТО (проверено: all:"mcp protocol security" = 0 записей,
    # all:mcp security = 4). Если кавычки пусты — повторяем без них.
    if not root.findall("a:entry", _NS):
        q2 = urllib.parse.quote(query)
        url2 = (f"{_ARXIV_URL}?search_query={q2}&start=0"
                f"&max_results={max_results}&sortBy=relevance")
        with contextlib.suppress(Exception):
            root = ET.fromstring(_http_get(url2, timeout=5))
    for ent in root.findall("a:entry", _NS):
        eid = (ent.findtext("a:id", "", _NS) or "").strip()
        title = " ".join((ent.findtext("a:title", "", _NS) or "").split())
        abstract = " ".join((ent.findtext("a:summary", "", _NS) or "").split())
        authors = [n.text.strip() for n in ent.findall("a:author/a:name", _NS) if n.text]
        year = (ent.findtext("a:published", "", _NS) or "")[:4]
        if not eid:
            continue
        # Нормализация: https://arxiv.org/abs/2301.00942v1 → .../2301.00942
        # (одна форма с DDG/кэшем — дедуп и счётчик доменов честные).
        eid = eid.replace("http://", "https://")
        eid = re.sub(r"v\d+$", "", eid)
        rows.append(
            {
                "title": title,
                "url": eid,
                "snippet": f"[{year}] {abstract[:260]}",
                "authors": authors[:2],
                "year": year,
            }
        )
    # 28.08: пустое кэшируется КОРОТКО (60с), не навсегда: arXiv 429
    # даёт 0 каждый раз (ретраи 4с × 2 = 8с на канал!) — негативный
    # кэш гасит повторные троттлы, а через 60с канал пробует снова.
    _cache_write(key, rows)
    return rows

def _s2_rows(query, max_results):
    """Статьи Semantic Scholar: тот же список записей (JSON API).
    Без ключа общий лимит 1000 rps, но бывают 429 — 2 попытки с паузой."""
    q = urllib.parse.quote(query)
    fields = "title,abstract,url,externalIds,publicationYear,citationCount,authors,venue,paperId"
    url = f"{_S2_URL}?query={q}&limit={max_results}&fields={fields}"
    key = f"acads2:{query}:{max_results}"
    cached = _cache_read(key)
    if cached is not None:
        return cached
    data = None
    for attempt in (1, 2, 3):
        try:
            # Semantic: медленный (200 отдаёт за ~5с, замер 28.08) —
            # 10с таймаут (5с резал бы живые ответы на грани).
            data = json.loads(_http_get(url, timeout=10))
            break
        except urllib.error.HTTPError as e:
            # 429 — не ретраить по 4с (трроттл долгий, негативный кэш
            # 60с гасит): выйти сразу (28.08, замер: 15.8с → 0.3с).
            if e.code == 429:
                break
            if attempt < 3:
                time.sleep(4)
            data = None
        except Exception:
            if attempt < 3:
                time.sleep(4)
            data = None
    if data is None:
        _cache_write(key, [])  # 429/сеть: пусто на 60с (а не ретраи по кругу)
        return []
    rows = []
    for p in data.get("data", []):
        ext = p.get("externalIds") or {}
        url = (
            p.get("url")
            or (f"https://arxiv.org/abs/{ext.get('ArXiv')}" if ext.get("ArXiv") else "")
            or f"https://www.semanticscholar.org/paper/{p.get('paperId')}"
        )
        if not url:
            continue
        abstract = " ".join((p.get("abstract") or "").split())
        rows.append(
            {
                "title": p.get("title") or "",
                "url": url,
                "snippet": f"[{p.get('publicationYear') or '?'}"
                f" · цит. {p.get('citationCount') or 0}] {abstract[:260]}",
                "authors": [a.get("name", "") for a in p.get("authors", [])[:2]],
                "year": str(p.get("publicationYear") or ""),
            }
        )
    _cache_write(key, rows)
    return rows

_CROSSREF_URL = "https://api.crossref.org/works"
_WIKI_URL = "https://en.wikipedia.org/w/api.php"


def _crossref_rows(query, max_results):
    """Статьи Crossref (научные журналы, DOI): без ключа, mailto — вежливо.
    Второй канал после arXiv 429 (проверено 28.08 — работает)."""
    key = f"acadcrossref:{query}:{max_results}"
    cached = _cache_read(key)
    if cached is not None:
        return cached
    rows = []
    try:
        url = (f"{_CROSSREF_URL}?query={urllib.parse.quote(query)}"
               f"&rows={max_results}&mailto=camoufox@example.com")
        # Вежливость: Crossref x-rate-limit-limit=3/1s (проверено
        # 28.08) — 1с пауза, чтобы 4 канала не толкались локтями.
        time.sleep(1)
        data = json.loads(_http_get(url, timeout=8))
        for it in data.get("message", {}).get("items", [])[:max_results]:
            title = " ".join((it.get("title") or [""])[0].split())
            doi = it.get("DOI") or ""
            if not title or not doi:
                continue
            year = (it.get("issued", {}).get("date-parts", [[None]])[0][0]) or ""
            _ct = (it.get("container-title") or [""])[0][:60] or ""
            rows.append({
                "title": title,
                "url": f"https://doi.org/{doi}",
                "snippet": f"[{year}] {_ct}",
                "authors": [(a.get("family") or "") for a in it.get("author", [])[:2]],
                "year": str(year or ""),
            })
    except Exception:
        pass
    _cache_write(key, rows)
    return rows


def _wiki_rows(query, max_results):
    """Wikipedia (энциклопедический обзор): бесплатный API, без ключа.
    Третий канал — не научный, но живой обзор темы (28.08)."""
    key = f"acadwiki:{query}:{max_results}"
    cached = _cache_read(key)
    if cached is not None:
        return cached
    rows = []
    try:
        url = (f"{_WIKI_URL}?action=query&list=search&srsearch="
               f"{urllib.parse.quote(query)}&format=json&srlimit={max_results}")
        data = json.loads(_http_get(url, timeout=8))
        for h in data.get("query", {}).get("search", [])[:max_results]:
            title = h.get("title") or ""
            if not title:
                continue
            rows.append({
                "title": title,
                "url": f"https://en.wikipedia.org/wiki/"
                        f"{urllib.parse.quote(title.replace(' ', '_'))}",
                "snippet": h.get("snippet", "").replace(
                    '<span class="searchmatch">', "").replace("</span>", "")[:260],
                "authors": [],
                "year": "",
            })
    except Exception:
        pass
    _cache_write(key, rows)
    return rows


_TOKEN_RX = r"[A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9\-]{3,}"
_GATE_MIN_HITS = 2


def _content_tokens(text):
    """Значимые токены текста: ≥4 букв, не стоп-слово, не число.

    Дефис — разделитель, а не часть слова: «anti-detection» должно дать
    «detection», иначе релевантный источник (сниппет «…for anti-detection
    purposes») не проходит гейт из-за одного совпадения вместо двух.
    """
    out = set()
    for w in re.findall(_TOKEN_RX, (text or "").replace("-", " ")):
        lw = w.lower()
        if len(lw) < 4 or lw in _STOP or lw.isdigit():
            continue
        out.add(lw)
    return out


def _relevant(query, title, snippet, min_hits=_GATE_MIN_HITS):
    """Гейт релевантности академической ноги.

    Урок 21.09: по теме «antidetect browser fingerprint detection 2026»
    arXiv отдал статьи про детекцию AI-картинок и рип-течений, Crossref —
    случайные DOI; как tier 0 они встали ПЕРВЫМИ в цитированном отчёте
    (первоисточник ранжируется выше всего). Требуем ≥min_hits общих
    значимых токенов; первые 5 букв считаем совпадением — грубо, но
    без стеммера ловит fingerprint(s)/fingerprints и т.п.

    Замер на живых данных: NTIRE (только «detection») — режется, а
    «Web Service Access Control Based on Browser Fingerprint Detection»
    (browser+fingerprint+detection) — проходит. Порог 2 подобран по
    этим строкам, не «на глаз».
    """
    q = _content_tokens(query)
    if not q:
        return True
    cand = _content_tokens(f"{title} {snippet}")
    hits = 0
    for t in q:
        for c in cand:
            if t == c or (len(t) >= 5 and len(c) >= 5 and t[:5] == c[:5]):
                hits += 1
                break
        if hits >= min_hits:
            return True
    return False


def paper_rows(query, max_results=8, sources="arxiv,semantic,crossref,wiki",
               relevant_only=False):
    """Сырьё для research/paper_search: list[(title, url, snippet, meta)].

    meta: {"source": "arxiv"|"semantic", "authors": [...], "year": ...}.
    28.08: +crossref,+wiki — цепочка каналов (arXiv 429 → crossref → wiki).
    Дедуп по URL: arxiv.org/abs/X (arXiv) и arxiv.org/abs/X (S2) = один.
    relevant_only=True — гейт по теме запроса (для research(academic=True):
    веб-охота не должна получать чужие статьи под видом первоисточников).
    paper_search зовёт без гейта: там академический поиск ЯВНО запрошен.
    """
    out, seen = [], set()
    _FETCH = {
        "arxiv": _arxiv_rows,
        "semantic": _s2_rows,
        "crossref": _crossref_rows,
        "wiki": _wiki_rows,
    }
    for src in _CHANNELS:
        if src not in sources.lower():
            continue
        rows = _FETCH[src](query, max_results)
        for r in rows:
            if not r.get("url") or r["url"] in seen:
                continue
            if relevant_only and not _relevant(
                    query, r.get("title", ""), r.get("snippet", "")):
                continue
            seen.add(r["url"])
            out.append(
                (
                    r["title"],
                    r["url"],
                    r["snippet"],
                    {"source": src, "authors": r.get("authors", []), "year": r.get("year", "")},
                )
            )
    return out

def paper_search(query, sources="arxiv,semantic", max_results=10):
    """Поиск научных статей: arXiv + Semantic Scholar (бесплатные).

    Возвращает список статей с годом/авторами/цитатами — первоисточники
    (tier 0), которых общий поиск почти не видит. Кэш на сутки.
    """
    rows = paper_rows(query, max_results=max(4, max_results), sources=sources)
    if not rows:
        return "ничего не нашёл по запросам (arXiv/S2 недоступны или пусто)"
    by_src = {}
    for _, _, _, meta in rows:
        by_src[meta["source"]] = by_src.get(meta["source"], 0) + 1
    out = [
        f"статей: {len(rows)} (" + " · ".join(f"{k}: {v}" for k, v in sorted(by_src.items())) + ")"
    ]
    for i, (title, url, snippet, meta) in enumerate(rows, 1):
        out.append(f"[{i}] {title}")
        out.append(f"    {url} ({meta['source']}, {meta.get('year', '?')})")
        if snippet:
            out.append(f"    {snippet[:200]}")
    return "\n".join(out)
