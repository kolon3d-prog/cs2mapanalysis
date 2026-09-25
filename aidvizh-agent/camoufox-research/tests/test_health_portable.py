#!/usr/bin/env python3
"""Пульс на не-Linux: пути, /proc и время загрузки.

Что чиним (вопрос владельца «есть ли поддержка win/mac/linux»): пульс был
жёстко Linux-ным —
  * пидфайл по умолчанию `/run/user/<uid>/camoufox-mcp.pid` (ни на macOS,
    ни на Windows такого каталога нет);
  * `_boot_time()` читал `/proc/stat`, `_proc_alive()` — `/proc/<pid>/cmdline`;
  * неизвестное время загрузки трактовалось как «машина давно включена»,
    то есть на mac/win мёртвый сторож давал FAIL вместо честного WARN.

Браузерный слой, наоборот, кроссплатформенный: Playwright + Camoufox,
ветка `IS_NT` для известного бага Windows-headless, `scripts/_compat.py`.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))


class PidfilePortabilityTest(unittest.TestCase):
    def setUp(self):
        import health_pulse as hp

        self.hp = hp

    def test_uses_xdg_runtime_dir_when_set(self):
        with mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": "/tmp/xdg-test"}):
            self.assertEqual(self.hp._default_pidfile(),
                             Path("/tmp/xdg-test/camoufox-mcp.pid"))

    def test_falls_back_to_os_temp_dir(self):
        """/run/user есть только на Linux — на macOS/Windows идём в temp."""
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("XDG_RUNTIME_DIR", None)
            with mock.patch.object(self.hp, "_procfs_available", return_value=False):
                self.assertEqual(self.hp._default_pidfile(),
                                 Path(tempfile.gettempdir()) / "camoufox-mcp.pid")

    def test_linux_keeps_run_user(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("XDG_RUNTIME_DIR", None)
            with mock.patch.object(self.hp, "_procfs_available", return_value=True):
                self.assertTrue(str(self.hp._default_pidfile()).startswith("/run/user/"))


class ProcFallbackTest(unittest.TestCase):
    """Нет /proc — нельзя молча решать «процесса нет»."""

    def setUp(self):
        import health_pulse as hp

        self.hp = hp

    def test_live_pid_without_procfs_reports_alive(self):
        with mock.patch.object(self.hp, "_pid_cmdline", return_value=None), \
                mock.patch.object(self.hp.os, "kill", return_value=None):
            self.assertTrue(self.hp._proc_alive(4242))

    def test_dead_pid_reports_dead(self):
        with mock.patch.object(self.hp.os, "kill", side_effect=OSError("нет процесса")):
            self.assertFalse(self.hp._proc_alive(4242))

    def test_cmdline_mismatch_reports_dead(self):
        with mock.patch.object(self.hp, "_pid_cmdline", return_value="python -c pass"), \
                mock.patch.object(self.hp.os, "kill", return_value=None):
            self.assertFalse(self.hp._proc_alive(4242))


class BootTimePortabilityTest(unittest.TestCase):
    def setUp(self):
        import health_pulse as hp

        self.hp = hp

    def test_linux_reads_proc_stat(self):
        with mock.patch.object(self.hp.sys, "platform", "linux"):
            self.assertIsInstance(self.hp._boot_time(), float)

    def test_macos_uses_sysctl(self):
        out = "{ sec = 1789990000, usec = 0 } Mon Sep 21 14:00:00 2026"
        with mock.patch.object(self.hp.sys, "platform", "darwin"), \
                mock.patch.object(self.hp.subprocess, "run",
                                  return_value=mock.Mock(stdout=out)):
            self.assertEqual(self.hp._boot_time(), 1789990000.0)

    def test_unknown_platform_returns_none(self):
        with mock.patch.object(self.hp.sys, "platform", "someos"):
            self.assertIsNone(self.hp._boot_time())

    def test_unknown_uptime_makes_warn_not_fail(self):
        """Сторож молчит, время загрузки неизвестно → WARN, не FAIL."""
        with tempfile.TemporaryDirectory() as td:
            cache = Path(td)
            (cache / "cache.db").write_bytes(b"x")  # иначе проверка кэша даст FAIL
            with mock.patch.object(self.hp, "CACHE", cache), \
                    mock.patch.object(self.hp, "ALERT", cache / "ALERT"), \
                    mock.patch.object(self.hp, "_server_alive", return_value=True), \
                    mock.patch.object(self.hp, "_boot_time", return_value=None), \
                    mock.patch.object(self.hp, "_last_ok",
                                      return_value=__import__("datetime").datetime(2020, 1, 1)):
                rc = self.hp.main()
            log = (cache / "health-pulse.log").read_text(encoding="utf-8")
        self.assertEqual(rc, 0)
        self.assertIn("WARN", log)
        self.assertIn("uptime-unknown", log)


if __name__ == "__main__":
    unittest.main()
