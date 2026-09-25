#!/usr/bin/env python3
"""Стражи доступа: URL (анти-SSRF/LFI) и путь записи (анти-RCE).

Дыры от 21.09 (нашёл security-аудит, воспроизведены без браузера):
  1) `fetch_page`/`session_navigate`/`crawl`/`read_document`/`session_download`
     принимали ЛЮБУЮ схему и адрес: `file:///etc/passwd` читался как
     локальный файл, `http://127.0.0.1:8833/…` и `169.254.169.254` — как
     SSRF через доверенный браузер владельца;
  2) `export(data, path=…)` и `citation_report(camp_id, path=…)` писали файл
     по любому пути с управляемым содержимым. `~/.cache/camoufox-research/
     config.env` подключается через `.` в cron-скриптах (`map_metric_cron.sh`,
     `pre-commit_autoupdate.sh`) — значит текст со страницы превращался в
     исполнение кода от владельца.

Тесты чистые: ни сети, ни браузера, ни записи вне temp.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)

from camoufox_research import camoufox_paths as paths  # noqa: E402


class UrlGuardTest(unittest.TestCase):
    """check_url: пропускает только http(s) на публичный адрес."""

    def setUp(self):
        from camoufox_research.camoufox_urlguard import check_url

        self.check = check_url
        for var in ("CAMOUFOX_ALLOW_FILE", "CAMOUFOX_ALLOW_PRIVATE"):
            os.environ.pop(var, None)

    def _rejected(self, url, needle=""):
        with self.assertRaises(ValueError) as cm:
            self.check(url)
        if needle:
            self.assertIn(needle, str(cm.exception))
        return str(cm.exception)

    def test_rejects_file_scheme(self):
        self._rejected("file:///etc/passwd", "схема")

    def test_rejects_data_and_js_schemes(self):
        for u in ("data:text/html,<script>1</script>", "javascript:alert(1)",
                  "blob:https://x/y", "view-source:http://x", "ftp://x/y"):
            self._rejected(u, "схема")

    def test_rejects_loopback_and_private(self):
        for u in ("http://127.0.0.1:8833/x", "http://localhost/x",
                  "http://[::1]/x", "http://10.0.0.5/", "http://192.168.1.1/",
                  "http://172.20.3.4/", "http://169.254.169.254/latest/meta-data/",
                  "http://0.0.0.0/", "http://127.1/x", "http://2130706433/x",
                  "http://printer.local/", "http://box.internal/"):
            self._rejected(u, "внутренний")

    def test_allows_public_http(self):
        for u in ("https://example.com/x", "http://93.184.216.34/x",
                  "https://ru.wikipedia.org/wiki/Тест"):
            self.assertEqual(self.check(u), u)

    def test_empty_and_garbage(self):
        for u in ("", "   ", "не-урл", "https://"):
            self._rejected(u)

    def test_file_allowed_by_env(self):
        with mock.patch.dict(os.environ, {"CAMOUFOX_ALLOW_FILE": "1"}):
            self.assertEqual(self.check("file:///etc/hostname"), "file:///etc/hostname")
        self._rejected("file:///etc/hostname")

    def test_private_allowed_by_env(self):
        with mock.patch.dict(os.environ, {"CAMOUFOX_ALLOW_PRIVATE": "1"}):
            self.assertEqual(self.check("http://127.0.0.1:8080/x"),
                             "http://127.0.0.1:8080/x")


class ExportPathGuardTest(unittest.TestCase):
    """Запись только внутрь каталога экспорта."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name) / "exports"
        self.dir.mkdir()
        from camoufox_research import camoufox_export as ex

        self.ex = ex
        for p in (mock.patch.object(paths, "export_dir", return_value=self.dir),
                  mock.patch.dict(os.environ, {}, clear=False)):
            p.start()
            self.addCleanup(p.stop)
        os.environ.pop("CAMOUFOX_ALLOW_ANY_PATH", None)

    def test_default_path_goes_to_export_dir(self):
        out = self.ex.export('{"a": 1}', "json")
        self.assertIn(str(self.dir), out)
        self.assertTrue(Path(out.split("сохранено: ")[1].split(" (")[0]).exists())

    def test_absolute_path_outside_is_refused(self):
        victim = Path(self._tmp.name) / "config.env"
        out = self.ex.export('["x"]', "md", str(victim))
        self.assertTrue(out.startswith("ошибка:"), out)
        self.assertIn("вне каталога", out)
        self.assertFalse(victim.exists())

    def test_traversal_is_refused(self):
        out = self.ex.export('["x"]', "md", str(self.dir / ".." / "config.env"))
        self.assertTrue(out.startswith("ошибка:"), out)
        self.assertFalse((Path(self._tmp.name) / "config.env").exists())

    def test_inside_path_still_allowed(self):
        target = self.dir / "мой-отчёт.md"
        out = self.ex.export('["строка"]', "md", str(target))
        self.assertIn("сохранено", out)
        self.assertTrue(target.exists())

    def test_escape_hatch_env(self):
        victim = Path(self._tmp.name) / "anywhere.md"
        with mock.patch.dict(os.environ, {"CAMOUFOX_ALLOW_ANY_PATH": "1"}):
            out = self.ex.export('["x"]', "md", str(victim))
        self.assertIn("сохранено", out)
        self.assertTrue(victim.exists())

    def test_citation_report_path_guarded(self):
        from camoufox_research import camoufox_digest_ext as de
        from camoufox_research import camoufox_export as ex

        victim = Path(self._tmp.name) / "outside.md"
        with mock.patch.object(paths, "export_dir", return_value=self.dir):
            out = de.citation_report("cmp_x", path=str(victim))
        # причина проверяется дословно: «ошибка:» прилетает и от «нет
        # источников», то есть по префиксу тест был бы ложнозелёным
        self.assertIn("вне каталога", out)
        self.assertFalse(victim.exists())


class FetchChokePointsTest(unittest.TestCase):
    """Страж стоит там, где реально приходит URL от пользователя/страницы.

    Проверяем ИСХОДНИК конкретных функций (inspect.getsource), а не число
    вхождений в файле: важно, что охраняется каждый вход, а не что импорт
    присутствует.
    """

    def _has_guard(self, module: str, func: str) -> bool:
        import importlib
        import inspect

        mod = importlib.import_module(f"camoufox_research.{module}")
        fn = getattr(mod, func, None)
        self.assertIsNotNone(fn, f"нет {module}.{func}")
        return "check_url(" in inspect.getsource(fn)

    def test_browser_goto_guarded(self):
        """Единственная дверь браузера: _goto (через неё идут все тулы)."""
        self.assertTrue(self._has_guard("camoufox_browser_core", "_goto"))

    def test_urllib_paths_guarded(self):
        for module, func in (("camoufox_crawl_core", "_fetch_bytes"),
                             ("camoufox_crawl_ext", "check_links"),
                             ("camoufox_docs", "_download_temp"),
                             ("camoufox_session_ext", "session_download")):
            with self.subTest(module=module, func=func):
                self.assertTrue(self._has_guard(module, func), f"{module}.{func}")


if __name__ == "__main__":
    unittest.main()


class CacheBypassTest(unittest.TestCase):
    """Страж обязан стоять ДО кэша.

    Живая проба 21.09: `fetch_page("file:///etc/passwd")` вернул 300 символов
    при already-исправленном страже — текст лежал в кэше с прогона, который
    случился до правки. Кэш = вечный обход стража, поэтому проверка адреса
    идёт первой строкой тула, а не только внутри _goto.
    """

    def test_fetch_page_checks_url_before_cache(self):
        from unittest import mock

        from camoufox_research import camoufox_worker_core_b as w

        poisoned = "root:x:0:0:root:/root:/bin/bash"
        with mock.patch.object(w, "_cache_get", return_value=poisoned) as cache, \
                mock.patch.object(w, "_browser_ctx") as browser:
            with self.assertRaises(ValueError):
                w.fetch_page("file:///etc/passwd")
        cache.assert_not_called()
        browser.assert_not_called()

    def test_normal_url_still_reads_cache(self):
        from unittest import mock

        from camoufox_research import camoufox_worker_core_b as w

        with mock.patch.object(w, "_cache_get", return_value="готовый текст") as cache:
            self.assertEqual(w.fetch_page("https://example.com"), "готовый текст")
        cache.assert_called_once()
