#!/usr/bin/env python3
"""Вентиль CAMOUFOX_CACHE_DIR действительно переносит ВСЁ состояние.

Находка F1 (аудит кросс-платформенности 21.09): восемь модулей пакета склеивали
путь из `Path.home()` на импорте, поэтому `CAMOUFOX_CACHE_DIR` — который читают
скрипты и пишет установщик — сервер игнорировал: кэш, экспорт, профили,
скриншоты, загрузки, память и метрика уезжали в домашний каталог, а бэкап,
пульс и статистика смотрели в указанный (пустой бэкап, «кэш пуст»).
Docker спасался симлинком на /data.

Тест держит инвариант: при заданном CAMOUFOX_CACHE_DIR КАЖДЫЙ путь состояния
лежит внутри него. На прежнем коде падал бы на восьми путях из девяти.
"""

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


class CacheDirMovesEverythingTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "own-cache"
        os.environ["CAMOUFOX_CACHE_DIR"] = str(self.root)
        self.addCleanup(os.environ.pop, "CAMOUFOX_CACHE_DIR", None)
        for var in ("CAMOUFOX_WATCHDOG_LOG", "CAMOUFOX_MEMORY_FILE", "CAMOUFOX_DEV_DIR",
                    "CAMOUFOX_CAMPAIGN_DB"):
            os.environ.pop(var, None)

    def test_every_state_path_inside_env_dir(self):
        from camoufox_research import camoufox_paths as p

        paths = {
            "cache_db": p.cache_db(), "export": p.export_dir(), "shots": p.shots_dir(),
            "downloads": p.downloads_dir(), "profiles": p.profiles_dir(),
            "research": p.research_dir(), "watchdog": p.watchdog_log(),
            "memory": p.memory_file(), "usage": p.usage_file(), "dev": p.dev_dir(),
        }
        for name, path in paths.items():
            with self.subTest(path=name):
                self.assertTrue(str(path).startswith(str(self.root)),
                                f"{name} = {path} — вне CAMOUFOX_CACHE_DIR")

    def test_modules_agree_with_paths(self):
        """Модули пакета берут пути ИЗ единого источника, а не из домашнего каталога."""
        import camoufox_research.camoufox_cache as cache
        import camoufox_research.camoufox_export as export
        import camoufox_research.camoufox_campaign_core as core
        import camoufox_research.camoufox_browser_ext as bext
        import camoufox_research.camoufox_session_ext as sext
        import camoufox_research.camoufox_housekeep as hk
        import camoufox_research.camoufox_research_bridge as br

        checks = {
            "cache._cache_db()": str(cache._cache_db()),
            "export._export_dir()": str(export._export_dir()),
            "core._export_dir()": str(core._export_dir()),
            "bext profiles": str(bext._paths.profiles_dir()),
            "sext shots": str(sext._paths.shots_dir()),
            "housekeep watchdog": str(hk._wlog()),
            "bridge usage": str(br._usage_file()),
        }
        for name, value in checks.items():
            with self.subTest(module=name):
                self.assertTrue(value.startswith(str(self.root)),
                                f"{name} = {value} — вне CAMOUFOX_CACHE_DIR")

    def test_env_is_read_at_call_time_not_import(self):
        """Смена env после импорта должна работать (иначе снова «на импорте»)."""
        from camoufox_research import camoufox_paths as p

        self.assertTrue(str(p.cache_dir()).startswith(str(self.root)))
        other = Path(self._tmp.name) / "second"
        os.environ["CAMOUFOX_CACHE_DIR"] = str(other)
        self.assertEqual(p.cache_dir(), other)


class PlatformDefaultTest(unittest.TestCase):
    def test_default_is_os_specific(self):
        """Без вентиля путь берётся по стандарту ОС, а не жёстким ~/.cache."""
        from camoufox_research import camoufox_paths as p

        os.environ.pop("CAMOUFOX_CACHE_DIR", None)
        base = p.cache_dir()
        if sys.platform == "darwin":
            self.assertIn("Library/Caches", str(base))
        elif sys.platform == "win32":
            self.assertIn("camoufox-research", str(base))
        else:
            self.assertTrue(str(base).endswith(".cache/camoufox-research"))

    def test_paths_module_is_the_only_source(self):
        """Грубая охрана: в пакете не осталось самодельных склеек домашнего кэша."""
        offenders = []
        for f in (REPO / "camoufox_research").glob("*.py"):
            if f.name in ("camoufox_paths.py", "camoufox_critic.py"):
                continue
            text = f.read_text(encoding="utf-8")
            for line in text.splitlines():
                if ".cache" in line and "camoufox-research" in line and "os.path.join" in line:
                    offenders.append(f"{f.name}: {line.strip()[:80]}")
        self.assertEqual(offenders, [], f"самодельные пути: {offenders}")


if __name__ == "__main__":
    unittest.main()
