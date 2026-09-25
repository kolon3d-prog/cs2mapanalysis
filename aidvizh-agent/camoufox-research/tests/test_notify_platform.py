#!/usr/bin/env python3
"""Уведомления пульса: дедуп по СОСТОЯНИЮ и поддержка не только Linux.

Две дыры, обе видны только вне юнит-теста:

1) СПАМ ВОЗВРАЩАЛСЯ. Дедуп сравнивал готовую строку сообщения, а в ней
   штамп времени `21.09 14:27` — значит два прогона в разные минуты давали
   разные строки, и уведомление уходило каждый раз (по таймеру — ежедневный
   спам). В тесте это не ловилось: два прогона подряд попадают в одну минуту.
   Дедуп обязан смотреть на СМЫСЛ вердикта (verdict+checks), а не на текст.

2) `notify-send` — только Linux. `_notify_allowed()` требовал наличие
   именно этого бинарника, поэтому на macOS (osascript) и Windows
   (PowerShell/toast) не было ни уведомлений, ни явного «не поддерживается».
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


class _Base(unittest.TestCase):
    def setUp(self):
        import health_pulse as hp

        self.hp = hp
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.cache = root / "cache"
        self.cache.mkdir()
        for p in (mock.patch.object(hp, "CACHE", self.cache),
                  mock.patch.object(hp, "ALERT", self.cache / "ALERT"),
                  mock.patch.object(hp, "PIDFILE", root / "pid"),
                  mock.patch.dict(os.environ, {
                      "DISPLAY": ":0",
                      "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
                      "HEALTH_PULSE_NOTIFY": "1",   # уведомления теперь opt-in
                  })):
            p.start()
            self.addCleanup(p.stop)
        os.environ.pop("HEALTH_PULSE_NOTIFY_REPEAT_MIN", None)
        # Механизмы проверяем при ЯВНО включённых уведомлениях: по умолчанию
        # пульс молчит (SilentByDefaultTest это и закрепляет).
        os.environ["HEALTH_PULSE_NOTIFY"] = "1"

    def _run(self, which="/usr/bin/notify-send", stamps=("01.01 10:00",)):
        """Прогон main() с фальшивыми бинарниками и подменённым временем."""
        seq = list(stamps)
        calls = []

        def fake_strftime(_fmt):
            return seq.pop(0) if len(seq) > 1 else seq[0]

        def fake_which(name):
            return which if (which and which.endswith(name)) else None

        with mock.patch.object(self.hp, "_server_alive", return_value=False), \
                mock.patch("shutil.which", side_effect=fake_which), \
                mock.patch("time.strftime", side_effect=fake_strftime), \
                mock.patch("subprocess.run", side_effect=lambda *a, **k: calls.append(a[0])):
            rc = self.hp.main()
        return rc, calls


class DedupeAcrossTimeTest(_Base):
    """Дедуп не должен зависеть от того, в какую минуту случился прогон."""

    def test_same_verdict_different_minutes_notifies_once(self):
        # два прогона: одинаковый набор проверок, разные штампы времени
        _, calls1 = self._run(stamps=("01.01 10:00", "01.01 10:00"))
        _, calls2 = self._run(stamps=("02.01 23:59", "02.01 23:59"))
        self.assertEqual(len(calls1), 1, "первый прогон должен уведомить")
        self.assertEqual(len(calls2), 0,
                         "тот же вердикт в другую минуту снова спавнит notify — спам")

    def test_changed_verdict_notifies_again(self):
        self._run(stamps=("01.01 10:00",))
        before = (self.cache / "health-pulse_notify.state").read_text(encoding="utf-8")
        self.assertIn("FAIL", before)
        with mock.patch.object(self.hp, "_server_alive", return_value=True), \
                mock.patch("shutil.which", return_value="/usr/bin/notify-send"), \
                mock.patch("time.strftime", return_value="01.01 10:05"), \
                mock.patch("subprocess.run") as run:
            self.hp.main()   # теперь WARN (сервер жив, но данных сторожа нет)
        self.assertEqual(run.call_count, 1, "смена вердикта обязана уведомить")


class SilentByDefaultTest(_Base):
    """По умолчанию пульс НЕ лезет на рабочий стол (требование владельца).

    «спамит — прекрати просто в системе»: фоновая проверка пишет лог и файл
    ALERT, а уведомление — только по явному HEALTH_PULSE_NOTIFY=1.
    """

    def test_no_env_no_notification(self):
        os.environ.pop("HEALTH_PULSE_NOTIFY", None)
        rc, calls = self._run(which="/usr/bin/notify-send")
        self.assertEqual(calls, [], "уведомление ушло без явного согласия")
        self.assertEqual(rc, 1)   # вердикт по-прежнему считается

    def test_explicit_off_also_silent(self):
        for value in ("0", "false", "no", "off"):
            with self.subTest(value=value):
                with mock.patch.dict(os.environ, {"HEALTH_PULSE_NOTIFY": value}):
                    _, calls = self._run(which="/usr/bin/notify-send")
                self.assertEqual(calls, [])

    def test_log_and_alert_still_written(self):
        os.environ.pop("HEALTH_PULSE_NOTIFY", None)
        self._run(which="/usr/bin/notify-send")
        self.assertTrue((self.cache / "health-pulse.log").exists())
        self.assertTrue((self.cache / "ALERT").exists())


class PlatformNotifyTest(_Base):
    """macOS и Windows: свой механизм, а не «нет notify-send — молчим»."""

    def test_linux_uses_notify_send(self):
        _, calls = self._run(which="/usr/bin/notify-send")
        self.assertEqual(calls[0][0], "/usr/bin/notify-send")
        self.assertIn("-u", calls[0])

    def test_macos_uses_osascript(self):
        with mock.patch.object(self.hp.sys, "platform", "darwin"):
            _, calls = self._run(which="/usr/bin/osascript")
        # на macOS до уведомления пульс ещё зовёт sysctl (время загрузки) —
        # считаем именно уведомления
        notif = [c for c in calls if str(c[0]).endswith("osascript")]
        self.assertEqual(len(notif), 1, f"на macOS уведомление не ушло: {calls}")
        self.assertIn("display notification", " ".join(notif[0]))

    def test_windows_uses_powershell_toast(self):
        ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        with mock.patch.object(self.hp.sys, "platform", "win32"):
            _, calls = self._run(which=ps)
        self.assertEqual(len(calls), 1, "на Windows уведомление не ушло")
        self.assertIn("powershell", calls[0][0].lower())

    def test_no_mechanism_no_crash(self):
        with mock.patch.object(self.hp.sys, "platform", "win32"):
            rc, calls = self._run(which=None)
        self.assertEqual(calls, [])
        self.assertEqual(rc, 1)   # вердикт считается независимо


if __name__ == "__main__":
    unittest.main()
