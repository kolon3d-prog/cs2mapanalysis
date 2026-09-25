#!/usr/bin/env python3
"""Документы определяются по СОДЕРЖИМОМУ, а не по имени в URL.

Живой баг 21.09 (замер контента): `read_document("https://arxiv.org/pdf/2604.11487")`
отбивался «формат '.11487' не поддерживается» — `os.path.splitext` принял
версию статьи за расширение. А arXiv-ссылки вида `/pdf/<id>` (и вообще
любые DOI/журнальные эндпоинты без `.pdf` в пути) — это самый частый способ
получить длинный документ, то есть ровно там, где облака отдают мало.

Контракт: расширение из URL — только подсказка; решает магия байтов
(`%PDF`, `PK\\x03\\x04` → zip → docx/xlsx по внутренним путям).

Без сети: скачивание подменено, парсеры фиксируют, что их позвали.
"""

import os
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest import mock

import unittest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

_PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"


def _zip_with(prefix: str) -> bytes:
    buf = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    buf.close()
    with zipfile.ZipFile(buf.name, "w") as z:
        z.writestr(f"{prefix}/data.xml", "<x/>")
    data = Path(buf.name).read_bytes()
    os.unlink(buf.name)
    return data


class DocumentSniffTest(unittest.TestCase):
    def setUp(self):
        from camoufox_research import camoufox_docs as docs

        self.docs = docs

    def _call(self, source: str, payload: bytes, max_chars: int = 6000):
        """Прогон read_document с подменённым скачиванием и парсерами."""
        local = Path(tempfile.mkdtemp()) / "download.bin"
        local.write_bytes(payload)
        seen = {}

        def fake_pdf(path):
            seen["parser"] = "pdf"
            return "PDF ТЕКСТ"

        def fake_docx(path):
            seen["parser"] = "docx"
            return "DOCX ТЕКСТ"

        def fake_xlsx(path):
            seen["parser"] = "xlsx"
            return "XLSX ТЕКСТ"

        with (
            mock.patch.object(self.docs, "_download_temp", return_value=str(local)),
            mock.patch.object(self.docs, "_extract_pdf", side_effect=fake_pdf),
            mock.patch.object(self.docs, "_extract_docx", side_effect=fake_docx),
            mock.patch.object(self.docs, "_extract_xlsx", side_effect=fake_xlsx),
        ):
            out = self.docs.read_document(source, max_chars=max_chars)
        return out, seen

    def test_arxiv_url_without_pdf_extension_is_read_as_pdf(self):
        out, seen = self._call("https://arxiv.org/pdf/2604.11487", _PDF_BYTES)
        self.assertNotIn("не поддерживается", out, out)
        self.assertEqual(seen.get("parser"), "pdf", "не отдали PDF-парсеру")
        self.assertIn("PDF ТЕКСТ", out)

    def test_extensionless_url_sniffed_by_magic(self):
        out, seen = self._call("https://example.com/download?id=42", _PDF_BYTES)
        self.assertEqual(seen.get("parser"), "pdf", out)

    def test_docx_zip_detected_by_inner_paths(self):
        out, seen = self._call("https://example.com/export", _zip_with("word"))
        self.assertEqual(seen.get("parser"), "docx", out)

    def test_xlsx_zip_detected_by_inner_paths(self):
        out, seen = self._call("https://example.com/export", _zip_with("xl"))
        self.assertEqual(seen.get("parser"), "xlsx", out)

    def test_unknown_content_reports_honestly(self):
        out, seen = self._call("https://example.com/page", "<html>не документ</html>".encode())
        self.assertIn("не поддерживается", out)
        self.assertNotIn("parser", seen)

    def test_explicit_extension_still_works(self):
        out, seen = self._call("https://example.com/report.pdf", _PDF_BYTES)
        self.assertEqual(seen.get("parser"), "pdf", out)


if __name__ == "__main__":
    unittest.main()
