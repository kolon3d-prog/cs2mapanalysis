#!/usr/bin/env bash
# memory-station: центр памяти агента (basic-memory) — install | status | check | doctor | note | search.
# Корень станции вычисляется от самого скрипта — абсолютных путей здесь нет.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'memory-station: нужен node\n' >&2
  exit 1
}

exec node "$ROOT/bin/memory.mjs" "$@"
