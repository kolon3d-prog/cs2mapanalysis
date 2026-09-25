#!/usr/bin/env python3
"""Стражи репозитория: pre-push, секрет-скан, cron-установщик, обёртка venv.

Находки shell/script-аудита 21.09 (все воспроизведены в песочнице):
  1) `git-pre-push.sh` при пуше НОВОГО бранча брал `$REPO_HASH_EMPTY` —
     переменной нет и `set -u` нет → пустая строка → `git diff --name-only
     ""...HEAD` → пустой список → страж не проверял НИ ОДНОГО файла;
  2) `gitleaks-precommit.sh` заканчивался безусловным `exit 0`, поэтому rc
     сканера затирался: `guard-all.sh` физически не мог остановить коммит;
  3) `install_cron.sh` держал все флаги в одной `MODE` → `--dry
     --keep-timings` терял `--dry` и ПИСАЛ crontab; опечатки не отвергались;
  4) `install_mcp.wrap_console` копировал console-скрипт в `.real`
     безусловно: второй прогон без переустановки пакета копировал уже
     СВОЮ обёртку → python исполнял bash-текст, сервер не стартовал.

Всё проверяется в temp-песочнице: реальный crontab и репо владельца не
трогаются, git-фикстура — временный репозиторий.
"""

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _write(path: Path, body: str, ex: bool = True) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    if ex:
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


class GitleaksWrapperTest(unittest.TestCase):
    """Секрет-скан обязан ронять хук, когда сам упал."""

    def _run(self, gitleaks_body):
        with tempfile.TemporaryDirectory() as td:
            fake = _write(Path(td) / "bin" / "gitleaks", gitleaks_body)
            env = dict(os.environ, PATH=f"{fake.parent}:/usr/bin:/bin")
            return subprocess.run(["bash", str(SCRIPTS / "gitleaks-precommit.sh")],
                                  capture_output=True, text=True, env=env, cwd=str(REPO))

    def test_failing_gitleaks_fails_the_hook(self):
        r = self._run("#!/bin/sh\nexit 1\n")
        self.assertEqual(r.returncode, 1, f"хук проглотил падение сканера: {r.stdout}{r.stderr}")

    def test_clean_gitleaks_passes(self):
        self.assertEqual(self._run("#!/bin/sh\nexit 0\n").returncode, 0)

    def test_missing_binary_is_not_fatal(self):
        """Нет gitleaks локально — не блокер (скажет CI), но и не тишина."""
        import shutil

        bash = shutil.which("bash")
        with tempfile.TemporaryDirectory() as td:
            env = dict(os.environ, PATH=td)
            r = subprocess.run([bash, str(SCRIPTS / "gitleaks-precommit.sh")],
                               capture_output=True, text=True, env=env, cwd=str(REPO))
        self.assertEqual(r.returncode, 0)
        self.assertIn("CI", r.stdout + r.stderr)


class CronDryRunTest(unittest.TestCase):
    """`--dry` не имеет права писать crontab ни в какой комбинации.

    Важно: песочницу держим живой до конца теста (tempfile.mkdtemp +
    addCleanup). Прошлая версия возвращала путь уже ПОСЛЕ выхода из
    TemporaryDirectory — `assertFalse(calls.exists())` смотрел в удалённый
    каталог и не мог упасть даже когда `--dry` реально писал crontab
    (ложно-зелёный тест, поймано bats-агентом на мутациях). Проверяем
    не факт файла, а СОДЕРЖИМОЕ вызовов: dry может читать (`-l`), но не писать.
    """

    def _run(self, args):
        root = Path(tempfile.mkdtemp(prefix="camoufox-dry-"))
        self.addCleanup(shutil.rmtree, root, True)
        calls = root / "crontab-calls.txt"
        _write(root / "bin" / "crontab",
               f'#!/bin/sh\necho "ARGS: $@" >> {calls}\nexit 0\n')
        env = dict(os.environ,
                   PATH=f"{root / 'bin'}:/usr/bin:/bin",
                   CAMOUFOX_CACHE_DIR=str(root / "cache"),
                   CAMOUFOX_REPO=str(REPO))
        (root / "cache").mkdir()
        r = subprocess.run(["bash", str(SCRIPTS / "install_cron.sh"), *args],
                           capture_output=True, text=True, env=env, cwd=str(REPO))
        recorded = calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []
        return r, recorded

    def test_dry_with_keep_timings_never_writes(self):
        r, calls = self._run(["--dry", "--keep-timings"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dry", (r.stdout + r.stderr).lower())
        writes = [c for c in calls if c.strip() != "ARGS: -l"]
        self.assertEqual(writes, [], f"dry-прогон писал crontab: {writes}")

    def test_dry_alone_never_writes(self):
        r, calls = self._run(["--dry"])
        writes = [c for c in calls if c.strip() != "ARGS: -l"]
        self.assertEqual(writes, [], f"dry-прогон писал crontab: {writes}")

    def test_unknown_flag_rejected(self):
        r, calls = self._run(["--dryy"])
        self.assertNotEqual(r.returncode, 0, "опечатка в флаге принята молча")
        writes = [c for c in calls if c.strip() != "ARGS: -l"]
        self.assertEqual(writes, [], f"crontab тронут при опечатке: {writes}")


class PrePushNewBranchTest(unittest.TestCase):
    """Новый бранч: страж обязан проверить весь уходящий history."""

    def _repo_with_blocked_file(self, td):
        root = Path(td) / "repo"
        root.mkdir()
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        for cmd in (["git", "init", "-q"],):
            subprocess.run(cmd, cwd=root, check=True, env=env)
        _write(root / "research" / "private.md", "# приватное\n", ex=False)
        subprocess.run(["git", "add", "-A"], cwd=root, check=True, env=env)
        subprocess.run(["git", "commit", "-qm", "private"], cwd=root, check=True, env=env)
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True,
                             capture_output=True, text=True, env=env).stdout.strip()
        return root, sha, env

    def test_new_branch_reports_blocked_file(self):
        with tempfile.TemporaryDirectory() as td:
            root, sha, env = self._repo_with_blocked_file(td)
            stdin = f"refs/heads/new {sha} refs/heads/new {'0' * 40}\n"
            r = subprocess.run(["bash", str(SCRIPTS / "git-pre-push.sh")],
                               input=stdin, capture_output=True, text=True,
                               cwd=root, env=env)
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 1, f"новый бранч прошёл без проверки: {out}")
        self.assertIn("research/private.md", out)

    def test_branch_with_only_allowed_file_passes(self):
        """История без запрещённых файлов: пустое дерево → только витрина."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "clean"
            root.mkdir()
            env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                       GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
            subprocess.run(["git", "init", "-q"], cwd=root, check=True, env=env)
            _write(root / "research" / "public" / "ok.md", "# витрина\n", ex=False)
            subprocess.run(["git", "add", "-A"], cwd=root, check=True, env=env)
            subprocess.run(["git", "commit", "-qm", "public only"], cwd=root,
                           check=True, env=env)
            sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True,
                                 capture_output=True, text=True, env=env).stdout.strip()
            stdin = f"refs/heads/new {sha} refs/heads/new {'0' * 40}\n"
            r = subprocess.run(["bash", str(SCRIPTS / "git-pre-push.sh")],
                               input=stdin, capture_output=True, text=True,
                               cwd=root, env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class ConsoleWrapTest(unittest.TestCase):
    """Повторная установка не должна превращать .real в bash-скрипт."""

    def test_double_wrap_keeps_python_entry(self):
        import install_mcp as im

        with tempfile.TemporaryDirectory() as td:
            venv = Path(td) / "venv"
            entry = venv / "bin" / "camoufox-research"
            _write(entry, "#!/usr/bin/env python3\nprint('настоящий сервер')\n")
            original = entry.read_text(encoding="utf-8")

            im.wrap_console(venv)
            first_real = (venv / "bin" / "camoufox-research.real").read_text(encoding="utf-8")
            im.wrap_console(venv)   # второй прогон БЕЗ переустановки пакета
            second_real = (venv / "bin" / "camoufox-research.real").read_text(encoding="utf-8")

            self.assertEqual(first_real, original)
            self.assertEqual(second_real, original,
                             ".real перезаписан обёрткой — python исполнит bash-текст")
            self.assertNotIn("Авто-обёртка", second_real)


if __name__ == "__main__":
    unittest.main()
