#!/usr/bin/env python3
"""Дефолты MCP-поверхности — правда, а не обещание:

1) профиль тулов: сервер БЕЗ CAMOUFOX_CAPS отдаёт не «всё», а DEFAULT_CAPS
   (research,browser = 34 тула) — ровно то, что обещают docs/agent-usage.md и
   обёртка scripts/install_mcp.py. Аудит 21.09: незаданная переменная
   означала «все 62 тула», и агент видел вдвое больше поверхности, чем ему
   документировали (та самая деградация выбора, ради которой профили и
   делались). Проверяется ДЕЙСТВУЮЩИЙ реестр сервера (импорт →
   _apply_tool_filter), а не чистая resolve_caps — её контракт живёт в
   tests/test_caps.py.
2) объём текста: дефолты тул-слоя совпадают с дефолтами движка
   (max_chars=12000), иначе агент получает урезанный ответ, не зная об этом."""

import contextlib
import importlib
import io
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)

from camoufox_research.camoufox_caps import (  # noqa: E402
    ALWAYS_ON,
    DEFAULT_CAPS,
    GROUPS,
    resolve_caps,
)

# Числа профилей = контракт документации (docs/agent-usage.md, таблица
# профилей). Разошлись — значит либо реестр вырос, либо дефолт сломан;
# в обоих случаях правим ОСОЗНАННО (тест краснеет, а не молчит).
N_DEFAULT = 34
N_FULL = 62
N_WITH_SESSION = 60

_CAPS_VARS = ("CAMOUFOX_CAPS", "CAMOUFOX_TOOLS_ONLY", "CAMOUFOX_TOOL_HIDE")


def _clean_env() -> dict[str, str]:
    """Окружение без тул-фильтров: их выставляет сам тест, а не шелл."""
    return {k: v for k, v in os.environ.items() if k not in _CAPS_VARS}


def _snapshot(env: dict[str, str]) -> tuple[set[str], str, str]:
    """(тулы, stderr, health) сервера при данном окружении.

    Пере-импорт, а не импорт: модуль мог быть загружен раньше (и тогда
    фильтр отработал на чужом env), а _apply_tool_filter живёт ровно в
    теле модуля — это и есть проверяемый путь."""
    import camoufox_research.camoufox_research as srv

    err = io.StringIO()
    with (
        mock.patch.dict(os.environ, {**_clean_env(), **env}, clear=True),
        contextlib.redirect_stderr(err),
    ):
        importlib.reload(srv)
        names = set(srv.mcp._tool_manager._tools)
        health = srv._res_health()
    return names, err.getvalue(), health


class DefaultCapsTest(unittest.TestCase):
    def test_counts_match_declared_groups(self):
        # Контракт «число в доке = число в реестре»: считаем из GROUPS.
        self.assertEqual(N_DEFAULT, len(resolve_caps(DEFAULT_CAPS)[0]))
        self.assertEqual(N_FULL, len(set().union(*GROUPS.values()) | set(ALWAYS_ON)))

    def test_unset_env_gives_default_profile(self):
        names, err, _ = _snapshot({})
        self.assertEqual(len(names), N_DEFAULT)
        self.assertEqual(err, "")
        # Смысл дефолта — весь цикл «поиск → чтение» без живой вкладки.
        for must in ("web_search", "research_start", "fetch_page", "extract"):
            self.assertIn(must, names)
        self.assertTrue(set(ALWAYS_ON) <= names)  # ping/stats не режутся
        # session и vision — opt-in: в дефолт не попадают НИКОГДА.
        self.assertEqual([n for n in names if n.startswith("session_")], [])
        self.assertNotIn("screenshot", names)

    def test_all_means_full_registry(self):
        names, _, _ = _snapshot({"CAMOUFOX_CAPS": "all"})
        self.assertEqual(len(names), N_FULL)
        self.assertIn("session_start", names)
        self.assertIn("screenshot", names)

    def test_star_is_synonym_of_all(self):
        names, _, _ = _snapshot({"CAMOUFOX_CAPS": "*"})
        self.assertEqual(len(names), N_FULL)

    def test_explicit_profile_research_browser_session(self):
        names, _, _ = _snapshot({"CAMOUFOX_CAPS": "research,browser,session"})
        self.assertEqual(len(names), N_WITH_SESSION)
        self.assertIn("session_start", names)
        self.assertNotIn("screenshot", names)  # vision остаётся opt-in

    def test_unknown_group_warns_and_falls_back_to_default(self):
        names, err, _ = _snapshot({"CAMOUFOX_CAPS": "bogus"})
        self.assertIn("неизвестная группа", err)
        self.assertIn("беру дефолт", err)
        # Не ping/stats (2 тула) — опечатка не «оголяет» сервер.
        self.assertEqual(len(names), N_DEFAULT)

    def test_partial_typo_keeps_known_group(self):
        # Известная группа + опечатка: едет известная (контракт resolve_caps —
        # «не валим всё из-за одной опечатки»), дефолт НЕ подмешивается.
        names, err, _ = _snapshot({"CAMOUFOX_CAPS": "research,bogus"})
        self.assertIn("bogus", err)
        self.assertIn("web_search", names)
        self.assertNotIn("fetch_page", names)  # browser не просили
        self.assertLess(len(names), N_DEFAULT)

    def test_tools_only_beats_default(self):
        # Явный allowlist специфичнее дефолта: иначе галка «оставь только
        # эти тулы» молча получила бы 34 чужих.
        names, _, _ = _snapshot({"CAMOUFOX_TOOLS_ONLY": "web_search"})
        self.assertEqual(names, {"web_search"})

    def test_health_reports_effective_caps(self):
        # health — источник правды для оператора: пустой env ≠ «all».
        _, _, health = _snapshot({})
        self.assertIn(f'"caps":"{DEFAULT_CAPS} (дефолт)"', health)
        _, _, full = _snapshot({"CAMOUFOX_CAPS": "all"})
        self.assertIn('"caps":"all"', full)


class ToolDefaultParityTest(unittest.TestCase):
    """MCP-ВИДИМЫЕ дефолты тул-слоя (то, что агент видит в tools/list).

    Тул-слой передаёт аргументы в движок ЯВНО и тем перекрывает его дефолты:
    если объём в подписи тула разойдётся с движком, агент молча получит
    урезанный ответ (замер 21.09: 4000 вместо 12000 = -66% символов при ТОМ
    ЖЕ времени — страница всё равно читается в кэш целиком).
    Равенство литерала `_CONTENT_CHARS` константе движка держит
    tests/test_content_defaults.py (там же и сам движок)."""

    @staticmethod
    def _tools() -> dict:
        from camoufox_research import camoufox_research_tools as rt

        class _MCP:
            def __init__(self):
                self.fns: dict = {}

            def tool(self):
                def deco(fn):
                    self.fns[fn.__name__] = fn
                    return fn

                return deco

        m = _MCP()
        rt.register(m, lambda *a, **k: None)
        return m.fns

    def test_mcp_visible_defaults(self):
        import inspect

        fns = self._tools()
        for name in ("research", "batch_fetch", "fetch_page"):
            default = inspect.signature(fns[name]).parameters["max_chars"].default
            self.assertEqual(default, 12_000, f"{name}: агенту обещан другой объём")
        # research по умолчанию сразу читает тексты (замер: fetch_top=0 → 0 текстов)
        self.assertEqual(inspect.signature(fns["research"]).parameters["fetch_top"].default, 3)


if __name__ == "__main__":
    unittest.main()
