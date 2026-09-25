#!/usr/bin/env python3
"""Две находки качественного аудита 21.09 (обе с воспроизведением).

1) Двойная загрузка воркера. Мост спавнит воркер как СКРИПТ из каталога
   пакета, рядом с которым лежит файл `camoufox_research.py`. Первый импорт
   грузит его как модуль (а не пакет) и падает, ветка `except ImportError`
   тянет core/ext под ГОЛЫМИ именами; дальше файл-модуль сам лечит sys.path,
   и остальные модули грузятся пакетно. В `sys.modules` оказываются ДВА
   разных `camoufox_worker_core`: `_LIVE` в serve-режиме пишет один, а
   ACTION `set_proxy` читает другой — живой браузер не перезапускается,
   хотя это документированное поведение serve-режима.

2) `domains_limit` игнорировался при `quality_first=False` (отбор шёл мимо
   rank_and_select), а в сводке всё равно печаталось «лимит N на домен» —
   агент ставил ограничение разнообразия, получал 10 источников с одного
   сайта и не узнавал об этом.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


class SingleWorkerLoadTest(unittest.TestCase):
    """Воркер обязан грузиться ОДИН раз (без коллизии файла и пакета)."""

    def test_no_duplicate_worker_modules(self):
        code = (
            "import sys;"
            f"sys.path.insert(0, {str(REPO / 'camoufox_research')!r});"
            "import camoufox_worker as w;"
            "import camoufox_research.camoufox_worker_core as pkg;"
            "bare = sys.modules.get('camoufox_worker_core');"
            "print('PACKAGED' if bare is None else "
            "('SAME' if bare is pkg else 'DUP'))"
        )
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                           cwd=str(REPO), env=dict(os.environ, PYTHONPATH=""))
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertNotIn("DUP", r.stdout,
                         "воркер загружен дважды: set_proxy в serve смотрит "
                         "в чужой _LIVE — живой браузер не перезапустится")


class DomainsLimitTest(unittest.TestCase):
    """Ограничение разнообразия домена работает и без quality_first."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        from camoufox_research import camoufox_fetch_ext as fe

        self.fe = fe
        for p in (mock.patch.object(fe, "_CACHE_DB", str(Path(self._tmp.name) / "c.db")),
                  mock.patch.object(fe, "_CACHE_TTL", 0)):
            p.start()
            self.addCleanup(p.stop)

    def _research(self, **kw):
        rows = [(f"https://one-site.example/p{i}", f"t{i}", "s") for i in range(6)]
        rows += [(f"https://other{i}.example/x", f"o{i}", "s") for i in range(3)]
        with mock.patch.object(self.fe, "_search_results", return_value=rows):
            return self.fe.research(queries=["q-уникальный-кейс"], **kw)

    @staticmethod
    def _domains_in_rows(out: str, domain: str) -> int:
        """Сколько ИСТОЧНИКОВ (строк вида «[N] …») с этим доменом."""
        return sum(1 for line in out.splitlines()
                   if line.startswith("[") and domain in line)

    def test_limit_applies_without_quality_first(self):
        out = self._research(domains_limit=2, max_results_per_query=10)
        self.assertLessEqual(self._domains_in_rows(out, "one-site.example"), 2, out[:400])

    def test_limit_reported_truthfully(self):
        """Печатаем «лимит N на домен» — значит N и соблюдён."""
        out = self._research(domains_limit=2, max_results_per_query=10)
        self.assertIn("лимит 2 на домен", out)
        self.assertLessEqual(self._domains_in_rows(out, "one-site.example"), 2, out[:400])

    def test_json_meta_consistent(self):
        raw = self._research(domains_limit=2, max_results_per_query=10, as_json=True)
        payload = json.loads(raw)
        per_domain = {}
        for s in payload["sources"]:
            per_domain[s["domain"]] = per_domain.get(s["domain"], 0) + 1
        self.assertLessEqual(max(per_domain.values()), 2, per_domain)


if __name__ == "__main__":
    unittest.main()
