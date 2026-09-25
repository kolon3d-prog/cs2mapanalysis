#!/usr/bin/env bash
# sentinel: сторож набора — жив ли диск DATA и живы ли ссылки в $HOME.
#
# Тонкая обёртка: движок один на все ОС — bin/sentinel.mjs (его же зовёт bin/sentinel.ps1).
# Проверка нужна именно снаружи диска: все прочие проверки набора лежат на нём самом, поэтому
# пропажу диска видит только тот, кто запускается не с него (локальная обёртка таймера —
# command-center/contrib/center-local.sh.in, копия в $HOME/.local/state/center).
#
# Использование: bin/sentinel.sh [--json] [--quiet]
#   --json   машинный вывод (ok, диск, ссылки, версия, проблемы)
#   --quiet  печатать только проблемы (режим таймера)
#
# Код возврата: 0 — всё живо, 1 — есть мёртвое (список строками), 2 — нечем запустить движок.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
CENTER="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'sentinel: нужен node (им работает движок сторожа)\n' >&2
  exit 2
}

exec node "$CENTER/bin/sentinel.mjs" "$@"
