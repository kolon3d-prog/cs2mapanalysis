#!/usr/bin/env bash
# Проверка диска: doctor + оффлайн-наборы skills-hub и соседних станций.
# Запускается systemd-юнитом при появлении диска и по таймеру; годится и для ручного вызова.
# Скрипт лежит на том же диске, поэтому «диска нет» — это случай, когда его самого не запустить.
# А если движка рядом нет — установка сломана: падаем видимо, чтобы таймер не молчал.
set -uo pipefail

HUB="${SKILLS_HUB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [[ ! -x "$HUB/skills-manager.sh" ]]; then
  printf 'skills-hub не на месте: %s\n' "$HUB"
  exit 1
fi

cd "$HUB" || exit 1
status=0
fail_fast() {
  printf 'skills-hub-check: первый провал — останавливаюсь без молчаливого продолжения\n' >&2
  exit 1
}

# у systemd в PATH нет dotnet-tools, а без pwsh windows-тесты в наборах пропускаются
if [[ -d "$HOME/.dotnet/tools" ]]; then
  PATH="$HOME/.dotnet/tools:$PATH"
  export PATH
fi

printf '== doctor\n'
./skills-manager.sh doctor || fail_fast

# Спека скиллов (agentskills.io): ошибки валят часовой прогон, предупреждения — только строкой итога.
collection="$(cd "$HUB/.." && pwd)/skills-station/collection"
printf '\n== spec-check: коллекция скиллов (agentskills.io)\n'
if [[ -f "$HUB/contrib/check-spec.mjs" && -d "$collection" ]] && command -v node >/dev/null 2>&1; then
  node "$HUB/contrib/check-spec.mjs" "$collection" --quiet || fail_fast
else
  printf 'node или коллекция недоступны — пропуск\n'
fi

printf '\n== bats: skills-hub\n'
if command -v bats >/dev/null 2>&1; then
  bats tests/hub.bats || fail_fast
else
  printf 'bats не установлен — набор пропущен\n'
  fail_fast
fi

# соседний проект на том же диске: у него свои установщики и свой набор
sysprompt="$(cd "$HUB/.." && pwd)/sysprompt"
printf '\n== bats: sysprompt\n'
if [[ -f "$sysprompt/tests/install.bats" ]]; then
  (cd "$sysprompt" && bats tests/install.bats) || fail_fast
else
  printf 'набор sysprompt не найден (%s) — пропуск\n' "$sysprompt"
fi

station="$(cd "$HUB/.." && pwd)/mcp-station"
printf '\n== bats: mcp-station\n'
if [[ -f "$station/tests/station.bats" ]]; then
  (cd "$station" && bats tests/station.bats) || fail_fast
else
  printf 'набор mcp-station не найден (%s) — пропуск\n' "$station"
fi

clis="$(cd "$HUB/.." && pwd)/cli-station"
printf '\n== bats: cli-station\n'
if [[ -f "$clis/tests/station.bats" ]]; then
  (cd "$clis" && bats tests/station.bats) || fail_fast
else
  printf 'набор cli-station не найден (%s) — пропуск\n' "$clis"
fi

prompts="$(cd "$HUB/.." && pwd)/prompt-station"
printf '\n== bats: prompt-station\n'
if [[ -f "$prompts/tests/station.bats" ]]; then
  (cd "$prompts" && bats tests/station.bats) || fail_fast
else
  printf 'набор prompt-station не найден (%s) — пропуск\n' "$prompts"
fi

skills="$(cd "$HUB/.." && pwd)/skills-station"
printf '\n== bats: skills-station\n'
if [[ -f "$skills/tests/station.bats" ]]; then
  (cd "$skills" && bats tests/station.bats) || fail_fast
else
  printf 'набор skills-station не найден (%s) — пропуск\n' "$skills"
fi

memory="$(cd "$HUB/.." && pwd)/memory-station"
printf '\n== bats: memory-station\n'
if [[ -f "$memory/tests/station.bats" ]]; then
  (cd "$memory" && bats tests/station.bats) || fail_fast
else
  printf 'набор memory-station не найден (%s) — пропуск\n' "$memory"
fi

wiki="$(cd "$HUB/.." && pwd)/wiki-station"
printf '\n== bats: wiki-station\n'
if [[ -f "$wiki/tests/station.bats" ]]; then
  (cd "$wiki" && bats tests/station.bats) || fail_fast
else
  printf 'набор wiki-station не найден (%s) — пропуск\n' "$wiki"
fi

spec="$(cd "$HUB/.." && pwd)/spec-station"
printf '\n== bats: spec-station\n'
if [[ -f "$spec/tests/station.bats" ]]; then
  (cd "$spec" && bats tests/station.bats) || fail_fast
else
  printf 'набор spec-station не найден (%s) — пропуск\n' "$spec"
fi

plugins="$(cd "$HUB/.." && pwd)/pi-plugins-station"
printf '\n== bats: pi-plugins-station\n'
if [[ -f "$plugins/tests/station.bats" ]]; then
  (cd "$plugins" && bats tests/station.bats) || fail_fast
else
  printf 'набор pi-plugins-station не найден (%s) — пропуск\n' "$plugins"
fi

modes="$(cd "$HUB/.." && pwd)/modes-station"
printf '\n== bats: modes-station\n'
if [[ -f "$modes/tests/station.bats" ]]; then
  (cd "$modes" && bats tests/station.bats) || fail_fast
else
  printf 'набор modes-station не найден (%s) — пропуск\n' "$modes"
fi

# Логика драйвера режимов — не bats: набор про node-модуль плагина (типы снимает bun или node ≥ 22.18).
# Стоит рядом с bats той же станции: без этого шага 32 доменные проверки не гоняет ни один гейт.
printf '\n== логика: modes-station\n'
if [[ -f "$modes/tests/logic.test.mjs" ]]; then
  if command -v bun >/dev/null 2>&1; then
    (cd "$modes" && bun tests/logic.test.mjs) || fail_fast
  elif command -v node >/dev/null 2>&1; then
    (cd "$modes" && node tests/logic.test.mjs) || fail_fast
  else
    printf 'ни bun, ни node — логика modes-station пропущена\n'
    fail_fast
  fi
  if [[ -f "$modes/tests/parity.test.mjs" ]]; then
    if command -v bun >/dev/null 2>&1; then
      (cd "$modes" && bun tests/parity.test.mjs) || fail_fast
    elif command -v node >/dev/null 2>&1; then
      (cd "$modes" && node tests/parity.test.mjs) || fail_fast
    else
      printf 'ни bun, ни node — parity modes-station пропущен\n'
      fail_fast
    fi
  fi
else
  printf 'набор логики modes-station не найден (%s) — пропуск\n' "$modes"
  fail_fast
fi

vibe="$(cd "$HUB/.." && pwd)/vibe-station"
printf '\n== bats: vibe-station\n'
if [[ -f "$vibe/tests/station.bats" ]]; then
  (cd "$vibe" && bats tests/station.bats) || fail_fast
else
  printf 'набор vibe-station не найден (%s) — пропуск\n' "$vibe"
fi

# Логика режима директора: стенд подменяет session/agent/tool API — модель в тестах не зовётся.
printf '\n== логика: vibe-station\n'
if [[ -f "$vibe/tests/logic.test.mjs" ]]; then
  if command -v bun >/dev/null 2>&1; then
    (cd "$vibe" && bun tests/logic.test.mjs) || fail_fast
  elif command -v node >/dev/null 2>&1; then
    (cd "$vibe" && node tests/logic.test.mjs) || fail_fast
  else
    printf 'ни bun, ни node — логика vibe-station пропущена\n'
    fail_fast
  fi
  if [[ -f "$vibe/tests/parity.test.mjs" ]]; then
    if command -v bun >/dev/null 2>&1; then
      (cd "$vibe" && bun tests/parity.test.mjs) || fail_fast
    elif command -v node >/dev/null 2>&1; then
      (cd "$vibe" && node tests/parity.test.mjs) || fail_fast
    else
      printf 'ни bun, ни node — parity vibe-station пропущен\n'
      fail_fast
    fi
  fi
else
  printf 'набор логики vibe-station не найден (%s) — пропуск\n' "$vibe"
  fail_fast
fi

fedora="$(cd "$HUB/.." && pwd)/fedora-windows-look"
printf '\n== bats: fedora-windows-look\n'
if [[ -f "$fedora/tests/scripts.bats" ]]; then
  (cd "$fedora" && bats tests/scripts.bats) || fail_fast
else
  printf 'набор fedora-windows-look не найден (%s) — пропуск\n' "$fedora"
fi

zenfree="$(cd "$HUB/.." && pwd)/omp-zen-free"
printf '\n== bats: omp-zen-free\n'
if [[ -f "$zenfree/tests/install.bats" ]]; then
  (cd "$zenfree" && bats tests/install.bats) || fail_fast
else
  printf 'набор omp-zen-free не найден (%s) — пропуск\n' "$zenfree"
fi

center="$(cd "$HUB/.." && pwd)/command-center"
printf '\n== bats: command-center\n'
if [[ -f "$center/tests/center.bats" ]]; then
  (cd "$center" && bats tests/center.bats) || fail_fast
else
  printf 'набор command-center не найден (%s) — пропуск\n' "$center"
fi

# набор плагинов центра: он лежит не в tests/, а рядом с самими плагинами
printf '\n== bats: command-center (плагины)\n'
if [[ -f "$center/plugin/tests/plugins.bats" ]]; then
  (cd "$center" && bats plugin/tests/plugins.bats) || fail_fast
else
  printf 'набор плагинов центра не найден (%s) — пропуск\n' "$center"
fi

cleanup="$(cd "$HUB/.." && pwd)/cleanup-station"
printf '\n== bats: cleanup-station\n'
if [[ -f "$cleanup/tests/station.bats" ]]; then
  (cd "$cleanup" && bats tests/station.bats) || fail_fast
else
  printf 'набор cleanup-station не найден (%s) — пропуск\n' "$cleanup"
fi

printf '\n== bats: cleanup-station (отчёт о мусоре)\n'
if [[ -f "$cleanup/tests/junk-report.bats" ]]; then
  (cd "$cleanup" && bats tests/junk-report.bats) || fail_fast
else
  printf 'набор cleanup-station/junk-report не найден (%s) — пропуск\n' "$cleanup"
fi

testcenter="$(cd "$HUB/.." && pwd)/test-center"
printf '\n== bats: test-center\n'
if [[ -f "$testcenter/tests/station.bats" ]]; then
  (cd "$testcenter" && bats tests/station.bats) || fail_fast
else
  printf 'набор test-center не найден (%s) — пропуск\n' "$testcenter"
fi

printf '\n== что устарело (center outdated)\n'
if [[ -x "$center/bin/center.sh" ]]; then
  outdated_json="$(cd "$center" && bin/center.sh outdated --json 2>/dev/null)"
  outdated_status=$?
  if (( outdated_status != 0 )); then
    printf 'center outdated вернул код %s — общий гейт красный\n' "$outdated_status"
    fail_fast
  fi
  if [[ -n "$outdated_json" ]]; then
    python3 - "$outdated_json" <<'PY' || fail_fast
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception:
    raise SystemExit(1)
rows = data.get("projects") or []
drift = [r for r in rows if r.get("status") == "updates"]
quiet = [r for r in rows if r.get("status") == "current"]
unknown = [r for r in rows if r.get("status") == "unknown"]
print(f"устарело: {len(drift)} · свежо: {len(quiet)} · без машинной сверки: {len(unknown)}")
for row in drift:
    print(f"  ↻ {row['name']}: {row.get('detail', '')}")
print("обновить: center update   (план: center update --dry-run all)")
PY
  else
    printf 'центр не ответил — пропуск\n'
  fi
else
  printf 'command-center не найден — пропуск\n'
fi

# Живая проверка MCP: стоят ли харнессы и отвечают ли серверы по протоколу в трёх средах. Спавнит
# настоящие серверы (часть поднимает браузер) — поэтому отдельным шагом, а не внутри doctor.
printf '\n== MCP: отвечают ли серверы (живой хендшейк)\n'
if [[ -x "$center/bin/center.sh" ]]; then
  # Таймаут ограничен: без него зависший сервер держал бы часовой прогон минутами
  # (42 рукопожатия × таймаут), а проверка идёт каждый час. Полная форма — `center verify`.
  verify_json="$(cd "$center" && timeout 180 bin/center.sh verify --json --timeout 8 2>/dev/null || true)"
  if [[ -n "$verify_json" ]]; then
    if ! python3 - "$verify_json" <<'PY'
import json, sys

try:
    data = json.loads(sys.argv[1])
except Exception:
    print("MCP: ответ центра не разобран — смотри center verify вручную")
    raise SystemExit(1)

mcp = data.get("mcp") or {}
parts, failed = [], 0
for name in ("omp", "opencode", "pi"):
    row = mcp.get(name)
    if row is None:
        parts.append(f"{name} —")
        continue
    good, bad = int(row.get("connected", 0)), int(row.get("failed", 0))
    parts.append(f"{name} {good}/{good + bad}")
    failed += bad
missing = int((data.get("summary") or {}).get("harness_missing", 0))
print("MCP: " + " · ".join(parts))
if data.get("error"):
    print(f"MCP: FAIL — {data['error']}")
elif failed or missing or not data.get("ok"):
    print(f"MCP: FAIL — серверов не ответило {failed}, харнессов нет {missing} (подробности: center verify)")
raise SystemExit(1 if (failed or missing or not data.get("ok")) else 0)
PY
    then
      fail_fast
    fi
  else
    printf 'MCP: центр не ответил — пропуск (проверить: center verify)\n'
    fail_fast
  fi
else
  printf 'command-center не найден — пропуск\n'
fi

printf '\n'
if (( status == 0 )); then
  printf 'skills-hub: проверка пройдена\n'
else
  printf 'skills-hub: ЕСТЬ ПРОБЛЕМЫ (см. выше)\n'
fi
exit "$status"
