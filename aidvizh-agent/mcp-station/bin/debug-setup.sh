#!/usr/bin/env bash
# debug-setup — рантаймы отладочных MCP: venv'ы в $HOME/.venvs, мост официального LLDB в $HOME/.local/bin.
# Идемпотентно: уже собранное не трогает. Системные пакеты не ставит — печатает, что доставить.
set -euo pipefail

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

export PATH="$HOME/.cargo/bin:$PATH"

# 1) системные инструменты: подсказка владельцу, не молчаливая установка
missing=""
for cmd in gdb tshark lldb; do
  have "$cmd" || missing="$missing $cmd"
done
[ "$(uname -s)" = "Linux" ] && { have bpftrace || missing="$missing bpftrace"; }
if [ -n "$missing" ]; then
  say "не хватает системных:${missing}"
  if [ "$(uname -s)" = "Darwin" ]; then
    say "поставь: brew install gdb wireshark llvm   (lldb с MCP — это LLVM, у Apple-шного lldb MCP нет)"
  else
    say "поставь: sudo dnf install gdb wireshark-cli bpftrace lldb   (Fedora; в других дистрибутивах — свои имена пакетов)"
  fi
fi
have cargo || say "нет cargo — bpftrace-mcp-server не собрать (поставь rustup)"

# radare2: в Fedora 5.x, а r2mcp собран против 6.x — нужен upstream
if ! r2 -v 2>/dev/null | grep -qE 'radare2 6\.'; then
  say "radare2: нужен upstream 6.x (в Fedora 5.x) — собери и поставь r2mcp:"
  say "  git clone https://github.com/radareorg/radare2 && cd radare2 && sys/install.sh && r2pm -Uci r2mcp"
elif ! r2pm -l 2>/dev/null | grep -q '^r2mcp$'; then
  say "r2mcp нет: r2pm -Uci r2mcp"
fi

# 2) bpftrace-mcp-server (Rust, crates.io) — один бинарь, venv не нужен; eBPF есть только в Linux
if [ "$(uname -s)" = "Linux" ] && have cargo && ! have bpftrace-mcp-server; then
  say "bpftrace-mcp-server: собираю cargo-ом (один раз)"
  cargo install --locked bpftrace-mcp-server
fi

# 3) venv'ы под python-серверы. Дефолты — из самих пакетов, а не из головы:
#    python 3.12 — mitmproxy-mcp объявляет Requires-Python >=3.12,<3.14 (PyPI);
#                  у frida нет wheel'ов под cp314 — uv сам скачает 3.12;
#    mcp<2 — frida_mcp/cli.py:11 импортирует mcp.server.fastmcp (в mcp 2.x модуля нет);
#    wireshark-mcp сам требует mcp>=2.1.1,<3 — идёт без пина.
have uv || { say "нет uv — venv'ы не собрать (uv ставит cli-station)"; exit 1; }
mkvenv() {
  local name="$1" py="$2"; shift 2
  if [ -x "$HOME/.venvs/$name/bin/$name" ]; then say "$name: уже собран"; return; fi
  say "$name: собираю (python $py)"
  uv venv "$HOME/.venvs/$name" --python "$py"
  uv pip install --python "$HOME/.venvs/$name/bin/python" "$@"
}
mkvenv frida-mcp     3.12 frida frida-mcp "mcp<2"
mkvenv wireshark-mcp 3.12 wireshark-mcp
mkvenv mitmproxy-mcp 3.12 mitmproxy-mcp

# 4) мост официального LLDB-MCP: в 22.x lldb-mcp — TCP, клиентам нужен stdio-мост
# mkdir + install без -D: -D есть только в GNU install, на macOS (BSD install) его нет
mkdir -p "$HOME/.local/bin"
install -m755 "$(dirname "$0")/lldb-mcp-bridge.sh" "$HOME/.local/bin/lldb-mcp-bridge"
say "lldb-mcp-bridge: $HOME/.local/bin/lldb-mcp-bridge"

say "готово. Дальше: bin/mcp-station.sh install gdb frida-mcp bpftrace wireshark-mcp mitmproxy-mcp lldb"
