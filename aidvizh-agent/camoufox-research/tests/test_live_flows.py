#!/usr/bin/env python3
"""Живые сценарии, которые владелец проверял руками: логин в форму, ленивый
скролл, честный отказ на file://.

Зачем файл (21.09): остальные тесты подменяют браузер и сеть заглушками — и
это правильно, 258 тестов обязаны бегать без сети. Но именно поэтому ЖИВОЙ
слой (реальный MCP-сервер → воркер → Camoufox → чужой публичный стенд) не
проверялся ничем, кроме рук владельца: сломанный селектор в session_form_fill,
переставшая догружаться ленивая лента или возврат isError=false на отказ
схемы не покраснели бы НИ В ОДНОМ тесте. Здесь сценарии закреплены как
регрессия, но за флагом: без `CAMOUFOX_LIVE_TESTS=1` файл пропускает всё
(skipUnless), поэтому обычный `unittest discover` в CI его не выполняет.

Запуск (и разбор сценариев): docs/testing-live-flows.md.
"""

import contextlib
import json
import os
import signal
import sys
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

# mcp_drive — штатный харнесс репо (scripts/mcp_drive.py: stdio-клиент MCP
# + Server с уборкой
# stderr-потока). Лежит РЯДОМ с репо, не в пакете: путь можно переопределить.
_DRIVE_DIR = Path(os.environ.get("CAMOUFOX_MCPDRIVE_DIR") or str(REPO.parent))
sys.path.insert(0, str(_DRIVE_DIR))
_DRIVE_ERR = ""
try:
    from mcp_drive import Server  # scripts/ добавлен в sys.path выше
except Exception as e:  # драйвер внешний: текст причины нужен для диагноза
    Server = None
    _DRIVE_ERR = f"{type(e).__name__}: {e}"

LIVE_FLAG = "CAMOUFOX_LIVE_TESTS"
LIVE = os.environ.get(LIVE_FLAG, "").strip() == "1"
SKIP_REASON = (
    f"живой прогон: реальный MCP-сервер + Camoufox + чужие публичные стенды; "
    f"включается {LIVE_FLAG}=1 (см. docs/testing-live-flows.md)"
)

# Публичный демо-стенд the-internet: логин и пароль напечатаны на самой
# странице — это не секрет, а фикстура.
LOGIN_URL = "https://the-internet.herokuapp.com/login"
SECURE_URL = "https://the-internet.herokuapp.com/secure"
SCROLL_URL = "https://the-internet.herokuapp.com/infinite_scroll"
LOGIN = "tomsmith"
PASSWORD = "SuperSecretPassword!"
# Лента infinite_scroll догружает блоки с этим классом (jscroll).
BLOCKS_JS = "document.querySelectorAll('.jscroll-added').length"

# Планка на ТЕСТ целиком, включая уборку: холодный старт браузера + чужой
# стенд. Замер 21.09: логин-сценарий ~16с, скролл ~38с, file:// ~0.03с —
# планка в разы выше с запасом на сеть/капчу, но не бесконечность.
TEST_TIMEOUT = int(os.environ.get("CAMOUFOX_LIVE_TIMEOUT", "300"))
ATTEMPTS = 3  # соседний агент может держать браузер прямо сейчас
RETRY_SLEEP = 20

# Что считаем «занято/перезапустилось», а не поломкой: sync-API Playwright
# потокопривязан, браузер и вкладка — общее состояние воркера, поэтому у
# соседа вылезает именно это. Указание владельца (21.09): ЖДАТЬ и повторять,
# а не пропускать тест. Timeout добавлен осознанно: у чужого стенда это
# обычно сеть/капча, а не сломанный селектор, и полный провал всё равно
# виден после всех попыток.
TRANSIENT = (
    "Cannot switch to a different thread",
    "EPIPE",
    "Broken pipe",
    "Target closed",
    "has been closed",
    "Timeout ",
    "воркер не ответил за",
    "не обслужен (",
    "пустой ответ воркера",
    "server closed stdout",
    "no reply for id=",
    "429 Too Many Requests",
)


class _Temporary(Exception):
    """Сбой, который лечится ожиданием/перезапуском сервера."""


class _LiveTimeout(Exception):
    """Тест не уложился в TEST_TIMEOUT — висим (браузер/сеть), а не падаем."""


@unittest.skipUnless(LIVE, SKIP_REASON)
class LiveFlowTest(unittest.TestCase):
    """Один MCP-сервер на класс: браузер поднимается ~8с, на каждый тест это
    лишние полминуты. Состояние вкладки между тестами не течёт — setUp и
    tearDown закрывают сессию (session_end)."""

    server = None

    @classmethod
    def setUpClass(cls):
        if Server is None:
            # Пропуск здесь был бы ложью: флаг включён, значит прогон ждали.
            raise AssertionError(
                f"нет драйвера mcp_drive ({_DRIVE_ERR}); "
                f"CAMOUFOX_MCPDRIVE_DIR={_DRIVE_DIR}"
            )
        cls.server = cls._spawn()

    @classmethod
    def _spawn(cls):
        """Сервер с профилем тулов из задания: research+browser+session."""
        srv = Server(str(REPO), {"CAMOUFOX_CAPS": "research,browser,session"})
        srv.handshake()
        return srv

    @classmethod
    def tearDownClass(cls):
        if cls.server is None:
            return
        with contextlib.suppress(Exception):
            cls._yield_session(cls.server)
        cls._dispose(cls.server)  # EOF воркеру → браузер закрывается сам
        cls.server = None

    # --- транспорт ------------------------------------------------------
    @staticmethod
    def _dispose(srv):
        """Стоп + закрытие труб. mcp_drive.stop() закрывает только stdin, а
        stdout/stderr остаются открытыми и ругаются ResourceWarning в конце
        прогона — шум, в котором теряются настоящие предупреждения."""
        with contextlib.suppress(Exception):
            srv.stop()
        for stream in (srv.p.stdout, srv.p.stderr):
            with contextlib.suppress(Exception):
                stream.close()

    @staticmethod
    def _yield_session(srv):
        """session_end по сырому rpc: любой ответ (в т.ч. ошибка) — не провал."""
        srv.rpc("tools/call", {"name": "session_end", "arguments": {}})

    def _raw(self, tool, args):
        """Один вызов тула → (isError, текст). Транспортные сбои → _Temporary."""
        cls = type(self)
        try:
            reply = cls.server.rpc("tools/call", {"name": tool, "arguments": args})
        except Exception as e:  # мёртвый сервер не переиспользуем
            self._restart()
            raise _Temporary(f"{tool}: транспорт ({type(e).__name__}: {e})") from e
        if "error" in reply:  # RPC-ошибка протокола, не ответ тула
            raise _Temporary(f"{tool}: RPC error {reply['error']!r}")
        res = reply["result"]
        text = "".join(
            c.get("text", "") for c in res.get("content", []) if c.get("type") == "text"
        )
        is_error = bool(res.get("isError"))
        if is_error and any(mark in text for mark in TRANSIENT):
            raise _Temporary(f"{tool}: {text[:200]}")
        return is_error, text

    def _restart(self):
        """Мёртвый сервер не переиспользуем: новый процесс = чистый воркер."""
        cls = type(self)
        if cls.server is not None:
            cls._dispose(cls.server)
        cls.server = cls._spawn()

    def _ok(self, tool, args):
        """Вызов, где ошибка = провал: текст ответа либо AssertionError."""
        is_error, text = self._raw(tool, args)
        self.assertFalse(is_error, f"{tool} вернул ошибку: {text[:400]}")
        return text

    def _flow(self, url, steps):
        """Сценарий целиком с повторами. Возвращает (текст старта, ответы шагов).

        Повтор — это СЦЕНАРИЙ С НАЧАЛА (session_end → session_start): после
        перезапуска сервера вкладки и логин-куки не существуют, поэтому
        повторять отдельный шаг было бы враньём.
        """
        last = ""
        for attempt in range(1, ATTEMPTS + 1):
            try:
                self._session_end()
                start = self._ok("session_start", {"url": url})
                return start, [self._ok(name, args) for name, args in steps]
            except _Temporary as e:
                last = str(e)
                if attempt < ATTEMPTS:
                    time.sleep(RETRY_SLEEP * attempt)
        self.fail(f"сценарий {url} не прошёл за {ATTEMPTS} попыток: {last}")

    def _session_end(self):
        """Уборка: за тестом не должно остаться открытой вкладки/сессии."""
        with contextlib.suppress(Exception):
            self._yield_session(type(self).server)

    # --- таймаут на тест (включая уборку) -------------------------------
    def _arm(self):
        if not hasattr(signal, "SIGALRM"):  # Windows: только штатный таймаут rpc
            return
        signal.signal(signal.SIGALRM, self._on_alarm)
        signal.alarm(TEST_TIMEOUT)

    @staticmethod
    def _on_alarm(signum, frame):
        raise _LiveTimeout(f"тест завис: не уложился в {TEST_TIMEOUT}с")

    @staticmethod
    def _disarm():
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)

    def setUp(self):
        self._arm()

    def tearDown(self):
        try:
            self._session_end()
        finally:
            self._disarm()

    # --- сценарии -------------------------------------------------------
    def test_login_then_secure_area(self):
        """Логин формой и вход в закрытую зону В ТОЙ ЖЕ вкладке (куки живут)."""
        steps = [
            (
                "session_form_fill",
                {
                    "fields": json.dumps({"#username": LOGIN, "#password": PASSWORD}),
                    "submit": "button[type=submit]",
                },
            ),
            ("session_navigate", {"url": SECURE_URL}),
        ]
        started, (filled, secure) = self._flow(LOGIN_URL, steps)
        self.assertIn("Login Page", started, "открылась не страница логина")
        # «НЕ НАЙДЕН» — так тул сообщает, что поля на странице нет: сценарный
        # отказ должен читаться сразу, а не как «нет текста про логин».
        self.assertNotIn("НЕ НАЙДЕН", filled)
        self.assertIn("You logged into a secure area", filled)
        self.assertIn("Secure Area", secure)

    def test_infinite_scroll_loads_more_blocks(self):
        """Ленивая лента: после session_scroll блоков БОЛЬШЕ, чем до него."""
        steps = [
            ("session_eval", {"expression": BLOCKS_JS}),
            ("session_scroll", {"direction": "bottom", "max_chars": 200}),
            ("session_eval", {"expression": BLOCKS_JS}),
        ]
        _, (before, _, after) = self._flow(SCROLL_URL, steps)
        for name, raw in (("до скролла", before), ("после скролла", after)):
            self.assertTrue(
                raw.strip().isdigit(),
                f"счётчик блоков {name} не число: {raw[:80]!r} (селектор .jscroll-added?)",
            )
        self.assertGreater(
            int(after),
            int(before),
            "скролл не догрузил ленту: lazy-подгрузка сломана либо блоки не считаются",
        )

    def test_file_scheme_is_refused(self):
        """Честный отказ: file:// не читается — страж схемы стоит ДО кэша."""
        is_error, text = self._raw("fetch_page", {"url": "file:///etc/passwd"})
        self.assertTrue(is_error, "file:// уехал как успешный ответ — стража нет")
        self.assertIn("схема 'file' запрещена", text)
        self.assertIn("http/https", text)


if __name__ == "__main__":
    unittest.main()
