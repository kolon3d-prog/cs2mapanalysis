#!/usr/bin/env python3
"""Пульс здоровья: уведомление (notify-send) — best-effort и не спамит.

Что закрепляем (жалоба владельца 21.09: «спавнит»):
  1) notify-send запускался синхронно с timeout=10 и БЕЗ обработки
     TimeoutExpired — висящий/недоступный нотификатор (нет шины,
     D-Bus активирует медленно) убивал пульс трейсбеком прежде, чем он
     успевал отдать вердикт и код возврата;
  2) уведомление уходило на КАЖДЫЙ прогон с тем же вердиктом — по
     таймеру это спам одним и тем же текстом;
  3) выключателя не было вовсе.

Сеть/шелл/браузер не трогаем: subprocess.run и shutil.which замоканы,
каталог кэша — temp, «жив ли сервер» — заглушка.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)
sys.path.insert(0, str(Path(REPO) / "scripts"))


class _PulseBase(unittest.TestCase):
    """temp-кэш + подменённые окружение/поиск/сервер."""

    def setUp(self):
        import health_pulse as hp

        self.hp = hp
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.cache = root / "cache"
        self.cache.mkdir()
        self.alert = self.cache / "health-pulse_ALERT"
        for p in (
            mock.patch.object(hp, "CACHE", self.cache),
            mock.patch.object(hp, "ALERT", self.alert),
            mock.patch.object(hp, "PIDFILE", root / "camoufox-mcp.pid"),
            mock.patch.dict(os.environ, {
                "DISPLAY": ":0",
                "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
            }),
        ):
            p.start()
            self.addCleanup(p.stop)

    def _main(self, alive=False, side_effect=None, notify=True):
        """Прогон main() с заглушками: (код возврата, мок subprocess.run)."""
        env = {"HEALTH_PULSE_NOTIFY": "1" if notify else "0"}
        with mock.patch.object(self.hp, "_server_alive", return_value=alive), \
                mock.patch.dict(os.environ, env), \
                mock.patch("shutil.which", return_value="/usr/bin/notify-send"), \
                mock.patch("subprocess.run", side_effect=side_effect) as run:
            rc = self.hp.main()
        return rc, run


class PulseVerdictTest(_PulseBase):
    """Уведомление не имеет права менять вердикт пульса."""

    def test_fail_path_writes_alert(self):
        rc, run = self._main(alive=False)
        self.assertEqual(rc, 1)
        self.assertTrue(self.alert.exists())
        self.assertEqual(run.call_count, 1)

    def test_notify_timeout_does_not_break_pulse(self):
        import subprocess

        rc, run = self._main(
            alive=False,
            side_effect=subprocess.TimeoutExpired(cmd="notify-send", timeout=5),
        )
        self.assertEqual(rc, 1)          # вердикт отдан
        self.assertTrue(self.alert.exists())
        self.assertEqual(run.call_count, 1)

    def test_notify_missing_binary_is_swallowed(self):
        rc, run = self._main(alive=False, side_effect=FileNotFoundError("не найден"))
        self.assertEqual(rc, 1)
        self.assertTrue(self.alert.exists())

    def test_notify_failure_keeps_log_line(self):
        import subprocess

        self._main(alive=False,
                   side_effect=subprocess.TimeoutExpired(cmd="notify-send", timeout=5))
        log = (self.cache / "health-pulse.log").read_text(encoding="utf-8")
        self.assertIn("PULSE FAIL", log)


class NotifyDedupeTest(_PulseBase):
    """Один и тот же вердикт — одно уведомление, а не по одному на прогон."""

    def test_same_state_notifies_once(self):
        _, run1 = self._main(alive=False)
        _, run2 = self._main(alive=False)
        self.assertEqual(run1.call_count, 1)
        self.assertEqual(run2.call_count, 0)

    def test_state_change_notifies_again(self):
        _, run1 = self._main(alive=False)   # FAIL
        _, run2 = self._main(alive=True)    # WARN (watchdog без данных)
        self.assertEqual(run1.call_count, 1)
        self.assertEqual(run2.call_count, 1)

    def test_repeat_after_window(self):
        with mock.patch.dict(os.environ, {"HEALTH_PULSE_NOTIFY_REPEAT_MIN": "0"}):
            _, run1 = self._main(alive=False)
            _, run2 = self._main(alive=False)
        self.assertEqual(run1.call_count, 1)
        self.assertEqual(run2.call_count, 1)  # окно истекло — напомнить снова


class NotifySwitchesTest(_PulseBase):
    """Выключатель и условия, при которых спавна быть не должно."""

    def test_disabled_by_env(self):
        rc, run = self._main(alive=False, notify=False)
        self.assertEqual(run.call_count, 0)
        self.assertEqual(rc, 1)  # вердикт считается независимо от уведомлений

    def test_no_display_no_spawn(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DISPLAY", None)
            os.environ.pop("WAYLAND_DISPLAY", None)
            rc, run = self._main(alive=False)
        self.assertEqual(run.call_count, 0)
        self.assertEqual(rc, 1)

    def test_no_session_bus_no_spawn(self):
        """Крон/таймер без сессионной шины: notify-send всё равно не дойдёт."""
        os.environ.pop("DBUS_SESSION_BUS_ADDRESS", None)
        rc, run = self._main(alive=False)
        self.assertEqual(run.call_count, 0)
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
