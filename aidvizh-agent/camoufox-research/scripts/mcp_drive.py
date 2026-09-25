#!/usr/bin/env python3
"""mcp_drive — минимальный stdio-клиент MCP для живых проверок сервера.

ПЕРЕЕХАЛ из корня рабочего диска (21.09): временные артефакты не должны
лежать рядом с боевыми каталогами. Отчёты по умолчанию идут в
$CAMOUFOX_DEV_DIR (по умолчанию ~/.cache/camoufox-research/dev).

Запуск: <venv>/bin/python scripts/mcp_drive.py <repo> '<json-план>'
Флаг --full: печатать ответ целиком (по умолчанию режем до 6000 символов,
чтобы не залить контекст).

Умеет: initialize (перебор версий протокола) → tools/list → tools/call с замером
времени. stderr сервера тянется отдельным потоком, чтобы не залипнуть.

Питон берёт из venv репо. Запуск:
  <venv>/bin/python scripts/mcp_drive.py <repo> '<json-план>'
План — JSON-массив шагов: {"tool": "...", "args": {...}} или {"op":"tools"} / {"op":"ping"}.
"""
import contextlib
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

def dev_dir():
    """Куда складывать артефакты прогонов: CAMOUFOX_DEV_DIR или кэш-каталог."""
    d = os.environ.get("CAMOUFOX_DEV_DIR") or os.path.join(
        os.path.expanduser("~"), ".cache", "camoufox-research", "dev")
    Path(d).mkdir(parents=True, exist_ok=True)
    return Path(d)


WIRE_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]


class Server:
    def __init__(self, repo, env_extra=None, cmd=None):
        self.env = dict(os.environ)
        self.env["PYTHONPATH"] = repo
        self.env["PYTHONUNBUFFERED"] = "1"
        if env_extra:
            self.env.update(env_extra)
        self.cmd = cmd or [sys.executable, "-m", "camoufox_research.camoufox_research"]
        self.p = subprocess.Popen(
            self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=repo, env=self.env, text=True, bufsize=1,
        )
        self.stderr_lines = []
        self._id = 0
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        for line in self.p.stderr:
            self.stderr_lines.append(line.rstrip())

    def send(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params=None, notify=False):
        if notify:
            self.send({"jsonrpc": "2.0", "method": method, "params": params or {}})
            return None
        self._id += 1
        rid = self._id
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        return self.wait(rid)

    def wait(self, rid, timeout=180):
        """Читает построчно и ждёт ответ с нужным id (логи/нотификации пропускает)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"server closed stdout (rc={self.p.poll()})")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == rid:
                return msg
            if msg.get("method") in ("notifications/message", "notifications/progress"):
                print(f"   [notify {msg['method']}] {json.dumps(msg.get('params'))[:200]}")
        raise TimeoutError(f"no reply for id={rid} in {timeout}s")

    def handshake(self):
        last = None
        for v in WIRE_VERSIONS:
            try:
                r = self.rpc("initialize", {
                    "protocolVersion": v,
                    "capabilities": {},
                    "clientInfo": {"name": "mcp_drive", "version": "0.1"},
                }, )
            except Exception as e:
                last = str(e)
                break
            if "error" not in r:
                self.rpc("notifications/initialized", notify=True)
                return r["result"]
            last = json.dumps(r["error"])
        raise RuntimeError(f"handshake failed: {last}")

    def stop(self):
        with contextlib.suppress(Exception):
            self.p.stdin.close()
        try:
            self.p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.p.kill()


def main():
    repo = sys.argv[1]
    plan = json.loads(sys.argv[2])
    env_extra = json.loads(os.environ.get("DRIVE_ENV", "{}"))
    cmd = json.loads(os.environ.get("DRIVE_CMD", "null"))
    t0 = time.time()
    s = Server(repo, env_extra, cmd)
    try:
        info = s.handshake()
        t_boot = time.time() - t0
        print(f"BOOT {t_boot:.2f}s | server={info.get('serverInfo')} "
              f"proto={info.get('protocolVersion')}")
        results = []
        for step in plan:
            op = step.get("op", "call")
            if op == "sleep":
                print(f"... sleep {step['sec']}s")
                time.sleep(step["sec"])
                continue
            if op == "tools":
                r = s.rpc("tools/list", {})
                tools = [t["name"] for t in r["result"]["tools"]]
                print(f"TOOLS n={len(tools)}: {', '.join(sorted(tools))}")
                results.append({"tools": tools})
                continue
            name = step["tool"]
            t1 = time.time()
            r = s.rpc("tools/call", {"name": name, "arguments": step.get("args", {})})
            dt = time.time() - t1
            ok = "error" not in r
            if ok:
                content = r["result"].get("content", [])
                text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
                label = step.get("label", name)
                print(f"\n--- {label} [{dt:.2f}s] isError={r['result'].get('isError')} "
                      f"len={len(text)} ---")
                print(text if step.get("full") else text[: step.get("show", 1200)])
                results.append({"tool": name, "sec": round(dt, 2), "len": len(text),
                                "isError": bool(r["result"].get("isError")),
                                "text": text if step.get("full") else text[:6000]})
            else:
                print(f"\n--- {name} [{dt:.2f}s] RPC ERROR ---\n{json.dumps(r['error'])[:800]}")
                results.append({"tool": name, "sec": round(dt, 2), "error": r["error"]})
        print("\n=== SERVER STDERR (tail 25) ===")
        for line in s.stderr_lines[-25:]:
            print("  " + line[:220])
        out = os.environ.get("DRIVE_OUT")
        if out:
            # относительный путь — кладём в dev-каталог (кэш), а не рядом с боевыми
            out = str(dev_dir() / out) if not os.path.isabs(out) else out
            with open(out, "w", encoding="utf-8") as f:
                json.dump({"boot_sec": round(t_boot, 2), "server": info, "results": results},
                          f, ensure_ascii=False, indent=1)
    finally:
        s.stop()


if __name__ == "__main__":
    main()
