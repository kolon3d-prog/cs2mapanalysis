#!/usr/bin/env bash
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
ROOT="$(cd "$(dirname "$SELF")" && pwd)"
MARKETS="$ROOT/markets"
DEFAULT_SOURCE="skills-sh"
SOURCES_ORDER=(skills-sh github clawhub skillsmp)
SECTION_LINES=20

WORK_DIR=""
cleanup() {
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
}
trap cleanup EXIT

die() { printf 'skills-manager: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
skills-manager: единый вход в маркеты скиллов

  search <query> [--source NAME] [adapter flags]
      по умолчанию skills-sh; --source all опрашивает все маркеты и схлопывает дубли
  inspect <pkg> [--source NAME|auto] [--full]
      выжимка SKILL.md: имя, описание, права, зависимости/установка; --full весь текст
  install <pkg> [--source NAME|auto] [--project]
      по умолчанию skills-sh; глобально в ~/.agents/skills, --project в ./.agents/skills
  check-spec [path] [--source не нужен] [--strict] [--quiet]
      проверка SKILL.md по спеке agentskills.io: по умолчанию ~/.agents/skills,
      можно каталог коллекции или один скилл; --strict валит и на предупреждениях
  list [--source NAME]
      установленные скиллы (skills-sh: по умолчанию глобальные)
  doctor
      проверка окружения: зависимости, симлинки, регистрация MCP, gh auth
  sources
      список маркетов

--source auto: источник по форме пакета — owner/repo@skill идёт сначала в skills-sh,
потом в github; слаг без слэша — в clawhub.
Маркеты: skills-sh (npx skills), github (gh skill), clawhub, skillsmp (только индекс,
установка найденного через --source skills-sh|github).
Таймаут npx-адаптеров — SKILLS_TIMEOUT секунд (по умолчанию 180).
Прямой вызов адаптера: markets/<name>.sh search <query>
EOF
}

adapter_for() {
  local name="$1"
  ADAPTER="$MARKETS/$name.sh"
  [[ -f "$ADAPTER" ]] || die "unknown source: $name (см. skills-manager sources)"
}

summarize() {
  local file="$1"
  printf '\n-- meta --\n'
  awk '
    NR == 1 && $0 == "---" { fm = 1; next }
    fm && $0 == "---" { exit }
    fm {
      if (/^[A-Za-z_][A-Za-z0-9_-]*:/) {
        key = $0
        sub(/:.*/, "", key)
        keep = (key ~ /^(name|description|license|allowed-tools|permissions|tools|metadata|version)$/)
      } else if ($0 !~ /^[[:space:]]/) {
        keep = 0
      }
      if (keep) print
    }
  ' "$file"

  printf '\n-- dependencies / permissions --\n'
  local found
  found="$(awk -v max="$SECTION_LINES" '
    BEGIN { IGNORECASE = 1 }
    /^#{1,6} / {
      active = match($0, /install|setup|dependen|requirement|prerequisit|permission|allowed|tools|requires|credentials|secrets/)
      n = 0
      if (active) { if (sections++) print ""; print }
      next
    }
    active && n < max && $0 !~ /^[[:space:]]*$/ { print; n++ }
  ' "$file")"
  if [[ -n "$found" ]]; then
    printf '%s\n' "$found"
  else
    printf 'no explicit sections\n'
  fi
}

dedupe_market_results() {
  awk '
    function canon(line, ref, n, parts, slug, owner) {
      if (match(line, /skills-sh:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/)) {
        ref = substr(line, RSTART + 10, RLENGTH - 10)
        n = split(ref, parts, "/")
        return parts[n - 2] "/" parts[n - 1] "@" parts[n]
      }
      if (match(line, /[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+/)) return substr(line, RSTART, RLENGTH)
      slug = $1
      if (slug == "") return ""
      owner = ""
      if (match(line, /@[A-Za-z0-9._-]+/)) owner = substr(line, RSTART + 1, RLENGTH - 1)
      return (owner == "" ? "slug:" slug : owner "/" slug)
    }
    /^== .* ==$/ { dropping = 0; print; next }
    /^[[:space:]]/ || $0 == "" { if (!dropping) print; next }
    {
      key = canon($0)
      if (key != "" && key in seen) { hidden++; dropping = 1; next }
      if (key != "") seen[key] = 1
      dropping = 0
      print
    }
    END { if (hidden > 0) printf "(скрыто дублей: %d)\n", hidden }
  '
}

cmd_search() {
  if [[ "$SOURCE" != all ]]; then
    adapter_for "$SOURCE"
    exec "$ADAPTER" search "$@"
  fi
  local dir
  dir="$(mktemp -d)"
  WORK_DIR="$dir"
  {
    for source in "${SOURCES_ORDER[@]}"; do
      printf '\n== %s ==\n' "$source"
      adapter_for "$source"
      if "$ADAPTER" search "$@"; then
        printf '%s\n' "$source" >>"$dir/ok"
      else
        printf '(%s failed)\n' "$source" >&2
      fi
    done
  } | dedupe_market_results
  [[ -s "$dir/ok" ]] || die "all sources failed"
}

resolve_source() {
  local pkg="$1" candidate
  case "$pkg" in
    skills-sh:*) printf 'skills-sh\n'; return 0 ;;
  esac
  if [[ "$pkg" == */*@* ]]; then
    for candidate in skills-sh github; do
      adapter_for "$candidate"
      if "$ADAPTER" fetch "$pkg" >/dev/null 2>&1; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
    return 1
  fi
  adapter_for clawhub
  if "$ADAPTER" fetch "$pkg" >/dev/null 2>&1; then
    printf 'clawhub\n'
    return 0
  fi
  return 1
}

cmd_inspect() {
  local full=0 pkg=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --full) full=1 ;;
      -h|--help) usage; return 0 ;;
      -*) die "unknown flag: $1" ;;
      *) pkg="$1" ;;
    esac
    shift
  done
  [[ -n "$pkg" ]] || die "usage: inspect <pkg> [--source NAME] [--full]"

  if [[ "$SOURCE" == auto ]]; then
    SOURCE="$(resolve_source "$pkg")" || die "auto: $pkg не найден в skills-sh, github, clawhub"
  fi

  adapter_for "$SOURCE"
  local tmp
  tmp="$(mktemp -d)"
  WORK_DIR="$tmp"
  "$ADAPTER" fetch "$pkg" >"$tmp/SKILL.md" || die "fetch failed for $pkg (source: $SOURCE)"

  printf 'source: %s\npkg:    %s\n' "$SOURCE" "$pkg"
  if (( full )); then
    printf '\n'
    cat "$tmp/SKILL.md"
  else
    summarize "$tmp/SKILL.md"
  fi
}

cmd_sources() {
  printf '%-10s %s\n' "skills-sh" "skills.sh через npx skills (search/fetch/install/list)"
  printf '%-10s %s\n' "github" "GitHub через gh skill (search/fetch/install/list)"
  printf '%-10s %s\n' "clawhub" "ClawHub/OpenClaw (search/fetch/install/list)"
  printf '%-10s %s\n' "skillsmp" "SkillsMP, только индекс (search)"
}

PROBLEMS=0

doctor_report() {
  printf '%-34s %-5s %s\n' "$2" "$1" "$3"
}

doctor_dep() {
  local bin="$1" required="$2" hint="${3:-}" found
  if found="$(command -v "$bin" 2>/dev/null)"; then
    doctor_report ok "$bin" "$found"
  elif [[ "$required" == required ]]; then
    doctor_report FAIL "$bin" "${hint:-не найден}"
    PROBLEMS=$((PROBLEMS + 1))
  else
    doctor_report warn "$bin" "${hint:-не найден}"
  fi
}

doctor_link() {
  local link="$1" expect="$2" target
  if [[ ! -L "$link" ]]; then
    doctor_report FAIL "$link" "нет симлинка — пересоздать по README"
    PROBLEMS=$((PROBLEMS + 1))
    return 0
  fi
  target="$(readlink "$link")"
  [[ "$target" == /* ]] || target="$(dirname "$link")/$target"
  if [[ ! -e "$target" ]]; then
    doctor_report FAIL "$link" "битый -> $target"
    PROBLEMS=$((PROBLEMS + 1))
  elif [[ "$target" != "$expect" ]]; then
    doctor_report FAIL "$link" "-> $target (ждали $expect)"
    PROBLEMS=$((PROBLEMS + 1))
  else
    doctor_report ok "$link" "-> $target"
  fi
}

doctor_mcp() {
  local file="$1" label="$2" raw path found=0
  if [[ ! -f "$file" ]]; then
    doctor_report warn "mcp $label" "нет файла $file"
    return 0
  fi
  while IFS= read -r raw; do
    [[ -n "$raw" ]] || continue
    found=1
    path="${raw//\$HOME/$HOME}"
    path="${path/#\~/$HOME}"
    if [[ -e "$path" ]]; then
      doctor_report ok "mcp $label" "$path"
    else
      doctor_report FAIL "mcp $label" "битый путь: $path"
      PROBLEMS=$((PROBLEMS + 1))
    fi
  done < <(jq -r '[.. | strings | scan("[^ \"]*skills-[a-z]+/mcp/server\\.mjs")] | unique | .[]' "$file" 2>/dev/null || true)
  (( found )) || doctor_report warn "mcp $label" "skills-hub не зарегистрирован"
}

cmd_doctor() {
  PROBLEMS=0
  printf 'root: %s\n\n' "$ROOT"

  case "$(uname -s 2>/dev/null || true)" in
    MINGW* | MSYS* | CYGWIN*)
      doctor_report ok "платформа" "$(uname -s): bash на месте, CLI работает; симлинки в профиле могут требовать прав"
      ;;
  esac

  doctor_dep curl required
  doctor_dep jq required "поставь jq (jaq тоже подходит)"
  doctor_dep node required "нужен npx-адаптерам"
  doctor_dep npx required "идёт в поставке node"
  doctor_dep gh optional "нужен только для --source github"
  doctor_dep shellcheck optional "нужен для проверки скриптов в наборе тестов"
  doctor_dep timeout optional "нужен для таймаутов npx-адаптеров (coreutils)"
  printf '\n'

  doctor_link "$HOME/.local/bin/skills-manager" "$ROOT/skills-manager.sh"
  doctor_link "$HOME/.agents/skills/skills-ops" "$ROOT"
  printf '\n'

  doctor_mcp "$HOME/.config/opencode/opencode.json" opencode
  doctor_mcp "$HOME/.omp/agent/mcp.json" omp
  printf '\n'

  if command -v gh >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then
      doctor_report ok "gh auth" "$(gh auth status 2>&1 | awk -F'account ' '/Logged in/{print $2; exit}')"
    else
      doctor_report warn "gh auth" "не залогинен: gh auth login"
    fi
  fi

  printf '\n'
  if (( PROBLEMS == 0 )); then
    printf 'doctor: ok\n'
  else
    printf 'doctor: проблем %d\n' "$PROBLEMS"
    return 1
  fi
}

[[ $# -gt 0 ]] || { usage; exit 1; }
command="$1"
shift

SOURCE="$DEFAULT_SOURCE"
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || die "--source requires a value"
      SOURCE="$2"
      shift 2
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
set -- "${args[@]}"

case "$command" in
  inspect|read|show|install|add|check-spec|-h|--help|help) ;;
  *)
    if [[ "$SOURCE" == auto ]]; then
      die "--source auto применим только к inspect/install: у search и list на входе не пакет"
    fi
    ;;
esac

case "$command" in
  search) cmd_search "$@" ;;
  inspect|read|show) cmd_inspect "$@" ;;
  install|add)
    if [[ "$SOURCE" == auto ]]; then
      package=""
      for arg in "$@"; do
        case "$arg" in
          -*) ;;
          *)
            package="$arg"
            break
            ;;
        esac
      done
      [[ -n "$package" ]] || die "install: нужен пакет"
      SOURCE="$(resolve_source "$package")" || die "auto: $package не найден в skills-sh, github, clawhub"
    fi
    adapter_for "$SOURCE"
    "$ADAPTER" install "$@"
    rc=$?
    # Мягкий spec-гейт: после успешной установки показать несоответствия спеки, не отменяя установку.
    if [[ $rc -eq 0 && -f "$ROOT/contrib/check-spec.mjs" ]] && command -v node >/dev/null 2>&1; then
      spec_root="$HOME/.agents/skills"
      for arg in "$@"; do
        if [[ "$arg" == "--project" ]]; then spec_root="./.agents/skills"; fi
      done
      if [[ -d "$spec_root" ]]; then
        printf '\n-- проверка спеки (agentskills.io)\n'
        node "$ROOT/contrib/check-spec.mjs" "$spec_root" --quiet || true
      fi
    fi
    exit "$rc"
    ;;
  list|ls)
    adapter_for "$SOURCE"
    exec "$ADAPTER" list "$@"
    ;;
  doctor) cmd_doctor ;;
  check-spec)
    command -v node >/dev/null 2>&1 || die "check-spec: нужен node"
    if [[ $# -eq 0 ]]; then
      exec node "$ROOT/contrib/check-spec.mjs" "$HOME/.agents/skills"
    fi
    exec node "$ROOT/contrib/check-spec.mjs" "$@"
    ;;
  sources) cmd_sources ;;
  -h|--help|help) usage ;;
  *) usage; die "unknown command: $command" ;;
esac
