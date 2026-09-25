#!/usr/bin/env bash
# spec-station: спек-режим (скилл spec-mode + слэш-команды) по клиентам.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'spec-station: нужен node (им запускается движок станции)\n' >&2
  exit 1
}

exec node "$ROOT/bin/spec-station.mjs" "$@"
