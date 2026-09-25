#!/usr/bin/env python3
"""soak_probe — нагрузочная проба MCP-сервера: зомби, зависания, память.

ПЕРЕЕХАЛ из корня рабочего диска (21.09): отчёт теперь пишется в кэш-каталог
(CAMOUFOX_SOAK_REPORT), а не рядом с боевыми каталогами.

Что меряем по итерациям (каждый прогон = новый сервер + браузер):
  * зомби (state Z) среди СВОИХ процессов — по /proc;
  * сироты после остановки сервера (живые camoufox-* / camoufox-bin);
  * зависания: каждый вызов под таймаутом, TimeoutError = hang;
  * память: суммарный RSS дерева (сервер + воркер + браузер) по итерациям —
    рост без причины = утечка.

Запуск:
  <venv>/bin/python scripts/soak_probe.py [итераций] [--session-stress N]
Код возврата: 0 — чисто, 1 — найдены зомби/сироты/зависания/утечка памяти.
"""
import json
import contextlib
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from mcp_drive import Server  # noqa: E402  (драйвер stdio-MCP рядом)

REPO = ROOT.parent  # харнесс живёт в scripts/, репозиторий — уровнем выше
CFG = Path(os.path.expanduser("~/.config/opencode/opencode.json"))

CALL_TIMEOUT = 90          # сек на вызов: больше = зависание
RSS_LEAK_MB = 250          # прирост на итерацию, выше которого это утечка


def _cmd():
    """Регистрация из opencode.json (то же, что видит клиент)."""
    try:
        return json.loads(CFG.read_text(encoding="utf-8"))["mcp"]["camoufox"]["command"]
    except Exception:
        return [str(REPO / ".venv/bin/camoufox-research")]


def _proc_table():
    """pid → (ppid, state, rss_kb, cmdline) по /proc (без ps)."""
    out = {}
    for p in Path("/proc").glob("[0-9]*"):
        try:
            stat = (p / "stat").read_text()
            rp = stat.rindex(")")          # имя может содержать пробелы/скобки
            fields = stat[rp + 2:].split()
            ppid, state = int(fields[1]), fields[0]
            rss = 0
            for line in (p / "status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
                    break
            cmd = (p / "cmdline").read_bytes().decode("utf-8", "ignore").replace("\0", " ").strip()
            out[int(p.name)] = (ppid, state, rss, cmd)
        except (OSError, ValueError, IndexError):
            continue
    return out


BASELINE = set()          # чужие camoufox-процессы (живой MCP владельца) — не считаем


def descendants(root_pid, table):
    """pid → прямые дети (по /proc) для проверки родства."""
    kids = {}
    for pid, (ppid, *_rest) in table.items():
        kids.setdefault(ppid, set()).add(pid)
    out, stack = set(), [root_pid]
    while stack:
        cur = stack.pop()
        for k in kids.get(cur, ()):
            if k not in out:
                out.add(k)
                stack.append(k)
    return out


def sample(our_pids, roots=()):
    """Срез: свои процессы, зомби, суммарный RSS.

    `roots` — pid наших серверов: считаем ТОЛЬКО их потомков. Иначе в
    «утечку» попадал MCP-сервер самого владельца, поднятый его клиентом
    (opencode держит зарегистрированный сервер живым): он стартует позже
    baseline и выглядит как сирота, хотя к прогону отношения не имеет.
    """
    t = _proc_table()
    allowed = set()
    for r in roots:
        allowed |= descendants(r, t)
        allowed.add(r)
    mine = {pid: v for pid, v in t.items()
            if ("camoufox-research" in v[3] or "camoufox-bin" in v[3])
            and pid not in BASELINE
            and (not roots or pid in allowed)}
    zombies = {pid: v for pid, v in t.items()
               if v[1] == "Z" and (v[0] in mine or pid in our_pids)}
    return {
        "n_proc": len(mine),
        "n_browser": sum(1 for v in mine.values() if "camoufox-bin" in v[3]),
        "rss_mb": round(sum(v[2] for v in mine.values()) / 1024, 1),
        "zombies": {str(k): v[3][:60] for k, v in zombies.items()},
        "pids": sorted(mine),
    }


def _kill(pids):
    for pid in pids:
        with contextlib.suppress(OSError):
            os.kill(pid, 15)
    time.sleep(2)
    for pid in pids:
        with contextlib.suppress(OSError):
            os.kill(pid, 9)


def one_iteration(i, session_stress=0):
    """Одна итерация: поднять сервер, дёрнуть тулы, снять, проверить след."""
    plan = [
        {"tool": "ping", "args": {}},
        {"tool": "web_search", "args": {"query": f"camoufox soak {i}", "max_results": 4}},
        {"tool": "fetch_page", "args": {"url": "https://example.com", "max_chars": 400}},
        {"tool": "session_start", "args": {"url": "https://example.com", "max_chars": 300}},
        {"tool": "session_eval", "args": {"expression": "JSON.stringify({t:document.title})"}},
        {"tool": "session_end", "args": {}},
    ]
    env = dict(os.environ)
    env["CAMOUFOX_CAPS"] = "research,browser,session"
    srv = Server(str(REPO), env_extra={"CAMOUFOX_CAPS": "research,browser,session"},
                 cmd=_cmd())
    rec = {"iter": i, "calls": [], "hangs": [], "boot_sec": None, "peak_rss_mb": 0}
    t0 = time.time()
    try:
        srv.handshake()
        rec["boot_sec"] = round(time.time() - t0, 2)
        rec["tools"] = len(srv.rpc("tools/list", {})["result"]["tools"])
        for step in plan:
            name = step["tool"]
            t1 = time.time()
            try:
                r = srv.rpc("tools/call", {"name": name, "arguments": step["args"]},
                            )
            except TimeoutError:
                rec["hangs"].append(name)
                continue
            dt = time.time() - t1
            ok = "error" not in r and not r["result"].get("isError")
            rec["calls"].append({"tool": name, "sec": round(dt, 2), "ok": ok})
            rec["peak_rss_mb"] = max(rec["peak_rss_mb"], sample([], [srv.p.pid])["rss_mb"])
        for k in range(session_stress):          # стресс живой сессии
            t1 = time.time()
            srv.rpc("tools/call", {"name": "session_eval",
                                   "arguments": {"expression": f"{k}*2"}})
            rec["calls"].append({"tool": "session_eval", "sec": round(time.time() - t1, 2),
                                 "ok": True})
        rec["peak_rss_mb"] = max(rec["peak_rss_mb"], sample([], [srv.p.pid])["rss_mb"])
        # дерево сервера ЖИВЫМ: после остановки проверим именно его (иначе
        # в «остатки» попадает MCP-сервер владельца, поднятый его клиентом)
        rec["tree_pids"] = sample([], [srv.p.pid])["pids"]
    finally:
        srv.stop()
    time.sleep(3)
    time.sleep(3)
    t = _proc_table()
    survivors = [pid for pid in rec.get("tree_pids", []) if pid in t]
    zombies = {str(p): t[p][3][:50] for p in survivors if t[p][1] == "Z"}
    rec["after"] = {"n_proc": len(survivors), "zombies": zombies,
                    "pids": survivors, "rss_mb": 0.0}
    rec["orphans"] = survivors
    rec["leak"] = bool(survivors)
    if rec["leak"]:
        _kill(survivors)                          # чистим за собой свои же сироты
    return rec


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 3
    stress = 0
    if "--session-stress" in sys.argv:
        stress = int(sys.argv[sys.argv.index("--session-stress") + 1])
    print(f"soak: {n} итераций, session-stress={stress}, команда={_cmd()[-1][:60]}")
    before = sample([])
    BASELINE.update(before["pids"])   # чужое (живой MCP владельца) не считаем
    print(f"до прогона: своих процессов={before['n_proc']} rss={before['rss_mb']}МБ "
          f"зомби={len(before['zombies'])} (baseline={sorted(BASELINE)})")
    rows, bad = [], []
    for i in range(1, n + 1):
        rec = one_iteration(i, stress)
        rows.append(rec)
        slow = [c for c in rec["calls"] if c["sec"] > CALL_TIMEOUT]
        errs = [c for c in rec["calls"] if not c["ok"]]
        print(f"\n--- итерация {i}: boot={rec['boot_sec']}с тулов={rec.get('tools')} "
              f"пикRSS={rec['peak_rss_mb']}МБ после снятия: процессов={rec['after']['n_proc']} "
              f"зомби={len(rec['after']['zombies'])}")
        for c in rec["calls"]:
            print(f"      {c['tool']:14} {c['sec']:6.2f}с {'ok' if c['ok'] else 'ОШИБКА'}")
        if rec["hangs"] or slow:
            bad.append(f"итерация {i}: зависания {rec['hangs'] + [c['tool'] for c in slow]}")
        if errs:
            bad.append(f"итерация {i}: ошибки вызовов {[c['tool'] for c in errs]}")
        if rec["leak"]:
            bad.append(f"итерация {i}: след после остановки — процессов "
                       f"{rec['after']['n_proc']}, зомби {rec['after']['zombies']}")
    rss = [r["peak_rss_mb"] for r in rows]
    drift = (rss[-1] - rss[0]) if len(rss) > 1 else 0
    if drift > RSS_LEAK_MB:
        bad.append(f"память: пик вырос на {drift:.0f}МБ за {len(rss)} итерации "
                   f"(порог {RSS_LEAK_MB})")
    print("\n=== ИТОГ ===")
    print(f"пик RSS по итерациям: {rss} (дрейф {drift:+.0f}МБ)")
    slow = [(r["iter"], c["tool"], c["sec"])
            for r in rows for c in r["calls"] if c["sec"] > CALL_TIMEOUT]
    print(f"медленные вызовы (> {CALL_TIMEOUT}с): {slow}")
    print("вердикт:", "ЧИСТО" if not bad else "ПРОБЛЕМЫ")
    for b in bad:
        print("  !", b)
    out = Path(os.environ.get("CAMOUFOX_SOAK_REPORT")
               or Path.home() / ".cache" / "camoufox-research" / "dev" / "soak_report.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print("отчёт:", out)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
