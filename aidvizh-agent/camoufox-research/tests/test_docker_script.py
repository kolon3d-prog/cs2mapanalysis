#!/usr/bin/env python3
"""Проверки безопасных значений run_in_docker.sh без Docker и сети."""

import json
import subprocess
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "run_in_docker.sh"


class DockerScriptTest(unittest.TestCase):
    def run_json(self, *args):
        result = subprocess.run(
            ["bash", str(SCRIPT), "--runtime", "/bin/true", *args],
            cwd=REPO,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_http_binds_to_loopback_by_default(self):
        result = self.run_json("--http", "8833", "--json")
        self.assertEqual(json.loads(result.stdout)["mcpServers"]["camoufox"]["url"], "http://127.0.0.1:8833/mcp")
        self.assertNotIn("0.0.0.0", result.stderr)

    def test_external_bind_requires_explicit_flag(self):
        result = self.run_json("--http", "8833", "--http-bind", "0.0.0.0", "--json")
        self.assertIn("0.0.0.0", result.stderr)
        self.assertEqual(json.loads(result.stdout)["mcpServers"]["camoufox"]["url"], "http://0.0.0.0:8833/mcp")


if __name__ == "__main__":
    unittest.main()
