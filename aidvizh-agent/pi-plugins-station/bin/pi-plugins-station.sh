#!/usr/bin/env bash
# pi-plugins-station: сторонние плагины pi из каталога станции.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'pi-plugins-station: нужен node (им запускается движок станции)\n' >&2
  exit 1
}

exec node "$ROOT/bin/pi-plugins-station.mjs" "$@"
