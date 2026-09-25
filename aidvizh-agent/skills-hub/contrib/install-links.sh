#!/usr/bin/env bash
# Симлинки хаба: команда skills-manager в PATH и скилл skills-ops для агента.
# Пути считаются от самого скрипта — абсолютных путей диска здесь нет.
# Идемпотентно: если ссылка уже ведёт сюда, ничего не делает.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
HUB="$(cd "$(dirname "$SELF")/.." && pwd)"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW* | MSYS* | CYGWIN*)
    printf 'windows: в Git Bash `ln -s` может сделать копию вместо ссылки.\n' >&2
    printf 'если нужна настоящая ссылка — запусти с MSYS=winsymlinks:nativestrict.\n' >&2
    ;;
esac

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

link "$HUB/skills-manager.sh" "$HOME/.local/bin/skills-manager"
link "$HUB" "$HOME/.agents/skills/skills-ops"

if [[ $DRY -eq 1 ]]; then
  printf '\n(dry-run: ничего не создано)\n'
else
  printf '\nготово. проверка: %s/skills-manager.sh sources\n' "$HUB"
fi
