#!/usr/bin/env bash
# command-center: центр координации проектов на диске (status/doctor/links/run/activate/bootstrap/check).
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'center: нужен node (им запускается движок центра)\n' >&2
  exit 1
}

exec node "$ROOT/bin/center.mjs" "$@"
