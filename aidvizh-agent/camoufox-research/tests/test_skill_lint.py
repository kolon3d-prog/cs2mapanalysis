#!/usr/bin/env python3
"""Линтер скиллов: frontmatter разбирается целиком, включая ПОСЛЕДНИЙ ключ.

Баг, пойманный на живом скилле (21.09): `parse()` обходил строки как
`[*lines, "---"]` и ждал, что синтетический терминатор `---` сработает как
новый ключ. Но у `---` нет `:` — строка уходила в `elif key is not None:
block.append(...)`, то есть просто ДОПИСЫВАЛАСЬ в блок последнего ключа,
а сам последний ключ в словарь не попадал. Практика: скилл с описанием
блоком `>-` в конце frontmatter получал вердикт «frontmatter: нет
description» и exit=1 — линтер ругался на корректный файл.
"""

import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))


def _skill(front: str, body: str = "Тело скилла.\n\nСсылка: docs/landmines.md\n") -> Path:
    d = Path(tempfile.mkdtemp())
    p = d / "SKILL.md"
    p.write_text(f"---\n{front}\n---\n{body}", encoding="utf-8")
    return p


class FrontmatterParseTest(unittest.TestCase):
    def test_last_key_with_block_description_is_kept(self):
        import skill_lint

        p = _skill(
            "name: my-skill\n"
            "description: >-\n"
            "  Триггеры: когда применять этот скилл и почему.\n"
            "  Вторая строка описания."
        )
        front = skill_lint.parse(p)["front"]
        self.assertIn("description", front, "последний ключ frontmatter потерян")
        self.assertIn("Триггеры", front["description"])
        self.assertIn("Вторая строка", front["description"])

    def test_last_key_with_simple_value_is_kept(self):
        import skill_lint

        p = _skill("name: my-skill\ndescription: короткое описание с триггером")
        front = skill_lint.parse(p)["front"]
        self.assertEqual(front["description"], "короткое описание с триггером")

    def test_keys_before_last_are_not_lost(self):
        import skill_lint

        p = _skill(
            "name: my-skill\n"
            "metadata:\n"
            "  owner: test\n"
            "description: >-\n"
            "  Описание блоком с триггерами."
        )
        front = skill_lint.parse(p)["front"]
        self.assertEqual(front["name"], "my-skill")
        self.assertIn("Описание блоком", front["description"])

    def test_clean_skill_passes_lint(self):
        import skill_lint

        p = _skill(
            "name: my-skill\n"
            "description: >-\n"
            "  Триггеры: кампания зависла, research_cancel, notify-send спам,\n"
            "  свежий кэш, страж URL. Применять при отладке ресёрч-стека."
        )
        issues = skill_lint.lint(p)
        self.assertEqual([i for i in issues if i["level"] == "BLOCK"], [],
                         f"линтер заблокировал корректный скилл: {issues}")


if __name__ == "__main__":
    unittest.main()
