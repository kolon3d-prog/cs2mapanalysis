#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Кауфми-пульс: раз в день — отчёт «живо ли племя», алерт при тишине.

Проверяет три артерии (без запуска браузера — только факты):
  1. MCP-сервер жив   — PID-файл (закон 35) + kill -0;
  2. сторож поиска свеж — последний `ok` в watchdog.log ≤ 48ч:
       машина недавно загрузилась (uptime < 20ч) → warn «машина спала»,
       а работала > 20ч и всё равно молчит  → FAIL «сторож умер»;
  3. cache.db на месте — добыча не потеряна.

Вывод: строка в health-pulse.log (конвенция кэша), FAIL → файл
health-pulse_ALERT (жив, пока беда жива, как watchdog_ALERT).

Cron (идемпотентно; ставится одной строкой — см. scripts/install_cron.sh):
0 8 * * * <путь-из-config.env>/scripts/health_pulse.py
  >> ~/.cache/camoufox-research/health-pulse.log 2>&1
"""

import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

CACHE = Path(os.environ.get("CAMOUFOX_CACHE_DIR", Path.home() / ".cache" / "camoufox-research"))
ALERT = CACHE / "health-pulse_ALERT"


def _procfs_available() -> bool:
    """Есть ли /proc (Linux). На macOS/Windows процедурной ФС нет."""
    return Path("/proc/stat").exists()


def _default_pidfile() -> Path:
    """Пидфайл по умолчанию, пригодный и вне Linux.

    Раньше путь был жёстко `/run/user/<uid>/…` — на macOS/Windows такого
    каталога нет, и пульс молча смотрел в никуда (вопрос «есть ли
    поддержка win/mac»). Порядок: XDG_RUNTIME_DIR → /run/user (если есть
    /proc) → системный temp.
    """
    xdg = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    if xdg:
        return Path(xdg) / "camoufox-mcp.pid"
    if _procfs_available() and hasattr(os, "getuid"):
        run_user = Path(f"/run/user/{os.getuid()}")
        if run_user.is_dir():
            return run_user / "camoufox-mcp.pid"
    return Path(tempfile.gettempdir()) / "camoufox-mcp.pid"


PIDFILE = Path(os.environ.get("CAMOUFOX_PIDFILE") or _default_pidfile())
STALE_H = int(os.environ.get("HEALTH_PULSE_STALE_H", "48"))
BOOT_GRACE_H = int(os.environ.get("HEALTH_PULSE_BOOT_GRACE_H", "20"))
BACKUP_STALE_H = int(os.environ.get("HEALTH_PULSE_BACKUP_STALE_H", "36"))


def _boot_time() -> float | None:
    """Время загрузки, если ОС его отдаёт; None — не знаем (не врём).

    Linux — /proc/stat (btime), macOS — sysctl kern.boottime, Windows —
    GetTickCount64. Раньше читался только /proc, поэтому вне Linux пульс
    получал `time.time()` (то есть «загрузились только что») и подменял
    FAIL на «машина спала» — молча терял настоящую аварию.
    """
    if sys.platform.startswith("linux"):
        try:
            for line in Path("/proc/stat").read_text().splitlines():
                if line.startswith("btime "):
                    return float(line.split()[1])
        except OSError:
            return None
        return None
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["sysctl", "-n", "kern.boottime"],
                                 capture_output=True, text=True, timeout=5).stdout
            m = re.search(r"sec\s*=\s*(\d+)", out or "")
            return float(m.group(1)) if m else None
        except Exception:
            return None
    if sys.platform == "win32":
        try:
            import ctypes

            return time.time() - ctypes.windll.kernel32.GetTickCount64() / 1000.0
        except Exception:
            return None
    return None


def _last_ok() -> datetime | None:
    """Последний `ok:` из watchdog.log («27.08 18:25 ok: 8 результатов»)."""
    log = CACHE / "watchdog.log"
    if not log.exists():
        return None
    for line in reversed(log.read_text(encoding="utf-8", errors="ignore").splitlines()):
        m = re.match(r"^(\d{2}\.\d{2}) (\d{2}:\d{2}) ok:", line)
        if m:
            day, hms = m.group(1), m.group(2)
            now = datetime.now()
            return datetime(
                now.year,
                now.month,
                now.day,
                int(hms[:2]),
                int(hms[3:5]),
            ).replace(day=int(day.split(".")[0]), month=int(day.split(".")[1]))
    return None


def main() -> int:
    checks: list[str] = []
    fail = False
    warn = False

    # 1. MCP-сервер жив: пидфайл (закон 35) + /proc-страховка
    # (урок 19:46: пидфайл мог остаться от умершего connect-процесса,
    # сервер жив — пульс не должен лгать «dead»)
    mcp = "alive" if _server_alive() else "MISSING"
    checks.append(f"mcp={mcp}")
    fail |= mcp != "alive"

    # 2. сторож поиска свеж (с поправкой «машина спала»)
    last = _last_ok()
    boot = _boot_time()
    uptime_h = (time.time() - boot) / 3600 if boot else None
    if last is None:
        warn = True
        checks.append("watchdog=no-data")
    elif time.time() - last.timestamp() > STALE_H * 3600:
        if uptime_h is not None and uptime_h < BOOT_GRACE_H:
            warn = True
            checks.append("watchdog=stale(machine-was-off)")
        elif uptime_h is None:
            # Время загрузки неизвестно (не Linux) — честный WARN:
            # раньше сюда подставлялось time.time(), и настоящая авария
            # выглядела как «машина спала».
            warn = True
            checks.append("watchdog=stale(uptime-unknown)")
        else:
            fail = True
            checks.append("watchdog=STALE-FAIL")
    else:
        checks.append("watchdog=ok")

    # 3. добыча (cache.db)
    db = CACHE / "cache.db"
    if db.exists() and db.stat().st_size > 0:
        checks.append("cache=ok")
    else:
        fail = True
        checks.append("cache=MISSING")

    # 4. последний бэкап (третий глаз на догон: машина спала → таймер
    # догнал при загрузке; если и догон молчит — WARN)
    bl = CACHE / "backup_cache.log"
    if bl.exists() and time.time() - bl.stat().st_mtime <= BACKUP_STALE_H * 3600:
        checks.append("backup=ok")
    else:
        warn = True
        checks.append("backup=stale" if bl.exists() else "backup=no-data")

    stamp = time.strftime("%d.%m %H:%M")
    verdict = "PASS" if not fail and not warn else ("FAIL" if fail else "WARN")
    line = f"{stamp} PULSE {verdict} " + " ".join(checks)
    # Ключ дедупа БЕЗ времени: иначе каждый прогон в новую минуту считался
    # новым состоянием и уведомление уходило снова (спам, 21.09).
    state_key = _notify_state_key(verdict, checks)
    with open(CACHE / "health-pulse.log", "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    if fail:
        ALERT.write_text(line + "\n", encoding="utf-8")
        _notify(line, "critical", state_key)
        return 1
    ALERT.unlink(missing_ok=True)
    if warn:  # машина спала / нет данных — догон уже в силе, но знать полезно
        _notify(line + " — догон сработает при загрузке", "normal", state_key)
    return 0


def _pid_cmdline(pid: int) -> str | None:
    """Командная строка процесса; None — узнать нельзя (нет /proc: macOS/Windows)."""
    proc = Path(f"/proc/{pid}/cmdline")
    if not proc.exists():
        return None
    try:
        return proc.read_bytes().decode("utf-8", "ignore")
    except OSError:
        return None


def _proc_alive(pid: int) -> bool:
    """PID жив И это кауфми-сервер (cmdline, если ОС его отдаёт)."""
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    except Exception:
        return False
    cmd = _pid_cmdline(pid)
    if cmd is None:
        return True  # /proc нет — верим самому факту «процесс жив»
    return "bin/camoufox-research" in cmd


def _server_alive() -> bool:
    """Жив ли сервер кауфми: пидфайл (главное), либо /proc-страховка —
    пидфайл мог застыть от connect-процесса (урок 31.08 19:46)."""
    if PIDFILE.exists():
        try:
            pid = int(PIDFILE.read_text().strip() or 0)
        except ValueError:
            pid = 0
        if pid > 0 and _proc_alive(pid):
            return True
    if not _procfs_available():
        return False  # вне Linux скан невозможен — верим только пидфайлу
    for p in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            if "bin/camoufox-research" in Path(p).read_bytes().decode("utf-8", "ignore"):
                return True
        except OSError:
            continue
    return False


def _notify_state_key(verdict: str, checks: list[str]) -> str:
    """Ключ состояния для дедупа: СМЫСЛ вердикта, без времени.

    Урок 21.09 (нашли вопросом «почему всё ещё спамит»): дедуп сравнивал
    готовую строку, а в ней штамп `21.09 14:27` — два прогона в разные
    минуты давали разные строки, и уведомление уходило каждый раз. Тест
    этого не видел: два прогона подряд попадают в одну минуту.
    """
    return f"{verdict} " + " ".join(checks)


def _notify_cmd(msg: str, urgency: str, title: str = "Кауфми-пульс") -> list[str] | None:
    """argv уведомления под текущую ОС; None — механизма нет.

    Linux — notify-send (libnotify), macOS — osascript (display
    notification), Windows — PowerToys-free toast через PowerShell
    (Windows.UI.Notifications есть в 5.1 из коробки). Раньше был только
    notify-send, поэтому на mac/win уведомлений не было вовсе.
    """
    if sys.platform == "darwin":
        exe = shutil.which("osascript")
        if not exe:
            return None
        script = (f"display notification {json.dumps(msg)} "
                  f"with title {json.dumps(title)}")
        if urgency == "critical":
            script += ' sound name "Basso"'
        return [exe, "-e", script]
    if sys.platform == "win32":
        exe = (shutil.which("powershell") or shutil.which("powershell.exe")
               or shutil.which("pwsh"))
        if not exe:
            return None
        q = lambda s: s.replace("'", "''")  # noqa: E731 — экранирование PS
        ps = (
            "[Windows.UI.Notifications.ToastNotificationManager,"
            " Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;"
            "$t=[Windows.UI.Notifications.ToastNotificationManager]::"
            "GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]"
            "::ToastText02);"
            "$x=$t.GetElementsByTagName('text');"
            f"$x.Item(0).AppendChild($t.CreateTextNode('{q(title)}')) > $null;"
            f"$x.Item(1).AppendChild($t.CreateTextNode('{q(msg)}')) > $null;"
            "$n=[Windows.UI.Notifications.ToastNotification]::new($t);"
            "[Windows.UI.Notifications.ToastNotificationManager]::"
            "CreateToastNotifier('camoufox-research').Show($n)"
        )
        return [exe, "-NoProfile", "-Command", ps]
    exe = shutil.which("notify-send")
    if not exe:
        return None
    return [exe, "-u", urgency, title, msg]


def _notify_allowed() -> bool:
    """Разрешены ли уведомления на рабочий стол.

    ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНЫ (21.09, требование владельца: «спамит —
    прекрати просто в системе»). Пульс — фоновая проверка: её результат и
    так лежит в `health-pulse.log` и в файле ALERT, лезть на рабочий стол
    без явного согласия она не должна. Включается ровно одним способом:
    HEALTH_PULSE_NOTIFY=1. Дисплей и сессионная шина спрашиваются только
    на Linux — на macOS/Windows их нет, а уведомление работает.
    """
    if os.environ.get("HEALTH_PULSE_NOTIFY", "").strip().lower() not in (
            "1", "true", "yes", "on"):
        return False
    if sys.platform.startswith("linux"):
        if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            return False
        if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
            return False
    return True


def _notify_worth_it(state: str) -> bool:
    """Тот же смысл вердикта — одно уведомление, а не по одному на прогон.

    Помним последнее отправленное СОСТОЯНИЕ; то же состояние молчит, пока
    не истекло окно HEALTH_PULSE_NOTIFY_REPEAT_MIN (default 1440 мин —
    сутки), потом напоминает снова. Смена состояния уведомляет сразу.
    """
    repeat_min = int(os.environ.get("HEALTH_PULSE_NOTIFY_REPEAT_MIN", "1440"))
    state_path = CACHE / "health-pulse_notify.state"  # от CACHE: тесты патчат его
    now = time.time()
    try:
        last = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        last = {}
    if last.get("state") == state and now - float(last.get("ts") or 0) < repeat_min * 60:
        return False
    with contextlib.suppress(OSError):
        # состояние не записалось — уведомление важнее, шлём
        state_path.write_text(json.dumps({"state": state, "ts": now}), encoding="utf-8")
    return True


def _notify(msg: str, urgency: str, state: str = "") -> None:
    """Уведомление на рабочий стол: best-effort, НЕ блокирует пульс.

    Спавн ограничен (_notify_allowed), дедуп по состоянию (_notify_worth_it),
    короткий таймаут и глушение ЛЮБОЙ ошибки: висящий notify-send уносил
    пульс в трейсбек вместе с вердиктом и кодом возврата (урок 21.09).
    """
    if not _notify_allowed() or not _notify_worth_it(state or msg):
        return
    cmd = _notify_cmd(msg, urgency)
    if not cmd:
        return
    with contextlib.suppress(Exception):
        # нет механизма/шины/таймаут — вердикт пульса важнее
        subprocess.run(
            cmd,
            timeout=5,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


if __name__ == "__main__":
    sys.exit(main())
