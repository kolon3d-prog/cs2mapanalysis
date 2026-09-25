#!/usr/bin/env bash
# mcp-station: одна команда ставит MCP-серверы в конфиги клиентов.
# Корень станции вычисляется от самого скрипта — абсолютных путей здесь нет.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'mcp-station: нужен node (им запускается движок станции и MCP-серверы)\n' >&2
  exit 1
}

exec node "$ROOT/bin/station.mjs" "$@"
