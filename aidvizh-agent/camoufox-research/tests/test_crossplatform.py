#!/usr/bin/env python3
"""Кроссплатформенность: статика, которую видно из кода (без сети).

Зачем отдельный тест на вопрос владельца «точно везде кроссплатформенность?»:
обещание не проверяемо, а три машинных факта — проверяемы на любой ОС:

  1. в пакете нет Unix-only вызовов (`os.fork`, `pwd`, `fcntl`, `tty`…), а
     процедурная ФС (`/proc/...`) читается ТОЛЬКО под стражем платформы —
     иначе на Windows/macOS это ImportError/FileNotFoundError в рантайме;
  2. пути собираются через `Path`/`os.path`, а не склейкой со слешем
     (`"C:\\dir" + "/" + "f"` даёт смешанный разделитель; os-API его терпит,
     но внешние инструменты и сравнение строк — нет);
  3. точка входа установки на каждой ОС существует и знает свою ОС.

Живые macOS/Windows здесь не запускаются: этот файл держит СТАТИКУ, а
поведенческие пробы платформенных веток живут рядом —
tests/test_health_portable.py (пульс вне Linux) и
tests/test_notify_platform.py (каналы уведомлений). Реестр «фича · ОС ·
чем доказано · где ограничение» — docs/CROSSPLATFORM.md.
"""

import ast
import re
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

PACKAGE = REPO / "camoufox_research"
SCRIPTS = REPO / "scripts"

# Строки, где поведение ветвится по ОС. Стражем считается и объявленный
# модулем флаг (IS_NT в camoufox_browser_core.py, _compat.py).
GUARD = re.compile(
    r"sys\.platform\s*[=!]="
    r"|os\.name\s*[=!]="
    r"|\bIS_NT\b|\bIS_POSIX\b|\bIS_CI\b"
    r"|platform\.system\("
)
GUARD_LOOKBACK = 3  # строк: `if platform:` + тело

# Unix-only вызовы и модули. os.kill/os.sysconf СОЗНАТЕЛЬНО не в списке:
# os.kill есть и на Windows (os.kill(pid, 0) = проба живости), а sysconf в
# пакете вызывается только внутри ветки darwin (camoufox_fetch_core).
UNIX_ONLY = re.compile(
    r"\bos\.fork\b"
    r"|\bos\.(geteuid|getegid|getuid|setsid|killpg|setpgrp)\b"
    r"|\bfrom\s+(pwd|grp|fcntl|termios|tty|pty|resource|syslog)\s+import\b"
    r"|\bimport\s+(pwd|grp|fcntl|termios|tty|pty|resource|syslog)\b"
    r"|\bpty\.(spawn|openpty|fork)\b"
    r"|\bfcntl\.(ioctl|flock)\b"
    r"|\btermios\.\w+"
)

# Пути процедурной ФС: только Linux. Литерал в коде допустим ЛИБО под
# стражем, ЛИБО в комментарии/докстроке (пояснение «почему»).
PROCFS_PATH = re.compile(r"""["']/(proc|sys|dev|run)/""")
COMMENT_LINE = re.compile(r"^\s*#")


def _python_files(root: Path):
    return sorted(p for p in root.glob("*.py"))


# Все Python-каталоги репозитория: правило про пути универсально (тесты и
# CI-скрипты тоже поедут на чужую ОС), а Unix-only — только пакет.
PYTHON_ROOTS = (PACKAGE, SCRIPTS, REPO / "mcp", REPO / "tests", REPO / ".github" / "scripts")


class UnixOnlyCallsTest(unittest.TestCase):
    """Пакет обязан импортироваться и работать вне Linux."""

    def test_no_unix_only_calls(self):
        bad = []
        for path in _python_files(PACKAGE):
            lines = path.read_text(encoding="utf-8").splitlines()
            for i, line in enumerate(lines):
                if COMMENT_LINE.match(line) or not UNIX_ONLY.search(line):
                    continue
                window = lines[max(0, i - GUARD_LOOKBACK):i + 1]
                if not any(GUARD.search(w) for w in window):
                    bad.append(f"{path.name}:{i + 1}: {line.strip()}")
        self.assertEqual(
            bad, [],
            "Unix-only вызов без стража платформы (сломается на Windows/macOS):\n"
            + "\n".join(bad),
        )

    def test_procfs_paths_are_platform_guarded(self):
        """/proc/... — только под `sys.platform == "linux"` (или в комментарии)."""
        bad = []
        for path in _python_files(PACKAGE):
            lines = path.read_text(encoding="utf-8").splitlines()
            for i, line in enumerate(lines):
                if COMMENT_LINE.match(line) or not PROCFS_PATH.search(line):
                    continue
                window = lines[max(0, i - GUARD_LOOKBACK):i + 1]
                if not any(GUARD.search(w) for w in window):
                    bad.append(f"{path.name}:{i + 1}: {line.strip()}")
        self.assertEqual(
            bad, [],
            "путь процедурной ФС без стража платформы:\n" + "\n".join(bad),
        )


class PathConstructionTest(unittest.TestCase):
    """Пути — через Path/os.path, а не склейкой со слешем.

    Ловим три недвусмысленных признака ручной склейки (`+` со строковым
    литералом-разделителем или двумя литералами-путями). Склейку
    `переменная + "/хвост"` AST от постройки URL не отличает
    (`url + "/api"` — законно и встречается повсюду), поэтому она
    проверяется глазами, а не здесь: ложные срабатывания тут дороже
    пропуска — на них перестают смотреть.
    """

    def _literals(self, node):
        for side, other in ((node.left, node.right), (node.right, node.left)):
            if isinstance(side, ast.Constant) and isinstance(side.value, str):
                yield side.value, other

    def test_no_slash_concatenation(self):
        bad = []
        for root in PYTHON_ROOTS:
            for path in _python_files(root):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if not (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add)):
                        continue
                    for lit, other in self._literals(node):
                        if "://" in lit:
                            continue  # URL, а не путь ФС
                        two_literals = (len(lit) > 1 and lit[0] == "/"
                                        and isinstance(other, ast.Constant)
                                        and isinstance(other.value, str)
                                        and "://" not in other.value)
                        if (lit in ("/", "\\")
                                or (len(lit) > 1 and lit.endswith("/"))
                                or two_literals):
                            bad.append(
                                f"{path.relative_to(REPO)}:{node.lineno}: "
                                f"{ast.unparse(node)}"
                            )
        self.assertEqual(
            bad, [],
            "путь склеен со слешем — используй Path/os.path.join:\n" + "\n".join(bad),
        )


class InstallerEntryPointsTest(unittest.TestCase):
    """Один вход на ОС: install.sh (Linux/macOS/MSYS), install.ps1 (Windows)."""

    def test_install_sh_detects_os(self):
        sh = (SCRIPTS / "install.sh").read_text(encoding="utf-8")
        self.assertIn("uname -s", sh, "нет детекта ОС через uname")
        for branch in ("linux*) echo linux", "darwin*) echo macos",
                       "mingw*|msys*|cygwin*) echo windows"):
            self.assertIn(branch, sh, f"нет ветки ОС: {branch}")
        # Форсаж ОС для плана/тестов — единственная ветка без uname.
        self.assertIn("linux|macos|windows) OS_FORCE=", sh, "нет --os linux|macos|windows")
        # Раскладка venv по ОС: Scripts/ против bin/.
        self.assertIn('VENV_BIN="$VENV/Scripts"', sh, "нет Windows-раскладки venv")

    def test_install_ps1_detects_os(self):
        ps1 = (SCRIPTS / "install.ps1").read_text(encoding="utf-8")
        # PowerShell 7+ — в 5.1 нет $IsWindows (автопеременные платформы).
        self.assertIn("#Requires -Version 7.0", ps1, "нет гейта версии PowerShell")
        self.assertIn("$IsWindows", ps1, "нет детекта ОС в PowerShell-установщике")

    def test_install_ps1_picks_venv_layout_by_os(self):
        """venv-раскладка выбирается по ОС: Scripts\\python.exe против bin/python.

        Захардкоженный `Scripts` — исторический баг этого файла: на Linux-pwsh
        venv создавался с bin/, проверка искала Scripts\\python.exe и установка
        падала на «venv не создался» уже ПОСЛЕ pip.
        """
        ps1 = (SCRIPTS / "install.ps1").read_text(encoding="utf-8")
        self.assertIn("'Scripts'", ps1)
        self.assertIn("'bin'", ps1)
        # Отказ ГРОМКИЙ: нет интерпретатора venv — FAIL, а не «продолжаем».
        self.assertIn("venv не создался", ps1, "нет честного провала установки venv")

    def test_powershell_surface_detects_os(self):
        """Обе PowerShell-обвязки ветвятся по ОС: и установщик, и пульс."""
        for name in ("install.ps1", "health_pulse.ps1"):
            src = (SCRIPTS / name).read_text(encoding="utf-8")
            self.assertIn("$IsWindows", src, f"{name}: нет ветвления по ОС")


if __name__ == "__main__":
    unittest.main()
