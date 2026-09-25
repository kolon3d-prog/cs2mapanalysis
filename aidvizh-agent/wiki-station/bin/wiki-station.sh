#!/usr/bin/env bash
# wiki-station: центр вики (схема Karpathy LLM Wiki) — new | list | open | search | index | log | lint | install | check.
# Корень станции вычисляется от самого скрипта — абсолютных путей здесь нет.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || { printf 'wiki-station: нужен node\n' >&2; exit 1; }

exec node "$ROOT/bin/wiki.mjs" "$@"
