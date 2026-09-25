#!/usr/bin/env python3
"""Поиск по вики: сначала по базе (FTS5 + trigram), если её нет — по файлам.

Контракт из README вики:

    python3 db-tools/search.py -r <корень вики> "запрос"
    python3 db-tools/search.py -r <корень вики> --tags ai,agents "память"

Опции:
  -d, --db <имя>       имя базы (wiki) или путь к файлу .db
  -r, --root <путь>    корень вики (и для поиска базы, и для файлового фолбэка)
  --queries "a;b;c"    несколько запросов одним запуском (результаты слиты, дедуп по path)
  --tags <список>      фильтр по тегам (через запятую, все должны встретиться)
  --topic <папка>      фильтр по тематической папке
  --limit <N>          сколько результатов показать (по умолчанию 10)
  --body-chars <N>     сколько символов тела поста отдавать (по умолчанию 800)
  --no-body            не отдавать тело поста
  --snippet <N>        длина сниппета (по умолчанию 200)
  --fields <список>    какие поля результата оставить (path,title,description,tags,date,topic,score,query,snippet,body_chars,body)
  --explain            добавить разбор: какие токены не сматчились, близкие заголовки/теги
  --json               машинный вывод

Как ищем:
1. строгий AND по всем токенам запроса (стемминг + транслит, см. wikitext.normalize);
2. AND с исправлением токенов, которых нет в словаре базы (опечатки через difflib,
   `wiregard` → `wireguard`; исправление сообщается, только если реально дало выдачу);
3. OR по токенам + словарь предметных синонимов (SYNONYMS, «обход блокировок» → vpn/proxy) —
   если строгий AND пуст, ранжируем по доле совпавших слов запроса, фразе и свежести;
4. trigram-фолбэк для подстрочных совпадений (например, `singbox` внутри `singbox-tun`).
Нехватку добираем следующими стратегиями — в `notes` видно, чем именно искали; если выдача
пуста, в `suggestions` и `notes` попадают посты с похожими заголовками/тегами.

Ранжирование к найденному: bm25 + покрытие слов запроса + точная фраза, а поверх —
тематические бусты: тег/тема/заголовок/описание запроса, штраф заглушке, содержательность
(см. `WikiSearch._score`). Разбор бустов виден в `notes` и в `explain.boosts` при `--explain`.

Коды возврата: 0 — есть результат ИЛИ пусто (пусто — это `ok:true,count:0` с
`suggestions`/`notes`), 2 — реальная ошибка (в stdout JSON `{"ok": false, "error": "..."}`).
"""
from __future__ import annotations

import argparse
import difflib
import json
import math
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# байткод не пишем: db-tools лежат ВНУТРИ вики, а правило станции —
# артефакты (включая __pycache__) не мусорят рядом с данными
sys.dont_write_bytecode = True

import wikitext as wt  # noqa: E402

SCHEMA_VERSION = 3
DEFAULT_LIMIT = 10
DEFAULT_BODY_CHARS = 800
DEFAULT_SNIPPET = 200
RESULT_FIELDS = (
    "path",
    "title",
    "description",
    "tags",
    "date",
    "topic",
    "score",
    "query",
    "snippet",
    "body_chars",
    "body",
)

# Словарь предметных синонимов: как человек формулирует → теги, которыми это помечено в вики.
# Ключ — фраза из нормализованных токенов (сравнение по префиксам слов, «блокиров» накрывает
# блокировка/блокировки/блокировок), значение — теги-токены. Расширяет запрос (recall), а не
# сужает: точные совпадения слов запроса всё равно ранжируются выше. Пополняй по мере практики.
SYNONYMS = (
    (("обход", "блокиров"), ("vpn", "proxy")),
    (("обойти", "блокиров"), ("vpn", "proxy")),
    (("анонимн", "сет"), ("vpn", "proxy", "privacy")),
    (("свой", "сервер"), ("selfhosted", "homelab")),
    (("домашний", "сервер"), ("selfhosted", "homelab")),
    (("локальн", "модел"), ("local", "llm")),
    (("свой", "ассистент"), ("agents", "assistant")),
)

# Бусты тематического матча. Тег/тема — заявленная тема поста, случайное слово в абзаце ею не
# является, поэтому точное совпадение токена запроса с тегом (или с темой-папкой) весит
# заметно больше, чем совпадение в теле. Значения подобраны так, чтобы перекрывать разброс
# bm25 (он награждает короткие документы: заглушка-пачка ссылок обгоняла тег vpn на ~4 балла).
TAG_BOOST = 14.0
TOPIC_BOOST = TAG_BOOST  # для темы папки — тот же вес: это такая же заявка на тему
NEIGHBOR_BOOST = 5.0  # соседний по словарю синонимов тег при уже совпавшем теге (vpn ↔ proxy)
# Заголовок и описание — тоже заявленные поля поста, просто слабее тега. Без них слово в
# заголовке проигрывало простому объёму тела (bm25-вес заголовка перекрывался плюсом за
# содержательность), и пост «про это» уходил вниз за постом, где слово просто длиннее написано.
TITLE_BOOST = 6.0
DESC_BOOST = 3.0
STUB_PENALTY = 12.0  # теги pending/stub/draft или status: pending|draft — пост-свалка вниз
SUBSTANCE_WEIGHT = 2.0  # +2·log10(байт тела): 3 КБ разбора впереди 1 КБ оглавления
STUB_TAGS = frozenset({"pending", "stub", "draft"})
STUB_STATUS = frozenset({"pending", "draft"})


def _tag_neighbors() -> dict[str, frozenset[str]]:
    """Соседи тега по словарю синонимов: пост с тегом vpn рядом с тегом proxy тематически
    плотнее, чем пост с одним proxy (слово «proxy» там про другое: LLM api-прокси)."""
    graph: dict[str, set[str]] = {}
    for _, tags in SYNONYMS:
        for tag in tags:
            graph.setdefault(tag, set()).update(other for other in tags if other != tag)
    return {tag: frozenset(others) for tag, others in graph.items()}


TAG_NEIGHBORS = _tag_neighbors()

DB_SELECT = {
    "posts_fts": """
SELECT p.path, p.title, p.description, p.tags, p.date, p.topic, p.body, p.status, p.type,
       posts_fts.title AS ntitle, posts_fts.description AS ndescription,
       posts_fts.tags AS ntags, posts_fts.body AS nbody,
       bm25(posts_fts, 10, 6, 8, 1) AS bm
FROM posts_fts JOIN posts p ON p.path = posts_fts.path
WHERE posts_fts MATCH ?
{where}
ORDER BY bm
LIMIT ?
""",
    "posts_trgm": """
SELECT p.path, p.title, p.description, p.tags, p.date, p.topic, p.body, p.status, p.type,
       f.title AS ntitle, f.description AS ndescription, f.tags AS ntags, f.body AS nbody,
       bm25(posts_trgm) AS bm
FROM posts_trgm JOIN posts p ON p.path = posts_trgm.path
JOIN posts_fts f ON f.path = p.path
WHERE posts_trgm MATCH ?
{where}
ORDER BY bm
LIMIT ?
""",
}


def open_db(name: str, root: Path) -> tuple[sqlite3.Connection | None, str]:
    candidates = []
    path = Path(name)
    if path.suffix == ".db" or "/" in name:
        candidates.append(path if path.is_absolute() else root / path)
    else:
        candidates += [
            root / "db" / f"{name}.db",
            root / f"{name}.db",
            Path(__file__).resolve().parent.parent / "db" / f"{name}.db",
        ]
    for candidate in candidates:
        if candidate.exists():
            try:
                conn = sqlite3.connect(f"file:{candidate}?mode=ro", uri=True)
                conn.execute("SELECT 1 FROM meta WHERE key = 'schema_version'").fetchone()
            except sqlite3.Error:
                return None, f"база {candidate} старого формата — пересобери: python3 db-tools/build.py -r {root} -o db/wiki.db"
            version = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
            if not version or version[0] != str(SCHEMA_VERSION):
                conn.close()
                return None, f"база {candidate} старого формата — пересобери: python3 db-tools/build.py -r {root} -o db/wiki.db"
            return conn, ""
    return None, "базы нет — собери: python3 db-tools/build.py -r %s -o db/wiki.db" % root


def date_key(value: str) -> int:
    digits = re.sub(r"\D", "", value or "")
    return int(digits[:8]) if len(digits) >= 8 else 0


def term_expr(term: dict) -> str:
    """FTS5-термин. Варианты транслита добавляет сама база (индекс расширен при сборке),
    а группировать их в запросе нельзя: FTS5 не поддерживает скобки."""
    return f'"{term["primary"]}"'


def and_expr(terms: list[dict]) -> str:
    return " AND ".join(term_expr(term) for term in terms)


def or_expr(terms: list[dict]) -> str:
    return " OR ".join(term_expr(term) for term in terms)


def trigram_expr(query: str) -> str:
    tokens = wt.query_string_tokens(query)
    return " OR ".join(f'"{token}"' for token in tokens)


def collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _phrase_in(tokens: list[str], phrase: tuple[str, ...]) -> bool:
    """Есть ли фраза словаря в токенах запроса. Ключ словаря и токены запроса сравниваются
    в одной нормализованной форме (стемминг), поэтому «свой сервер» ловится и как «своего
    сервера», и как «свой сервер»."""
    key = []
    for part in phrase:
        stems = wt.primary_tokens(part)
        key.append(stems[0] if stems else part)
    if len(key) > len(tokens):
        return False
    for start in range(len(tokens) - len(key) + 1):
        if all(tokens[start + offset].startswith(part) for offset, part in enumerate(key)):
            return True
    return False


def make_snippet(body: str, description: str, terms: list[dict], width: int) -> str:
    """Сниппет из живого текста: строка с наибольшим числом совпавших токенов."""
    text = (body or description or "").strip()
    if not text:
        return ""
    best_line, best_hits = "", 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        words = set(wt.normalize(line).split())
        hits = sum(1 for term in terms if any(v in words for v in term["variants"]))
        if hits > best_hits:
            best_line, best_hits = line, hits
    snippet = collapse(best_line) or collapse(text)
    if len(snippet) <= width:
        return snippet
    lowered = snippet.lower()
    position = min(
        (pos for pos in (lowered.find(t["primary"]) for t in terms) if pos >= 0),
        default=0,
    )
    start = max(0, position - width // 3)
    return ("…" if start else "") + snippet[start : start + width] + "…"


class WikiSearch:
    """Поиск по базе FTS5 или (если базы нет) по файлам вики."""

    def __init__(self, root: Path, conn: sqlite3.Connection | None, limit: int, body_chars: int, snippet: int, topic: str, tags: list[str]):
        self.root = root
        self.conn = conn
        self.limit = limit
        self.body_chars = body_chars
        self.snippet_width = snippet
        self.topic = topic
        self.tags = tags
        self._corpus: list[dict] | None = None
        self._vocab: list[str] | None = None
        self._where = self._build_filters()

    # ---------------------------------------------------------------- filters
    def _build_filters(self) -> tuple[str, list[str]]:
        sql, params = "", []
        if self.topic:
            sql += " AND (' ' || p.topic_norm || ' ') LIKE ?"
            params.append(f"% {' '.join(wt.primary_tokens(self.topic))} %")
        for tag in self.tags:
            variants = wt.variants(wt.stem(tag))
            sql += " AND (" + " OR ".join(["(' ' || p.tags_norm || ' ') LIKE ?"] * len(variants)) + ")"
            params += [f"% {variant} %" for variant in variants]
        return sql, params

    # ---------------------------------------------------------------- sources
    def corpus(self) -> list[dict]:
        """Файловый фолбэк: разобранные посты с нормализованными полями."""
        if self._corpus is None:
            rows = []
            for rel, path, text in wt.iter_posts(self.root):
                meta, body = wt.parse_frontmatter(text)
                tags = wt.tags_of(meta)
                title = str(meta.get("title") or path.stem)
                description = str(meta.get("description") or "")
                rows.append(
                    {
                        "path": str(rel).replace("\\", "/"),
                        "title": title,
                        "description": description,
                        "tags": ", ".join(tags),
                        "date": str(meta.get("date") or ""),
                        "topic": rel.parts[0],
                        "body": body,
                        "status": str(meta.get("status") or "stable"),
                        "type": str(meta.get("type") or "Post"),
                        "ntitle": wt.normalize(title),
                        "ndescription": wt.normalize(description),
                        "ntags": wt.normalize(", ".join(tags)),
                        "nbody": wt.normalize(body),
                        "bare": text.lower(),
                        "bm": 0.0,
                    }
                )
            self._corpus = rows
        return self._corpus

    @property
    def vocab(self) -> list[str]:
        if self._vocab is None:
            if self.conn is not None:
                self._vocab = [row[0] for row in self.conn.execute("SELECT term FROM terms")]
            else:
                terms = set()
                for row in self.corpus():
                    for field in ("ntitle", "ndescription", "ntags", "nbody"):
                        terms.update(wt.primary_tokens(row[field]))
                self._vocab = sorted(terms)
        return self._vocab

    def _query(self, table: str, expr: str, cap: int) -> list[dict]:
        sql = DB_SELECT[table].format(where=self._where[0])
        cursor = self.conn.execute(sql, [expr, *self._where[1], cap])
        keys = ["path", "title", "description", "tags", "date", "topic", "body", "status", "type", "ntitle", "ndescription", "ntags", "nbody", "bm"]
        return [dict(zip(keys, row)) for row in cursor.fetchall()]

    # ------------------------------------------------------------- strategies
    def _repair(self, terms: list[dict]) -> tuple[list[dict], dict]:
        """Правит токены, которых нет в словаре базы: wiregard → wireguard.

        Кандидат обязан начинаться с той же буквы, быть той же длины (±2) и совпадать
        на ≥ 0.85 — иначе «sing» превращался бы в «using», а «обойт» в «обойтис».
        """
        known = set(self.vocab)
        fixed, corrections = [], {}
        for term in terms:
            if set(term["variants"]) & known:
                fixed.append(term)
                continue
            first, length = term["primary"][:1], len(term["primary"])
            candidates = [
                candidate
                for candidate in difflib.get_close_matches(term["primary"], self.vocab, n=5, cutoff=0.85)
                if candidate[:1] == first and abs(len(candidate) - length) <= 2
            ]
            if not candidates:
                fixed.append(term)
                continue
            corrections[term["primary"]] = candidates[:3]
            fixed.append({"primary": candidates[0], "variants": wt.variants(candidates[0])})
        changed = any(a["primary"] != b["primary"] for a, b in zip(terms, fixed))
        return (fixed, corrections) if changed else (terms, corrections)

    def _expanded(self, terms: list[dict]) -> tuple[list[dict], list[tuple[str, str]]]:
        """Добивает запрос словарём синонимов: «обход блокировок» → теги vpn/proxy."""
        primaries = [term["primary"] for term in terms]
        extras, hits = [], []
        for phrase, tags in SYNONYMS:
            if not _phrase_in(primaries, phrase):
                continue
            added = []
            for tag in tags:
                if not any(wt.variants(tag) == term["variants"] for term in terms + extras):
                    extras.append({"primary": tag, "variants": wt.variants(tag)})
                    added.append(tag)
            if added:
                hits.append((" ".join(phrase), ", ".join(added)))
        return extras, hits

    @staticmethod
    def _stub(row: dict) -> bool:
        """Заглушка: пост-свалка (пачка ссылок) — тег pending/stub/draft или status pending/draft."""
        if set(row["ntags"].split()) & STUB_TAGS:
            return True
        return any(v in STUB_STATUS for v in wt.variants(str(row["status"] or "").lower()))

    @staticmethod
    def _boost_text(row: dict) -> str:
        parts = []
        if row["tag_hits"]:
            parts.append("тег " + "/".join(row["tag_hits"]) + f" +{TAG_BOOST:g}")
        if row["topic_hits"]:
            parts.append("тема " + "/".join(row["topic_hits"]) + f" +{TOPIC_BOOST:g}")
        if row["title_hits"]:
            parts.append("заголовок " + "/".join(row["title_hits"]) + f" +{TITLE_BOOST:g}")
        if row["desc_hits"]:
            parts.append("описание " + "/".join(row["desc_hits"]) + f" +{DESC_BOOST:g}")
        if row["neighbor_hits"]:
            parts.append("соседний тег " + "/".join(row["neighbor_hits"]) + f" +{NEIGHBOR_BOOST:g}")
        if row["stub"]:
            parts.append(f"заглушка −{STUB_PENALTY:g}")
        parts.append(f"объём +{row['substance']:g}")
        return row["path"] + " — " + ", ".join(parts)

    def _score(self, rows: list[dict], terms: list[dict], source: str, required: list[str] | None = None) -> list[dict]:
        """Ранжирование: bm25 (веса title/description/tags/body из SQL) + покрытие слов запроса
        + бонус за все слова запроса + бонус за точную фразу.

        Поверх этого — тематические бусты, чтобы заявленная тема побеждала формальный матч:
          • точное совпадение токена запроса с ТЕГОМ (+TAG_BOOST) или с ТЕМОЙ-папкой (+TOPIC_BOOST);
          • соседний по словарю синонимов тег при уже совпавшем теге (+NEIGHBOR_BOOST);
          • совпадение в заголовке (+TITLE_BOOST) или описании (+DESC_BOOST) — заявленные поля,
            слабее тега: иначе плюс за объём тела перебивал слово в заголовке;
          • заглушка: теги pending/stub/draft или status pending/draft (−STUB_PENALTY);
          • содержательность: +2·log10(байт тела) — вместо погони за длиной в лоб.

        Слова из словаря синонимов (required=None → все terms обязательны) считаются так же,
        но буст «все слова» и тематические бусты — только за настоящие слова запроса.
        """
        required = required if required is not None else [t["primary"] for t in terms]
        phrase = " ".join(required)
        claimed = [t for t in terms if t["primary"] in required]
        scored = []
        for row in rows:
            ntext = " ".join([row["ntitle"], row["ndescription"], row["ntags"], row["nbody"]])
            words = set(ntext.split())
            title_words = set(row["ntitle"].split())
            desc_words = set(row["ndescription"].split())
            tag_words = set(row["ntags"].split())
            topic_words = set(wt.normalize(row["topic"]).split())
            matched = [t["primary"] for t in terms if any(v in words for v in t["variants"])]
            all_matched = all(any(v in words for v in t["variants"]) for t in claimed)
            phrase_hit = len(required) > 1 and phrase in ntext
            title_hits = [t["primary"] for t in claimed if any(v in title_words for v in t["variants"])]
            desc_hits = [t["primary"] for t in claimed if any(v in desc_words for v in t["variants"])]
            tag_hits = [t["primary"] for t in claimed if any(v in tag_words for v in t["variants"])]
            topic_hits = [t["primary"] for t in claimed if any(v in topic_words for v in t["variants"])]
            neighbor_hits = [
                neighbor
                for token in tag_hits
                for neighbor in sorted(TAG_NEIGHBORS.get(token, ()))
                if any(v in tag_words for v in wt.variants(neighbor))
            ]
            stub = self._stub(row)
            substance = round(SUBSTANCE_WEIGHT * math.log10(len(row["body"]) + 1), 3)
            score = (-float(row["bm"]) if source == "db" else 0.0) + 10.0 * len(matched) / len(terms)
            if all_matched:
                score += 12.0
            if phrase_hit:
                score += 6.0
            score += TAG_BOOST * len(tag_hits) + TOPIC_BOOST * len(topic_hits)
            score += TITLE_BOOST * len(title_hits) + DESC_BOOST * len(desc_hits)
            score += NEIGHBOR_BOOST * len(neighbor_hits) + substance
            if stub:
                score -= STUB_PENALTY
            scored.append(
                {
                    **row,
                    "matched": matched,
                    "missing": [name for name in required if name not in matched],
                    "all_matched": all_matched,
                    "phrase": phrase_hit,
                    "title_hits": title_hits,
                    "desc_hits": desc_hits,
                    "tag_hits": tag_hits,
                    "topic_hits": topic_hits,
                    "neighbor_hits": neighbor_hits,
                    "stub": stub,
                    "substance": substance,
                    "strategy": source,
                    "score": round(score, 3),
                }
            )
        return scored

    def _fetch(self, name: str, table: str, expr: str, terms: list[dict], cap: int, required: list[str] | None = None) -> list[dict]:
        if not expr:
            return []
        if self.conn is not None:
            rows = self._query(table, expr, cap)
            scored = self._score(rows, terms, "db", required)
        else:
            scored = self._scan_files(table, expr, terms, cap, required)
        for row in scored:
            row["attempt"] = name
        return scored

    def _scan_files(self, table: str, expr: str, terms: list[dict], cap: int, required: list[str] | None = None) -> list[dict]:
        """Файловый фолбэк: те же стратегии, но проверка по разобранному корпусу."""
        needles = re.findall(r'"([^"]*)"', expr) if table == "posts_trgm" else []
        has_filters = bool(self.topic or self.tags)
        rows = []
        for row in self.corpus():
            if has_filters and not self._file_matches_filters(row):
                continue
            words = set(" ".join([row["ntitle"], row["ndescription"], row["ntags"], row["nbody"]]).split())
            if needles:
                if not any(needle in row["bare"] for needle in needles):
                    continue
            elif not any(v in words for t in terms for v in t["variants"]):
                continue
            rows.append(row)
            if len(rows) >= cap:
                break
        return self._score(rows, terms, "files", required)

    def _file_matches_filters(self, row: dict) -> bool:
        if self.topic and self.topic not in row["topic"]:
            return False
        words = set(row["ntags"].split())
        for tag in self.tags:
            if not any(v in words for v in wt.variants(wt.stem(tag))):
                return False
        return True

    # ------------------------------------------------------------------ query
    def run(self, query: str, explain: bool) -> dict:
        terms = wt.query_terms(query)
        notes: list[str] = []
        empty_explain = {"query": query, "tokens": [], "matched": [], "missing": [], "corrections": {}, "strategies": []}
        if not terms:
            notes.append("в запросе нет значимых слов — остались только стоп-слова")
            return {"results": [], "notes": notes, "suggestions": [], "explain": empty_explain}

        required = [term["primary"] for term in terms]
        fixed, corrections = self._repair(terms)
        extras, expansions = self._expanded(terms)
        scoring_terms = terms + extras
        cap = max(self.limit * 20, 200)

        attempts: list[tuple[str, str, str, list[dict]]] = [("строгий AND", "posts_fts", and_expr(terms), terms)]
        if corrections:
            attempts.append(("AND с исправлением опечаток", "posts_fts", and_expr(fixed), scoring_terms))
        or_name = "OR по токенам" + (" + словарь синонимов" if extras else "")
        attempts.append((or_name, "posts_fts", or_expr(scoring_terms), scoring_terms))
        if corrections:
            attempts.append(("OR с исправлением опечаток", "posts_fts", or_expr(fixed + extras), scoring_terms))
        trgm = trigram_expr(query)
        if trgm:
            attempts.append(("trigram (подстрока)", "posts_trgm", trgm, scoring_terms))

        collected: dict[str, dict] = {}
        tried: list[tuple[str, int]] = []
        repair_names = {name for name, _, _, _ in attempts if "исправлением" in name}
        corrections_helped = False
        for name, table, expr, scoring in attempts:
            if len(collected) >= self.limit:
                break
            rows = self._fetch(name, table, expr, scoring, cap, required)
            tried.append((name, len(rows)))
            if name in repair_names and rows:
                corrections_helped = True
            added = 0
            for row in rows:
                if row["path"] in collected:
                    continue
                added += 1
                collected[row["path"]] = row
            if collected and not added and len(tried) > 1:
                break  # стратегия не добавила ничего нового — дальше смысла нет

        # Кандидатов набираем больше, чем нужно отдать: обрезка до limit ДО ранжирования
        # оставляла верхние позиции за теми, кого любит bm25 (короткие посты), и буст тега
        # уже не мог поднять тематический пост из глубины. Сортируем весь пул, режем — потом.
        pool = sorted(collected.values(), key=lambda r: (-r["score"], -date_key(r["date"]), r["path"]))
        results = pool[: self.limit]
        near = pool[self.limit : self.limit + 8]

        used = ", ".join(f"{name} — {count}" for name, count in tried)
        primary = next((name for name, count in tried if count), None)
        notes.append("искал: " + (used or "нечего искать"))
        if primary and primary != attempts[0][0]:
            notes.append(f"строгий AND пуст — результаты дал «{primary}»")
        if not primary:
            notes.append("совпадений нет — запрос, похоже, не про эту вики")
        if corrections_helped:
            notes.append("исправил опечатки: " + ", ".join(f"{bad} → {good[0]}" for bad, good in corrections.items()))
        unknown = [term["primary"] for term in terms if not (set(term["variants"]) & set(self.vocab))]
        if unknown and not primary:
            notes.append("нет в словаре базы: " + ", ".join(unknown))
        if expansions:
            notes.append("расширил словарём синонимов: " + "; ".join(f"{phrase} → {tags}" for phrase, tags in expansions))
        if any(r["phrase"] for r in results):
            notes.append("есть точное вхождение фразы запроса")
        boosted = [
            row
            for row in results
            if row["tag_hits"] or row["topic_hits"] or row["title_hits"] or row["desc_hits"]
            or row["neighbor_hits"] or row["stub"]
        ]
        if boosted:
            notes.append("бусты тематического матча: " + "; ".join(self._boost_text(row) for row in boosted[:3]))
        if any(row["stub"] for row in boosted):
            notes.append("заглушки (pending/stub/draft) опущены на " + f"{STUB_PENALTY:g} — свалка ссылок тему не возглавляет")

        suggestions, explain_data = [], {
            "query": query,
            "tokens": required,
            "expanded": [term["primary"] for term in extras],
            "matched": sorted({token for row in results for token in row["matched"]}),
            "missing": sorted({token for row in results for token in row["missing"]}),
            "corrections": corrections if corrections_helped else {},
            "unknown": unknown,
            "strategies": [{"name": name, "found": count} for name, count in tried],
            "boosts": [
                {
                    "path": row["path"],
                    "tag": row["tag_hits"],
                    "topic": row["topic_hits"],
                    "title": row["title_hits"],
                    "description": row["desc_hits"],
                    "neighbor_tags": row["neighbor_hits"],
                    "stub": row["stub"],
                    "substance": row["substance"],
                }
                for row in results[:5]
            ],
            "close_titles": [{"path": row["path"], "title": row["title"]} for row in near[:3]],
            "close_tags": sorted({tag.strip() for row in near for tag in row["tags"].split(",") if tag.strip()})[:6],
        }
        if not results:
            misses = self.near_misses(required)
            suggestions = [row["path"] for row in misses]
            close = ", ".join(f"{row['title']} [{row['path']}]" for row in misses[:3])
            notes.append("похожие заголовки/теги: " + close if close else "и близкого ничего нет")
            explain_data["close_titles"] = [{"path": row["path"], "title": row["title"]} for row in misses[:3]]
            explain_data["close_tags"] = sorted({tag.strip() for row in misses for tag in row["tags"].split(",") if tag.strip()})[:6]
        elif explain:
            suggestions = [row["path"] for row in near[:5]]
        return {"results": results, "notes": notes, "suggestions": suggestions, "explain": explain_data}

    def near_misses(self, tokens: list[str], limit: int = 5) -> list[dict]:
        """Посты с похожими словами в заголовке/тегах — для пустой выдачи и `--explain`.
        В базе берём только заголовки и теги (без тел), в файловом режиме — разобранный корпус."""
        if self.conn is not None:
            source = [
                {"path": path, "title": title, "tags": tags}
                for path, title, tags in self.conn.execute("SELECT path, title, tags FROM posts")
            ]
        else:
            source = [{"path": row["path"], "title": row["title"], "tags": row["tags"]} for row in self.corpus()]
        hits = []
        for row in source:
            words = [w for token in wt.primary_tokens(f"{row['title']} {row['tags']}") for w in wt.variants(token)]
            score = 0
            for token in tokens:
                found = False
                for variant in wt.variants(token):
                    for word in words:
                        if word[:1] == variant[:1] and abs(len(word) - len(variant)) <= 2 and difflib.SequenceMatcher(None, variant, word).ratio() >= 0.75:
                            found = True
                            break
                    if found:
                        break
                score += found
            if score:
                hits.append((score, row))
        hits.sort(key=lambda pair: (-pair[0], pair[1]["path"]))
        return [row for _, row in hits[:limit]]

    # ----------------------------------------------------------------- output
    def record(self, row: dict, query: str, fields: tuple[str, ...] | None) -> dict:
        body = row["body"][: self.body_chars] if self.body_chars else ""
        record = {
            "path": row["path"],
            "title": row["title"],
            "description": row["description"],
            "tags": row["tags"],
            "date": row["date"],
            "topic": row["topic"],
            "score": row["score"],
            "query": query,
            "snippet": make_snippet(row["body"], row["description"], wt.query_terms(query), self.snippet_width),
            "body_chars": len(body),
            "body": body,
        }
        if fields:
            record = {key: record[key] for key in RESULT_FIELDS if key in fields}
        return record

    def index_info(self) -> dict:
        if self.conn is None:
            rows = self.corpus()
            dates = sorted(r["date"] for r in rows if r["date"][:4].isdigit())
            return {"posts": len(rows), "built_at": "", "stale": True, "newest_post": dates[-1] if dates else ""}
        meta = dict(self.conn.execute("SELECT key, value FROM meta"))
        newest_mtime = 0.0
        count = 0
        for _, path in wt.iter_post_paths(self.root):
            count += 1
            newest_mtime = max(newest_mtime, path.stat().st_mtime)
        try:
            built_mtime = float(meta.get("newest_mtime", "0"))
        except ValueError:
            built_mtime = 0.0
        try:
            recorded = int(meta.get("posts", "-1"))
        except ValueError:
            recorded = -1
        stale = count != recorded or newest_mtime > built_mtime + 1
        return {
            "posts": max(recorded, 0),
            "built_at": meta.get("built_at", ""),
            "stale": stale,
            "newest_post": meta.get("newest_post", ""),
        }


def main() -> int:
    ap = argparse.ArgumentParser(description="Поиск по вики (база FTS5 + trigram или файлы)")
    ap.add_argument("query", nargs="*", help="что искать")
    ap.add_argument("-d", "--db", default="wiki", help="имя базы (wiki) или путь к .db")
    ap.add_argument("-r", "--root", default=".", help="корень вики")
    ap.add_argument("--queries", default="", help='несколько запросов через ";"')
    ap.add_argument("--tags", default="", help="теги через запятую (все должны быть)")
    ap.add_argument("--topic", default=None, help="тематическая папка")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="сколько показать")
    ap.add_argument("--body-chars", type=int, default=DEFAULT_BODY_CHARS, help="сколько символов тела поста отдавать")
    ap.add_argument("--no-body", action="store_true", help="не отдавать тело поста")
    ap.add_argument("--snippet", type=int, default=DEFAULT_SNIPPET, help="длина сниппета")
    ap.add_argument("--fields", default="", help="оставить только эти поля результата")
    ap.add_argument("--explain", action="store_true", help="разбор: несматчившиеся токены, близкие заголовки")
    ap.add_argument("--json", action="store_true", help="машинный вывод")
    args = ap.parse_args()

    queries = [part.strip() for part in args.queries.split(";") if part.strip()]
    joined = " ".join(args.query).strip()
    if joined:
        queries.append(joined)

    def fail(message: str) -> int:
        if args.json:
            print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        else:
            print(f"search: {message}", file=sys.stderr)
        return 2

    if not queries:
        return fail("нужен запрос")
    if args.limit < 1 or args.body_chars < 0 or args.snippet < 0:
        return fail("--limit должен быть ≥ 1, --body-chars/--snippet — ≥ 0")

    fields: tuple[str, ...] | None = None
    if args.fields:
        fields = tuple(part.strip() for part in args.fields.split(",") if part.strip())
        bad = [name for name in fields if name not in RESULT_FIELDS]
        if bad:
            return fail("неизвестные поля: " + ", ".join(bad))

    root = Path(args.root).resolve()
    if not root.is_dir():
        return fail(f"нет каталога {root}")

    body_chars = 0 if args.no_body else args.body_chars
    tags = [tag.strip().lower() for tag in args.tags.split(",") if tag.strip()]

    conn, db_note = open_db(args.db, root)
    try:
        engine = WikiSearch(root, conn, args.limit, body_chars, args.snippet, args.topic, tags)
        notes: list[str] = [db_note] if db_note else []
        suggestions: list[str] = []
        explains: list[dict] = []
        per_query: list[tuple[str, list[dict]]] = []
        prefix = (lambda text: f"«{query}»: {text}") if len(queries) > 1 else (lambda text: text)
        for query in queries:
            outcome = engine.run(query, args.explain)
            notes.extend(prefix(note) for note in outcome["notes"])
            explains.append(outcome["explain"])
            for path in outcome["suggestions"]:
                if path not in suggestions:
                    suggestions.append(path)
            per_query.append((query, outcome["results"]))
        # Слияние по кругу: у каждого запроса первое место достаётся его лучшему результату,
        # дедуп по path — несколько запросов одним вызовом не «съедают» бюджет друг друга.
        merged: list[tuple[dict, str]] = []
        seen: set[str] = set()
        depth = max((len(rows) for _, rows in per_query), default=0)
        for index in range(depth):
            for query, rows in per_query:
                if index >= len(rows) or len(merged) >= args.limit:
                    continue
                row = rows[index]
                if row["path"] in seen:
                    continue
                seen.add(row["path"])
                merged.append((row, query))
            if len(merged) >= args.limit:
                break
        results = [engine.record(row, query, fields) for row, query in merged]
        index = engine.index_info()
    except sqlite3.Error as error:
        return fail(f"база не отвечает: {error}")

    mode = "db" if conn is not None else "files"
    if index["stale"] and mode == "db":
        notes.append("база старше последних правок — пересобери: python3 db-tools/build.py -r %s -o db/wiki.db" % root)

    if args.json:
        payload = {
            "ok": True,
            "mode": mode,
            "wiki": str(root),
            "queries": queries,
            "count": len(results),
            "index": index,
            "results": results,
            "suggestions": [] if results else suggestions[:5],
            "notes": notes,
        }
        if args.explain:
            payload["explain"] = explains
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if not results:
        print(f"ничего не нашлось ({'база' if mode == 'db' else 'файлы'})")
        for note in notes:
            print(f"  · {note}")
        return 0

    for item in results:
        title = item["title"]
        if len(queries) > 1:
            title += f"  ← «{item['query']}»"
        print(f"• {title}  [{item['path']}]")
        if item["description"]:
            print(f"  {item['description']}")
        if item["tags"]:
            print(f"  теги: {item['tags']}")
        if item["snippet"]:
            print(f"  …{item['snippet']}")
    for note in notes:
        print(f"  · {note}")
    print(f"\nнайдено: {len(results)} ({'база' if mode == 'db' else 'файлы'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
