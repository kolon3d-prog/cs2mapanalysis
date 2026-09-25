#!/usr/bin/env python3
"""Контракт «MCP-тул → ACTION воркера»: имена аргументов обязаны сходиться.

Живая проба 21.09 поймала ровно это: тул research_start передаёт
terms_wave/academic по имени, а ACTION-обёртка в camoufox_campaign_ext
их не принимала → «ошибка: TypeError: research_start() got an unexpected
keyword argument 'terms_wave'», кампания не стартовала вовсе. Юнит-тесты
кампаний этого не видели: они звали start() напрямую, минуя мост.

Здесь тулы регистрируются с ПОДМЕННЫМ call (побочек нет), поэтому видно,
какие kwargs каждый тул реально шлёт; их проверяем bind'ом по подписи
настоящего ACTION. Сеть/браузер/БД/воркер не трогаем.
"""

import inspect
import sys
import unittest
from pathlib import Path

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)

_COVERAGE_FLOOR = 30  # тулов, которые обязаны дойти до call с заглушкой


class _CollectingMCP:
    """@mcp.tool() возвращает функцию и запоминает её."""

    def __init__(self):
        self.tools = []

    def tool(self):
        def deco(fn):
            self.tools.append(fn)
            return fn

        return deco


def _dummy(param: inspect.Parameter):
    """Заглушка обязательного аргумента: call подменён, значение неважно."""
    s = str(param.annotation)
    if "bool" in s:
        return True
    if "int" in s or "float" in s:
        return 1
    if "list" in s:
        return ["x"]
    return "x"


def _collect_tools():
    """Все тулы обоих модулей + записанные пары (ACTION, kwargs)."""
    from camoufox_research import camoufox_research_tools as rt
    from camoufox_research import session_tools as st

    seen = []
    mcp = _CollectingMCP()

    def fake_call(name, **kwargs):
        seen.append((name, kwargs))
        return "ok"

    rt.register(mcp, fake_call)
    st.register(mcp, fake_call)
    return mcp.tools, seen


def _exercise(tools):
    """Дёрнуть каждый тул с заглушками — видно, что он шлёт в call."""
    for fn in tools:
        kwargs = {}
        for p in inspect.signature(fn).parameters.values():
            if p.default is not inspect.Parameter.empty:
                continue
            if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                continue
            kwargs[p.name] = _dummy(p)
        try:
            fn(**kwargs)
        except Exception:
            continue  # тул упал ДО call — его пару не проверяем


class ToolActionContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from camoufox_research.camoufox_worker_ext import ACTIONS

        cls.actions = ACTIONS
        cls.tools, cls.seen = _collect_tools()
        _exercise(cls.tools)

    def test_captured_most_tools(self):
        self.assertGreaterEqual(len(self.seen), _COVERAGE_FLOOR, self.seen)

    def test_no_tool_twice(self):
        names = [n for n, _ in self.seen]
        self.assertEqual(len(names), len(set(names)), f"дубли вызовов: {names}")

    def test_every_call_name_exists_in_actions(self):
        missing = {n for n, _ in self.seen if n not in self.actions}
        self.assertEqual(missing, set(), f"вызовы без ACTION: {missing}")

    def test_kwargs_bind_to_action_signature(self):
        """timeout — параметр RPC-моста (_call(action, timeout=...)), не ACTION."""
        bad = []
        for name, kwargs in self.seen:
            target = self.actions.get(name)
            if target is None:
                continue
            args = {k: v for k, v in kwargs.items() if k != "timeout"}
            try:
                inspect.signature(target).bind(**args)
            except TypeError as e:
                bad.append(f"{name}: {e}")
        self.assertEqual(bad, [], "тул шлёт аргументы, которых ACTION не знает")


if __name__ == "__main__":
    unittest.main()
