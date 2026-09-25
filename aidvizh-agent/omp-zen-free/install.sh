#!/usr/bin/env bash
# omp-zen-free: расширения для omp/pi.
#   zen-free-tier-headers.ts — снимает 403 бесплатного тарифа OpenCode Go/Zen (omp + pi)
#   keys.ts                  — команда /keys: мультиключи omp (только omp: пишет в его хранилище)
# Кладём симлинками: правка файла на диске сразу доходит до клиента (обновление — см. README.md).
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")" && pwd)"
HEADERS="zen-free-tier-headers.ts"
KEYS="keys.ts"

dry_run=0
targets=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --omp) targets+=("omp") ;;
    --pi) targets+=("pi") ;;
    --all) targets=("omp" "pi") ;;
    -h | --help)
      printf 'omp-zen-free: расширения -> каталоги расширений omp и pi\n'
      printf '  %s — заголовки шлюза (omp и pi)\n' "$HEADERS"
      printf '  %s — команда /keys, мультиключи (только omp)\n' "$KEYS"
      printf 'флаги: --omp, --pi, --all (по умолчанию), --dry-run, --help\n'
      exit 0
      ;;
    *)
      printf 'omp-zen-free: неизвестный аргумент %s (есть --omp, --pi, --all, --dry-run)\n' "$arg" >&2
      exit 2
      ;;
  esac
done
if [[ "${#targets[@]}" -eq 0 ]]; then targets=("omp" "pi"); fi

for file in "$HEADERS" "$KEYS"; do
  [[ -f "$ROOT/$file" ]] || {
    printf 'omp-zen-free: нет файла расширения %s\n' "$ROOT/$file" >&2
    exit 1
  }
done

agent_dir() {
  case "$1" in
    omp) printf '%s' "${OMP_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}}" ;;
    pi) printf '%s' "${PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}" ;;
  esac
}

# что и куда кладём: заголовки — в оба клиента, keys.ts — только в omp (у pi нет такого хранилища)
planned_links() {
  local target
  for target in "${targets[@]}"; do
    printf '%s\t%s\n' "$(agent_dir "$target")/extensions/$HEADERS" "$ROOT/$HEADERS"
    if [[ "$target" == "omp" ]]; then
      printf '%s\t%s\n' "$(agent_dir "$target")/extensions/$KEYS" "$ROOT/$KEYS"
    fi
  done
}

# Git Bash на Windows делает ln -s копией: зовём PowerShell-установщик или просим его руками.
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW* | MSYS* | CYGWIN*)
    if [[ "${OMP_ZEN_FREE_ALLOW_MSYS:-}" != "1" ]]; then
      if command -v pwsh >/dev/null 2>&1; then
        printf 'windows: симлинки из Git Bash выходят копиями — зову pwsh -File install.ps1\n'
        if [[ "$dry_run" -eq 1 ]]; then
          exec pwsh -NoProfile -File "$ROOT/install.ps1" -WhatIf
        fi
        exec pwsh -NoProfile -File "$ROOT/install.ps1"
      fi
      printf 'windows: симлинки из Git Bash превращаются в копии.\n' >&2
      printf 'поставь через PowerShell: pwsh -File install.ps1\n' >&2
      printf '(если копии устраивают — OMP_ZEN_FREE_ALLOW_MSYS=1 install.sh)\n' >&2
      exit 1
    fi
    ;;
esac

# сначала проверяем все места: занятый файл — отказ до любых правок
while IFS=$'\t' read -r dst _src; do
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    printf 'занято: %s — это не симлинк, не трогаю\n' "$dst" >&2
    exit 1
  fi
done < <(planned_links)

while IFS=$'\t' read -r dst src; do
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'будет: %s -> %s\n' "$dst" "$src"
    continue
  fi
  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
  printf '%s -> %s\n' "$dst" "$src"
done < <(planned_links)

if [[ "$dry_run" -eq 0 ]]; then
  printf 'готово: расширения подхватятся на старте новой сессии omp/pi (текущую перезапусти)\n'
  printf '/keys в omp: список, add, check [--prune], disable/enable/remove\n'
fi
