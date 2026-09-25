#!/usr/bin/env bash
# Симлинк центра: команда `center` в PATH.
# Без него доки лгут — везде написано `center status`, а такой команды нет и на новой машине не будет.
# Пути считаются от самого скрипта — абсолютных путей диска здесь нет.
# Идемпотентно: если ссылка уже ведёт сюда, ничего не делает.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
CENTER="$(cd "$(dirname "$SELF")/.." && pwd)"
DRY=0
[[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]] && DRY=1

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    printf 'windows: в Git Bash `ln -s` может сделать копию вместо ссылки.\n' >&2
    printf 'на настоящей Windows зови `pwsh -File contrib/install-links.ps1` — там своя обёртка.\n' >&2
    ;;
esac

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
TARGET="$CENTER/bin/center.sh"
LINK="$BIN_DIR/center"

if [[ ! -x "$TARGET" ]]; then
  printf 'точки входа нет: %s — центр с этого диска не запустить\n' "$TARGET" >&2
  exit 2
fi

link() {
  local src="$1" dst="$2"
  local current=""
  [[ -L "$dst" ]] && current="$(readlink -f "$dst" 2>/dev/null || true)"
  if [[ "$current" == "$src" ]]; then
    printf 'ok       %s (уже ведёт сюда)\n' "$dst"
    return 0
  fi
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    printf 'занято:  %s — это не симлинк, не трогаю\n' "$dst" >&2
    return 1
  fi
  printf '%s %s -> %s\n' "$([[ $DRY -eq 1 ]] && echo 'будет  ' || echo 'создаю ')" "$dst" "$src"
  [[ $DRY -eq 1 ]] || { mkdir -p "$(dirname "$dst")"; ln -sfn "$src" "$dst"; }
}

link "$TARGET" "$LINK"

if [[ $DRY -eq 1 ]]; then
  printf '\n(dry-run: ничего не создано)\n'
else
  printf '\nготово. проверка: center version\n'
fi
