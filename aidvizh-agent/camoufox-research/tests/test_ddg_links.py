#!/usr/bin/env python3
"""Ссылка клиенту — цель, а не редирект DDG.

html.duckduckgo.com отдаёт часть результатов через
//duckduckgo.com/l/?uddg=<urlencoded>&rut=… — web_search печатал клиенту
именно это (проверено 21.09), агент декодировал сам, а домены считались
по duckduckgo.com. Разворот — в парсере, поэтому его и проверяем: строка
ниже — реальный ответ DDG из живой пробы, не выдумка.

Сеть не трогаем: _unwrap_ddg — чистая функция.
"""

import sys
import unittest
from pathlib import Path

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)


class DdgLinkTest(unittest.TestCase):
    def test_unwraps_real_wrapper(self):
        from camoufox_research.camoufox_browser_core import _unwrap_ddg

        wrapped = ("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2F"
                   "daijro%2Fcamoufox&rut=20845cdb8742c42296623c2924391921")
        self.assertEqual(_unwrap_ddg(wrapped), "https://github.com/daijro/camoufox")

    def test_unwraps_scheme_relative(self):
        from camoufox_research.camoufox_browser_core import _unwrap_ddg

        self.assertEqual(
            _unwrap_ddg("//duckduckgo.com/l/?uddg=https%3A%2F%2Fcamoufox.com%2F"),
            "https://camoufox.com/",
        )

    def test_percent_escapes_survive(self):
        """parse_qs уже раскодировал — повторный unquote калечил цель:
        «/a%20b» превращался в «/a b», «?q=a%2Bb» — в «?q=a+b»."""
        from urllib.parse import quote

        from camoufox_research.camoufox_browser_core import _unwrap_ddg

        for target in ("https://example.com/a%20b",
                       "https://example.com/?q=a%2Bb",
                       "https://ru.wikipedia.org/wiki/%D0%A2%D0%B5%D1%81%D1%82"):
            wrapped = "https://duckduckgo.com/l/?uddg=" + quote(target, safe="")
            self.assertEqual(_unwrap_ddg(wrapped), target)

    def test_plain_urls_untouched(self):
        from camoufox_research.camoufox_browser_core import _unwrap_ddg

        for url in ("https://github.com/daijro/camoufox",
                    "https://duckduckgo.com/?q=camoufox",
                    "https://example.com/l/?uddg=not-a-url"):
            self.assertEqual(_unwrap_ddg(url), url)


if __name__ == "__main__":
    unittest.main()
