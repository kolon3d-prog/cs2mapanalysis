#!/usr/bin/env bash
set -euo pipefail

WORK_DIR=""
cleanup() {
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
}
trap cleanup EXIT

die() { printf 'github: %s\n' "$*" >&2; exit 1; }
strip_ansi() { sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g'; }

# на Windows gh лежит как gh.exe и может не находиться по короткому имени
GH_BIN="$(command -v gh || command -v gh.exe || true)"

usage() {
  cat <<'EOF'
github: маркет GitHub через gh skill (GitHub CLI 2.90+)
  search <query> [--limit N] [--owner O] [--json]
  fetch <owner/repo@skill>          SKILL.md в stdout
  install <pkg> [--project]         глобально в ~/.agents/skills или в ./.agents/skills
  list
EOF
}

[[ -n "$GH_BIN" ]] || die "gh not found (на Windows поставь GitHub CLI и добавь gh.exe в PATH)"

split_pkg() {
  local pkg="$1"
  REPO="${pkg%%@*}"
  SKILL="${pkg#*@}"
  [[ "$pkg" == *"@"* && -n "$REPO" && -n "$SKILL" ]] || die "need owner/repo@skill, got: $pkg"
}

cmd_search() {
  local json=0 limit=15 owner="" query=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1 ;;
      --limit) limit="${2:?--limit requires a value}"; shift ;;
      --owner) owner="${2:?--owner requires a value}"; shift ;;
      -h|--help) usage; return 0 ;;
      -*) die "unknown flag: $1" ;;
      *) query="${query:+$query }$1" ;;
    esac
    shift
  done
  [[ -n "$query" ]] || die "usage: search <query> [--limit N] [--owner O] [--json]"

  local fields="repo,skillName,namespace,path,stars,description"
  local -a args=(skill search "$query" -L "$limit" --json "$fields")
  [[ -n "$owner" ]] && args+=(--owner "$owner")

  if (( json )); then
    "$GH_BIN" "${args[@]}"
    return 0
  fi
  "$GH_BIN" "${args[@]}" | jq -r '.[] | "\(.repo)@\(if .namespace == "" then .skillName else "\(.namespace)/\(.skillName)" end)  [\(.stars // 0) stars]\n  https://github.com/\(.repo)"'
}

cmd_fetch() {
  local pkg="${1:-}"
  [[ -n "$pkg" ]] || die "usage: fetch <owner/repo@skill>"
  split_pkg "$pkg"

  local tmp
  tmp="$(mktemp -d)"
  WORK_DIR="$tmp"

  if ! "$GH_BIN" skill install "$REPO" "$SKILL" --dir "$tmp" -f >"$tmp/out.txt" 2>"$tmp/err.txt"; then
    cat "$tmp/err.txt" "$tmp/out.txt" >&2
    die "failed to fetch $pkg"
  fi
  local md
  md="$(find "$tmp" -type f -name SKILL.md | head -n 1)"
  [[ -n "$md" ]] || die "SKILL.md not found in downloaded skill"
  cat "$md"
}

cmd_install() {
  local project=0 pkg=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project=1 ;;
      -h|--help) usage; return 0 ;;
      -*) die "unknown flag: $1 (тонкие флаги gh skill передавай напрямую в gh)" ;;
      *) pkg="$1" ;;
    esac
    shift
  done
  [[ -n "$pkg" ]] || die "usage: install <pkg> [--project]"
  split_pkg "$pkg"

  local dir
  if (( project )); then
    dir="$(pwd)/.agents/skills"
  else
    dir="$HOME/.agents/skills"
  fi

  "$GH_BIN" skill install "$REPO" "$SKILL" --dir "$dir" -f 2>&1 | strip_ansi

  local name="${SKILL##*/}"
  if [[ -d "$dir/$name" ]]; then
    printf 'skill:  %s\n' "$dir/$name"
  else
    printf 'warning: %s not found in %s\n' "$name" "$dir" >&2
  fi
}

cmd_list() {
  "$GH_BIN" skill list 2>&1 | strip_ansi
}

[[ $# -gt 0 ]] || { usage; exit 1; }
command="$1"
shift
case "$command" in
  search) cmd_search "$@" ;;
  fetch) cmd_fetch "$@" ;;
  install|add) cmd_install "$@" ;;
  list|ls) cmd_list ;;
  -h|--help|help) usage ;;
  *) usage; die "unknown command: $command" ;;
esac
