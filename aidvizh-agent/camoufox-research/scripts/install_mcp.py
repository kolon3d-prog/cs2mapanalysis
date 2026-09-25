#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Чипсет установки кауфми-MCP в opencode ИЗ ГИТА (схема 28.08).

Ритуал одной командой (замена ручных шагов из README):
  1) git clone (если репо нет) + git pull;
  2) venv + pip install git+https://…@main (БЕЗ editable — код с гита);
  3) python -m camoufox fetch (браузер, один раз);
  4) прописать MCP в ~/.config/opencode/opencode.json (если нет);
  5) проверка: импорт + число тулов.

Запуск:  python scripts/install_mcp.py [--venv ПУТЬ] [--reinstall]
         (--venv по умолчанию ~/.venvs/camoufox-research — РАНТАЙМ, не клон;
          env CAMOUFOX_VENV; путь резолвится в абсолютный и таким идёт в
          opencode.json)
Идемпотентно: уже установлено — только проверяет; --reinstall —
переустановить заново.
"""

import argparse
import json
import os  # verify(): чистое окружение для замера профиля тулов
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GIT_URL = "https://github.com/aidvizhhub/camoufox-research.git"
OPENCODE_CFG = Path.home() / ".config" / "opencode" / "opencode.json"
MCP_NAME = "camoufox"
# Метка владельца записи: её читает снятие (scripts/install.sh --uninstall,
# функция remove_mcp_entry) и удаляет ТОЛЬКО свою запись — в конфиге клиента
# ключ 'camoufox' ставит ещё и каталог mcp-station (своей обёрткой), рушить
# чужую установку нельзя. Тот же литерал продублирован в install.sh (одна
# строка без общего модуля — осознанно: install.sh правит JSON и без нашего
# пакета, а тянуть сюда импорт ради одной строки хуже, чем дубль).
OWNER_MARK = "CAMOUFOX_MCP_OWNER"
OWNER_VALUE = "camoufox-research"
# Канон места установки: venv — В РАНТАЙМЕ, не в клоне (код отдельно, окружение
# отдельно; иначе снос/перенос клона убивает MCP-сервер, а вторая копия репо
# тянет второе окружение и гонки за cache.db). Тот же дефолт у scripts/install.sh
# и в README; переопределяется --venv / CAMOUFOX_VENV.
DEFAULT_VENV = Path.home() / ".venvs" / "camoufox-research"
# Профиль тулов по умолчанию для агента: ресёрч + чтение страниц + живая вкладка (скролл,
# клики, формы) + картинки (snapshot/screenshot). Так агент сходу умеет и искать, и работать со
# страницей; сузить (например до research,browser) — задать CAMOUFOX_CAPS явно. Тот же дефолт в
# mcp-station/catalog/camoufox.json и в scripts/install.ps1 (README: как сузить профиль).
DEFAULT_CAPS = "research,browser,session,vision"


def run(cmd, env=None, check=True):
    """Команда с живым выводом; check=False — не падать на ненулевом rc."""
    print("  $", " ".join(cmd) if isinstance(cmd, list) else cmd)
    r = subprocess.run(cmd, env=env, check=False, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"команда упала (rc={r.returncode}): {cmd}")
    return r


def ensure_repo():
    """Репо локально? Нет — clone. Да — pull (ff-only)."""
    if not (REPO / ".git").exists():
        print("[1] репо нет — git clone")
        run(["git", "clone", GIT_URL, str(REPO)])
        return
    print("[1] репо есть — git pull")
    run(["git", "-C", str(REPO), "pull", "--ff-only", "origin", "main"], check=False)
    # СИНТАКС-ГЕЙТ (28.08, риск: запушили сломанное — editable сервер
    # упал бы). py_compile всех .py репо ПЕРЕД использованием —
    # сломанное не пройдёт, честный отказ с указанием файла.
    import subprocess as _sp2
    import pathlib as _pl2

    _bad = []
    for _f in _pl2.Path(REPO).rglob("*.py"):
        if ".venv" not in str(_f) and "node_modules" not in str(_f):
            _r = _sp2.run(
                [sys.executable, "-m", "py_compile", str(_f)], capture_output=True, text=True
            )
            if _r.returncode != 0:
                _bad.append(str(_f))
    if _bad:
        print(f"⛔ СИНТАКС-ГЕЙТ: сломанные файлы (не пушим дальше): {_bad[:3]}")
        sys.exit(1)


def ensure_venv(venv: Path):
    """venv нет — создать."""
    if not (venv / "bin" / "python").exists():
        print(f"[2] venv нет — создаю {venv}")
        venv.mkdir(parents=True, exist_ok=True)
        run([sys.executable, "-m", "venv", str(venv)])


def install_package(venv: Path, reinstall: bool):
    """pip install git+…@main (без editable). --reinstall — force."""
    pip = str(venv / "bin" / "pip")
    cmd = [pip, "install", "--upgrade", f"git+{GIT_URL}@main"]
    if reinstall:
        cmd = [pip, "install", "--force-reinstall", f"git+{GIT_URL}@main"]
    print("[3] pip install из git (схема «с гита» 28.08)")
    run(cmd, check=False)


def wrap_console(venv: Path) -> None:
    """Общая обёртка консольного скрипта (31.08, урок dsh).

    Проблема: сторонние клиенты (dsh web, dsh.service) запускают
    `camoufox-research` ПОЛНЫМ путём venv/bin — мимо обёртки PATH и
    мимо opencode-обёртки → сервер без caps (все 61 тул) и без памяти/
    отчётов. Два сервера с разными профилями = гонки за cache.db.
    Решение: после pip install кладём ПОВЕРХ консольного скрипта
    обёртку (дефолт caps = research,browser,session,vision; оригинал — .real,
    всегда свежий: копия ТОЛЬКО ЧТО установленного скрипта). Любой запуск
    через этот скрипт получает единый профиль; opencode-обёртка
    задаёт CAMOUFOX_CAPS явно — дефолт не трогает (setdefault).
    """
    entry = venv / "bin" / "camoufox-research"
    if not entry.exists():
        return
    # Повторный прогон БЕЗ переустановки пакета: pip не перезаписал entry,
    # значит в нём уже НАША обёртка — копировать её в .real нельзя, иначе
    # python исполнит bash-текст и сервер не стартует (аудит 21.09).
    if "Авто-обёртка install_mcp.py" in entry.read_text(encoding="utf-8", errors="ignore"):
        return
    (entry.parent / "camoufox-research.real").write_bytes(entry.read_bytes())
    (entry.parent / "camoufox-research.real").chmod(0o755)
    wrapper = (
        "#!/usr/bin/env bash\n"
        "# Авто-обёртка install_mcp.py (общая: caps + отчёты).\n"
        f'export CAMOUFOX_CAPS="${{CAMOUFOX_CAPS:-{DEFAULT_CAPS}}}"\n'
        f'export CAMOUFOX_REPORT_DIR="${{CAMOUFOX_REPORT_DIR:-{REPO / "research"}}}"\n'
        f'exec {venv / "bin" / "python3"} {entry.parent / "camoufox-research.real"} "$@"\n'
    )
    entry.write_text(wrapper)
    entry.chmod(0o755)
    print(f"  [3a] консоль-обёртка: {entry} (+ .real)")


def fetch_browser(venv: Path):
    """Браузер Camoufox — один раз (если нет)."""
    py = str(venv / "bin" / "python")
    print("[4] браузер: python -m camoufox fetch (пропущу, если есть)")
    run([py, "-m", "camoufox", "fetch"], check=False)


CAMOUFOX_CACHE = Path.home() / ".cache" / "camoufox-research"


def write_env_config(venv: Path):
    """~/.cache/camoufox-research/config.env — ЕДИНСТВЕННОЕ место с
    путями репо/venv (переносимость, закон 28: НЕ хардкод в обёртках).
    camo-publish / map_metric_cron читают его (env CAMOUFOX_* — приоритет).
    НЕ секрет, только пути."""

    CAMOUFOX_CACHE.mkdir(parents=True, exist_ok=True)
    body = (
        f'CAMOUFOX_REPO="{REPO}"\n'
        f'CAMOUFOX_PYTHON="{venv / "bin" / "python"}"\n'
        f'CAMOUFOX_CACHE_DIR="{CAMOUFOX_CACHE}"\n'
    )
    path = CAMOUFOX_CACHE / "config.env"
    path.write_text(body, encoding="utf-8")
    print(f"[5+] пути в {path} (читают camo-publish/крон)")


def install_gitleaks():
    """gitleaks локально (28.08): секрет-скан ДО коммита (2-й слой
    рядом с CI). Если go нет — предупреждение, не падение (CI догонит).
    Модуль переименован: github.com/zricethezav/gitleaks (грабля 28.08)."""
    import shutil

    if shutil.which("gitleaks"):
        print("[6] gitleaks уже установлен — пропускаю")
        return
    if not shutil.which("go"):
        print("[6] ⚠️  go нет — gitleaks пропущен (CI gitleaks.yml догонит)")
        return
    try:
        import subprocess

        r = subprocess.run(
            ["go", "install", "github.com/zricethezav/gitleaks/v8@latest"],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if r.returncode == 0:
            gobin = Path.home() / "go" / "bin" / "gitleaks"
            if gobin.exists():
                bindir = Path.home() / ".local" / "bin"
                bindir.mkdir(parents=True, exist_ok=True)
                link = bindir / "gitleaks"
                if not link.exists():
                    link.symlink_to(gobin)
                print(f"[6] gitleaks установлен ({gobin})")
            else:
                print("[6] gitleaks собран, но бинарник не найден — проверь PATH")
        else:
            print(f"[6] ⚠️  go install упал: {r.stderr.strip()[:100]}")
    except Exception as e:
        print(f"[6] ⚠️  gitleaks пропущен: {type(e).__name__}")


def write_mcp_config(venv: Path):
    """Прописать MCP в opencode.json, если секции нет."""
    if not OPENCODE_CFG.exists():
        print(f"[5] {OPENCODE_CFG} нет — пропускаю (создай вручную по README)")
        return
    cfg = json.loads(OPENCODE_CFG.read_text(encoding="utf-8"))
    mcp = cfg.setdefault("mcp", {})
    if MCP_NAME in mcp:
        print(f"[5] MCP '{MCP_NAME}' уже в конфиге — не трогаю")
        return
    mcp[MCP_NAME] = {
        "type": "local",
        "command": [str(venv / "bin" / "camoufox-research")],
        # Метка владельца → снятие (install.sh --uninstall) снимет эту запись
        # как свою; чужую запись 'camoufox' (её ставит mcp-station) не тронет.
        "environment": {OWNER_MARK: OWNER_VALUE},
        "enabled": True,
    }
    OPENCODE_CFG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[5] MCP '{MCP_NAME}' прописан в {OPENCODE_CFG}")


def verify(venv: Path):
    """Импорт + РАБОТОСПОСОБНОСТЬ: сервер поднимается и отдаёт свой профиль.

    Аудит 21.09: порог «>= 50» был верен, пока «CAMOUFOX_CAPS не задан» = все
    62 тула. Здесь меряется дефолт САМОГО СЕРВЕРА (python -c, мимо консоль-обёртки,
    у которой свой, более широкий дефолт агента) = research,browser (34), и жёсткое
    число ловило бы не поломку, а смену профиля. Проверяем два ИНВАРИАНТА, которые
    не устанут от роста реестра: (1) дефолт сервера содержит ядро ресёрча и НЕ
    содержит session (для сервера session — opt-in); (2) явный CAMOUFOX_CAPS=all
    отдаёт строго больше дефолта (полный реестр жив).
    """
    py = str(venv / "bin" / "python")
    if not Path(py).exists():
        # verify зовут и на «ещё не установлено»: это НЕ исключение, а диагноз
        # (раньше subprocess падал FileNotFoundError — стек вместо ответа).
        print(f"[✗] проверка: нет {py} — venv не установлен")
        return False
    probe = (
        "import camoufox_research.camoufox_research as s;"
        "t = set(s.mcp._tool_manager._tools);"
        "print('TOOLS', len(t), int('web_search' in t), "
        "int(any(x.startswith('session_') for x in t)))"
    )
    # Чистое окружение для проверки профиля: чужой CAPS/TOOLS_ONLY/HIDE из
    # шелла не должен подменять то, что мы измеряем (иначе «дефолт» — не дефолт).
    clean = {
        k: v
        for k, v in os.environ.items()
        if k not in ("CAMOUFOX_CAPS", "CAMOUFOX_TOOLS_ONLY", "CAMOUFOX_TOOL_HIDE")
    }

    def measure(extra: dict[str, str]):
        r = subprocess.run(
            [py, "-c", probe], capture_output=True, text=True, env={**clean, **extra}
        )
        parts = r.stdout.split()
        if r.returncode or len(parts) != 4 or parts[0] != "TOOLS":
            print("[✗] проверка: ", (r.stdout.strip() or r.stderr.strip())[-200:] or "нет ответа")
            return None
        return int(parts[1]), bool(int(parts[2])), bool(int(parts[3]))

    base = measure({})
    full = measure({"CAMOUFOX_CAPS": "all"})
    if base and full:
        n_def, core, sess = base
        if core and not sess and full[0] > n_def:
            print(
                f"[✓] установка OK — дефолт {n_def} тулов (session только opt-in), "
                f"all {full[0]} (0.19.0)"
            )
            return True
        print(f"[✗] профиль: дефолт {n_def} (ядро {core}, session {sess}), all {full[0]}")
    return False


def _print_config(venv: Path) -> int:
    """--print: показать РЕАЛЬНЫЕ пути (config.env) одной командой —
    проверка, откуда система берёт repo/python/кэш (диагностика)."""
    cfg = CAMOUFOX_CACHE / "config.env"
    print("camoufox-research: пути (config.env — единый источник)")
    if cfg.exists():
        for line in cfg.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                val = v.strip().strip('"')
                print(f"  {k.strip():20s}= {val}")
    else:
        print(f"  (config.env ещё нет: {cfg} — запусти установку)")
    print(f"  {'VENV (по умолчанию)':20s}= {venv}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="установка кауфми-MCP из git в opencode")
    ap.add_argument(
        "--venv",
        default=os.environ.get("CAMOUFOX_VENV") or str(DEFAULT_VENV),
        help=f"каталог venv (по умолчанию {DEFAULT_VENV}; env CAMOUFOX_VENV)",
    )
    ap.add_argument("--reinstall", action="store_true", help="переустановить (force)")
    ap.add_argument("--print", action="store_true", help="показать пути (config.env) и выйти")
    args = ap.parse_args()
    # АБСОЛЮТНЫЙ путь: в opencode.json кладём именно его — MCP-клиент стартует
    # сервер с cwd клиента, и относительный --venv/.venv там не найдётся.
    venv = Path(args.venv).expanduser().resolve()
    if args.print:
        return _print_config(venv)

    ensure_repo()
    ensure_venv(venv)
    install_package(venv, args.reinstall)
    wrap_console(venv)  # обёртка ПОВЕРХ entry (dsh-урок 31.08) — всегда после pip
    fetch_browser(venv)
    write_mcp_config(venv)
    write_env_config(venv)
    install_gitleaks()
    ok = verify(venv)
    # АВТО-ХИТЧ (28.08): переподключение MCP в opencode2 САМО, вместо
    # «переподключи руками». Порядок ВАЖЕН: сначала disconnect — сервис V2
    # кэширует «Connection closed» навсегда, connect БЕЗ disconnect может
    # не оживить (кампания 28.08: хитч молчал, статус висел «failed»).
    # После connect — ПРОВЕРКА mcp list: returncode=0 ещё не значит
    # «подключён» (тот же урок 28.08).
    # ЗАПРЕЩЕНО (закон 35): НЕ убивать процессы camoufox-research руками
    # «чтобы пересоздались» — сервис НЕ пересоздаёт их (баг V2), статус
    # «closed» вечен. Единственный путь — API disconnect/connect; последний
    # рубеж — «opencode2 service restart». Команды «mcp restart» НЕТ.
    try:
        import subprocess as _sp

        for _m in ("disconnect", "connect"):
            _sp.run(
                ["opencode2", "api", "post", f"/api/mcp/camoufox/{_m}"],
                capture_output=True,
                text=True,
                timeout=20,
            )
        time.sleep(3)  # сервису время пересоздать процесс и список тулов
        _r = _sp.run(["opencode2", "mcp", "list"], capture_output=True, text=True, timeout=20)
        if "camoufox" in _r.stdout and "connected" in _r.stdout:
            print("[+] MCP переподключён и ПРОВЕРЕН: ✓ camoufox connected")
        else:
            print("[!] connect выполнен, но статус не «connected» —")
            print("    последний рубеж: opencode2 service restart")
    except Exception as _e:
        print(f"[!] переподключи вручную (auto-fail {type(_e).__name__})")
        print("    команды: opencode2 api post /api/mcp/camoufox/disconnect;")
        print("              opencode2 api post /api/mcp/camoufox/connect")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
