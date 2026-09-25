#!/usr/bin/env bash
set -euo pipefail

WORK_DIR=""
cleanup() {
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
}
trap cleanup EXIT

die() { printf 'clawhub: %s\n' "$*" >&2; exit 1; }
strip_ansi() { sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g'; }

# npx на Windows лежит как npx.cmd — ищем оба имени
NPX_BIN="$(command -v npx || command -v npx.cmd || true)"

TIMEOUT_SECONDS="${SKILLS_TIMEOUT:-180}"
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout -k 10 "$TIMEOUT_SECONDS")
else
  TIMEOUT_CMD=(env)
fi

usage() {
  cat <<'EOF'
clawhub: маркет ClawHub (OpenClaw), слаги вида puppeteer, @owner/slug или skills-sh:owner/repo/skill
  search <query>
  fetch <slug>                      SKILL.md в stdout
  install <slug> [--project]        глобально в ~/.agents/skills или в ./.agents/skills
  list
EOF
}

clawhub_cli() {
  local status=0
  [[ -n "$NPX_BIN" ]] || die "не найден npx: поставь node (или npx.cmd в PATH), иначе clawhub CLI не запустить"
  "${TIMEOUT_CMD[@]}" "$NPX_BIN" -y clawhub@latest "$@" || status=$?
  if (( status == 124 )); then
    die "clawhub CLI не ответил за ${TIMEOUT_SECONDS}с (SKILLS_TIMEOUT переопределяет)"
  fi
  return "$status"
}

cmd_search() {
  local query="" limit=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="${2:?--limit requires a value}"; shift ;;
      -h|--help) usage; return 0 ;;
      -*) die "unknown flag: $1" ;;
      *) query="${query:+$query }$1" ;;
    esac
    shift
  done
  [[ -n "$query" ]] || die "usage: search <query> [--limit N]"

  local -a args=(search "$query" --no-input)
  [[ -n "$limit" ]] && args+=(--limit "$limit")
  clawhub_cli "${args[@]}" 2>&1 | strip_ansi
}

cmd_fetch() {
  local slug="${1:-}"
  [[ -n "$slug" ]] || die "usage: fetch <slug>"

  local tmp
  tmp="$(mktemp -d)"
  WORK_DIR="$tmp"

  if ! clawhub_cli install "$slug" --workdir "$tmp" --no-input >"$tmp/out.txt" 2>"$tmp/err.txt"; then
    cat "$tmp/err.txt" "$tmp/out.txt" >&2
    die "failed to fetch $slug"
  fi
  local md
  md="$(find "$tmp" -type f -name SKILL.md | head -n 1)"
  [[ -n "$md" ]] || die "SKILL.md not found in downloaded skill"
  cat "$md"
}

cmd_install() {
  local project=0 slug=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project=1 ;;
      -h|--help) usage; return 0 ;;
      -*) die "unknown flag: $1" ;;
      *) slug="$1" ;;
    esac
    shift
  done
  [[ -n "$slug" ]] || die "usage: install <slug> [--project]"

  local workdir
  if (( project )); then
    workdir="$(pwd)"
  else
    workdir="$HOME"
  fi

  clawhub_cli install "$slug" --workdir "$workdir" --dir .agents/skills --no-input 2>&1 | strip_ansi

  printf 'lock:   %s\n' "$workdir/.clawhub/lock.json"
  printf 'skills: %s\n' "$workdir/.agents/skills"
}

cmd_list() {
  clawhub_cli list --workdir "$HOME" --dir .agents/skills --no-input 2>&1 | strip_ansi
}

[[ $# -gt 0 ]] || { usage; exit 1; }
command="$1"
shift
case "$command" in
  search) cmd_search "$@" ;;
  fetch) cmd_fetch "$@" ;;
  install|add) cmd_install "$@" ;;
  list|ls) cmd_list "$@" ;;
  -h|--help|help) usage ;;
  *) usage; die "unknown command: $command" ;;
esac
