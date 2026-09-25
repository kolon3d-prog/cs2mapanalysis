#!/usr/bin/env bash
# Ключи станции: интерактивный ввод и управление файлом секретов.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'keys: нужен node (им запускается движок ключей)\n' >&2
  exit 1
}

exec node "$ROOT/bin/keys.mjs" "$@"
