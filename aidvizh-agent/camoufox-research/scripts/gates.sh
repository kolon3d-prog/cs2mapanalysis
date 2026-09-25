#!/usr/bin/env bash
# gates.sh — все гейты репозитория одной командой.
#
# Зачем отдельный скрипт: у каждого инструмента есть свой кэш (mypy — 30 МБ,
# ruff, __pycache__), и по умолчанию они сыплются ВНУТРЬ репозитория, а репозиторий
# лежит на диске данных. Урок 21.09: прод-диск — не свалка, поэтому кэши уводим
# в рантайм-каталог (PYTHONPYCACHEPREFIX/MYPY_CACHE_DIR/RUFF_CACHE_DIR).
#
# Запуск:  bash scripts/gates.sh            # всё
#          bash scripts/gates.sh --quick    # без semgrep и bats (быстрая петля)
#
# Код возврата: 0 — всё зелёное, иначе — номер упавшего гейта.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Окружение живёт В РАНТАЙМЕ (~/.venvs), а не в клоне: репо на диске данных — только код.
# Фолбэк на <repo>/.venv оставлен для CI и одноразовых песочниц.
VENV="${CAMOUFOX_VENV:-$HOME/.venvs/camoufox-research}"
[ -x "$VENV/bin/python" ] || VENV="$ROOT/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  printf 'gates.sh: нет окружения (%s и %s/.venv пусты). Поставь: bash scripts/install.sh\n' \
    "${CAMOUFOX_VENV:-$HOME/.venvs/camoufox-research}" "$ROOT" >&2
  exit 2
fi
PY="$VENV/bin/python"
export CAMOUFOX_VENV="$VENV"
CACHE="${CAMOUFOX_GATES_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/camoufox-research/gates}"
mkdir -p "$CACHE/mypy" "$CACHE/ruff" "$CACHE/pycache"
export MYPY_CACHE_DIR="$CACHE/mypy"
export RUFF_CACHE_DIR="$CACHE/ruff"
export PYTHONPYCACHEPREFIX="$CACHE/pycache"   # __pycache__ не в репозиторий

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1
FAILED=()
cd "$ROOT"

step() {  # $1=имя, далее команда
  local name="$1"; shift
  printf '\n=== %s ===\n' "$name"
  if "$@"; then printf '[ok] %s\n' "$name"; else printf '[FAIL] %s\n' "$name"; FAILED+=("$name"); fi
}

tool() {  # $1=имя бинарника: сначала из окружения, потом из PATH
  if [ -x "$VENV/bin/$1" ]; then printf '%s' "$VENV/bin/$1"; else command -v "$1"; fi
}
step "ruff"    "$(tool ruff)" check camoufox_research/ --line-length 100
step "mypy"    "$(tool mypy)" --config-file mypy.ini camoufox_research/
step "bandit"  "$(tool bandit)" -q -r camoufox_research/ -x tests -lll
if [ "$QUICK" -eq 0 ]; then
  step "semgrep" semgrep --config .semgrep.yml camoufox_research/ scripts/ \
       --metrics=off --disable-version-check --error
  step "bats"    bats tests/bats/
fi
step "unittest" "$PY" -m unittest discover -s tests

printf '\n=== итог ===\n'
if [ "${#FAILED[@]}" -eq 0 ]; then
  printf 'все гейты зелёные (venv: %s; кэши: %s)\n' "$VENV" "$CACHE"
  exit 0
fi
printf 'упали: %s\n' "${FAILED[*]}"
exit 1
