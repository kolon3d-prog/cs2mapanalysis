#!/usr/bin/env python3
"""Сборка поисковой базы вики: frontmatter + текст постов → SQLite с FTS5.

Контракт из README вики:

    python3 db-tools/build.py -r <корень вики> -o <файл базы>

Что делает:
- читает все *.md в тематических папках (кроме README.md, index.md, log.md, _templates/);
- разбирает YAML-frontmatter (type, title, description, date, tags, source, author, status),
  включая многострочные скаляры и `>`/`|`-блоки — иначе description теряется;
- складывает в SQLite: posts (метаданные + сырое тело), posts_fts (взвешенный поиск по
  нормализованным токенам), posts_trgm (trigram-FTS для нечёткого/подстрочного совпадения),
  terms (словарь токенов для опечаток), meta (built_at, posts, newest_post, hash);
- печатает сводку; если содержимое не менялось с прошлой сборки — база не пересобирается.

Нормализация (wikitext.normalize): нижний регистр, дефис/точка/слэш — разделители,
стоп-слова ru+en, лёгкий русский стеммер, транслит-варианты (впн ↦ vpn).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# байткод не пишем: db-tools лежат ВНУТРИ вики, а правило станции —
# артефакты (включая __pycache__) не мусорят рядом с данными
sys.dont_write_bytecode = True

import wikitext as wt  # noqa: E402

SCHEMA_VERSION = "3"

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
  path TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  topic_norm TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  date TEXT,
  tags TEXT,
  tags_norm TEXT,
  source TEXT,
  author TEXT,
  status TEXT,
  type TEXT,
  body TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  path UNINDEXED, title, description, tags, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS posts_trgm USING fts5(
  path UNINDEXED, text,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS terms (term TEXT PRIMARY KEY, df INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def collect(root: Path) -> list[dict]:
    posts = []
    for rel, path, text in wt.iter_posts(root):
        meta, body = wt.parse_frontmatter(text)
        tags = wt.tags_of(meta)
        posts.append(
            {
                "path": str(rel).replace("\\", "/"),
                "topic": rel.parts[0],
                "topic_norm": " ".join(wt.primary_tokens(rel.parts[0])),
                "slug": path.stem,
                "title": str(meta.get("title") or path.stem),
                "description": str(meta.get("description") or ""),
                "date": str(meta.get("date") or ""),
                "tags": ", ".join(tags),
                "tags_norm": wt.normalize(" ".join(tags)),
                "source": str(meta.get("source") or ""),
                "author": str(meta.get("author") or ""),
                "status": str(meta.get("status") or "stable"),
                "type": str(meta.get("type") or "Post"),
                "body": body,
                "text": text,
                "mtime": path.stat().st_mtime,
            }
        )
    return posts


def content_hash(posts: list[dict]) -> str:
    digest = hashlib.sha256()
    digest.update(SCHEMA_VERSION.encode())
    for post in posts:
        digest.update(b"\0")
        digest.update(post["path"].encode())
        digest.update(b"\0")
        digest.update(post["text"].encode())
    return digest.hexdigest()


def build_terms(posts: list[dict]) -> list[tuple[str, int]]:
    df: dict[str, int] = {}
    for post in posts:
        seen = set()
        for field in ("title", "description", "tags_norm", "body"):
            for token in wt.primary_tokens(str(post[field])):
                seen.add(token)
        for token in seen:
            df[token] = df.get(token, 0) + 1
    return sorted(df.items())


def newest_post(posts: list[dict]) -> str:
    dates = sorted(p["date"] for p in posts if p["date"][:4].isdigit())
    return dates[-1] if dates else ""


def existing_hash(out: Path) -> tuple[str, int]:
    """(hash, schema_version) прошлой сборки — для инкрементального пропуска."""
    if not out.exists():
        return "", 0
    try:
        conn = sqlite3.connect(f"file:{out}?mode=ro", uri=True)
        rows = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        conn.close()
    except sqlite3.Error:
        return "", 0
    try:
        return str(rows.get("hash", "")), int(rows.get("schema_version", "0"))
    except ValueError:
        return str(rows.get("hash", "")), 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Собрать поисковую базу вики (SQLite + FTS5)")
    ap.add_argument("-r", "--root", default=".", help="корень вики (по умолчанию текущий каталог)")
    ap.add_argument("-o", "--out", default="db/wiki.db", help="куда положить базу")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"build: нет каталога {root}", file=sys.stderr)
        return 2

    posts = collect(root)
    out = Path(args.out)
    if not out.is_absolute():
        out = root / out

    digest = content_hash(posts)
    old_hash, old_version = existing_hash(out)
    topics = sorted({p["topic"] for p in posts})
    if old_hash == digest and old_version == int(SCHEMA_VERSION):
        print(f"база актуальна: {out}")
        print(f"постов: {len(posts)} в темах: {', '.join(topics) if topics else '—'}")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    terms = build_terms(posts)
    conn = sqlite3.connect(out)
    try:
        conn.executescript(SCHEMA)
        conn.executemany(
            """INSERT INTO posts VALUES (:path,:topic,:topic_norm,:slug,:title,:description,
               :date,:tags,:tags_norm,:source,:author,:status,:type,:body)""",
            posts,
        )
        conn.executemany(
            "INSERT INTO posts_fts (path, title, description, tags, body) VALUES (?,?,?,?,?)",
            [
                (
                    p["path"],
                    wt.normalize(p["title"]),
                    wt.normalize(p["description"]),
                    wt.normalize(p["tags"]),
                    wt.normalize(p["body"]),
                )
                for p in posts
            ],
        )
        conn.executemany(
            "INSERT INTO posts_trgm (path, text) VALUES (?,?)",
            [
                (
                    p["path"],
                    "\n".join([p["title"], p["description"], p["tags"], p["body"]]).lower(),
                )
                for p in posts
            ],
        )
        conn.executemany("INSERT INTO terms VALUES (?,?)", terms)
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        conn.executemany(
            "INSERT INTO meta VALUES (?,?)",
            [
                ("built_at", stamp),
                ("posts", str(len(posts))),
                ("topics", json.dumps(topics, ensure_ascii=False)),
                ("newest_post", newest_post(posts)),
                ("newest_mtime", str(max((p["mtime"] for p in posts), default=0.0))),
                ("hash", digest),
                ("schema_version", SCHEMA_VERSION),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    print(f"база: {out}")
    print(f"постов: {len(posts)} в темах: {', '.join(topics) if topics else '—'}")
    print(f"токенов в словаре: {len(terms)}; новейший пост: {newest_post(posts) or '—'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
