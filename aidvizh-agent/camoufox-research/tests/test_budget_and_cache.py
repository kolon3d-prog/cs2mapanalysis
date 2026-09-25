#!/usr/bin/env python3
"""Бюджет кампании в ВЫЗОВАХ + негативный кэш академии — без сети.

Что закрепляем (аудит 21.09, обе находки с доказательством):
  1) CAMOUFOX_SEARCH_BUDGET объявлен лимитом ПОИСКОВЫХ ВЫЗОВОВ на
     кампанию, а campaigns.search_calls рос «+1 за волну»: «5/40» в
     статусе = 5 волн (кампания делает ≥2 волны + до 3 доборок — до
     ~200 вызовов), академическая нога в счёт не входила вовсе;
  2) комментарии обещали негативный кэш 60с на пустой ответ академии,
     но `_search_cache_set` звался только под `if rows:` — 429 arXiv
     оплачивался (8с ретраев на канал) на каждом запросе заново.

Сеть НЕ трогаем (landmine 19 — новый цикл гонять на фейке): research()
подменён фейком, http-канал академии — моком. Кэш searches — словарь
в памяти: живой ~/.cache/camoufox-research не наш (данные владельца).
"""

import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)

from camoufox_research import camoufox_paths as paths  # noqa: E402

_TMP = None
_DB = ""
_EXPORTS = None


def setUpModule():
    global _TMP, _DB, _EXPORTS
    _TMP = tempfile.TemporaryDirectory()
    root = Path(_TMP.name)
    _DB = str(root / "cache.db")
    _EXPORTS = root / "exports"
    _mk_db(_DB)


def tearDownModule():
    if _TMP is not None:
        _TMP.cleanup()


def _mk_db(db_path: str) -> None:
    """Схема кампаний как в core._SCHEMA (+search_calls)."""
    con = sqlite3.connect(db_path)
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS campaigns (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            queries TEXT NOT NULL,
            target_sources INTEGER NOT NULL,
            domains_limit INTEGER DEFAULT 2,
            feeds TEXT DEFAULT '[]',
            status TEXT DEFAULT 'running',
            error TEXT DEFAULT '',
            created_ts REAL, updated_ts REAL,
            search_calls INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS campaign_sources (
            camp_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT DEFAULT '',
            domain TEXT DEFAULT '',
            tier INTEGER DEFAULT 2,
            tier_label TEXT DEFAULT '',
            snippet TEXT DEFAULT '',
            added_ts REAL,
            digest TEXT DEFAULT '',
            live INTEGER DEFAULT -1,
            verified_ts REAL DEFAULT 0,
            UNIQUE(camp_id, url));
        """
    )
    con.commit()
    con.close()


class _BudgetBase(unittest.TestCase):
    """Чистая temp-база/exports + фейковый research (сеть не зовём).

    Кампания «не доходит до цели» (target 50, фейк даёт 1 домен за
    волну) — значит охоту останавливает ТОЛЬКО бюджет: если бы учёт был
    в волнах, фейк вызвался бы все 2 волны / 3 добора.
    """

    BUDGET = "7"

    def setUp(self):
        import camoufox_research.camoufox_campaign_core as core
        import camoufox_research.camoufox_campaign_ext as ext
        import camoufox_research.camoufox_housekeep as hk

        self.core, self.ext = core, ext
        self._patches = [
            mock.patch.object(core, "_DB_PATH", _DB),
            mock.patch.object(ext, "_DB_PATH", _DB),
            mock.patch.object(paths, "export_dir", return_value=_EXPORTS),
            # отчёты/пост-пак не пишем (иначе улетят в живой кэш владельца)
            mock.patch.object(hk, "save_report", return_value=None),
            mock.patch.object(hk, "post_pack", return_value={}),
            mock.patch.object(hk, "marker_update", return_value=None),
            # критик без LLM — честное «недоступен», сеть не трогаем
            mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "",
                                         "OLLAMA_HOST": ""}),
            mock.patch.dict(os.environ, {"CAMOUFOX_SEARCH_BUDGET": self.BUDGET}),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)
        if _EXPORTS.exists():
            import shutil

            shutil.rmtree(_EXPORTS, ignore_errors=True)
        _EXPORTS.mkdir(parents=True, exist_ok=True)  # hunt пишет маркер в exports
        con = sqlite3.connect(_DB)
        con.execute("DELETE FROM campaigns")
        con.execute("DELETE FROM campaign_sources")
        con.commit()
        con.close()
        # фейк поиска: пишет, ЧТО у него просили (единица бюджета — запрос)
        self.asked: list[list[str]] = []

    def _fake_research(self, *args, **kwargs):
        queries = list(kwargs.get("queries") or (args[0] if args else []))
        self.asked.append(queries)
        n = len(self.asked)
        return json.dumps({
            "meta": {"sources": 1, "domains": 1, "queries": queries},
            "sources": [{"title": f"источник {n}", "url": f"https://w{n}.example.com/a",
                         "domain": f"w{n}.example.com", "tier": 2,
                         "tier_label": "форум/блог", "snippet": "текст"}],
            "texts": [], "notes": [],
        }, ensure_ascii=False)

    def _hunt(self, camp_id, queries, target=50, academic=False, terms_wave=True):
        with mock.patch("camoufox_research.camoufox_fetch.research",
                        side_effect=self._fake_research):
            self.core.hunt(camp_id, "тема бюджета", queries, target, 2,
                           str(_EXPORTS / f"{camp_id}.log"),
                           str(_EXPORTS / f"{camp_id}.json"),
                           academic=academic, terms_wave=terms_wave)

    def _insert(self, camp_id, queries, target=50, search_calls=0):
        con = sqlite3.connect(_DB)
        con.execute(
            "INSERT INTO campaigns (id, topic, queries, target_sources,"
            " domains_limit, feeds, status, created_ts, updated_ts, search_calls)"
            " VALUES (?,?,?,?,2,'[]','running',?,?,?)",
            (camp_id, "тема бюджета", json.dumps(queries), target,
             time.time(), time.time(), search_calls))
        con.commit()
        con.close()

    def _spent(self, camp_id) -> int:
        con = sqlite3.connect(_DB)
        row = con.execute("SELECT COALESCE(search_calls,0) FROM campaigns "
                          "WHERE id=?", (camp_id,)).fetchone()
        con.close()
        return int(row[0])

    def _status_row(self, camp_id):
        con = sqlite3.connect(_DB)
        row = con.execute("SELECT status, error FROM campaigns WHERE id=?",
                          (camp_id,)).fetchone()
        con.close()
        return row


class WaveBudgetTest(_BudgetBase):
    """Волны кампании не превышают бюджет в ВЫЗОВАХ (не в волнах)."""

    def test_wave_is_cut_to_budget_and_second_wave_refused(self):
        """8 базовых запросов при лимите 7: волна урезана до 7, вторая — стоп.

        С учётом в волнах фейк позвали бы ДВАЖДЫ (8 + 32 запроса = 40
        вызовов при лимите 7) — здесь он зван один раз, на 7 запросов.
        """
        self._insert("cmp_b1", [f"q{i}" for i in range(8)])
        self._hunt("cmp_b1", [f"q{i}" for i in range(8)])

        self.assertEqual(len(self.asked), 1, "вторая волна не остановлена бюджетом")
        self.assertEqual(len(self.asked[0]), 7, "волна не урезана по остатку")
        self.assertEqual(self._spent("cmp_b1"), 7, "списано не по числу вызовов")
        status, error = self._status_row("cmp_b1")
        self.assertEqual(status, "partial")  # цель 50 не достигнута
        self.assertIn("бюджет", error)  # причина в БД видна агенту

    def test_academic_leg_costs_calls_too(self):
        """Академия — не бесплатная: 1 запрос = DDG + 4 канала.

        При лимите 10 и цене запроса 5 волна получает 2 запроса (10/5),
        а не 10: если бы академия шла мимо счёта, ушло бы 10 запросов.
        """
        with mock.patch.dict(os.environ, {"CAMOUFOX_SEARCH_BUDGET": "10"}):
            self._insert("cmp_b2", ["a", "b", "c", "d"])
            self._hunt("cmp_b2", ["a", "b", "c", "d"], academic=True)

        self.assertEqual(len(self.asked), 1)
        self.assertEqual(len(self.asked[0]), 2,
                         "цена академических каналов не учтена в бюджете")
        self.assertEqual(self._spent("cmp_b2"), 10)
        self.assertEqual(self._status_row("cmp_b2")[0], "partial")

    def test_status_and_report_show_same_number_as_limit(self):
        """Что выводит research_status/report — то же число, что лимит.

        Две волны: базовая (2 запроса) и угловая (8 запросов, урезана до
        остатка 5) — итого 7 вызовов при лимите 7.
        """
        self._insert("cmp_b3", ["a", "b"])
        self._hunt("cmp_b3", ["a", "b"])
        self.assertEqual([len(q) for q in self.asked], [2, 5])
        self.assertEqual(self._spent("cmp_b3"), 7)

        out = self.ext.research_status("cmp_b3")
        self.assertIn("бюджет поиска: 7/7 вызовов", out)
        rep = self.ext.research_report("cmp_b3")
        self.assertIn("бюджет: 7/7 вызовов", rep)

    def test_log_carries_budget_in_calls(self):
        self._insert("cmp_b4", ["a", "b", "c"])
        self._hunt("cmp_b4", ["a", "b", "c"])
        log = (_EXPORTS / "cmp_b4.log").read_text(encoding="utf-8")
        self.assertIn("волна 1: 3 запросов", log)
        self.assertIn("бюджет 0/7 вызовов", log)  # ДО волны — остаток честный
        self.assertIn("бюджет 3/7 вызовов", log)  # в финале — списанное


class ResumeBudgetTest(_BudgetBase):
    """Доборка платит из ТОГО ЖЕ бюджета, что волны."""

    def _resume(self, camp_id, queries, academic=False):
        with mock.patch("camoufox_research.camoufox_fetch.research",
                        side_effect=self._fake_research):
            self.ext._resume_hunt(camp_id, "тема бюджета", queries, 50, 2,
                                  str(_EXPORTS / f"{camp_id}.log"),
                                  str(_EXPORTS / f"{camp_id}.json"),
                                  academic=academic)

    def test_resume_stops_when_budget_exhausted(self):
        """Волны съели 5 из 7 → добор берёт 2 запроса и встаёт.

        Старое поведение: добор шёл все 3 раунда (2+2+2 запроса) мимо
        остатка — бюджет кончался в волнах, а добор его не видел.
        """
        self._insert("cmp_r1", ["a"], search_calls=5)
        self._resume("cmp_r1", ["a"])

        self.assertEqual(len(self.asked), 1, "добор не остановлен остатком")
        self.assertEqual(len(self.asked[0]), 2)
        self.assertEqual(self._spent("cmp_r1"), 7)
        self.assertIn("остаток 0/7", self._status_row("cmp_r1")[1])

    def test_resume_refused_when_nothing_left(self):
        self._insert("cmp_r2", ["a"], search_calls=7)
        self._resume("cmp_r2", ["a"])

        self.assertEqual(self.asked, [], "добор пошёл при нулевом остатке")
        self.assertEqual(self._spent("cmp_r2"), 7)
        self.assertIn("бюджет: остаток 0/7", self._status_row("cmp_r2")[1])


_ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2301.00942v1</id>
    <title>MCP protocol security</title>
    <summary>Про безопасность протокола</summary>
    <author><name>И. Тестов</name></author>
    <published>2023-01-03T00:00:00Z</published>
  </entry>
</feed>"""


class AcadNegativeCacheTest(unittest.TestCase):
    """Негативный кэш 60с: пустой ответ академии не жжёт сеть дважды."""

    def setUp(self):
        from camoufox_research import camoufox_academic as ac

        self.ac = ac
        self.store: dict[str, str] = {}
        self._patches = [
            # кэш searches — в памяти: живой кэш владельца не наш
            mock.patch.object(ac, "_search_cache_get",
                              side_effect=lambda k, *_a: self.store.get(k)),
            mock.patch.object(ac, "_search_cache_set",
                              side_effect=lambda k, v, *_a: self.store.__setitem__(k, v)),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def _http(self, calls: list, result=None, error=None):
        """Мок канала: считает вызовы (это и есть «идти в сеть»)."""
        def fake(url, timeout=25):
            calls.append(url)
            if error is not None:
                raise error
            return result
        return mock.patch.object(self.ac, "_http_get", side_effect=fake)

    def test_empty_arxiv_answer_is_cached_60s(self):
        calls: list = []
        with self._http(calls, error=OSError("429 Too Many Requests")):
            self.assertEqual(self.ac._arxiv_rows("mcp protocol", 4), [])
            self.assertEqual(len(calls), 1)
            key = "acadarxiv:mcp protocol:4"
            self.assertIn(key, self.store, "пустой ответ не закэширован")
            self.assertIn("neg_ts", json.loads(self.store[key]))
            # ВТОРОЙ вызов — из негативного кэша: сеть не трогаем (8с не жжём)
            self.assertEqual(self.ac._arxiv_rows("mcp protocol", 4), [])
        self.assertEqual(len(calls), 1, "повторный вызов пошёл в сеть")

    def test_expired_negative_cache_retries_channel(self):
        """Через 60с канал пробует снова — «пусто» не вечное."""
        calls: list = []
        with self._http(calls, error=OSError("429")):
            self.ac._arxiv_rows("mcp protocol", 4)
            self.assertEqual(len(calls), 1)
        self.store["acadarxiv:mcp protocol:4"] = json.dumps(
            {"neg_ts": time.time() - self.ac._NEG_TTL - 1})
        with self._http(calls, result=_ATOM):
            rows = self.ac._arxiv_rows("mcp protocol", 4)
        self.assertEqual(len(calls), 2, "протухший негатив запер канал навсегда")
        self.assertEqual(rows[0]["url"], "https://arxiv.org/abs/2301.00942")

    def test_positive_answer_still_cached_for_a_day(self):
        """Позитив не сломан: статьи кладутся списком и читаются из кэша."""
        calls: list = []
        with self._http(calls, result=_ATOM):
            first = self.ac._arxiv_rows("mcp protocol", 4)
            second = self.ac._arxiv_rows("mcp protocol", 4)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(second), 1)
        self.assertEqual(first[0]["title"], second[0]["title"])
        self.assertIsInstance(json.loads(self.store["acadarxiv:mcp protocol:4"]), list)

    def test_empty_wiki_answer_is_cached_too(self):
        """Негативный кэш — общий для каналов (wiki без sleep, в отличие
        от crossref: у того 1с вежливой паузы)."""
        calls: list = []
        with self._http(calls, error=OSError("403")):
            self.ac._wiki_rows("mcp protocol", 4)
            self.ac._wiki_rows("mcp protocol", 4)
        self.assertEqual(len(calls), 1)

    def test_acad_call_cost_matches_channels(self):
        self.assertEqual(self.ac.acad_call_cost(), 4)
        self.assertEqual(self.ac.acad_call_cost("arxiv,wiki"), 2)
        self.assertEqual(self.ac.acad_call_cost("books"), 0)


if __name__ == "__main__":
    unittest.main()


class HuntAutoStopTest(unittest.TestCase):
    """Авто-стоп «2+ мусорные волны подряд» действительно срабатывает.

    Найдено при разборе бюджета: `_dead_waves = 0` стоял ВНУТРИ цикла волн,
    то есть счётчик обнулялся на каждой итерации и условие `>= 2` не могло
    выполниться никогда — охоту нельзя было остановить по мусору, она жгла
    бюджет до конца. Проверяем фактом: две волны с нулевым приростом → стоп
    (третьей волны нет), в маркере причина.
    """

    def test_two_empty_waves_stop_the_hunt(self):
        import camoufox_research.camoufox_campaign_core as core
        import camoufox_research.camoufox_campaign_ext as ext

        camp_id = "cmp_autostop"
        _EXPORTS.mkdir(parents=True, exist_ok=True)  # _finish пишет маркер сюда
        calls = []
        empty = json.dumps({"sources": []})

        def fake_research(**kwargs):
            calls.append(kwargs)
            return empty

        with mock.patch.object(core, "_DB_PATH", _DB), \
                mock.patch.object(paths, "export_dir", return_value=_EXPORTS), \
                mock.patch.dict(os.environ, {"CAMOUFOX_SEARCH_BUDGET": "40"}):
            con = sqlite3.connect(_DB)
            con.execute(
                "INSERT INTO campaigns (id, topic, queries, target_sources,"
                " domains_limit, feeds, status, error, created_ts, updated_ts,"
                " search_calls) VALUES (?,?,?,?,?,?,'running','',?,?,0)",
                (camp_id, "тема", '["a"]', 50, 2, "[]", time.time(), time.time()))
            con.commit()
            con.close()
            with mock.patch("camoufox_research.camoufox_fetch.research",
                            side_effect=fake_research):
                core.hunt(camp_id, "тема", ["a", "b"], 50, 2,
                          str(_EXPORTS / f"{camp_id}.log"),
                          str(_EXPORTS / f"{camp_id}.json"))
            with sqlite3.connect(_DB) as con:
                err = con.execute("SELECT error FROM campaigns WHERE id=?",
                                  (camp_id,)).fetchone()[0]

        self.assertEqual(len(calls), 2,
                         f"авто-стоп не сработал: волн {len(calls)} вместо 2")
        self.assertIn("авто-стоп", err)
