#!/usr/bin/env bash
# cli-station: установка CLI (omp / pi / opencode) одной командой. Корень считается от скрипта.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'cli-station: нужен node (им запускается движок станции)\n' >&2
  exit 1
}

exec node "$ROOT/bin/cli-station.mjs" "$@"
