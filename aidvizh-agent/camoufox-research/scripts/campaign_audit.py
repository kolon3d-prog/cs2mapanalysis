#!/usr/bin/env python3
"""campaign_audit — «сколько мусора в кампании»: глазами, а не по счётчику доменов.

ПЕРЕЕХАЛ из корня рабочего диска (21.09). Читает cache.db, ничего не пишет.

Счётчик кампании меряет РАЗНЫЕ ДОМЕНЫ, а не релевантность: 29/12 «done»
ничего не говорит о том, что в цитатах. Скрипт берёт кампанию из кэша и
раскладывает источники на «по теме» / «мимо» по домену и заголовку,
плюс показывает follow-up запросы волны (в них и живёт мусор).

Запуск:
  camoufox-research/.venv/bin/python scripts/campaign_audit.py <camp_id|last>
"""
import json
import os
import sqlite3
import sys

DB = os.path.expanduser("~/.cache/camoufox-research/cache.db")

# Тема кампании → слова, по которым считаем «по теме» (заголовок+URL).
_TOPIC_HINTS = {
    "antidetect": ("antidetect", "anti-detect", "fingerprint", "browser",
                   "gologin", "multilogin", "incogniton", "iproyal", "whoer",
                   "browserscan", "dolphin", "webgl", "canvas"),
}
_JUNK_HINTS = ("audio", "pixabay", "audacity", "audiomack", "music",
               "sound", "spotify", "ntire", "arxiv", "doi.org", "crossref",
               "phishing", "rip current")


def main():
    camp = sys.argv[1] if len(sys.argv) > 1 else "last"
    con = sqlite3.connect(DB)
    if camp == "last":
        row = con.execute(
            "SELECT id, topic FROM campaigns ORDER BY created_ts DESC LIMIT 1").fetchone()
    else:
        row = con.execute("SELECT id, topic FROM campaigns WHERE id=?", (camp,)).fetchone()
    if not row:
        print("нет кампании")
        return 1
    camp_id, topic = row
    st = con.execute("SELECT status, updated_ts FROM campaigns WHERE id=?",
                     (camp_id,)).fetchone()
    src = con.execute(
        "SELECT domain, url, title, tier FROM campaign_sources WHERE camp_id=? "
        "ORDER BY tier, domain", (camp_id,)).fetchall()
    print(f"кампания {camp_id} · статус {st[0]} · тема: {topic}")
    print(f"источников: {len(src)} · разных доменов: "
          f"{len({d for d, *_ in src})}")

    low = topic.lower()
    hints = next((v for k, v in _TOPIC_HINTS.items() if k in low), None)
    in_topic, junk = [], []
    for domain, url, title, tier in src:
        blob = f"{domain} {url} {title}".lower()
        if any(h in blob for h in _JUNK_HINTS):
            junk.append((domain, title, tier))
        elif hints is None or any(h in blob for h in hints):
            in_topic.append((domain, title, tier))
        else:
            junk.append((domain, title, tier))
    print(f"\nпо теме: {len(in_topic)} · мимо: {len(junk)}")
    if junk:
        print("--- мимо темы ---")
        for domain, title, tier in junk:
            print(f"  [{tier}] {domain:24} {(title or '')[:70]}")

    print("\n--- поисковые вызовы кампании (след волн) ---")
    for q, res in con.execute(
            "SELECT query, substr(result,1,160) FROM searches "
            "WHERE ts > (SELECT created_ts FROM campaigns WHERE id=?) "
            "ORDER BY ts", (camp_id,)):
        one = " ".join((res or "").split())[:120]
        print(f"  {q[:90]}\n     {one}")
    inner = con.execute(
        "SELECT result FROM searches WHERE query LIKE 'research:%' "
        "ORDER BY ts DESC LIMIT 1").fetchone()
    if inner:
        try:
            meta = json.loads(inner[0]).get("meta", {})
            print("\nmeta последнего research-вызова:")
            for k in ("sources", "domains", "target_domains", "academic_sources",
                      "followup_queries"):
                print(f"  {k}: {meta.get(k)}")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
