#!/usr/bin/env sh
# Симлинк скилла в канонический стор агента (~/.agents/skills) и в каталог opencode.
# Скилл — это текст: ничего не устанавливается, только ссылки. Идемпотентно, есть --dry-run.
set -eu

SELF="$0"
while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
REPO="$(cd "$(dirname "$SELF")" && pwd)"
NAME=fedora-windows-look
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW* | MSYS* | CYGWIN*)
    printf 'windows: в Git Bash `ln -s` может сделать копию; нужна MSYS=winsymlinks:nativestrict\n' >&2
    ;;
esac

link() {
  src="$1"; dst="$2"
  if [ -L "$dst" ] && [ "$(readlink -f "$dst" 2>/dev/null || true)" = "$src" ]; then
    printf 'ok      %s\n' "$dst"
    return 0
  fi
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    printf 'занято: %s — не симлинк, не трогаю\n' "$dst" >&2
    return 1
  fi
  printf '%s%s -> %s\n' "$([ "$DRY" -eq 1 ] && echo 'будет  ' || echo 'создаю ')" "$dst" "$src"
  [ "$DRY" -eq 1 ] || { mkdir -p "$(dirname "$dst")"; ln -sfn "$src" "$dst"; }
}

cfgd="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills"
link "$REPO" "$HOME/.agents/skills/$NAME"
link "../../../.agents/skills/$NAME" "$cfgd/$NAME"

if [ "$DRY" -eq 1 ]; then
  printf '\n(dry-run: ничего не создано)\n'
fi
exit 0
