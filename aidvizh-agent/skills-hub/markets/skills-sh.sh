#!/usr/bin/env bash
set -euo pipefail

API_BASE="${SKILLS_API_URL:-https://skills.sh}"
DEFAULT_LIMIT=10

WORK_DIR=""
cleanup() {
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
}
trap cleanup EXIT

die() { printf 'skills-sh: %s\n' "$*" >&2; exit 1; }
strip_ansi() { sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g'; }

# npx на Windows лежит как npx.cmd — ищем оба имени, чтобы Git Bash тоже нашёл
NPX_BIN="$(command -v npx || command -v npx.cmd || true)"

TIMEOUT_SECONDS="${SKILLS_TIMEOUT:-180}"
HTTP_TIMEOUT="${SKILLS_HTTP_TIMEOUT:-30}"
HTTP_CONNECT_TIMEOUT=$((HTTP_TIMEOUT < 10 ? HTTP_TIMEOUT : 10))
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout -k 10 "$TIMEOUT_SECONDS")
else
  TIMEOUT_CMD=(env)
fi

usage() {
  cat <<'EOF'
skills-sh: маркет skills.sh через официальный npx skills
  search <query> [--limit N] [--owner O] [--json]
  fetch <owner/repo@skill>          SKILL.md в stdout
  install <pkg> [--project]         глобально в ~/.agents/skills или в ./.agents/skills
  list [-g]                         установленные скиллы (по умолчанию глобальные)
EOF
}

skills_cli() {
  local status=0
  if command -v skills >/dev/null 2>&1; then
    "${TIMEOUT_CMD[@]}" skills "$@" || status=$?
  else
    [[ -n "$NPX_BIN" ]] || die "не найден npx: поставь node (или npx.cmd в PATH), иначе skills CLI не запустить"
    "${TIMEOUT_CMD[@]}" "$NPX_BIN" -y skills@latest "$@" || status=$?
  fi
  if (( status == 124 )); then
    die "skills CLI не ответил за ${TIMEOUT_SECONDS}с (SKILLS_TIMEOUT переопределяет)"
  fi
  return "$status"
}

normalize_pkg() {
  local pkg="$1"
  pkg="${pkg#https://skills.sh/}"
  pkg="${pkg#http://skills.sh/}"
  pkg="${pkg%/}"
  if [[ "$pkg" != *"@"* && "$pkg" != *"://"* ]]; then
    local -a parts
    IFS='/' read -r -a parts <<<"$pkg"
    if [[ ${#parts[@]} -ge 3 ]]; then
      pkg="${parts[0]}/${parts[1]}@${parts[2]}"
    fi
  fi
  printf '%s' "$pkg"
}

cmd_search() {
  local json=0 limit="$DEFAULT_LIMIT" owner="" query=""
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

  local -a curl_args=(
    -fsS
    --connect-timeout "$HTTP_CONNECT_TIMEOUT"
    --max-time "$HTTP_TIMEOUT"
    --get "$API_BASE/api/search"
    --data-urlencode "q=$query"
    --data-urlencode "limit=$limit"
  )
  [[ -n "$owner" ]] && curl_args+=(--data-urlencode "owner=$owner")

  local raw
  raw="$(curl "${curl_args[@]}")" || die "skills.sh search request failed (таймаут ${HTTP_TIMEOUT}с — подними SKILLS_HTTP_TIMEOUT)"

  if (( json )); then
    jq --argjson n "$limit" '.skills |= (sort_by(-.installs) | .[0:$n])' <<<"$raw"
    return 0
  fi
  if [[ "$(jq '.skills | length' <<<"$raw")" -eq 0 ]]; then
    printf 'nothing found for: %s\n' "$query"
    return 0
  fi
  jq -r --argjson n "$limit" '.skills | sort_by(-.installs) | .[0:$n][] | "\(.source)@\(.name)  [\(.installs) installs]\n  https://skills.sh/\(.id)"' <<<"$raw"
}

cmd_fetch() {
  local pkg="${1:-}"
  [[ -n "$pkg" ]] || die "usage: fetch <owner/repo@skill>"
  pkg="$(normalize_pkg "$pkg")"
  [[ "$pkg" == *"@"* ]] || die "fetch needs an exact skill: owner/repo@skill"

  local tmp
  tmp="$(mktemp -d)"
  WORK_DIR="$tmp"

  if ! skills_cli use "$pkg" >"$tmp/use.txt" 2>"$tmp/err.txt"; then
    cat "$tmp/err.txt" >&2
    head -n 3 "$tmp/use.txt" >&2
    die "failed to fetch $pkg"
  fi
  sed -n '/^<SKILL.md>$/,/^<\/SKILL.md>$/p' "$tmp/use.txt" | sed '1d;$d' >"$tmp/SKILL.md"
  [[ -s "$tmp/SKILL.md" ]] || cp "$tmp/use.txt" "$tmp/SKILL.md"
  cat "$tmp/SKILL.md"
}

cmd_install() {
  local project=0 pkg=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project=1 ;;
      -h|--help) usage; return 0 ;;
      -*) die "unknown flag: $1 (для тонких случаев зови npx skills add напрямую)" ;;
      *) pkg="$1" ;;
    esac
    shift
  done
  [[ -n "$pkg" ]] || die "usage: install <pkg> [--project]"
  pkg="$(normalize_pkg "$pkg")"

  local name="${pkg##*@}"
  [[ "$name" == "$pkg" ]] && name="${pkg##*/}"

  local -a args=(add "$pkg" -y)
  (( project )) || args+=(-g)

  skills_cli "${args[@]}" 2>&1 | strip_ansi

  local lock skills_dir
  if (( project )); then
    lock="$(pwd)/skills-lock.json"
    skills_dir="$(pwd)/.agents/skills"
  else
    lock="$HOME/.agents/.skill-lock.json"
    skills_dir="$HOME/.agents/skills"
  fi
  if [[ -f "$lock" ]] && jq -e --arg n "$name" '.skills[$n]' "$lock" >/dev/null 2>&1; then
    printf 'locked: %s\nskill:  %s\n' "$lock" "$skills_dir/$name"
  else
    printf 'warning: %s not found in %s\n' "$name" "$lock" >&2
  fi
}

cmd_list() {
  local -a args=(list -g)
  local arg
  for arg in "$@"; do
    case "$arg" in
      -g | --global) args+=("$arg") ;;
      *) die "unknown flag: $arg (для остального зови npx skills list напрямую)" ;;
    esac
  done
  skills_cli "${args[@]}" 2>&1 | strip_ansi
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
