#!/usr/bin/env python3
"""Восстановление кампаний после сбоя воркера (без браузера/сети).

Что закрепляем (уроки 21.09, поймано живой пробой на чистом кэше):
  1) на свежей машине ~/.cache/camoufox-research/exports не существует —
     start() открывал лог ДО спавна и падал FileNotFoundError;
  2) упавший старт оставлял строку running, и «закон одного инстанса»
     запирал ВСЕ следующие кампании (тулы отмены не было вовсе);
  3) живая кампания не должна попадать под авто-сброс, а зависшая —
     должна, иначе очередь освободить нечем.

Одна temp-база на модуль (путь _DB_PATH фиксируется при импорте), но
каждый тест получает ЧИСТУЮ базу: setUp чистит таблицы и каталог
exports. Спавн не запускаем — subprocess.Popen замокан.
"""

import os
import shutil
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


def setUpModule():  # noqa: N802  (unittest-хук)
    """temp-база + temp-exports. CAMOUFOX_CAMPAIGN_DB НЕ трогаем: _DB_PATH
    фиксируется при первом импорте core, и подмена env из чужого модуля
    ломает соседей по suite (проверено: 7 ошибок у следующих тестов).
    Вместо env — патч атрибута в каждом тесте (см. _Base.setUp)."""
    global _TMP, _DB, _EXPORTS
    _TMP = tempfile.TemporaryDirectory()
    root = Path(_TMP.name)
    _DB = str(root / "cache.db")
    _EXPORTS = root / "exports"
    _mk_db(_DB)


def tearDownModule():  # noqa: N802  (unittest-хук)
    if _TMP is not None:
        _TMP.cleanup()


def _mk_db(db_path: str) -> None:
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


class _Base(unittest.TestCase):
    """Чистая база + temp-каталог exports перед каждым тестом."""

    def setUp(self):
        import camoufox_research.camoufox_campaign_core as core
        import camoufox_research.camoufox_campaign_ext as ext

        self.ext = ext
        # _db() живёт в core и читает СВОЙ _DB_PATH — патчим там, иначе
        # тест уходит в чужую (или вовсе удалённую) temp-базу соседей.
        self._db_patch = mock.patch.object(core, "_DB_PATH", _DB)
        self._db_patch.start()
        self.addCleanup(self._db_patch.stop)
        con = sqlite3.connect(_DB)
        con.execute("DELETE FROM campaigns")
        con.execute("DELETE FROM campaign_sources")
        con.commit()
        con.close()
        if _EXPORTS.exists():
            shutil.rmtree(_EXPORTS, ignore_errors=True)  # каждый тест = «свежий кэш»
        self._patch = mock.patch.object(paths, "export_dir", return_value=_EXPORTS)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def _campaigns(self):
        con = sqlite3.connect(_DB)
        rows = con.execute(
            "SELECT id, status, error FROM campaigns ORDER BY created_ts").fetchall()
        con.close()
        return rows

    def _insert_running(self, camp_id: str, log_age_min: float = 0.0) -> None:
        """Кампания в running + лог с заданным возрастом (heartbeat)."""
        _EXPORTS.mkdir(parents=True, exist_ok=True)
        log = _EXPORTS / f"{camp_id}.log"
        log.write_text("старт\n", encoding="utf-8")
        stamp = time.time() - log_age_min * 60
        os.utime(log, (stamp, stamp))
        con = sqlite3.connect(_DB)
        con.execute(
            "INSERT INTO campaigns (id, topic, queries, target_sources,"
            " domains_limit, feeds, status, error, created_ts, updated_ts,"
            " search_calls) VALUES (?,?,?,?,?,?,'running','',?,?,0)",
            (camp_id, "тема", "[]", 5, 2, "[]", time.time(), time.time()))
        con.commit()
        con.close()


class FreshCacheTest(_Base):
    """Свежая машина: каталога exports нет — start не должен падать."""

    def test_paths_creates_missing_exports_dir(self):
        self.assertFalse(_EXPORTS.exists())
        log_path, done_path = self.ext._paths("cmp_fresh")
        self.assertTrue(_EXPORTS.is_dir())
        self.assertEqual(Path(log_path).name, "cmp_fresh.log")
        self.assertEqual(Path(done_path).name, "cmp_fresh.json")

    def test_start_marks_failed_when_spawn_raises(self):
        """Спавн упал — строка НЕ остаётся running (иначе очередь заперта)."""
        with mock.patch.object(self.ext.subprocess, "Popen",
                               side_effect=OSError("нет такого файла")):
            out = self.ext.start("тест темы", background=True)
        self.assertIn("ошибка старта", out)
        rows = self._campaigns()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "failed")
        self.assertIn("OSError", rows[0][2])
        # освобождённая очередь: следующий старт проходит
        with mock.patch.object(self.ext.subprocess, "Popen", return_value=mock.Mock()):
            out2 = self.ext.start("вторая тема", background=True)
        self.assertIn("запущена В ФОНЕ", out2)


class ReclaimTest(_Base):
    """Зависший воркер не должен держать очередь вечно."""

    def test_live_campaign_is_not_reclaimed(self):
        self._insert_running("cmp_live", log_age_min=1)
        self.assertEqual(self.ext._reclaim_stale(), "")
        out = self.ext.start("новая тема", background=True)
        self.assertIn("уже бежит кампания cmp_live", out)
        self.assertIn("research_cancel", out)  # агент видит выход из тупика

    def test_stale_campaign_is_reclaimed_and_queue_frees(self):
        self._insert_running("cmp_dead", log_age_min=90)
        self.assertEqual(self.ext._reclaim_stale(), "cmp_dead")
        rows = {r[0]: r for r in self._campaigns()}
        self.assertEqual(rows["cmp_dead"][1], "failed")
        self.assertIn("авто-сброс", rows["cmp_dead"][2])
        with mock.patch.object(self.ext.subprocess, "Popen", return_value=mock.Mock()):
            out = self.ext.start("новая тема", background=True)
        self.assertIn("запущена В ФОНЕ", out)

    def test_stale_threshold_is_configurable(self):
        self._insert_running("cmp_mid", log_age_min=40)
        with mock.patch.dict(os.environ, {"CAMOUFOX_CAMPAIGN_STALE_MIN": "120"}):
            self.assertEqual(self.ext._reclaim_stale(), "")
        with mock.patch.dict(os.environ, {"CAMOUFOX_CAMPAIGN_STALE_MIN": "5"}):
            self.assertEqual(self.ext._reclaim_stale(), "cmp_mid")


class CancelTest(_Base):
    """Ручная отмена: единственный путь снять зависшую строку."""

    def test_cancel_frees_running(self):
        self._insert_running("cmp_zombie", log_age_min=0)
        out = self.ext.research_cancel("cmp_zombie")
        self.assertIn("failed", out)
        rows = {r[0]: r for r in self._campaigns()}
        self.assertEqual(rows["cmp_zombie"][1], "failed")
        self.assertIn("отменена вручную", rows["cmp_zombie"][2])
        with mock.patch.object(self.ext.subprocess, "Popen", return_value=mock.Mock()):
            self.assertIn("запущена В ФОНЕ",
                          self.ext.start("после отмены", background=True))

    def test_cancel_unknown_campaign(self):
        self.assertIn("нет кампании", self.ext.research_cancel("cmp_nope"))

    def test_cancel_finished_campaign_keeps_status(self):
        con = sqlite3.connect(_DB)
        con.execute(
            "INSERT INTO campaigns (id, topic, queries, target_sources,"
            " domains_limit, feeds, status, created_ts, updated_ts,"
            " search_calls) VALUES ('cmp_done','т','[]',5,2,'[]','done',?,?,0)",
            (time.time(), time.time()))
        con.commit()
        con.close()
        out = self.ext.research_cancel("cmp_done")
        self.assertIn("стало «done»", out)
        self.assertEqual({r[0]: r[1] for r in self._campaigns()}["cmp_done"], "done")


if __name__ == "__main__":
    unittest.main()
