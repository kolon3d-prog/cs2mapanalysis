#!/usr/bin/env bash
set -euo pipefail

API_BASE="${SKILLSMP_API_URL:-https://skillsmp.com}"
DEFAULT_LIMIT=10
REQUEST_SLACK=20
HTTP_TIMEOUT="${SKILLS_HTTP_TIMEOUT:-30}"
HTTP_CONNECT_TIMEOUT=$((HTTP_TIMEOUT < 10 ? HTTP_TIMEOUT : 10))
# Индекс отдаёт выдачу по звёздам репозитория (своей релевантности у него нет) и повторяет
# один и тот же скилл из разных папок репозитория. Поэтому: схлопываем по ref и
# пересортировываем по совпадению слов запроса — имя (3), репозиторий (2), описание (1),
# плюс бонус за фразу целиком в имени (6) и описании (3); при равенстве порядок индекса.
JQ_RANK='
def terms($q): $q | ascii_downcase | [scan("[[:alnum:]]{3,}")];
def hits($hay; $ts): reduce $ts[] as $t (0; if ($hay | contains($t)) then . + 1 else . end);
def score($s; $ts; $phrase):
  (3 * hits($s.name | ascii_downcase; $ts))
  + (2 * hits($s.route.ownerSlug + " " + $s.route.repoSlug | ascii_downcase; $ts))
  + hits(($s.description // "") | ascii_downcase; $ts)
  + (if ($s.name | ascii_downcase | contains($phrase)) then 6 else 0 end)
  + (if (($s.description // "") | ascii_downcase | contains($phrase)) then 3 else 0 end);
def ranked($q):
  ($q | ascii_downcase) as $phrase
  | terms($q) as $ts
  | .skills
  | reduce .[] as $s ({seen: {}, out: []};
      ($s.route.ownerSlug + "/" + $s.route.repoSlug + "@" + $s.name) as $k
      | if .seen[$k] then . else .seen[$k] = true | .out += [$s] end)
  | .out
  | map(. + {searchScore: score(.; $ts; $phrase)})
  | sort_by(-.searchScore)
  | map(del(.searchScore));
'

die() { printf 'skillsmp: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
skillsmp: поиск по индексу SkillsMP (установки нет, только индекс)
  search <query> [--limit N] [--sort stars|recent] [--json]

Выдача: без дублей (один ref — одна строка), порядок — по совпадению слов запроса с именем,
репозиторием и описанием; при равенстве — порядок индекса (--sort stars|recent выбирает его).

Установка найденного: ref вида owner/repo@skill гони в
  skills-manager install <owner/repo@skill> --source skills-sh
  skills-manager install <owner/repo@skill> --source github
EOF
}

cmd_search() {
  local json=0 limit="$DEFAULT_LIMIT" sort="stars" query=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1 ;;
      --limit) limit="${2:?--limit requires a value}"; shift ;;
      --sort) sort="${2:?--sort requires a value}"; shift ;;
      -h|--help) usage; return 0 ;;
      -*) die "unknown flag: $1" ;;
      *) query="${query:+$query }$1" ;;
    esac
    shift
  done
  [[ -n "$query" ]] || die "usage: search <query> [--limit N] [--sort stars|recent] [--json]"
  case "$sort" in
    stars | recent) ;;
    *) die "--sort принимает stars или recent: остальное индекс молча заменяет на stars" ;;
  esac

  local raw
  raw="$(curl -fsS --connect-timeout "$HTTP_CONNECT_TIMEOUT" --max-time "$HTTP_TIMEOUT" --get "$API_BASE/api/skills" \
    --data-urlencode "search=$query" \
    --data-urlencode "limit=$((limit + REQUEST_SLACK))" \
    --data-urlencode "sortBy=$sort")" || die "skillsmp request failed (таймаут ${HTTP_TIMEOUT}с — подними SKILLS_HTTP_TIMEOUT)"

  if [[ "$(jq '.skills | length' <<<"$raw")" -eq 0 ]]; then
    printf 'nothing found for: %s\n' "$query"
    return 0
  fi

  if (( json )); then
    jq --arg q "$query" --argjson n "$limit" "${JQ_RANK}"'(ranked($q)) as $s | .skills = $s[0:$n]' <<<"$raw"
    return 0
  fi
  jq -r --arg q "$query" --argjson n "$limit" "${JQ_RANK}"'ranked($q) | .[0:$n][] | "\(.route.ownerSlug)/\(.route.repoSlug)@\(.name)  [\(.stars // 0) stars]\n  \(.githubUrl)"' <<<"$raw"
}

[[ $# -gt 0 ]] || { usage; exit 1; }
command="$1"
shift
case "$command" in
  search) cmd_search "$@" ;;
  fetch|install|add|list|ls) die "skillsmp — только индекс; ставь через --source skills-sh или --source github" ;;
  -h|--help|help) usage ;;
  *) usage; die "unknown command: $command" ;;
esac
