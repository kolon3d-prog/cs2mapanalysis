#!/usr/bin/env python3
"""Качество выдачи: волна из термов, академический гейт, разворот ссылок.

Все три проверки — на ЖИВЫХ данных 21.09 (не выдуманные строки): именно
на них баг и поймался, поэтому они же и регрессия.
  1) extract_terms отдавал 5 голых слов («check · blend · audio · built ·
     evade») — волна уходила в музыкальные сайты, счётчик доменов рос;
  2) академическая нога без гейта тащила статьи про детекцию AI-картинок
     по теме про антидетект-браузеры — и как tier 0 вставала ПЕРВОЙ в
     цитированном отчёте;
  3) web_search печатал duckduckgo.com/l/?uddg=… вместо источника.

Сеть не трогаем: extract_terms/_relevant/_unwrap_ddg — чистые функции,
каналы академии подменены заглушками с захваченными строками.
"""

import re
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)

_QUERY = "antidetect browser fingerprint detection 2026"

# Строки, захваченные живой пробой кампании (arXiv/Crossref/Wiki).
_REAL_ROWS = [
    (
        "NTIRE 2026 Challenge on Robust AI-Generated Image Detection in the Wild",
        "[2026] This paper presents an overview of the NTIRE 2026 Challenge on"
        " Robust AI-Generated Image Detection in the Wild, held in conjunction"
        " with the NTIRE workshop at CVPR 2026.",
        False,
    ),
    (
        "NTIRE 2026 Rip Current Detection and Segmentation (RipDetSeg) Challenge Report",
        "[2026] This report presents the NTIRE 2026 Rip Current Detection and"
        " Segmentation (RipDetSeg) Challenge, which targets automatic rip"
        " current understanding in images.",
        False,
    ),
    (
        "AutoRestTest at the SBFT 2026 Tool Competition",
        "[2026] Large input spaces and complex inter-operation dependencies make"
        " black-box REST API testing challenging.",
        False,
    ),
    (
        "Phishing Detection Browser Extension",
        "[2026] International Research Journal of Modernization in Engineering",
        False,
    ),
    (
        "Dolphin Anty",
        "web browser that allows creating isolated browser environments with"
        " configurable fingerprints. The Dolphin Anty browser was created for"
        " anti-detection purposes",
        True,
    ),
    (
        "Web Service Access Control Based on Browser Fingerprint Detection",
        "[2021] Journal of Web Engineering",
        True,
    ),
]

# Форма первой волны: тема, подтема (в 2 источниках) и мусорные одиночки.
_WAVE_TEXTS = [
    "Antidetect browsers mask fingerprints; audio fingerprinting is one known vector",
    "Fingerprint detection guide: canvas fingerprinting and audio fingerprinting",
    "Dolphin Anty review — Dolphin Anty isolates every profile",
    "Dolphin Anty pricing, Dolphin Anty alternatives",
    "check this blend of built tricks to evade a naive detector",
]
_JUNK_ONCE = ("check", "blend", "built", "evade")  # по одному упоминанию

_PHRASE_RX = r"^[A-Z][A-Za-z0-9]+(?:[ -][A-Z][A-Za-z0-9]+)+$"


class ExtractTermsTest(unittest.TestCase):
    """Волна из термов: одиночное слово уходит ТОЛЬКО с якорем темы."""

    def setUp(self):
        from camoufox_research.camoufox_sources_ext import extract_terms

        self.terms = extract_terms(_WAVE_TEXTS, [_QUERY])

    def test_no_bare_single_words(self):
        for t in self.terms:
            self.assertTrue(
                re.match(_PHRASE_RX, t) or t.endswith(_QUERY),
                f"«{t}» не фраза и не составлено с якорем темы",
            )

    def test_single_mention_terms_dropped(self):
        """df=1 — шум: ни как запрос, ни внутри составного."""
        for junk in _JUNK_ONCE:
            self.assertFalse(
                any(re.search(rf"\b{junk}\b", t.lower()) for t in self.terms),
                f"терм «{junk}» из одного источника попал в волну",
            )

    def test_phrase_goes_first(self):
        self.assertEqual(self.terms[0], "Dolphin Anty")

    def test_topic_term_survives_with_anchor(self):
        """«audio» (в 2 источниках) остаётся — но приклеенный к теме."""
        self.assertIn(f"audio {_QUERY}", self.terms)

    def test_cap_respected(self):
        self.assertLessEqual(len(self.terms), 5)

    def test_without_base_query_no_singles(self):
        from camoufox_research.camoufox_sources_ext import extract_terms

        out = extract_terms(_WAVE_TEXTS, [])
        self.assertTrue(all(re.match(_PHRASE_RX, t) for t in out), out)


class AcademicGateTest(unittest.TestCase):
    """Гейт: чужая статья не должна встать tier 0 в цитатах."""

    def test_real_rows_verdicts(self):
        from camoufox_research.camoufox_academic import _relevant

        for title, snippet, want in _REAL_ROWS:
            with self.subTest(title=title[:40]):
                self.assertEqual(_relevant(_QUERY, title, snippet), want)

    def test_paper_rows_filters_when_asked(self):
        """Интеграция: relevant_only=True режет канал, по умолчанию — нет."""
        from camoufox_research import camoufox_academic as ac

        stub = [
            {"title": t, "url": f"https://x/{i}", "snippet": s,
             "authors": [], "year": ""}
            for i, (t, s, _w) in enumerate(_REAL_ROWS)
        ]
        with mock.patch.object(ac, "_arxiv_rows", return_value=stub), \
                mock.patch.object(ac, "_s2_rows", return_value=[]), \
                mock.patch.object(ac, "_crossref_rows", return_value=[]), \
                mock.patch.object(ac, "_wiki_rows", return_value=[]):
            kept = ac.paper_rows(_QUERY, sources="arxiv", relevant_only=True)
            allrows = ac.paper_rows(_QUERY, sources="arxiv")
        self.assertEqual(len(allrows), len(_REAL_ROWS))
        self.assertEqual({t for t, *_ in kept},
                         {t for t, _s, want in _REAL_ROWS if want})

    def test_empty_query_keeps_everything(self):
        from camoufox_research.camoufox_academic import _relevant

        self.assertTrue(_relevant("", "что угодно", ""))


if __name__ == "__main__":
    unittest.main()
