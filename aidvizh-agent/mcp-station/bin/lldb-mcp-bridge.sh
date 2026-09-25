#!/usr/bin/env bash
# lldb-mcp-bridge — stdio-MCP поверх официального MCP-сервера LLDB (пакет Fedora lldb 22.x).
# Почему мост: в 22.x /usr/bin/lldb-mcp поднимает lldb с MCP на TCP-порту и форвардит в него IO,
# а клиентам нужен stdio-сервер. Здесь: живой бэкенд на фиксированном порту + мост nc.
set -uo pipefail

PORT="${LLDB_MCP_PORT:-59999}"
LLDB_BIN="${LLDB_BIN:-lldb}"
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/lldb-mcp-bridge"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/lldb-backend.$PORT.log"

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

command -v "$LLDB_BIN" >/dev/null 2>&1 || { printf 'нет %s: sudo dnf install lldb\n' "$LLDB_BIN" >&2; exit 1; }
command -v nc >/dev/null 2>&1 || { printf 'нет nc: sudo dnf install nmap-ncat\n' >&2; exit 1; }

if ! port_open; then
  # stdin бэкенда держим открытым (tail -f /dev/null): с EOF lldb выйдет и сервер умрёт
  BACKEND="tail -f /dev/null | '$LLDB_BIN' -O 'protocol-server start MCP listen://127.0.0.1:$PORT' >>'$LOG' 2>&1"
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "$BACKEND" &
  else
    # macOS: setsid нет — бэкенд уводим nohup-ом, чтобы пережил выход моста
    nohup bash -c "$BACKEND" >/dev/null 2>&1 &
  fi
  # ждём событие — порт открылся; не дождались — говорим, где смотреть причину
  for _ in $(seq 1 100); do
    port_open && break
    sleep 0.1
  done
fi

port_open || { printf 'бэкенд lldb не поднялся за 10 с: смотри %s\n' "$LOG" >&2; exit 1; }
exec nc 127.0.0.1 "$PORT"
