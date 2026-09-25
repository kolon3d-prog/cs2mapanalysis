#!/usr/bin/env python3
"""Контракт ошибок MCP: ошибка тула обязана быть isError=true, не текстом.

Живая проба 21.09: вызов вернул `isError=False` с текстом
`ошибка: TypeError: research_start() got an unexpected keyword argument
'terms_wave'`. Клиент-агент такое не отличит от успеха: не сработает
retry, не сработает ветвление «получилось/нет», ошибка утонет в выводе.
Причина: `_parse()` в мосте превращал ошибку воркера в СТРОКУ с префиксом
«ошибка:», а FastMCP строку отдаёт как успешный результат (isError=false).

Здесь проверяем обёртку моста `tool_call`: строка-ошибка → исключение
ToolError (SDK превратит его в isError=true), обычный ответ → как есть.
Браузер/сеть/БД не трогаем: `_call` подменён.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)


class ToolCallErrorContractTest(unittest.TestCase):
    def setUp(self):
        from camoufox_research import camoufox_research_bridge as br

        self.br = br

    def test_worker_error_becomes_exception(self):
        with mock.patch.object(self.br, "_call", return_value="ошибка: нет кампании cmp_x"):
            with self.assertRaises(self.br.ToolError) as cm:
                self.br.tool_call("research_status", camp_id="cmp_x")
        self.assertIn("нет кампании", str(cm.exception))

    def test_auth_error_becomes_exception(self):
        """401/429 рождаются в самом мосте — тоже обязаны быть исключением."""
        with mock.patch.object(self.br, "_call",
                               return_value="ошибка: 401 Unauthorized — неверный api_key"):
            with self.assertRaises(self.br.ToolError):
                self.br.tool_call("web_search", query="x")

    def test_success_passes_through(self):
        with mock.patch.object(self.br, "_call", return_value="[1] результат"):
            self.assertEqual(self.br.tool_call("web_search", query="x"), "[1] результат")

    def test_legit_text_with_word_error_inside_is_not_error(self):
        """Префикс — это ABI: «ошибка» в середине текста ошибкой не считается."""
        text = "источники: 3\n— в статье описана ошибка парсера"
        with mock.patch.object(self.br, "_call", return_value=text):
            self.assertEqual(self.br.tool_call("fetch_page", url="u"), text)

    def test_kwargs_forwarded_unchanged(self):
        with mock.patch.object(self.br, "_call", return_value="ok") as c:
            self.br.tool_call("research", timeout=900, queries=["a"], target_domains=3)
        c.assert_called_once_with("research", timeout=900, queries=["a"], target_domains=3)


class ServerWiringTest(unittest.TestCase):
    """Сервер обязан отдавать тулам ОБЁРТКУ, а не голый _call."""

    def test_raised_class_is_sdk_toolerror(self):
        """Свой класс вместо SDK-шного — живая ошибка: SDK считает это крахом
        (`UnexpectedToolError`), текст теряется, агенту достаётся «Error
        executing tool X» без причины. Проверено живьём 21.09."""
        from mcp.server.mcpserver.exceptions import ToolError as SDKToolError

        from camoufox_research import camoufox_research_bridge as br

        self.assertTrue(issubclass(br.ToolError, SDKToolError))

    def test_tools_registered_with_wrapper(self):
        import camoufox_research.camoufox_research as srv

        tools = srv.mcp._tool_manager._tools
        self.assertIn("research_status", tools)
        src = Path(srv.__file__).read_text(encoding="utf-8")
        self.assertIn("register_research(mcp, tool_call)", src)
        self.assertIn("register_session(mcp, tool_call)", src)


if __name__ == "__main__":
    unittest.main()
