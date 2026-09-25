#!/usr/bin/env python3
"""Заморозка порядка тулов: список детерминирован (по имени) и стабилен.
Prompt-кэш гигиена (dev.to): порядок менять нельзя — держим сортировку."""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)


class ToolOrderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import importlib

        import camoufox_research.camoufox_research as srv

        # Полный реестр — ЯВНО (CAMOUFOX_CAPS=all): после аудита 21.09
        # незаданный профиль = ДЕФОЛТ агента (34 тула), а этот тест держит
        # заморозку порядка ВСЕГО реестра. env ставим только на время
        # пере-импорта: дальше реестр уже построен.
        with mock.patch.dict(os.environ, {"CAMOUFOX_CAPS": "all"}):
            importlib.reload(srv)
        cls.names = list(srv.mcp._tool_manager._tools.keys())

    def test_sorted_by_name(self):
        self.assertEqual(self.names, sorted(self.names))

    def test_all_tools_registered(self):
        # реестр полный: профиль задан явно (all), а не «как повезёт с env»
        self.assertGreater(len(self.names), 50)
        for must in ("ping", "web_search", "session_start", "screenshot"):
            self.assertIn(must, self.names)


if __name__ == "__main__":
    unittest.main()
