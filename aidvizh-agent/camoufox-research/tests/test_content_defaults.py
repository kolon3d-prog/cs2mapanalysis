#!/usr/bin/env python3
"""Дефолты полноты: сколько контента отдают тулы БЕЗ аргументов и сколько воркеров.

Замер 21.09.2026 (цель владельца «победить tavily/exa по полноте»): дефолт
`max_chars=4000` был ниже, чем у конкурентов (tavily/exa отдают 1-30k на
страницу), поэтому «полнота по умолчанию» = обрезок. Здесь проверяется
КОНТРАКТ (числа и края), а не качество текста:

1) дефолты сигнатур движка совпадают с задокументированными константами
   (один источник правды DEFAULT_CONTENT_CHARS) и не превышают потолок
   хранения fetch_limit() — иначе дефолт обещает больше, чем мы храним;
2) `_workers_for` считает воркеров на краях правильно (0/1 URL, явный
   max_parallel, 0/отрицательное = «не распараллеливай»);
3) короткий батч с ЯВНЫМ max_parallel реально идёт в пул потоков, а без него
   остаётся последовательным (прежняя ловушка: порог >=8 URL отменял просьбу);
4) путь короткого батча добывает текст тем же extract_retry, что и
   параллельный (раньше у него была ХУДШАЯ полнота при той же работе);
5) кэш, снятый под низкий потолок (легаси 12k), не запирает «дай больше»;
6) max_chars входит в ключ кэша research — иначе повторный вызов с большим
   лимитом сутки отдавал бы прежнюю обрезку.

Без браузера и сети: браузерные вызовы подменены заглушками.
"""

import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


def _urls(n, host="example.com"):
    return [f"https://h{i}.{host}/page{i}" for i in range(n)]


class DefaultsDocumentedTest(unittest.TestCase):
    """Дефолты движка = задокументированные константы (замер в комментарии)."""

    def setUp(self):
        from camoufox_research import camoufox_fetch_core as core

        self.core = core

    def test_batch_fetch_default_is_completeness_value(self):
        import inspect

        default = inspect.signature(self.core.batch_fetch).parameters["max_chars"].default
        self.assertEqual(default, self.core.DEFAULT_CONTENT_CHARS)
        self.assertGreaterEqual(
            default, 10_000,
            "дефолт снова ниже облачных 1-30k на страницу: «полноты» не будет",
        )

    def test_research_default_is_completeness_value(self):
        import inspect

        from camoufox_research.camoufox_fetch_ext import research

        params = inspect.signature(research).parameters
        self.assertEqual(params["max_chars"].default, self.core.DEFAULT_CONTENT_CHARS)
        # fetch_top по умолчанию 0 — сознательно: движковые волны кампаний
        # (target_domains) читают сотни URL ради адресов; тул-слой MCP ставит
        # fetch_top=3, чтобы пользователь сразу получал тексты.
        self.assertEqual(params["fetch_top"].default, 0)

    def test_default_never_exceeds_storage_ceiling(self):
        from camoufox_research.camoufox_cache import fetch_limit

        self.assertLessEqual(
            self.core.DEFAULT_CONTENT_CHARS, fetch_limit(),
            "дефолт обещает больше символов, чем мы вообще храним",
        )

    def test_tool_layer_declares_same_default(self):
        """Тул-слой MCP (тут владелец другой) обязан объявлять ТОТ ЖЕ дефолт.

        Иначе агент по умолчанию получает одну полноту, а движок — другую:
        расхождение всплывает только замером и выглядит как «тул отдаёт не то».
        """
        try:
            from camoufox_research.camoufox_research_tools import _CONTENT_CHARS
        except (ImportError, AttributeError):  # тул-слой перестроен — не наш суд
            self.skipTest("в тул-слое нет _CONTENT_CHARS")
        self.assertEqual(
            _CONTENT_CHARS, self.core.DEFAULT_CONTENT_CHARS,
            "дефолт полноты в тул-слое разошёлся с движком",
        )


class WorkersForEdgesTest(unittest.TestCase):
    """Сколько воркеров пула нужно на N URL — края и явный заказ клиента."""

    def setUp(self):
        from camoufox_research import camoufox_fetch_core as core

        self.core = core

    def test_empty_and_single(self):
        self.assertEqual(self.core._workers_for(0), 0)
        self.assertEqual(self.core._workers_for(1), 1)
        self.assertEqual(self.core._workers_for(1, 4), 1)

    def test_explicit_parallel_is_honoured(self):
        self.assertEqual(self.core._workers_for(6, 4), 4)
        self.assertEqual(self.core._workers_for(8, 12), 8, "воркеров больше задач")

    def test_explicit_one_and_negative_mean_serial(self):
        self.assertEqual(self.core._workers_for(20, 1), 1)
        self.assertEqual(self.core._workers_for(20, 0), 1)
        self.assertEqual(self.core._workers_for(20, -3), 1)

    def test_auto_is_bounded_by_tasks(self):
        auto = self.core._auto_workers()
        self.assertEqual(self.core._workers_for(2, None), min(auto, 2))
        self.assertGreaterEqual(self.core._workers_for(8, None), 1)
        self.assertLessEqual(self.core._workers_for(8, None), 8)


class _ConcurrencyProbe:
    """Считает, сколько добыч текста шло ОДНОВРЕМЕННО (+ сколько всего)."""

    def __init__(self, text="т" * 300, delay=0.05):
        self.text = text
        self.delay = delay
        self.live = 0
        self.peak = 0
        self.calls = 0
        self.lock = threading.Lock()

    def _enter(self):
        with self.lock:
            self.live += 1
            self.calls += 1
            self.peak = max(self.peak, self.live)

    def _exit(self):
        with self.lock:
            self.live -= 1

    def serve(self, *args, **kwargs):
        """Заглушка и для _fetch_one (параллельный путь), и для extract_retry."""
        self._enter()
        time.sleep(self.delay)
        self._exit()
        return self.text


class BatchParallelTest(unittest.TestCase):
    """Явный max_parallel поднимает пул и на коротком батче; дефолт — нет."""

    def _run(self, urls, probe, **kwargs):
        from camoufox_research import camoufox_fetch_core as core

        calls = []
        with (
            mock.patch.object(core, "_cache_get", return_value=None),
            mock.patch.object(core, "_cache_set",
                              side_effect=lambda u, t, s="": calls.append(u)),
            mock.patch.object(core, "_save_to_internet", return_value=None),
            mock.patch.object(core, "_fetch_one",
                              side_effect=lambda u, mc, ao: (u, probe.serve())),
            mock.patch.object(core, "_browser_ctx", return_value=mock.MagicMock()),
            mock.patch.object(core, "_goto", return_value=None),
            mock.patch.object(core, "extract_retry",
                              side_effect=lambda p, u, ao, mc: probe.serve()),
        ):
            return core.batch_fetch(urls, **kwargs), calls

    def test_short_batch_with_explicit_max_parallel_uses_pool(self):
        probe = _ConcurrencyProbe()
        out, _ = self._run(_urls(3), probe, max_parallel=2)
        self.assertEqual(probe.calls, 3, "не все URL обработаны")
        self.assertEqual(
            probe.peak, 2,
            "max_parallel=2 на 3 URL не включил пул (прежняя ловушка порога >=8)",
        )
        self.assertEqual(out.count("--- URL:"), 3)

    def test_short_batch_without_explicit_parallel_stays_serial(self):
        probe = _ConcurrencyProbe()
        out, _ = self._run(_urls(3), probe)
        self.assertEqual(
            probe.peak, 1,
            "дефолт не должен плодить браузеры на 3 URL (один браузер дешевле)",
        )
        self.assertIn("--- URL:", out)

    def test_big_batch_keeps_pool(self):
        from camoufox_research import camoufox_fetch_core as core

        probe = _ConcurrencyProbe()
        out, _ = self._run(_urls(8), probe)
        self.assertEqual(probe.calls, 8)
        self.assertEqual(
            probe.peak, core._workers_for(8, None),
            "порог 8 URL перестал поднимать пул потоков",
        )
        self.assertEqual(out.count("--- URL:"), 8)


class ShortBatchRecallTest(unittest.TestCase):
    """Короткий батч добывает текст тем же extract_retry (паритет полноты)."""

    def test_short_batch_uses_retry_policy(self):
        from camoufox_research import camoufox_fetch_core as core

        extract_calls = []
        with (
            mock.patch.object(core, "_cache_get", return_value=None),
            mock.patch.object(core, "_cache_set", return_value=None),
            mock.patch.object(core, "_save_to_internet", return_value=None),
            mock.patch.object(core, "_browser_ctx", return_value=mock.MagicMock()),
            mock.patch.object(core, "_goto", return_value=None),
            mock.patch.object(core, "extract_retry",
                              side_effect=lambda p, u, ao, mc: (
                                  extract_calls.append(u), "ДЛИННЫЙ ТЕКСТ")[1]),
        ):
            out = core.batch_fetch(_urls(2), max_chars=12000)
        self.assertEqual(len(extract_calls), 2)
        self.assertIn("ДЛИННЫЙ ТЕКСТ", out)


class LegacyCacheTest(unittest.TestCase):
    """Кэш под низкий потолок не запирает «дай больше» (замер: 11999 из БД)."""

    def _run(self, cached_text, max_chars):
        from camoufox_research import camoufox_fetch_core as core

        probe = _ConcurrencyProbe(text="Я" * max_chars)
        with (
            mock.patch.object(core, "_cache_get", return_value=cached_text),
            mock.patch.object(core, "_cache_set", return_value=None),
            mock.patch.object(core, "_save_to_internet", return_value=None),
            mock.patch.object(core, "_browser_ctx", return_value=mock.MagicMock()),
            mock.patch.object(core, "_goto", return_value=None),
            mock.patch.object(core, "extract_retry",
                              side_effect=lambda p, u, ao, mc: probe.serve()),
        ):
            out = core.batch_fetch(["https://en.wikipedia.org/wiki/Web_scraping"],
                                  max_chars=max_chars, article_only=True)
        return out, probe.calls

    def test_truncated_cache_is_refetched(self):
        out, refetches = self._run("ы" * 12_000, 20_000)
        self.assertEqual(refetches, 1, "обрезанный кэш отдан вместо перечитки")
        self.assertEqual(len(out.split("\n", 1)[1]), 20_000)

    def test_honest_short_page_is_served_from_cache(self):
        out, refetches = self._run("ы" * 5_000, 20_000)
        self.assertEqual(refetches, 0, "короткую страницу перечитываем зря")
        self.assertEqual(len(out.split("\n", 1)[1]), 5_000)


class _FakeSearches:
    """sqlite-заглушка таблицы `searches` (ключ → (результат, ts))."""

    def __init__(self):
        self.rows = {}

    def connect(self, *_a, **_kw):
        return self

    def execute(self, sql, params=()):
        if sql.strip().upper().startswith("SELECT"):
            row = self.rows.get(params[0])
            return SimpleNamespace(fetchone=lambda: row)
        self.rows[params[0]] = (params[2], time.time())
        return SimpleNamespace(fetchone=lambda: None)

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


class ResearchCacheKeyTest(unittest.TestCase):
    """Разный max_chars — разный ответ, а не суточная обрезка из кэша."""

    def test_bigger_max_chars_is_not_served_from_cache(self):
        from camoufox_research import camoufox_fetch_ext as ext

        fake_db = _FakeSearches()
        fetches = []

        def fake_search(query, n, pages=1):
            return [("https://a.example.com/1", "Заголовок", "сниппет")]

        def fake_batch(urls, max_chars=None, **kw):
            fetches.append(max_chars)
            return "--- URL: https://a.example.com/1\n" + "т" * max_chars

        with (
            mock.patch.object(ext, "sqlite3", fake_db),
            mock.patch.object(ext, "_search_results", side_effect=fake_search),
            mock.patch.object(ext, "batch_fetch", side_effect=fake_batch),
        ):
            small = ext.research(queries=["полнота контента"], fetch_top=3, max_chars=4000)
            big = ext.research(queries=["полнота контента"], fetch_top=3, max_chars=12000)
        self.assertEqual(len(fetches), 2, "второй вызов не пошёл за текстом — кэш склеил")
        self.assertIn("т" * 4000, small)
        self.assertIn("т" * 12000, big)
        self.assertNotEqual(len(small), len(big))

    def test_same_arguments_are_served_from_cache(self):
        from camoufox_research import camoufox_fetch_ext as ext

        fake_db = _FakeSearches()
        fetches = []

        def fake_batch(urls, max_chars=None, **kw):
            fetches.append(max_chars)
            return "--- URL: https://a.example.com/1\n" + "т" * max_chars

        with (
            mock.patch.object(ext, "sqlite3", fake_db),
            mock.patch.object(
                ext, "_search_results",
                side_effect=lambda q, n, pages=1: [("https://a.example.com/1", "T", "s")]),
            mock.patch.object(ext, "batch_fetch", side_effect=fake_batch),
        ):
            first = ext.research(queries=["полнота контента"], fetch_top=3, max_chars=12000)
            second = ext.research(queries=["полнота контента"], fetch_top=3, max_chars=12000)
        self.assertEqual(len(fetches), 1, "повторный одинаковый вызов должен идти из кэша")
        self.assertEqual(first, second)
        self.assertIn("т" * 12000, second)


if __name__ == "__main__":
    unittest.main()
