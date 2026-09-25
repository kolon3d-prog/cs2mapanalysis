#!/usr/bin/env bash
# junk-report-station: отчёт по мусору на диске данных (только чтение, ничего не удаляет).
set -euo pipefail
SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
command -v node >/dev/null 2>&1 || { printf 'junk-report: нужен node (им запускается движок)\n' >&2; exit 1; }
exec node "$ROOT/bin/junk-report.mjs" "$@"
