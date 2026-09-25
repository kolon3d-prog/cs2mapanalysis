#!/usr/bin/env bash
# prompt-station: прошивка системных промтов (персон) в omp, pi и opencode.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'prompt-station: нужен node (им запускается движок станции)\n' >&2
  exit 1
}

exec node "$ROOT/bin/prompt-station.mjs" "$@"
