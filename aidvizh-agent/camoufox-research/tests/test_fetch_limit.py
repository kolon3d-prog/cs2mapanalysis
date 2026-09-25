#!/usr/bin/env python3
"""Сколько контента реально отдаётся: потолок вместо жёстких 12k.

Замер 21.09: `fetch_page(max_chars=30000)` и даже 50000 возвращали РОВНО
12000 символов — в `camoufox_cache.py` стоял `_FETCH_LIMIT = 12000`, и он же
был потолком для кэша: обрезанный текст лежал в БД 24 часа, поэтому «дай
больше» не работало ни на первом, ни на повторном вызове. Для сравнения:
tavily/exa отдают 7-30k на страницу, то есть мы сами себе ставили потолок
ниже конкурентов.

Контракт после правки: сколько ХРАНИМ и несём в браузерный слой — вентиль
`CAMOUFOX_FETCH_LIMIT` (по умолчанию 100k); сколько ВЕРНУТЬ клиенту —
по-прежнему решает `max_chars` вызывающего.

Без браузера/сети: `_goto`/`extract_retry`/кэш подменены.
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


class FetchLimitTest(unittest.TestCase):
    def setUp(self):
        from camoufox_research import camoufox_cache as cache

        self.cache = cache
        os.environ.pop("CAMOUFOX_FETCH_LIMIT", None)

    def test_default_is_generous(self):
        self.assertGreaterEqual(self.cache.fetch_limit(), 100_000,
                                "потолок снова ниже облачных 7-30k на страницу")

    def test_env_overrides(self):
        with mock.patch.dict(os.environ, {"CAMOUFOX_FETCH_LIMIT": "5000"}):
            self.assertEqual(self.cache.fetch_limit(), 5000)

    def test_broken_env_falls_back(self):
        with mock.patch.dict(os.environ, {"CAMOUFOX_FETCH_LIMIT": "не-число"}):
            self.assertGreaterEqual(self.cache.fetch_limit(), 100_000)


class FetchPageReturnsMoreTest(unittest.TestCase):
    """fetch_page больше не режет на 12k и кладёт в кэш полный текст."""

    LONG = "ё" * 40_000

    def _run(self, max_chars):
        from camoufox_research import camoufox_worker_core_b as w

        stored = {}

        def fake_set(url, text, suffix=""):
            stored["len"] = len(text)

        # заглушка extract_retry ВЕДЁТ СЕБЯ КАК НАСТОЯЩАЯ — режет по
        # переданному лимиту; иначе тест замокал бы сам потолок и ничего не ловил
        def fake_extract(page, url, article_only, limit):
            return self.LONG[:limit]

        with (
            mock.patch.object(w, "_cache_get", return_value=None),
            mock.patch.object(w, "_prefetch_text", return_value=None),
            mock.patch.object(w, "_cache_set", side_effect=fake_set),
            mock.patch.object(w, "_save_to_internet", return_value=None),
            mock.patch.object(w, "_browser_ctx", return_value=mock.MagicMock()),
            # _goto/_wait_content не мокать нельзя: они реально ждут
            # контент по 8с на MagicMock-странице (тест полз 9с вместо 0.05)
            mock.patch.object(w, "_goto", return_value=None),
            mock.patch.object(w, "_wait_content", return_value=None),
            mock.patch.object(w, "extract_retry", side_effect=fake_extract),
        ):
            out = w.fetch_page("https://example.com/big", max_chars=max_chars)
        return out, stored

    def test_returns_more_than_old_ceiling(self):
        out, _ = self._run(30_000)
        self.assertEqual(len(out), 30_000,
                         "вернулось меньше запрошенного — потолок всё ещё режет")

    def test_cache_keeps_full_text_for_later_slices(self):
        _, stored = self._run(30_000)
        self.assertGreaterEqual(stored["len"], 30_000,
                                "в кэш ушла обрезанная копия — «дай больше» не сработает")

    def test_caller_max_chars_still_caps_return(self):
        out, _ = self._run(1_000)
        self.assertEqual(len(out), 1_000)


if __name__ == "__main__":
    unittest.main()


class CacheTooSmallTest(unittest.TestCase):
    """Кэш, снятый под старый потолок, не должен запирать «дай больше».

    Живая ловушка: страница уже лежит в БД с обрезанными 12000 символами
    (снята до правки потолка), и на запрос `max_chars=30000` мы отдали бы
    эти 12000 до истечения суточного TTL. Признак обрезки — длина ровно по
    прежнему потолку; тогда перечитываем страницу и обновляем кэш.
    """

    OLD_CEIL = 12_000

    def _fetch(self, cached_text, max_chars):
        from camoufox_research import camoufox_worker_core_b as w

        stored = {}
        refetched = {"n": 0}

        def fake_extract(page, url, article_only, limit):
            refetched["n"] += 1
            return "ё" * limit

        with (
            mock.patch.object(w, "_cache_get", return_value=cached_text),
            mock.patch.object(w, "_prefetch_text", return_value=None),
            mock.patch.object(w, "_cache_set",
                              side_effect=lambda u, t, s="": stored.update(len=len(t))),
            mock.patch.object(w, "_save_to_internet", return_value=None),
            mock.patch.object(w, "_browser_ctx", return_value=mock.MagicMock()),
            mock.patch.object(w, "_goto", return_value=None),
            mock.patch.object(w, "_wait_content", return_value=None),
            mock.patch.object(w, "extract_retry", side_effect=fake_extract),
        ):
            out = w.fetch_page("https://example.com/x", max_chars=max_chars)
        return out, refetched["n"], stored

    def test_truncated_cache_is_refetched(self):
        out, n, stored = self._fetch("ё" * self.OLD_CEIL, 30_000)
        self.assertEqual(n, 1, "обрезанный кэш отдан вместо перечитки")
        self.assertEqual(len(out), 30_000)
        self.assertGreaterEqual(stored.get("len", 0), 30_000)

    def test_short_page_is_served_from_cache(self):
        out, n, _ = self._fetch("короткая страница", 30_000)
        self.assertEqual(n, 0, "короткую страницу перечитывали зря")
        self.assertEqual(out, "короткая страница")

    def test_small_request_still_uses_cache(self):
        out, n, _ = self._fetch("ё" * self.OLD_CEIL, 2_000)
        self.assertEqual(n, 0, "запрос меньше кэша — перечитывать нечего")
        self.assertEqual(len(out), 2_000)
