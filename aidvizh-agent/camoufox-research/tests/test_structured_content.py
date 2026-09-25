#!/usr/bin/env python3
"""Контракт MCP: JSON-режимы отдают structuredContent, текст — как раньше.

Зачем тест (скилл mcp-builder): агент должен получать разобранный объект,
а не строку с JSON внутри. Ловушка SDK: `structuredContent` валидируется
по outputSchema ПОСТОЯННО, поэтому объявлять схему «на все режимы» нельзя —
текстовый режим сломается (проверено живой пробой). Форма ответа воркера
меняется легко, и это надо держать под тестом, а не в /tmp-скрипте.

Ни сети, ни браузера, ни БД: `call` подменён, состав тулов — как у сервера.
"""

import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

_RESEARCH_JSON = json.dumps(
    {"meta": {"sources": 2}, "sources": [{"url": "u"}], "texts": [], "notes": []},
    ensure_ascii=False,
)


class _FakeMCP:
    """@mcp.tool() собирает тулы в словарь — сервер не поднимаем."""

    def __init__(self):
        self.tools = {}

    def tool(self):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn

        return deco


def _register():
    from camoufox_research.camoufox_research_tools import register

    seen = []

    def fake_call(name, **kwargs):
        seen.append((name, kwargs))
        if name == "research":
            return _RESEARCH_JSON if kwargs.get("as_json") else "источников: 2"
        if name == "research_index":
            return json.dumps([{"id": "cmp_1"}], ensure_ascii=False)
        if name == "research_report":
            return json.dumps({"id": "cmp_1", "items": []}, ensure_ascii=False)
        return "ok"

    mcp = _FakeMCP()
    register(mcp, fake_call)
    return mcp.tools, seen


class StructuredWrapperTest(unittest.TestCase):
    """`_structured` решает по ФАКТУ разбора, а не по флагу."""

    def setUp(self):
        from camoufox_research.camoufox_research_tools import _structured

        self.wrap = _structured

    def test_json_becomes_structured_and_keeps_text(self):
        r = self.wrap(_RESEARCH_JSON)
        self.assertEqual(r.structured_content, json.loads(_RESEARCH_JSON))
        self.assertEqual(r.content[0].text, _RESEARCH_JSON)

    def test_plain_text_has_no_structured(self):
        r = self.wrap("источников: 2\nдоменов: 2")
        self.assertIsNone(r.structured_content)
        self.assertEqual(r.content[0].text, "источников: 2\nдоменов: 2")

    def test_array_is_wrapped_in_object(self):
        """structuredContent по протоколу — объект, массив заворачиваем."""
        r = self.wrap(json.dumps([{"id": "cmp_1"}]), "campaigns")
        self.assertEqual(r.structured_content, {"campaigns": [{"id": "cmp_1"}]})

    def test_broken_json_stays_a_string(self):
        r = self.wrap("ошибка: не-JSON ответ: мусор")
        self.assertIsNone(r.structured_content)


class ToolJsonModesTest(unittest.TestCase):
    def setUp(self):
        self.tools, self.seen = _register()

    def test_research_json_mode(self):
        out = self.tools["research"](queries=["x"], as_json=True)
        self.assertEqual(out.structured_content["meta"]["sources"], 2)

    def test_research_text_mode_unchanged(self):
        out = self.tools["research"](queries=["x"])
        self.assertIsNone(out.structured_content)
        self.assertEqual(out.content[0].text, "источников: 2")

    def test_index_and_report_json_modes(self):
        idx = self.tools["research_index"](fmt="json")
        self.assertEqual(idx.structured_content, {"campaigns": [{"id": "cmp_1"}]})
        rep = self.tools["research_report"](camp_id="c", fmt="json")
        self.assertEqual(rep.structured_content["id"], "cmp_1")

    def test_long_tools_get_a_real_budget(self):
        """Дефолт моста 120с на 30-40 URL — гарантированный обрыв."""
        self.tools["citation_pack"](camp_id="c")
        self.tools["research_digest"](camp_id="c")
        by_name = dict((n, k.get("timeout")) for n, k in self.seen)
        self.assertEqual(by_name.get("citation_pack"), 900)
        self.assertEqual(by_name.get("research_digest"), 900)


if __name__ == "__main__":
    unittest.main()
