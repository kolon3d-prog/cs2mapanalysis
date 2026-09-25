#!/usr/bin/env python3
"""session_network: HTTP-статус вкладки вместо KeyError.

Живой баг (замер 21.09.2026): писатель наблюдения
(`camoufox_session_core_a._watch_page`) клал сеть под ключом `"net"`, а
читатель (`camoufox_session_ext.session_network`) брал `w["network"]` —
тул падал `KeyError: 'network'` на КАЖДОЙ вкладке. Итог: «прошло / 403 /
429» агент определить не мог, «страница пустая» оставалось догадкой.

Контракт после правки — ОДИН источник правды: состояние наблюдения
создаёт только `_watch_page` (ключи `network`/`console`/`blocked`), а все
читатели ходят через `watch_state(page)` (живой словарь, а не копия имени
в фасаде — иначе после `session_reset` читатель смотрел бы в старый).

Без браузера/сети: вкладка — заглушка с `page.on`/`emit` (как Playwright),
`_session_page` подменён; режим кольца проверяется уменьшением `_NET_LIMIT`.
"""

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


class FakeRequest:
    """Мимикрия playwright.sync_api.Request (поля, которые читает наблюдатель)."""

    def __init__(self, url, method="GET", resource_type="document", failure=None):
        self.url = url
        self.method = method
        self.resource_type = resource_type
        self.failure = failure


class FakeResponse:
    def __init__(self, request, status=200):
        self.request = request
        self.url = request.url
        self.status = status


class FakePage:
    """Вкладка без браузера: page.on(event, fn) + emit(event, obj)."""

    def __init__(self):
        self.handlers = {}
        self.url = ""

    def on(self, event, fn):
        self.handlers.setdefault(event, []).append(fn)

    def emit(self, event, obj):
        for fn in self.handlers.get(event, []):
            fn(obj)

    def is_closed(self):
        return False


class SessionNetworkTest(unittest.TestCase):
    def setUp(self):
        from camoufox_research import camoufox_session_core_a as core_a
        from camoufox_research import camoufox_session_ext as ext

        self.core_a, self.ext = core_a, ext
        self.page = FakePage()
        self._limit = core_a._NET_LIMIT
        saved = (
            core_a._SESSION,
            core_a._SESSION_URL,
            core_a._TABS,
            core_a._NEXT_TAB,
            core_a._LIVE_PROVIDER,
        )
        core_a._WATCH.clear()
        # Живой путь без браузера: провайдер отдаёт заглушку-контекст, а
        # фокусная вкладка уже открыта и не закрыта — _session_page()
        # возвращает её, не создавая новых вкладок.
        core_a._LIVE_PROVIDER = lambda: (None, type("Ctx", (), {"new_page": FakePage})())
        core_a._SESSION, core_a._SESSION_URL = self.page, ""
        core_a._TABS, core_a._NEXT_TAB = {"1": self.page}, 2
        self.addCleanup(self._restore, saved)

    def _restore(self, saved):
        (
            self.core_a._SESSION,
            self.core_a._SESSION_URL,
            self.core_a._TABS,
            self.core_a._NEXT_TAB,
            self.core_a._LIVE_PROVIDER,
        ) = saved
        self.core_a._WATCH.clear()
        self.core_a._NET_LIMIT = self._limit

    def rows(self, out):
        return [line for line in out.splitlines() if line.startswith("[")]

    def test_response_status_reaches_the_agent(self):
        """Ключевая проверка бага: статус навигации виден, а не KeyError."""
        self.core_a._watch_page(self.page)
        req = FakeRequest("https://example.com/", "GET", "document")
        self.page.emit("request", req)
        self.page.emit("response", FakeResponse(req, 200))

        out = self.ext.session_network()

        self.assertIn("[200] GET document https://example.com/", out)
        self.assertIn("запросов: 1", out)
        self.assertEqual(len(self.rows(out)), 1, "запрос и ответ — ОДНА строка, не дубль")

    def test_state_keys_are_one_source_of_truth(self):
        """Ключи состояния — те, что читает session_network (канон)."""
        state = self.core_a._watch_page(self.page)

        self.assertEqual(set(state), {"network", "console", "blocked"})
        self.assertIs(state, self.core_a.watch_state(self.page))
        self.assertIs(state, self.ext._watch_of(self.page))

    def test_request_without_response_is_shown(self):
        """Запрос без ответа — факт, а не пропажа (оборванные/зависшие)."""
        self.core_a._watch_page(self.page)
        self.page.emit("request", FakeRequest("https://cdn.test/app.js", "GET", "script"))

        out = self.ext.session_network()

        self.assertIn("[—] GET script https://cdn.test/app.js", out)

    def test_failed_request_reports_reason(self):
        """Свой route в _goto режет картинки — агент должен видеть причину."""
        self.core_a._watch_page(self.page)
        req = FakeRequest("https://cdn.test/a.png", "GET", "image", failure="net::ERR_ABORTED")
        self.page.emit("request", req)
        self.page.emit("requestfailed", req)

        out = self.ext.session_network()

        self.assertIn("net::ERR_ABORTED", out)

    def test_ring_keeps_last_requests_not_first(self):
        """Кольцо: последние запросы, а не «первые 200 навсегда»."""
        self.core_a._NET_LIMIT = 3
        self.core_a._watch_page(self.page)
        for i in range(4):
            self.page.emit("request", FakeRequest(f"https://t.test/{i}", "GET", "xhr"))

        out = self.ext.session_network(limit=10)

        self.assertIn("запросов: 3", out)
        self.assertIn("кольцо 3 заполнено", out)
        self.assertIn("https://t.test/3", out)
        self.assertNotIn("https://t.test/0", out)

    def test_limit_reports_total_and_shown(self):
        self.core_a._watch_page(self.page)
        for i in range(5):
            self.page.emit("request", FakeRequest(f"https://t.test/{i}", "GET", "xhr"))

        out = self.ext.session_network(limit=2)

        self.assertIn("запросов: 5", out)
        self.assertIn("показаны последние 2", out)
        self.assertEqual(self.rows(out), ["[—] GET xhr https://t.test/3",
                                          "[—] GET xhr https://t.test/4"])

    def test_console_reads_same_state(self):
        self.core_a._watch_page(self.page)
        msg = type("Msg", (), {"type": "error", "text": "Uncaught TypeError"})()
        self.page.emit("console", msg)

        out = self.ext.session_console()

        self.assertIn("сообщений: 1", out)
        self.assertIn("[error] Uncaught TypeError", out)

    def test_block_does_not_crash_on_watched_page(self):
        """block/unblock писали в состояние без ключа `blocked` — KeyError."""
        self.core_a._watch_page(self.page)

        self.assertIn("блокирую: analytics", self.ext.session_block("analytics"))
        self.assertEqual(self.core_a.watch_state(self.page)["blocked"], ["analytics"])
        self.assertIn("блокировки сняты: 0 осталось", self.ext.session_unblock())
        self.assertEqual(self.core_a.watch_state(self.page)["blocked"], [])

    def test_unwatched_page_answers_honestly(self):
        """Наблюдателя нет — честный ответ, а не KeyError и не пустой вид."""
        self.assertIn("наблюдение вкладки потеряно", self.ext.session_network())
        self.assertTrue(self.ext.session_block("ads").startswith("ошибка:"))

    def test_watch_is_idempotent_and_per_page(self):
        self.core_a._watch_page(self.page)
        self.core_a._watch_page(self.page)
        self.page.emit("request", FakeRequest("https://t.test/one", "GET", "xhr"))

        self.assertEqual(len(self.core_a.watch_state(self.page)["network"]), 1,
                         "повторный _watch_page удвоил обработчики")
        self.assertIsNone(self.core_a.watch_state(FakePage()))

    def test_reset_does_not_leave_stale_network(self):
        """session_reset пересоздаёт _WATCH: читатель обязан видеть новый
        словарь, а не копию имени в фасаде (старый держал бы чужие запросы)."""
        self.core_a._watch_page(self.page)
        self.page.emit("request", FakeRequest("https://old.test/1", "GET", "xhr"))
        self.assertIn("old.test", self.ext.session_network())

        self.core_a._WATCH = {}  # ровно то, что делает session_reset
        self.core_a._watch_page(self.page)

        self.assertNotIn("old.test", self.ext.session_network())

    def test_new_tab_keeps_observer(self):
        """session_tabs op=new: новая вкладка сразу под наблюдением."""
        from camoufox_research import camoufox_session_core_b as core_b

        new_page = FakePage()
        context = type("Ctx", (), {"new_page": lambda _self: new_page})()
        self.core_a._LIVE_PROVIDER = lambda: (None, context)

        out = core_b.session_tabs(op="new")

        self.assertIn("вкладка 2 открыта", out)
        self.assertIsNotNone(self.core_a.watch_state(new_page), "вкладка без наблюдателя")
        self.assertIn(new_page, self.core_a.get_session_pages(),
                      "_close_pages закроет вкладку сессии")
        new_page.emit("request", FakeRequest("https://new.test/", "GET", "document"))
        self.assertIn("https://new.test/", self.ext.session_network())


if __name__ == "__main__":
    unittest.main()
