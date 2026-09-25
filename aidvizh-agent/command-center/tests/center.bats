#!/usr/bin/env bats
# Тесты центра координации: реестр, состояние, связи, запуск проектов, активация, план установки,
# обновление (outdated/update) и версия набора.
# Центр работает по реальному дереву (он и создан, чтобы его читать), но ничего не меняет:
# активация и обновление проверяются в режиме плана, дом подменяется для проверки битых ссылок,
# а команды обновления — заглушками в подменённом реестре (CENTER_REGISTRY/CENTER_PROJECTS_ROOT).
# Запуск: bats tests/center.bats

setup() {
  CENTER="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export CENTER
  export CENTER_HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$CENTER_HOME"
  cd "$BATS_TEST_TMPDIR"
}

# Заглушки для проверок обновления: свой каталог проектов и свой реестр, команды проектов подменены
# скриптами (они пишут в журнал, а не ставят что-либо всерьёз). Живой дом при этом не трогается:
# CENTER_REGISTRY/CENTER_PROJECTS_ROOT/CENTER_HOME ведут во временный каталог теста.
stub_env() {
  STUBS="$BATS_TEST_TMPDIR/stubs"
  PROJECTS="$STUBS/projects"
  export STUB_LOG="$STUBS/log"

  mkdir -p "$PROJECTS/updater/bin" "$PROJECTS/quiet/bin" "$PROJECTS/bare" "$PROJECTS/broken/bin"
  : >"$STUB_LOG"

  # updater: умеет сверку (JSON как у mcp-station) и объявил --dry-run
  cat >"$PROJECTS/updater/bin/upd.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$STUB_LOG"
if [ "${1:-}" = "outdated" ]; then
  printf '{"ok":true,"schema":1,"summary":{"current":1,"changed":2,"missing":3}}\n'
  exit 0
fi
if [ "${2:-}" = "--dry-run" ]; then
  printf 'план: ничего не меняю\n'
  exit 0
fi
: >"$(dirname "$0")/ran"
printf 'обновил\n'
EOF

  # quiet: то же, но флага «ничего не менять» в команде нет — центр всерьёз её не позовёт в режиме плана
  cat >"$PROJECTS/quiet/bin/upd.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$STUB_LOG"
: >"$(dirname "$0")/ran"
printf 'обновил\n'
EOF

  # broken: сверка отвечает не разбором, а мусором
  cat >"$PROJECTS/broken/bin/upd.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$STUB_LOG"
printf 'не json: сверка сломана\n'
exit 3
EOF

  chmod +x "$PROJECTS"/*/bin/upd.sh

  cat >"$STUBS/registry-ok.json" <<'EOF'
{"projects":[
 {"name":"updater","what":"заглушка: сверка и обновление","update":"bin/upd.sh update","outdated":"bin/upd.sh outdated --json","outdatedUnit":"деталь"},
 {"name":"quiet","what":"заглушка: команда без флага «ничего не менять»","update":"bin/upd.sh update"},
 {"name":"bare","what":"заглушка без команды обновления","updateNote":"своей команды нет: заглушка"}
]}
EOF

  cat >"$STUBS/registry-broken.json" <<'EOF'
{"projects":[
 {"name":"broken","what":"заглушка со сломанной сверкой","outdated":"bin/upd.sh outdated --json"}
]}
EOF

  # конфиги клиентов на подменённом доме: doctor после обновления должен увидеть живые MCP-регистрации
  mkdir -p "$CENTER_HOME/.omp/agent" "$CENTER_HOME/.pi/agent" "$CENTER_HOME/.config/opencode"
  printf '{"mcpServers":{"stub":{"command":"x"}}}' >"$CENTER_HOME/.omp/agent/mcp.json"
  printf '{"mcpServers":{"stub":{"command":"x"}}}' >"$CENTER_HOME/.pi/agent/mcp.json"
  printf '{"mcp":{"stub":{"type":"local"}}}' >"$CENTER_HOME/.config/opencode/opencode.json"
}

# Центр в режиме заглушек: реестр и каталог проектов — временные, XDG не подглядывает в живой дом.
stub_center() {
  local registry="$1"
  shift
  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$registry" CENTER_PROJECTS_ROOT="$PROJECTS" node "$CENTER/bin/center.mjs" "$@"
}

# Заглушки для verify: харнессы отвечает cli-station, живые соединения — mcp-station. Обе подменены
# скриптами, поэтому набор не поднимает ни одного настоящего сервера: тест проверяет сведение отчёта,
# а не сами серверы (живой прогон — руками: center verify).
verify_env() {
  VSTUBS="$BATS_TEST_TMPDIR/vstubs"
  VPROJECTS="$VSTUBS/projects"
  export VSTUBS VPROJECTS VERIFY_LOG="$VSTUBS/verify.log"
  mkdir -p "$VPROJECTS/cli-station/bin" "$VPROJECTS/mcp-station/bin"

  cat >"$VPROJECTS/cli-station/bin/cli-station.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$VERIFY_LOG"
cat "$CLI_JSON"
EOF

  # mcp-station: отдаёт отчёт из файла, но фильтрует по --client и шумит перед JSON — как настоящая
  cat >"$VPROJECTS/mcp-station/bin/mcp-station.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$VERIFY_LOG"
client=all
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[i]}" = "--client" ] && client="${args[i + 1]}"
done
printf 'mcp-station: проверяю серверы\n'
if [ "$client" = "all" ]; then
  cat "$MCP_JSON"
else
  jq --arg client "$client" '.clients |= map(select(.client == $client))' "$MCP_JSON"
fi
EOF

  chmod +x "$VPROJECTS"/cli-station/bin/cli-station.sh "$VPROJECTS"/mcp-station/bin/mcp-station.sh
  : >"$VERIFY_LOG"

  # реестр объявляет, кто умеет живые проверки: харнессы — cli-station, соединения — mcp-station
  cat >"$VSTUBS/registry.json" <<'EOF'
{"projects":[
 {"name":"cli-station","what":"заглушка: список харнессов","run":"bin/cli-station.sh","harnessStatus":"status --json"},
 {"name":"mcp-station","what":"заглушка: живые соединения","run":"bin/mcp-station.sh","mcpVerify":"verify --json"}
]}
EOF

  cat >"$VSTUBS/cli-all.json" <<'EOF'
[{"name":"omp","installed":true,"path":"/x/omp","version":"omp/1.0","code":0},
 {"name":"opencode","installed":true,"path":"/x/opencode2","version":"opencode v1","code":0},
 {"name":"pi","installed":true,"path":"/x/pi","version":"0.9","code":0}]
EOF
  cat >"$VSTUBS/cli-pi-missing.json" <<'EOF'
[{"name":"omp","installed":true,"path":"/x/omp","version":"omp/1.0","code":0},
 {"name":"opencode","installed":true,"path":"/x/opencode2","version":"opencode v1","code":0},
 {"name":"pi","installed":false,"path":"","version":"","code":1}]
EOF

  # три среды: omp 2/2, pi 1/1, opencode 2/2 — как отдаёт mcp-station verify --json
  cat >"$VSTUBS/mcp-ok.json" <<'EOF'
{"ok":true,"schema":1,"timeout":20,"clients":[
 {"client":"omp","label":"omp/pi","file":"/x/home/.omp/agent/mcp.json","installed":["wiki","basic-memory"],
  "servers":[{"name":"wiki","state":"connected","ms":171,"tools":10,"server":"wiki-station 2.0","error":""},
             {"name":"basic-memory","state":"connected","ms":3507,"tools":21,"server":"Basic Memory","error":""}]},
 {"client":"pi","label":"omp/pi","file":"/x/home/.pi/agent/mcp.json","installed":["wiki"],
  "servers":[{"name":"wiki","state":"connected","ms":210,"tools":10,"server":"wiki-station 2.0","error":""}]},
 {"client":"opencode","label":"opencode","file":"/x/home/.config/opencode/opencode.json","installed":["wiki","playwright"],
  "servers":[{"name":"wiki","state":"connected","ms":190,"tools":10,"server":"wiki-station 2.0","error":""},
             {"name":"playwright","state":"connected","ms":1400,"tools":24,"server":"playwright-mcp","error":""}]}],
 "summary":{"total":5,"connected":5,"failed":0}}
EOF
  # то же, но тяжёлый playwright у opencode не ответил: состояние timeout и причина в error
  cat >"$VSTUBS/mcp-timeout.json" <<'EOF'
{"ok":false,"schema":1,"timeout":20,"clients":[
 {"client":"omp","label":"omp/pi","file":"/x/home/.omp/agent/mcp.json","installed":["wiki","basic-memory"],
  "servers":[{"name":"wiki","state":"connected","ms":171,"tools":10,"server":"wiki-station 2.0","error":""},
             {"name":"basic-memory","state":"connected","ms":3507,"tools":21,"server":"Basic Memory","error":""}]},
 {"client":"pi","label":"omp/pi","file":"/x/home/.pi/agent/mcp.json","installed":["wiki"],
  "servers":[{"name":"wiki","state":"connected","ms":210,"tools":10,"server":"wiki-station 2.0","error":""}]},
 {"client":"opencode","label":"opencode","file":"/x/home/.config/opencode/opencode.json","installed":["wiki","playwright"],
  "servers":[{"name":"wiki","state":"connected","ms":190,"tools":10,"server":"wiki-station 2.0","error":""},
             {"name":"playwright","state":"timeout","ms":20000,"tools":0,"server":"","error":"нет ответа на initialize"}]}],
 "summary":{"total":5,"connected":4,"failed":1}}
EOF
  # чужая запись покупателя (ours:false) упала, наши все живы — центр не валит проверку дома
  cat >"$VSTUBS/mcp-foreign.json" <<'EOF'
{"ok":true,"schema":1,"timeout":20,"owners":"state","clients":[
 {"client":"omp","label":"omp/pi","file":"/x/home/.omp/agent/mcp.json","installed":["wiki","basic-memory"],
  "servers":[{"name":"wiki","state":"connected","ms":171,"tools":10,"server":"wiki-station 2.0","error":"","ours":true},
             {"name":"basic-memory","state":"connected","ms":3507,"tools":21,"server":"Basic Memory","error":"","ours":true}]},
 {"client":"pi","label":"omp/pi","file":"/x/home/.pi/agent/mcp.json","installed":["wiki"],
  "servers":[{"name":"wiki","state":"connected","ms":210,"tools":10,"server":"wiki-station 2.0","error":"","ours":true}]},
 {"client":"opencode","label":"opencode","file":"/x/home/.config/opencode/opencode.json","installed":["wiki","playwright"],
  "servers":[{"name":"wiki","state":"connected","ms":190,"tools":10,"server":"wiki-station 2.0","error":"","ours":true},
             {"name":"playwright","state":"timeout","ms":20000,"tools":0,"server":"","error":"нет ответа на initialize","ours":false}]}],
 "summary":{"total":5,"connected":4,"failed":1,"failed_ours":0,"foreign_failed":1},
 "foreign_failures":[{"client":"opencode","name":"playwright","state":"timeout","ms":20000,"error":"нет ответа на initialize"}]}
EOF
  # наша запись тоже упала: провал один наш, один чужой — код 1, но чужие всё равно отдельно
  cat >"$VSTUBS/mcp-mixed.json" <<'EOF'
{"ok":false,"schema":1,"timeout":20,"owners":"state","clients":[
 {"client":"omp","label":"omp/pi","file":"/x/home/.omp/agent/mcp.json","installed":["wiki","basic-memory"],
  "servers":[{"name":"wiki","state":"connected","ms":171,"tools":10,"server":"wiki-station 2.0","error":"","ours":true},
             {"name":"basic-memory","state":"connected","ms":3507,"tools":21,"server":"Basic Memory","error":"","ours":true}]},
 {"client":"pi","label":"omp/pi","file":"/x/home/.pi/agent/mcp.json","installed":["wiki"],
  "servers":[{"name":"wiki","state":"connected","ms":210,"tools":10,"server":"wiki-station 2.0","error":"","ours":true}]},
 {"client":"opencode","label":"opencode","file":"/x/home/.config/opencode/opencode.json","installed":["wiki","playwright"],
  "servers":[{"name":"wiki","state":"timeout","ms":20000,"tools":0,"server":"","error":"нет ответа на initialize","ours":true},
             {"name":"playwright","state":"spawn-failed","ms":2,"tools":0,"server":"","error":"не удалось запустить my-own-playwright: ENOENT","ours":false}]}],
 "summary":{"total":5,"connected":3,"failed":2,"failed_ours":1,"foreign_failed":1},
 "foreign_failures":[{"client":"opencode","name":"playwright","state":"spawn-failed","ms":2,"error":"не удалось запустить my-own-playwright: ENOENT"}]}
EOF
}

# Какой сценарий отдают заглушки: что стоит у харнессов и что отвечают серверы.
verify_fixture() {
  case "$1" in
    ok) export CLI_JSON="$VSTUBS/cli-all.json" MCP_JSON="$VSTUBS/mcp-ok.json" ;;
    timeout) export CLI_JSON="$VSTUBS/cli-all.json" MCP_JSON="$VSTUBS/mcp-timeout.json" ;;
    foreign) export CLI_JSON="$VSTUBS/cli-all.json" MCP_JSON="$VSTUBS/mcp-foreign.json" ;;
    mixed) export CLI_JSON="$VSTUBS/cli-all.json" MCP_JSON="$VSTUBS/mcp-mixed.json" ;;
    harness-missing) export CLI_JSON="$VSTUBS/cli-pi-missing.json" MCP_JSON="$VSTUBS/mcp-ok.json" ;;
  esac
  : >"$VERIFY_LOG"
}

# Центр в режиме заглушек verify: свой реестр (в нём объявлены harnessStatus/mcpVerify) и свой каталог.
vcenter() {
  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$VSTUBS/registry.json" CENTER_PROJECTS_ROOT="$VPROJECTS" node "$CENTER/bin/center.mjs" "$@"
}

@test "реестр описывает все проекты и их точки входа" {
  run node -e '
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[1];
const data = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const problems = [];
for (const project of data.projects) {
  const dir = join(root, "..", project.name);
  const exists = existsSync(dir);
  // необязательные проекты (данные машины, напр. _dump) в архиве отсутствуют by design
  if (!exists && project.optional) continue;
  if (!exists) problems.push(`${project.name}: нет каталога`);
  if (exists && project.run && !existsSync(join(dir, project.run))) problems.push(`${project.name}: нет ${project.run}`);
  if (exists && project.tests && !existsSync(join(dir, project.tests))) problems.push(`${project.name}: нет ${project.tests}`);
  if (!project.what) problems.push(`${project.name}: нет описания`);
}
const copyable = ["skills-hub", "modes-station", "vibe-station", "prompt-station", "sysprompt", "omp-zen-free"];
for (const name of copyable) {
  const project = data.projects.find((item) => item.name === name);
  if (!project || !project.expectLinks || project.expectLinks.some((link) => link.allowCopy !== true)) {
    problems.push(`${name}: копии должны быть разрешены в expectLinks`);
  }
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`проектов в реестре: ${data.projects.length}`);
' "$CENTER"
  [ "$status" -eq 0 ]
  # число проектов берём из самого реестра: новый проект не ломает тест
  expected="$(jq '.projects | length' "$CENTER/registry.json")"
  [[ "$output" == *"проектов в реестре: $expected"* ]]
}

@test "status показывает состояние всех проектов" {
  run node "$CENTER/bin/center.mjs" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills-hub"* ]]
  [[ "$output" == *"fedora-windows-look"* ]]
  [[ "$output" == *"cleanup-station"* ]]
  # проект с ожиданиями: строка показывает живые ссылки и у скольких клиентов заведён его MCP
  [[ "$output" == *"camoufox-research"*"ссылки "*"/4, mcp "*"/3"* ]]
  [[ "$output" == *"проблемных: 0"* ]]
}

@test "status --json отдаёт машинный вид" {
  run node "$CENTER/bin/center.mjs" status --json
  [ "$status" -eq 0 ]
  expected="$(jq '.projects | length' "$CENTER/registry.json")"
  run bash -c 'printf "%s" "$1" | jq -e "length == $2 and all(.[]; .exists or .optional)"' _ "$output" "$expected"
  [ "$output" = "true" ]
}

@test "doctor проверяет связи и MCP-регистрации (реальный дом)" {
  run env -u CENTER_HOME node "$CENTER/bin/center.mjs" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills-ops"* ]]
  [[ "$output" == *"mcp.json: серверов"* ]]
  [[ "$output" == *"MCP-ожидания реестра"* ]]
  [[ "$output" == *"camoufox (camoufox-research)"* ]]
  [[ "$output" == *"doctor: связи в порядке"* ]]
}

@test "doctor называет клиентов, у которых заведён MCP проекта из реестра" {
  # expectMcp проверяется на подменённом доме: кто из трёх клиентов сервер завёл, кто нет
  mkdir -p "$CENTER_HOME/.omp/agent" "$CENTER_HOME/.pi/agent" "$CENTER_HOME/.config/opencode"
  printf '{"mcpServers":{"camoufox":{"command":"x"}}}' >"$CENTER_HOME/.omp/agent/mcp.json"
  printf '{"mcpServers":{"другой":{"command":"x"}}}' >"$CENTER_HOME/.pi/agent/mcp.json"
  printf '{"mcp":{"camoufox":{"type":"local"}}}' >"$CENTER_HOME/.config/opencode/opencode.json"

  run env -u XDG_CONFIG_HOME node "$CENTER/bin/center.mjs" doctor
  [[ "$output" == *"camoufox (camoufox-research): есть у omp, opencode; нет у pi"* ]]
  # это справка, а не приговор: строку ожидания doctor не помечает FAIL (регистрирует mcp-station)
  ! printf '%s\n' "$output" | grep -q '^FAIL.*camoufox'

  # сервер не завёл никто — doctor говорит об этом прямо
  printf '{"mcpServers":{"другой":{"command":"x"}}}' >"$CENTER_HOME/.omp/agent/mcp.json"
  printf '{"mcp":{"другой":{"type":"local"}}}' >"$CENTER_HOME/.config/opencode/opencode.json"
  run env -u XDG_CONFIG_HOME node "$CENTER/bin/center.mjs" doctor
  [[ "$output" == *"camoufox (camoufox-research): есть у никого; нет у omp, pi, opencode"* ]]
}

@test "doctor ругается, когда ссылок нет (пустой дом)" {
  run node "$CENTER/bin/center.mjs" doctor
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"doctor: проблем"* ]]
}

@test "doctor: ссылка, которую ставит другой установщик, — справка, а не поломка" {
  # Реестр помечает camoufox-ссылки отдельными: их кладёт свой установщик, шага fresh нет.
  # Без свежей установки Fresh возвращал бы код 1 при 17/17 зелёных шагах — отказ без диагноза.
  local home="$BATS_TEST_TMPDIR/separate-home"
  mkdir -p "$home"
  run env -u XDG_CONFIG_HOME CENTER_HOME="$home" node "$CENTER/bin/center.mjs" doctor
  [[ "$output" == *"—    $home/.agents/skills/camoufox-research-rails"* ]]
  [[ "$output" == *"нет: "* ]]
  ! printf '%s\n' "$output" | grep -q '^FAIL.*camoufox-research-rails'

  # но запись, которая ЛЕЖИТ битой, — уже поломка: «не ставили» и «сломали» различать обязаны
  mkdir -p "$home/.agents/skills"
  ln -s /nonexistent-target "$home/.agents/skills/camoufox-research-rails"
  run env -u XDG_CONFIG_HOME CENTER_HOME="$home" node "$CENTER/bin/center.mjs" doctor
  [ "$status" -eq 1 ]
  printf '%s\n' "$output" | grep -q '^FAIL.*camoufox-research-rails'
}

@test "links показывает карту связей и цепочку активации" {
  run node "$CENTER/bin/center.mjs" links
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills-manager"* ]]
  [[ "$output" == *"personas"* ]]
  [[ "$output" == *"цепочка активации"* ]]
}

@test "run зовёт проект его же командой" {
  run node "$CENTER/bin/center.mjs" run skills-hub sources
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills-sh"* ]]
  [[ "$output" == *"skillsmp"* ]]

  run node "$CENTER/bin/center.mjs" run нетакого
  [ "$status" -eq 1 ]
  [[ "$output" == *"в реестре нет"* ]]
}

@test "activate --dry-run только показывает план" {
  run node "$CENTER/bin/center.mjs" activate --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"install all --dry-run"* ]]
  [[ "$output" == *"install-ext --dry-run"* ]]
  [[ "$output" == *"dry-run: ничего не запущено"* ]]
  [[ "$output" == *"dry-run не умеет"* ]]   # sysprompt: показываем без флага
}

@test "prereqs проверяет предпосылки и подсказывает, чем ставить" {
  # узкий PATH: node на месте, остальных нет — проверяем подсказки, а не машину разработчика
  local bin="$BATS_TEST_TMPDIR/bin9"
  mkdir -p "$bin"
  ln -sf "$(command -v sh)" "$bin/sh"
  ln -sf "$(command -v node)" "$bin/node"

  run env PATH="$bin" node "$CENTER/bin/center.mjs" prereqs
  [ "$status" -eq 1 ]
  [[ "$output" == *"node"* ]]
  [[ "$output" == *"bats"* ]]
  [[ "$output" == *"поставить:"* ]]
  [[ "$output" == *"не хватает:"* ]]

  # pwsh — обёртки под Windows: справочная строка, а не требование (баг чистой установки на linux)
  [[ "$output" == *"pwsh"* ]]
  [[ "$output" != *"НЕТ  pwsh"* ]]

  # когда всё на месте — честное «предпосылки на месте»
  run node "$CENTER/bin/center.mjs" prereqs
  if [ "$status" -eq 0 ]; then
    [[ "$output" == *"предпосылки на месте"* ]]
  else
    [[ "$output" == *"не хватает:"* ]]
  fi
}

@test "docs: индекс, тема целиком, путь для машин и ошибка на незнакомое" {
  run node "$CENTER/bin/center.mjs" docs
  [ "$status" -eq 0 ]
  [[ "$output" == *"00-map"* ]]
  [[ "$output" == *"08-troubleshooting"* ]]

  run node "$CENTER/bin/center.mjs" docs 02-cleanup
  [ "$status" -eq 0 ]
  [[ "$output" == *"clean-all"* ]]

  run node "$CENTER/bin/center.mjs" docs --json 05-mcp
  [ "$status" -eq 0 ]
  [ -f "$output" ]

  run node "$CENTER/bin/center.mjs" docs нетакой
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет темы"* ]]
}

@test "bootstrap перечисляет полный план установки с нуля" {
  run node "$CENTER/bin/center.mjs" bootstrap
  [ "$status" -eq 0 ]
  [[ "$output" == *"0. prereqs"* ]]
  # команда center ставится вторым шагом: без неё остальные шаги плана вызываются от файла
  [[ "$output" == *"1. command-center"* ]]
  [[ "$output" == *"command-center/contrib/install-links.sh"* ]]
  [[ "$output" == *"bash skills-hub/contrib/install-links.sh"* ]]
  [[ "$output" == *"center run cli-station install"* ]]
  [[ "$output" == *"mcp-station/bin/keys.sh import"* ]]
  [[ "$output" == *"center run prompt-station flash duck"* ]]
  [[ "$output" == *"install-units.sh"* ]]
  # сторож и бэкап набора — часть установки, а не то, что вспомнят потом.
  # Номера шагов не сверяем: план дополняют (memory, wiki уже встали), и жёсткий номер
  # ломается чужой вставкой. Держимся на содержании — это то, что реально важно.
  [[ "$output" == *"command-center/contrib/install-units.sh"* ]]
  [[ "$output" == *"center-sentinel.timer"* ]]
  [[ "$output" == *"команда: center check"* ]]
  [[ "$output" == *"остаётся руками"* ]]
  [[ "$output" == *"cleanup-station clean-all"* ]]
  [[ "$output" == *"agent-bundle/harness"* ]]
}

@test "план установки: MCP-списки берутся из каталога, а отладочные записи — в пропуске fresh" {
  local catalog="$CENTER/../mcp-station/catalog"
  run node "$CENTER/bin/center.mjs" bootstrap
  [ "$status" -eq 0 ]
  # станция реестра, которая без шага плана не попала бы на чистую машину
  [[ "$output" == *"modes-station"* ]]
  [[ "$output" == *"center run modes-station install"* ]]
  # число core-записей в плане — из каталога (было «8 штук» при пятнадцати записях)
  local n
  n="$(jq -r 'select(.tier == "core") | .name' "$catalog"/*.json | wc -l | tr -d ' ')"
  [[ "$output" == *"tier=core, записей: $n"* ]]

  # список пропуска в проверке fresh покрывает все записи каталога, у которых рантайм собирается
  # отдельно (подсказка debug-setup.sh в argv): новая такая запись без строки в DEBUG_SERVERS —
  # это упавший тест, а не тихая дыра в проверке
  local in_const name f
  in_const="$(sed -n 's/^const DEBUG_SERVERS = "\(.*\)";$/\1/p' "$CENTER/bin/center.mjs")"
  [ -n "$in_const" ]
  for f in "$catalog"/*.json; do
    jq -r '(.argv // []) | join(" ")' "$f" | grep -q "debug-setup\.sh" || continue
    name="$(jq -r .name "$f")"
    [[ ",$in_const," == *",$name,"* ]] || { echo "DEBUG_SERVERS не покрывает $name"; return 1; }
  done
  # и обратно: каждое имя из списка существует в каталоге
  for name in ${in_const//,/ }; do
    jq -s -e --arg n "$name" 'any(.[]; .name == $n)' "$catalog"/*.json >/dev/null || { echo "DEBUG_SERVERS: в каталоге нет $name"; return 1; }
  done

  run node "$CENTER/bin/center.mjs" fresh
  [ "$status" -eq 0 ]
  [[ "$output" == *"debug-setup.sh"* ]]
  [[ "$output" == *"tier=core, записей: $n"* ]]
}

@test "fresh без --yes показывает план сноса и установки, ничего не делая" {
  run node "$CENTER/bin/center.mjs" fresh
  [ "$status" -eq 0 ]
  [[ "$output" == *"0. снос: cleanup-station clean-all --yes"* ]]
  [[ "$output" == *"агенты"* ]]
  [[ "$output" == *"персона duck"* ]]
  [[ "$output" == *"сторож и бэкап набора"* ]]
  [[ "$output" == *"center fresh --yes"* ]]
  [[ "$output" == *"осталось руками" || "$output" == *"дальше вручную"* ]]

  run node "$CENTER/bin/center.mjs" fresh --deep
  [[ "$output" == *"(снос с состоянием и логинами)"* ]]
}

@test "fresh --no-cleanup: заселение рядом, шага сноса в плане нет" {
  run node "$CENTER/bin/center.mjs" fresh --no-cleanup
  [ "$status" -eq 0 ]
  [[ "$output" == *"(без сноса: ставлю рядом)"* ]]
  [[ "$output" != *"0. снос"* ]]
  [[ "$output" == *"агенты"* ]]
  [[ "$output" == *"center fresh --yes --no-cleanup"* ]]
}

@test "в центре нет абсолютных путей" {
  local checker="$CENTER/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$CENTER"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "windows: PowerShell-обёртка работает и -WhatIf не запускает активацию" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  run pwsh -NoProfile -File "$CENTER/bin/center.ps1" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills-hub"* ]]

  run pwsh -NoProfile -File "$CENTER/bin/center.ps1" activate -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run: ничего не запущено"* ]]
}

@test "реестр объявляет команду обновления и её файл на месте" {
  run node -e '
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[1];
const data = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const problems = [];
for (const project of data.projects) {
  const dir = join(root, "..", project.name);
  // у каждого проекта либо своя команда обновления, либо честная причина, почему её нет
  if (!project.update && !project.updateNote) problems.push(`${project.name}: ни update, ни updateNote`);
  if (!project.update) continue;
  if (project.update.startsWith("/")) problems.push(`${project.name}: абсолютный путь в update`);
  const file = join(dir, project.update.split(" ")[0]);
  if (!existsSync(file)) problems.push(`${project.name}: нет ${project.update.split(" ")[0]}`);
}
const station = data.projects.find((project) => project.name === "mcp-station");
if (station.update !== "bin/mcp-station.sh update") problems.push(`mcp-station: update = ${station.update}`);
if (station.outdated !== "bin/mcp-station.sh outdated --json") problems.push(`mcp-station: outdated = ${station.outdated}`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
const withUpdate = data.projects.filter((project) => project.update).length;
console.log(`проектов с командой обновления: ${withUpdate}`);
' "$CENTER"
  [ "$status" -eq 0 ]
  # Число считаем от реестра, а не хардкодом: появление нового проекта (например spec-station)
  # не должно красить тест — проверяем согласованность данных, а не конкретную цифру.
  expected="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len([p for p in d["projects"] if p.get("update")]))' "$CENTER/registry.json")"
  [[ "$output" == *"проектов с командой обновления: $expected"* ]]
}

@test "outdated сводит объявленные сверки проектов" {
  stub_env
  stub_center "$STUBS/registry-ok.json" outdated --json
  [ "$status" -eq 0 ]
  local json="$output"

  run bash -c 'printf "%s" "$1" | jq -r "[.ok, (.projects[] | select(.name==\"updater\") | .status), (.projects[] | select(.name==\"updater\") | .detail), (.projects[] | select(.name==\"updater\") | .update)] | join(\"|\")"' _ "$json"
  [ "$output" = 'true|updates|2 деталь changed, 3 missing|bin/upd.sh update' ]

  # проект без команды обновления: центр не падает, а говорит строку причины
  run bash -c 'printf "%s" "$1" | jq -r ".projects[] | select(.name==\"bare\") | .status + \" \" + .detail"' _ "$json"
  [ "$output" = "unknown своей команды нет: заглушка" ]

  stub_center "$STUBS/registry-ok.json" outdated
  [ "$status" -eq 0 ]
  [[ "$output" == *"updater"*"обновить"*"2 деталь changed, 3 missing"* ]]
  [[ "$output" == *"bare"*"не обновляется"* ]]
  [[ "$output" == *"итог: обновить 1"* ]]
}

@test "outdated честно помечает сломанную сверку (ok:false, код 1)" {
  stub_env
  stub_center "$STUBS/registry-broken.json" outdated --json
  [ "$status" -eq 1 ]
  [[ "$output" == *'"ok": false'* ]]
  [[ "$output" == *"сверка не разобрана"* ]]
}

@test "update --dry-run зовёт объявленное и ничего не меняет" {
  stub_env
  stub_center "$STUBS/registry-ok.json" update --dry-run all
  [ "$status" -eq 0 ]
  [[ "$output" == *"звал 1 из 3"* ]]
  [[ "$output" == *"quiet"*"в плане только показана"* ]]
  [[ "$output" == *"ничего не запущено всерьёз"* ]]

  # позван ровно тот, кто объявил флаг, и ровно с ним
  [ "$(cat "$STUB_LOG")" = "update --dry-run" ]
  [ ! -e "$PROJECTS/updater/bin/ran" ]
  [ ! -e "$PROJECTS/quiet/bin/ran" ]
}

@test "update зовёт команды из реестра и перепроверяет связи тем же doctor" {
  stub_env
  stub_center "$STUBS/registry-ok.json" update all
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_LOG")" = "$(printf 'update\nupdate')" ]
  [ -e "$PROJECTS/updater/bin/ran" ]
  [ -e "$PROJECTS/quiet/bin/ran" ]
  [[ "$output" == *"звал 2 из 3, нечем обновлять 1"* ]]
  [[ "$output" == *"связи после обновления"* ]]
  [[ "$output" == *"doctor: связи в порядке"* ]]

  stub_center "$STUBS/registry-ok.json" update --json all
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -r "[.ok, (.projects | length), (.projects[] | select(.name==\"bare\") | .status), .doctor] | join(\"|\")"' _ "$output"
  [ "$output" = "true|3|no-command|0" ]
}

@test "update: проект без команды обновления не падает, а докладывает; чужое имя — ошибка" {
  stub_env
  stub_center "$STUBS/registry-ok.json" update bare
  [ "$status" -eq 0 ]
  [[ "$output" == *"bare"*"no-command"*"своей команды нет: заглушка"* ]]
  [ ! -s "$STUB_LOG" ]

  stub_center "$STUBS/registry-ok.json" update нетакого
  [ "$status" -eq 1 ]
  [[ "$output" == *"в реестре нет"* ]]
}

@test "status помечает дрейф, не ломая машинный вид" {
  stub_env
  stub_center "$STUBS/registry-ok.json" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"↻ обновить (2 деталь changed, 3 missing)"* ]]

  stub_center "$STUBS/registry-ok.json" status --json
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -r "[(.[] | select(.name==\"updater\") | .update.status), (.[] | select(.name==\"bare\") | .update.label)] | join(\"|\")"' _ "$output"
  [ "$output" = "updates|не обновляется" ]
}

@test "status использует registry path для runtime-записи" {
  local root="$BATS_TEST_TMPDIR/runtime-project"
  mkdir -p "$root/projects"
  cat >"$root/registry.json" <<'EOF'
{"projects":[{"name":"runtime","path":"~/.local/state/command-center/dump","optional":true}]}
EOF
  mkdir -p "$CENTER_HOME/.local/state/command-center/dump"
  run env CENTER_HOME="$CENTER_HOME" CENTER_REGISTRY="$root/registry.json" CENTER_PROJECTS_ROOT="$root/projects" \
    node "$CENTER/bin/center.mjs" status --json
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -e ".[] | select(.name == \"runtime\") | .exists == true"' _ "$output"
  [ "$output" = "true" ]
}
@test "version показывает, из чего складывается версия набора, и ритуал релиза" {
  run node "$CENTER/bin/center.mjs" version
  [ "$status" -eq 0 ]
  local declared
  declared="$(cat "$CENTER/../VERSION")"
  [[ "$output" == *"версия набора: $declared"* ]]
  [[ "$output" == *"источник: "*"VERSION"* ]]
  [[ "$output" == *"правило бампа"* ]]
  [[ "$output" == *"ритуал релиза"* ]]
  [[ "$output" == *"center update"* && "$output" == *"center check"* ]]
  [[ "$output" == *"автоинкремента нет"* ]]

  run node "$CENTER/bin/center.mjs" version --json
  [ "$status" -eq 0 ]
  local version_json="$output"
  run bash -c 'printf "%s" "$1" | jq -r "[.version, (.source | endswith(\"/VERSION\")), (.root.commit != null), (.projects | length > 0), (.ritual | length)] | join(\"|\")"' _ "$version_json"
  [ "$output" = "$declared|true|true|true|4" ]
  run bash -c 'jq -e "[.projects[] | select(.name == \"cli-station\") | .commit] == [null]" <<<"$1"' _ "$version_json"
  [ "$status" -eq 0 ]

  # ритуал описан и в доках, которые печатает сам центр
  run node "$CENTER/bin/center.mjs" docs 09-release
  [ "$status" -eq 0 ]
  [[ "$output" == *"ритуал"* ]]
  [[ "$output" == *"VERSION"* ]]
}
@test "expectLinks: ссылка каталогом, ссылка внутри и копия — все три формы понятны" {
  # Багрепорт 5.1.0 (Fedora 44): установщик ставит ссылку КАТАЛОГОМ
  # (~/.agents/skills/скилл -> коллекция скиллов), а реестр ждал путь .../SKILL.md.
  # Проверка делала один lstat и на живой рабочей ссылке падала. Теперь смотрим первый
  # симлинк в пути, принимаем обоих хозяев (исходник и коллекцию) и копию без ссылки.
  PROJECTS_ROOT="$BATS_TEST_TMPDIR/projects"
  mkdir -p "$PROJECTS_ROOT/skills-station/collection/демо" "$PROJECTS_ROOT/скилл-проект/scripts" \
           "$CENTER_HOME/.agents/skills" "$PROJECTS_ROOT/чужой"
  echo "скилл" >"$PROJECTS_ROOT/skills-station/collection/демо/SKILL.md"
  echo "исходник" >"$PROJECTS_ROOT/скилл-проект/src.md"
  touch "$PROJECTS_ROOT/скилл-проект/scripts/install.sh"
  # A: ссылка каталогом на коллекцию (так ставит архив)
  ln -s "$PROJECTS_ROOT/skills-station/collection/демо" "$CENTER_HOME/.agents/skills/скилл-из-коллекции"
  # B: каталог настоящий, ссылка внутри — на исходник (так подключено на машине разработки)
  mkdir -p "$CENTER_HOME/.agents/skills/скилл-из-исходника"
  ln -s "$PROJECTS_ROOT/скилл-проект/src.md" "$CENTER_HOME/.agents/skills/скилл-из-исходника/SKILL.md"
  # C: копия без ссылки — рабочее состояние, проблемой не считаем
  mkdir -p "$CENTER_HOME/.agents/skills/скилл-копия"
  echo "скилл" >"$CENTER_HOME/.agents/skills/скилл-копия/SKILL.md"
  # D: ссылка в чужой проект — обязана падать
  mkdir -p "$CENTER_HOME/.agents/skills/скилл-чужой"
  ln -s "$PROJECTS_ROOT/чужой" "$CENTER_HOME/.agents/skills/скилл-чужой/ссылка"
  cat >"$BATS_TEST_TMPDIR/registry.json" <<EOF
{"projects":[{"name":"скилл-проект","kind":"проект","what":"демо","run":"scripts/install.sh","tests":"scripts/install.sh",
 "expectLinks":[
  {"link":"\$HOME/.agents/skills/скилл-из-коллекции","into":["skills-station","скилл-проект"],"allowCopy":true},
  {"link":"\$HOME/.agents/skills/скилл-из-исходника","into":["skills-station","скилл-проект"],"allowCopy":true},
  {"link":"\$HOME/.agents/skills/скилл-копия","into":["skills-station","скилл-проект"],"allowCopy":true},
  {"link":"\$HOME/.agents/skills/скилл-чужой","into":["skills-station","скилл-проект"]}]}]}
EOF
  run env CENTER_HOME="$CENTER_HOME" CENTER_REGISTRY="$BATS_TEST_TMPDIR/registry.json" \
          CENTER_PROJECTS_ROOT="$PROJECTS_ROOT" bash "$CENTER/bin/center.sh" doctor
  [ "$status" -eq 1 ]
  [[ "$output" == *"ок"* || "$output" == *"ok "*"скилл-из-коллекции"* ]]
  [[ "$output" == *"скилл-из-исходника"*"→ skills-station|скилл-проект"* ]]
  [[ "$output" == *"скилл-копия"*"(копия, не ссылка)"* ]]
  [[ "$output" == *"FAIL"*"скилл-чужой"* ]]
}

@test "expectLinks: симлинк уровня системы над домом — не признак ссылки скилла" {
  # macOS: BATS_TEST_TMPDIR лежит под /var → /var -> /private/var, и цепочка
  # до корня ловила этот уровень: копия ошибочно считалась ссылкой. Системный
  # симлинк над домом не решает, ссылкой стоит скилл или копией. Ловушка
  # собирается и на Linux: дом ведём через свой симлинк.
  local sysroot="$BATS_TEST_TMPDIR/sysreal"
  local syslink="$BATS_TEST_TMPDIR/syslink"
  local trap_home="$syslink/home"
  mkdir -p "$sysroot/home/.agents/skills/скилл-копия"
  echo "скилл" >"$sysroot/home/.agents/skills/скилл-копия/SKILL.md"
  ln -sfn "$sysroot" "$syslink"
  PROJECTS_ROOT="$BATS_TEST_TMPDIR/projects"
  mkdir -p "$PROJECTS_ROOT/скилл-проект/scripts"
  # конфиги клиентов на подменённом доме: doctor не должен краснеть из-за них
  mkdir -p "$trap_home/.omp/agent" "$trap_home/.pi/agent" "$trap_home/.config/opencode"
  printf '{"mcpServers":{"stub":{"command":"x"}}}' >"$trap_home/.omp/agent/mcp.json"
  printf '{"mcpServers":{"stub":{"command":"x"}}}' >"$trap_home/.pi/agent/mcp.json"
  printf '{"mcp":{"stub":{"type":"local"}}}' >"$trap_home/.config/opencode/opencode.json"
  touch "$PROJECTS_ROOT/скилл-проект/scripts/install.sh"
  # дом в реестре подставляем после сборки: так $HOME в heredoc не мешает
  cat >"$BATS_TEST_TMPDIR/registry.json" <<REG_EOF
{"projects":[{"name":"скилл-проект","kind":"проект","what":"демо","run":"scripts/install.sh",
 "expectLinks":[
  {"link":"TRAP_HOME/.agents/skills/скилл-копия","into":["скилл-проект"],"allowCopy":true}]}]}
REG_EOF
  # BSD sed требует суффикс у -i: пишем во временный .bak и убираем его
  sed -i.bak "s#TRAP_HOME#$trap_home#" "$BATS_TEST_TMPDIR/registry.json"
  rm -f "$BATS_TEST_TMPDIR/registry.json.bak"
  run env CENTER_HOME="$trap_home" CENTER_REGISTRY="$BATS_TEST_TMPDIR/registry.json" \
          CENTER_PROJECTS_ROOT="$PROJECTS_ROOT" bash "$CENTER/bin/center.sh" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"скилл-копия"*"(копия, не ссылка)"* ]]
}


@test "реестр объявляет живые проверки: харнессы и соединения" {
  # реестр — источник правды: центр не знает сам, кто умеет проверять, он ищет объявившего поле
  run node -e '
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[1];
const data = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const problems = [];
for (const [name, field] of [["cli-station", "harnessStatus"], ["mcp-station", "mcpVerify"]]) {
  const project = data.projects.find((item) => item.name === name);
  if (!project) { problems.push(`нет проекта ${name}`); continue; }
  if (!project[field]) problems.push(`${name}: нет поля ${field}`);
  if (!existsSync(join(root, "..", name, project.run))) problems.push(`${name}: нет ${project.run}`);
  const declared = data.projects.filter((item) => item[field]).map((item) => item.name);
  if (declared.length !== 1) problems.push(`${field} объявляют ${declared.length} проекта: ${declared.join(", ")}`);
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("живые проверки объявлены: harnessStatus у cli-station, mcpVerify у mcp-station");
' "$CENTER"
  [ "$status" -eq 0 ]
  [[ "$output" == *"harnessStatus у cli-station"* ]]
}

@test "verify: все серверы отвечают — код 0 и строка на клиента" {
  verify_env
  verify_fixture ok
  vcenter verify
  [ "$status" -eq 0 ]
  # харнессы — из cli-station, соединения — из mcp-station: обе подменённые команды позваны
  [[ "$(cat "$VERIFY_LOG")" == *"status --json"* ]]
  [[ "$(cat "$VERIFY_LOG")" == *"verify --json --timeout 20 --client all"* ]]
  [[ "$output" == *"харнессы: omp (omp/1.0) · opencode (opencode v1) · pi (0.9)"* ]]
  [[ "$output" == *"omp"*"connected 2/2"* ]]
  [[ "$output" == *"pi"*"connected 1/1"* ]]
  [[ "$output" == *"opencode"*"connected 2/2"* ]]
  [[ "$output" == *"итог: серверов 5, connected 5, провалов 0, харнессов не хватает 0"* ]]
  [[ "$output" != *"провалы:"* ]]
}

@test "verify --json отдаёт отчёт по контракту (всё connected)" {
  verify_env
  verify_fixture ok
  vcenter verify --json
  [ "$status" -eq 0 ]
  local json="$output"
  # контракт: ok, harness[] (name/installed/version), mcp{клиент:{connected,failed}}, summary
  run bash -c 'printf "%s" "$1" | jq -r "[(.ok|tostring), (.harness|length|tostring),
    ([.harness[] | .name + \":\" + (.installed|tostring)] | join(\",\")),
    (.mcp | to_entries | map(.key + \" \" + (.value.connected|tostring) + \"/\" + ((.value.connected + .value.failed)|tostring)) | join(\", \")),
    (.summary.harness_missing|tostring), (.summary.servers_failed|tostring)] | join(\"|\")"' _ "$json"
  [ "$output" = "true|3|omp:true,opencode:true,pi:true|omp 2/2, pi 1/1, opencode 2/2|0|0" ]
  # на удачной проверке лишних полей нет: молчаливых нулей вместо ответа тоже
  run bash -c 'printf "%s" "$1" | jq -e "has(\"error\") | not"' _ "$json"
  [ "$output" = "true" ]
}

@test "verify: сервер не ответил — код 1, клиент и причина в выводе" {
  verify_env
  verify_fixture timeout
  vcenter verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"провалы:"* ]]
  [[ "$output" == *"opencode/playwright — timeout (20000 мс): нет ответа на initialize"* ]]
  [[ "$output" == *"итог: серверов 5, connected 4, провалов 1, харнессов не хватает 0"* ]]
}

@test "verify --json: провал сервера виден в mcp и summary, код 1" {
  verify_env
  verify_fixture timeout
  vcenter verify --json
  [ "$status" -eq 1 ]
  run bash -c 'printf "%s" "$1" | jq -r "[(.ok|tostring), (.mcp.opencode.connected|tostring), (.mcp.opencode.failed|tostring),
    (.mcp.omp.failed|tostring), (.summary.servers_failed|tostring), (.summary.harness_missing|tostring)] | join(\"|\")"' _ "$output"
  [ "$output" = "false|1|1|0|1|0" ]
}

@test "verify: чужая запись упала — свой дом жив: код 0 и строка «чужое, не считаем»" {
  verify_env
  verify_fixture foreign
  vcenter verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"итог: серверов 4, connected 4, провалов 0, харнессов не хватает 0"* ]]
  [[ "$output" != *"провалы:"* ]]
  [[ "$output" == *"чужое, не считаем: opencode/playwright — timeout"* ]]
}

@test "verify --json: чужие провалы отдельным полем, наши — в servers_failed" {
  verify_env
  verify_fixture foreign
  vcenter verify --json
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -r "[(.ok|tostring), (.mcp.opencode.connected|tostring), (.mcp.opencode.failed|tostring),
    (.mcp.opencode.foreign_failed|tostring), (.summary.servers_failed|tostring), (.summary.foreign_failed|tostring),
    (.foreign_failures[0].client + \"/\" + .foreign_failures[0].name)] | join(\"|\")"' _ "$output"
  [ "$output" = "true|1|0|1|0|1|opencode/playwright" ]
}

@test "verify: наша упала и чужая упала — провалов 1, чужих 1, код 1" {
  verify_env
  verify_fixture mixed
  vcenter verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"провалы:"* ]]
  [[ "$output" == *"opencode/wiki — timeout"* ]]
  [[ "$output" == *"чужое, не считаем: opencode/playwright — spawn-failed"* ]]
  [[ "$output" == *"итог: серверов 4, connected 3, провалов 1, харнессов не хватает 0"* ]]
}

@test "verify: пропавший харнесс — код 1 и строка про него" {
  verify_env
  verify_fixture harness-missing
  vcenter verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"pi — НЕТ"* ]]
  [[ "$output" == *"харнессов не хватает 1"* ]]
  # серверы при этом отвечают: провал именно у харнесса, и сводка это разделяет
  [[ "$output" == *"провалов 0"* ]]

  vcenter verify --json
  [ "$status" -eq 1 ]
  run bash -c 'printf "%s" "$1" | jq -r "[(.ok|tostring), (.summary.harness_missing|tostring), (.summary.servers_failed|tostring)] | join(\"|\")"' _ "$output"
  [ "$output" = "false|1|0" ]
}

@test "verify передаёт таймаут, среду и исключения, а мусор в них — ошибка" {
  verify_env
  verify_fixture ok
  vcenter verify --timeout 5 --client omp --exclude playwright,chrome-devtools wiki
  [ "$status" -eq 0 ]
  [[ "$(cat "$VERIFY_LOG")" == *"verify --json --timeout 5 --client omp --exclude playwright,chrome-devtools wiki"* ]]
  # спросили одну среду — в отчёте одна строка клиента (glob по всему выводу тут врёт: он идёт через строки)
  [[ "$output" == *"omp"*"connected 2/2"* ]]
  ! printf '%s\n' "$output" | grep -q '^pi '
  ! printf '%s\n' "$output" | grep -q '^opencode '
  vcenter verify --json --client pi
  [ "$status" -eq 0 ]
  local json="$output"
  run bash -c 'printf "%s" "$1" | jq -r "[(.mcp | keys | join(\",\")), (.summary.servers_failed|tostring)] | join(\"|\")"' _ "$json"
  [ "$output" = "pi|0" ]

  vcenter verify --client windows
  [ "$status" -eq 1 ]
  [[ "$output" == *"--client: неизвестная среда windows"* ]]
  vcenter verify --timeout ноль
  [ "$status" -eq 1 ]
  [[ "$output" == *"--timeout: нужно целое число секунд"* ]]
}

@test "verify честно падает, когда проверку нечем провести" {
  # в реестре никто не объявил mcpVerify — центр не выдумывает команду, а говорит прямо
  verify_env
  verify_fixture ok
  printf '{"projects":[{"name":"cli-station","what":"заглушка","run":"bin/cli-station.sh","harnessStatus":"status --json"}]}' >"$VSTUBS/registry-only-harness.json"
  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$VSTUBS/registry-only-harness.json" CENTER_PROJECTS_ROOT="$VPROJECTS" \
      node "$CENTER/bin/center.mjs" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"в реестре никто не объявил поле mcpVerify"* ]]

  # станция ответила мусором: это не «всё хорошо» — ok:false и строка почему, а не нули
  printf '{"projects":[{"name":"cli-station","what":"заглушка","run":"bin/cli-station.sh","harnessStatus":"status --json"},{"name":"mcp-station","what":"заглушка","run":"bin/mcp-station.sh","mcpVerify":"verify --json"}]}' >"$VSTUBS/registry.json"
  printf '#!/usr/bin/env bash\nprintf "станция сломалась\\n"\nexit 3\n' >"$VPROJECTS/mcp-station/bin/mcp-station.sh"
  chmod +x "$VPROJECTS/mcp-station/bin/mcp-station.sh"
  vcenter verify --json
  [ "$status" -eq 1 ]
  run bash -c 'printf "%s" "$1" | jq -r "[(.ok|tostring), (.mcp|length|tostring), (.summary.servers_failed|tostring), (.error | startswith(\"mcp-station verify не разобран\"))] | join(\"|\")"' _ "$output"
  [ "$output" = "false|0|0|true" ]
}

# ── гейт доков (bin/docs-check.sh): числа, списки и команды в README/docs против факта ──────────

# мини-диск: реестр на два проекта, версия, станция alpha с набором из трёх тестов, коллекция и доки
docs_fixture() { # $1 — каталог мини-диска, $2 — сколько тестов написать в README станции
  local root="$1" said="$2"
  mkdir -p "$root/command-center" "$root/alpha/bin" "$root/alpha/tests" \
    "$root/skills-station/collection/one-skill" "$root/skills-hub/contrib"
  printf '9.9.9\n' >"$root/VERSION"
  cat >"$root/command-center/registry.json" <<'EOF'
{"projects":[
 {"name":"alpha","what":"заглушка станции","run":"bin/alpha.sh"},
 {"name":"skills-station","what":"заглушка коллекции","run":"bin/skills-station.sh"}
]}
EOF
  cat >"$root/alpha/bin/alpha.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-status}" in
  status) printf 'ok\n' ;;
  install) printf 'поставил\n' ;;
  *) printf 'alpha: не знаю команду\n' >&2; exit 2 ;;
esac
EOF
  chmod +x "$root/alpha/bin/alpha.sh"
  # у каждой станции на диске свой .ps1-сосед: гейт платформенной полноты считает .sh без него дырой
  cat >"$root/alpha/bin/alpha.ps1" <<'EOF'
#Requires -Version 5.1
# stub: Windows twin of the alpha station (same commands as the .sh)
param([string[]] $Arguments)
exit 0
EOF
  printf '@test "один" { true; }\n@test "два" { true; }\n@test "три" { true; }\n' >"$root/alpha/tests/station.bats"
  printf -- '---\nname: one-skill\ndescription: заглушка\n---\n' >"$root/skills-station/collection/one-skill/SKILL.md"
  {
    printf '# alpha\n\n'
    printf '    bats tests/station.bats   # %s тестов\n' "$said"
    printf '    bin/alpha.sh status       # состояние\n'
  } >"$root/alpha/README.md"
}

@test "гейт доков: неверное число тестов в README станции — падает с «сказано N, на деле M»" {
  local root="$BATS_TEST_TMPDIR/disk-bad"
  docs_fixture "$root" 5

  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"README станции alpha: сказано 5, на деле 3"* ]]
  [[ "$output" == *"расхождений"* ]]
}

@test "гейт доков: верное число тестов — проходит и говорит, что числа сходятся" {
  local root="$BATS_TEST_TMPDIR/disk-ok"
  docs_fixture "$root" 3

  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"числа и списки в доках сходятся с фактом"* ]]
}

@test "гейт доков: команда, которой нет в usage станции, — расхождение" {
  local root="$BATS_TEST_TMPDIR/disk-cmd"
  docs_fixture "$root" 3
  printf '    bin/alpha.sh frobnicate   # такой команды у станции нет\n' >>"$root/alpha/README.md"

  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"команда «bin/alpha.sh frobnicate» не найдена в usage станции alpha"* ]]
}

@test "гейт доков: проект из реестра, не названный в README центра, — расхождение в --json" {
  local root="$BATS_TEST_TMPDIR/disk-list"
  docs_fixture "$root" 3
  printf '# command-center\n\n## Что знает\n\n- `alpha`\n' >"$root/command-center/README.md"

  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --json
  [ "$status" -eq 1 ]
  [[ "$output" == *'"ok":false'* ]]
  [[ "$output" == *"проект skills-station есть в реестре, а в README — нет"* ]]
}

@test "гейт доков: битый registry.json не превращается в projects=0" {
  local root="$BATS_TEST_TMPDIR/disk-broken-registry"
  docs_fixture "$root" 3
  printf '{ broken json\n' >"$root/command-center/registry.json"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 2 ]
  [[ "$output" == *"registry.json"* ]]
  [[ "$output" == *"не разобран"* ]]
}


@test "гейт доков: доки самого центра сходятся с фактом (числа, списки, команды)" {
  run bash "$CENTER/bin/docs-check.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"сходятся с фактом"* ]]
}

@test "гейт доков: корневой README тоже проверяет число шагов bootstrap" {
  local root="$BATS_TEST_TMPDIR/disk-root-readme"
  docs_fixture "$root" 3
  mkdir -p "$root/command-center/bin"
  {
    printf 'const commands = new Set(["status"]);\n'
    printf 'function cmdBootstrap() {\n  const steps = [\n'
    for i in $(seq 0 21); do printf '    ["%s", "step-%s"],\n' "$i" "$i"; done
    printf '  ];\n  const manual = [];\n}\n'
  } >"$root/command-center/bin/center.mjs"
  printf '# AGGG\n\ncenter bootstrap: 21 шаг\n' >"$root/README.md"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"README.md"*'сказано 21'*'на деле 22'* ]]
}
@test "гейт доков: список команд плагина сверяется с ядром плагина в обе стороны" {
  local root="$BATS_TEST_TMPDIR/disk-plugin"
  docs_fixture "$root" 3
  mkdir -p "$root/command-center/plugin/lib" "$root/command-center/docs"
  cat >"$root/command-center/plugin/lib/center.ts" <<'EOF'
export const COMMANDS: Command[] = [
  { name: "status", description: "Состояние", timeoutMs: 120_000 },
  { name: "ps", description: "Процессы", timeoutMs: 30_000 },
];
EOF
  printf '# Плагины\n\n`/center status` и `/center frobnicate`.\n' >"$root/command-center/docs/10-plugins.md"

  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  # команда, которой нет в ядре плагина
  [[ "$output" == *"названа команда «/center frobnicate», а в plugin/lib/center.ts её нет"* ]]
  # и обратная сторона: команда ядра, не названная ни в одном доке плагина
  [[ "$output" == *"команда плагина «ps» не названа"* ]]
}

@test "гейт доков: PowerShell-версия даёт тот же вердикт, что bash (и на верном дереве, и на неверном)" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  local good="$BATS_TEST_TMPDIR/disk-ps1-ok" bad="$BATS_TEST_TMPDIR/disk-ps1-bad"
  docs_fixture "$good" 3
  docs_fixture "$bad" 5

  # верное дерево: обе обёртки зелёные и говорят одно и то же
  run env DOCS_CHECK_ROOT="$good" bash "$CENTER/bin/docs-check.sh"
  [ "$status" -eq 0 ]
  local from_bash="$output"
  run env DOCS_CHECK_ROOT="$good" pwsh -NoProfile -File "$CENTER/bin/docs-check.ps1"
  [ "$status" -eq 0 ]
  [ "$output" = "$from_bash" ]

  # неверное: тот же код возврата и та же строка про расхождение, а не «свои» числа
  run env DOCS_CHECK_ROOT="$bad" bash "$CENTER/bin/docs-check.sh"
  [ "$status" -eq 1 ]
  from_bash="$output"
  [[ "$from_bash" == *"сказано 5, на деле 3"* ]]

  run env DOCS_CHECK_ROOT="$bad" pwsh -NoProfile -File "$CENTER/bin/docs-check.ps1"
  [ "$status" -eq 1 ]
  [ "$output" = "$from_bash" ]

  # --json тоже общий движок: один и тот же контракт у обеих обёрток
  run env DOCS_CHECK_ROOT="$bad" pwsh -NoProfile -File "$CENTER/bin/docs-check.ps1" --json
  [ "$status" -eq 1 ]
  run bash -c 'printf "%s" "$1" | jq -r "[.ok, .facts.projects, .facts.bats_files_all, (.mismatches | length > 0)] | join(\"|\")"' _ "$output"
  [ "$output" = "false|2|1|true" ]
}

@test "платформенная полнота: .sh без соседа .ps1 и без исключения — расхождение" {
  local root="$BATS_TEST_TMPDIR/disk-platform-gap"
  docs_fixture "$root" 3
  # забытый порт: .sh есть, .ps1 нет, в исключениях его тоже нет (строгий режим — есть: тут не про него)
  printf '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n' >"$root/alpha/bin/legacy.sh"

  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"platform: alpha/bin/legacy.sh — .sh без соседа legacy.ps1 и нет в platform-exceptions.txt"* ]]
  # и видно, чего не хватает бумаге: причина в строке исключения обязательна
  [[ "$output" == *"допиши порт или внеси строку с причиной"* ]]

  # тот же legacy.sh со .ps1-соседом — гейт молчит про платформы
  printf '#Requires -Version 5.1\nexit 0\n' >"$root/alpha/bin/legacy.ps1"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 0 ]
  [[ "$output" != *"platform:"* ]]
}

@test "платформенная полнота: протухшее исключение (файла нет или уже есть .ps1) — расхождение" {
  local root="$BATS_TEST_TMPDIR/disk-platform-stale"
  docs_fixture "$root" 3

  # путь, которого на диске нет: исключение протухло
  printf 'alpha/bin/ghost.sh|systemd: такого скрипта уже нет\n' >"$root/command-center/platform-exceptions.txt"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"platform: platform-exceptions.txt: alpha/bin/ghost.sh — такого .sh на диске нет"* ]]
  [[ "$output" == *"исключение протухло: убери строку"* ]]

  # путь есть, но порт уже написали: исключение больше не причина
  printf 'alpha/bin/alpha.sh|linux-only: станция только под Linux\n' >"$root/command-center/platform-exceptions.txt"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"platform: platform-exceptions.txt: alpha/bin/alpha.sh — у него появился сосед .ps1"* ]]

  # а строку без причины гейт не принимает вовсе (формат «путь|причина»)
  printf 'alpha/bin/alpha.sh\n' >"$root/command-center/platform-exceptions.txt"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"строка 1 без причины"* ]]
}

@test "платформы: реестр объявляет их, а центр честно говорит про чужую ОС" {
  # реестр: у каждого проекта непустой список из известных платформ
  run node -e '
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const data = JSON.parse(readFileSync(join(process.argv[1], "registry.json"), "utf8"));
const known = new Set(["linux", "darwin", "win32"]);
const problems = [];
for (const project of data.projects) {
  if (!Array.isArray(project.platforms) || project.platforms.length === 0) problems.push(`${project.name}: нет platforms`);
  else for (const one of project.platforms) if (!known.has(one)) problems.push(`${project.name}: чужая платформа ${one}`);
  const file = project.platforms?.includes("win32") ? project.runWindows : undefined;
  if (file && !require("node:fs").existsSync(join(process.argv[1], "..", project.name, file))) problems.push(`${project.name}: нет ${file}`);
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`платформы объявлены у ${data.projects.length} проектов`);
' "$CENTER"
  [ "$status" -eq 0 ]

  # Unix-only станция на своей ОС: строка об этом говорит прямым текстом
  run node "$CENTER/bin/center.mjs" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"fedora-windows-look"*"только linux"* ]]

  # на чужой ОС проект не падает и не ищет точку входа, которой там нет
  run env CENTER_PLATFORM=win32 node "$CENTER/bin/center.mjs" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"fedora-windows-look"*"не поддерживается на этой ОС (platforms: linux)"* ]]
  [[ "$output" == *"проблемных: 0"* ]]

  # то же самое видно машине и в запуске проекта
  run env CENTER_PLATFORM=win32 node "$CENTER/bin/center.mjs" status --json
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -r ".[] | select(.name == \"fedora-windows-look\") | [(.platforms | join(\",\")), (.supported | tostring), .update.label] | join(\"|\")"' _ "$output"
  [ "$output" = "linux|false|не поддерживается" ]

  run env CENTER_PLATFORM=win32 node "$CENTER/bin/center.mjs" run fedora-windows-look
  [ "$status" -eq 0 ]
  [[ "$output" == *"fedora-windows-look: не поддерживается на этой ОС (platforms: linux)"* ]]
  [[ "$output" != *"нет команды запуска"* ]]
}

@test "path helper понимает Windows-разделители и не путает соседний путь" {
  run bash -c 'cd "$1" && node --input-type=module -e "$2"' _ "$CENTER" '
    import { isPathWithin } from "./bin/path-utils.mjs";
    const ok = isPathWithin("C:\\\\Users\\\\admin", "C:\\\\Users\\\\admin\\\\.agents\\\\skills", { caseInsensitive: true });
    const sibling = isPathWithin("C:\\\\Users\\\\admin", "C:\\\\Users\\\\administrator\\\\.agents", { caseInsensitive: true });
    const outside = isPathWithin("C:\\\\Users\\\\admin", "C:\\\\Users\\\\other\\\\.agents", { caseInsensitive: true });
    if (!ok || sibling || outside) process.exit(1);
    console.log("path helper ok");
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"path helper ok"* ]]
}

@test "doctor не считает Linux-only проект сломанным на Windows" {
  stub_env
  mkdir -p "$PROJECTS/linux-only"
  cat >"$STUBS/registry-linux-only.json" <<'EOF'
{"projects":[
  {"name":"linux-only","what":"заглушка Linux-only","platforms":["linux"],
   "expectLinks":[{"link":"$HOME/.agents/skills/linux-only","into":"linux-only"}]}
]}
EOF
  mkdir -p "$CENTER_HOME/.omp/agent" "$CENTER_HOME/.pi/agent" "$CENTER_HOME/.config/opencode"
  printf '{"mcpServers":{"stub":{"command":"x"}}}' >"$CENTER_HOME/.omp/agent/mcp.json"
  printf '{"mcpServers":{"stub":{"command":"x"}}}' >"$CENTER_HOME/.pi/agent/mcp.json"
  printf '{"mcp":{"stub":{"type":"local"}}}' >"$CENTER_HOME/.config/opencode/opencode.json"

  run env -u XDG_CONFIG_HOME CENTER_PLATFORM=win32 CENTER_REGISTRY="$STUBS/registry-linux-only.json" \
    CENTER_PROJECTS_ROOT="$PROJECTS" node "$CENTER/bin/center.mjs" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"linux-only"*"не поддерживается на этой ОС"* ]]
  ! printf '%s\n' "$output" | grep -q '^FAIL'
}

# ── expectLinks: ссылка или копия (цепочка симлинков до корня) ─────────────────────────────

# Форма владения скиллом тремя способами: ссылка каталогом на коллекцию, файл-ссылка
# внутри настоящего каталога, копия без ссылки. Дальше — ловушка системного симлинка над домом.


# ── ps: кто что держит (процессы, роли, владелец блокировки браузера) ──────────────────────────

# Снимок процессов для теста: свой «/proc» (CENTER_PROC_ROOT), поэтому отчёт не зависит от того,
# что сейчас работает на машине. Спека процесса — «pid:ppid:секунд-назад:командная строка».
# Время старта выводится из btime и тиков так же, как это делает /proc (100 тиков в секунду).
proc_fixture() {
  local root="$1"
  shift
  mkdir -p "$root"
  printf 'cpu  1 2 3\nbtime %s\n' "$(( $(date +%s) - 100000 ))" >"$root/stat"
  printf '100000.00 1.00\n' >"$root/uptime"
  local spec pid ppid ago cmd ticks
  for spec in "$@"; do
    pid="${spec%%:*}"; spec="${spec#*:}"
    ppid="${spec%%:*}"; spec="${spec#*:}"
    ago="${spec%%:*}"; cmd="${spec#*:}"
    ticks=$(( (100000 - ago) * 100 ))
    mkdir -p "$root/$pid"
    printf '%s' "$cmd" | tr ' ' '\000' >"$root/$pid/cmdline"
    # поля stat как их читает /proc: 4-е — родитель, 22-е — время старта в тиках (17 полей между ними)
    printf '%s (%s) S %s 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 %s 0 0 0\n' \
      "$pid" "${cmd%% *}" "$ppid" "$ticks" >"$root/$pid/stat"
  done
}

# Заглушки MCP-записей и файла записи: примета записи — путь к файлу (он же виден в командной строке).
ps_env() {
  stub_env
  mkdir -p "$CENTER_HOME/.agents/wiki/mcp" "$CENTER_HOME/.venvs/camoufox-research/bin"
  : >"$CENTER_HOME/.agents/wiki/mcp/server.mjs"
  : >"$CENTER_HOME/.venvs/camoufox-research/bin/camoufox-research"
  cat >"$CENTER_HOME/.omp/agent/mcp.json" <<EOF
{"mcpServers":{"wiki":{"command":"bash","args":["-lc","exec node \"\$HOME/.agents/wiki/mcp/server.mjs\""]}}}
EOF
  # реестр знает, что запись camoufox принадлежит проекту updater (как camoufox-research в живом)
  jq '.projects[0].expectMcp = ["camoufox"]' "$STUBS/registry-ok.json" >"$STUBS/registry-mcp.json"
  export PROC="$BATS_TEST_TMPDIR/proc"
}

pcenter() {
  # CENTER_PLATFORM=linux: фикстура /proc — линуксовая раскладка, на macOS ветка была бы другая
  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$STUBS/registry-mcp.json" CENTER_PROJECTS_ROOT="$PROJECTS" \
      CENTER_PLATFORM=linux CENTER_PROC_ROOT="$PROC" node "$CENTER/bin/center.mjs" "$@"
}

@test "ps: серверы MCP, браузеры, тесты, движки станций и клиенты — с проектом, pid и временем старта" {
  ps_env
  proc_fixture "$PROC" \
    "101:1:7200:bun $CENTER_HOME/.bun/bin/omp" \
    "102:101:7190:node $CENTER_HOME/.agents/wiki/mcp/server.mjs" \
    "103:101:7180:/opt/google/chrome/chrome --user-data-dir=$CENTER_HOME/.omp/run/daemons/x" \
    "104:1:900:/usr/libexec/bats-core/bats tests/center.bats" \
    "105:1:300:bash $PROJECTS/updater/bin/upd.sh outdated" \
    "106:1:120:$CENTER_HOME/.cache/camoufox/browsers/official/x/camoufox-bin -no-remote -headless -profile /tmp/playwright_firefoxdev_profile-x"

  pcenter ps
  [ "$status" -eq 0 ]
  # сервер записи клиента: проект — каталог станции MCP (реестр её не объявлял), владелец — клиент
  [[ "$output" == *"MCP wiki (клиент omp)"* ]]
  # браузер: у chrome владелец — клиент, у camoufox проект берётся из объявления реестра (expectMcp)
  [[ "$output" == *"браузер chrome (клиент omp)"* ]]
  [[ "$output" == *"браузер camoufox"* ]]
  [[ "$output" == *"updater"*"браузер camoufox"* ]]
  [[ "$output" == *"тесты: /usr/libexec/bats-core/bats tests/center.bats"* ]]
  [[ "$output" == *"движок станции"* ]]
  [[ "$output" == *"клиент omp"* ]]
  # у каждой строки видно время старта, а не только pid
  [[ "$output" =~ [0-9]{2}\.[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2} ]]
  [[ "$output" == *"всего:"* ]]
  # блокировки нет — так и говорим
  [[ "$output" == *"блокировка браузера: свободна"* ]]
}

@test "ps --json отдаёт процессы и блокировку машинным видом" {
  ps_env
  proc_fixture "$PROC" \
    "101:1:7200:bun $CENTER_HOME/.bun/bin/omp" \
    "102:101:7190:node $CENTER_HOME/.agents/wiki/mcp/server.mjs"

  pcenter ps --json
  [ "$status" -eq 0 ]
  local json="$output"
  run bash -c 'printf "%s" "$1" | jq -r "[.ok, .platform, (.processes|length), (.processes[] | select(.role==\"mcp\") | .what), (.lock.state)] | join(\"|\")"' _ "$json"
  [ "$output" = "true|linux|2|MCP wiki (клиент omp)|free" ]
  # у строки есть и проект, и pid, и машинное время старта, и командная строка
  run bash -c 'printf "%s" "$1" | jq -e ".processes[0] | has(\"project\") and has(\"pid\") and has(\"started\") and has(\"cmd\")"' _ "$json"
  [ "$output" = "true" ]
  # роли и время старта у строки живые: строка «клиент omp» стартовала 7200 секунд назад по снимку
  run bash -c 'printf "%s" "$1" | jq -r "[.processes[] | select(.role==\"agent\") | .project, .since] | join(\"|\")"' _ "$json"
  [[ "$output" == "cli-station|"* ]]
  [[ "$output" =~ [0-9]{2}\.[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2} ]]
}

@test "ps называет владельца блокировки браузера и путь, чем снять" {
  ps_env
  proc_fixture "$PROC" "101:1:60:bun $CENTER_HOME/.bun/bin/omp"
  mkdir -p "$CENTER_HOME/.local/state/command-center"
  # живой pid (свой шелл) и свежее время — блокировка держится
  printf 'pid=%s\nowner=mcp-station verify\nrun=браузерные: camoufox\nstarted=%s\nttl=1800\n' \
    "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CENTER_HOME/.local/state/command-center/browser.lock"

  pcenter ps
  [ "$status" -eq 0 ]
  [[ "$output" == *"блокировка браузера: занята — mcp-station verify (браузерные: camoufox)"* ]]
  [[ "$output" == *"pid $$"* ]]
  [[ "$output" == *"снять принудительно: rm ~/.local/state/command-center/browser.lock"* ]]

  pcenter ps --json
  run bash -c 'printf "%s" "$1" | jq -r "[.lock.state, .lock.owner, .lock.run, (.lock.pid|tostring)] | join(\"|\")"' _ "$output"
  [ "$output" = "held|mcp-station verify|браузерные: camoufox|$$" ]

  # мёртвый pid — блокировка протухла, и это видно
  printf 'pid=999999\nowner=давний прогон\nstarted=%s\nttl=1800\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$CENTER_HOME/.local/state/command-center/browser.lock"
  pcenter ps
  [[ "$output" == *"блокировка браузера: протухла (pid 999999 не жив)"* ]]
  pcenter ps --json
  run bash -c 'printf "%s" "$1" | jq -r "[.lock.state, .lock.reason] | join(\"|\")"' _ "$output"
  [ "$output" = "stale|pid 999999 не жив" ]

  # старше TTL (30 мин) — тоже протухла, даже если pid жив
  printf 'pid=%s\nowner=давний прогон\nstarted=2020-01-01T00:00:00Z\nttl=1800\n' "$$" \
    >"$CENTER_HOME/.local/state/command-center/browser.lock"
  pcenter ps --json
  run bash -c 'printf "%s" "$1" | jq -r "[.lock.state, (.lock.reason | startswith(\"старше TTL\"))] | join(\"|\")"' _ "$output"
  [ "$output" = "stale|true" ]
}

@test "ps: наших процессов нет — говорит об этом прямо, а не молчит" {
  ps_env
  # ни сервера, ни браузера, ни теста, ни клиента: система и чужая команда — не наш отчёт
  proc_fixture "$PROC" "101:1:900:/usr/lib/systemd/systemd --user" "102:1:900:bash /tmp/чужой-скрипт.sh"

  pcenter ps
  [ "$status" -eq 0 ]
  [[ "$output" == *"наших процессов не видно"* ]]
}

@test "ps: без /proc (Windows) честно говорит, что показывает по tasklist" {
  ps_env
  # CENTER_PLATFORM=win32, а tasklist на этой машине нет: показываем, что можем, и не выдумываем
  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$STUBS/registry-mcp.json" CENTER_PROJECTS_ROOT="$PROJECTS" \
      CENTER_PLATFORM=win32 CENTER_PROC_ROOT="$PROC" node "$CENTER/bin/center.mjs" ps
  [ "$status" -eq 0 ]
  [[ "$output" == *"нет /proc"* ]]
  [[ "$output" == *"tasklist"* ]]
}

# ── logs: где лежат логи проекта и их хвост ────────────────────────────────────────────────────

@test "logs: хвост файловых логов проекта, --tail режет хвост, --json отдаёт машинный вид" {
  stub_env
  mkdir -p "$CENTER_HOME/.cache/updater"
  printf 'строка один\nстрока два\nстрока три\n' >"$CENTER_HOME/.cache/updater/watchdog.log"

  stub_center "$STUBS/registry-ok.json" logs updater --tail 2
  [ "$status" -eq 0 ]
  [[ "$output" == *"логи updater (хвост по 2 строк"* ]]
  [[ "$output" == *"~/.cache/updater/watchdog.log"* ]]
  [[ "$output" == *"строка три"* ]]
  [[ "$output" != *"строка один"* ]]

  stub_center "$STUBS/registry-ok.json" logs updater --json
  [ "$status" -eq 0 ]
  local json="$output"
  run bash -c 'printf "%s" "$1" | jq -r "[.ok, .project, (.sources|length), .sources[0].path, (.sources[0].tail|length|tostring)] | join(\"|\")"' _ "$json"
  [ "$output" = "true|updater|1|$CENTER_HOME/.cache/updater/watchdog.log|3" ]
}

@test "logs: использует XDG_STATE_HOME и XDG_CACHE_HOME" {
  stub_env
  local state="$BATS_TEST_TMPDIR/xdg-state" cache="$BATS_TEST_TMPDIR/xdg-cache"
  mkdir -p "$state/updater/logs" "$cache/updater"
  printf 'из state\n' >"$state/updater/logs/watchdog.log"
  printf 'из cache\n' >"$cache/updater/watchdog.log"

  run env -u XDG_CONFIG_HOME XDG_STATE_HOME="$state" XDG_CACHE_HOME="$cache" \
    CENTER_REGISTRY="$STUBS/registry-ok.json" CENTER_PROJECTS_ROOT="$PROJECTS" \
    node "$CENTER/bin/center.mjs" logs updater --json
  [ "$status" -eq 0 ]
  [[ "$output" == *"$state/updater/logs/watchdog.log"* ]]
  [[ "$output" == *"$cache/updater/watchdog.log"* ]]
  [[ "$output" == *"из state"* ]]
  [[ "$output" == *"из cache"* ]]
}

@test "logs: своих логов нет — говорит «логов нет» и где смотреть (журнал юнита, рантайм)" {
  stub_env
  mkdir -p "$CENTER_HOME/.config/systemd/user" "$CENTER_HOME/.local/state/quiet"
  printf '[Unit]\nDescription=заглушка\n' >"$CENTER_HOME/.config/systemd/user/quiet-check.service"

  stub_center "$STUBS/registry-ok.json" logs quiet
  [ "$status" -eq 0 ]
  [[ "$output" == *"логов нет: quiet своих логов не пишет"* ]]
  [[ "$output" == *"journalctl --user -u quiet-check.service -n 40"* ]]
  [[ "$output" == *"рантайм станции: ~/.local/state/quiet (файлов .log там нет)"* ]]

  # ни файлов, ни юнита — единственный честный ответ: вывод на экран
  stub_center "$STUBS/registry-ok.json" logs bare
  [ "$status" -eq 0 ]
  [[ "$output" == *"логов нет: bare"* ]]
  [[ "$output" == *"вывод идёт на экран"* ]]
}

@test "logs: неизвестный проект — ошибка со списком, мусор в --tail — код 2" {
  stub_env
  stub_center "$STUBS/registry-ok.json" logs нетакого
  [ "$status" -eq 1 ]
  [[ "$output" == *"в реестре нет нетакого"* ]]

  stub_center "$STUBS/registry-ok.json" logs updater --tail ноль
  [ "$status" -eq 2 ]
  [[ "$output" == *"--tail принимает число строк"* ]]
}

# ── «зарегистрирован ≠ видно в сессии» и гейт доков в сквозной проверке ────────────────────────

@test "verify: конфиг новее запуска клиента — строка про перезапуск и session_stale в JSON" {
  verify_env
  verify_fixture ok
  # снимок процессов: opencode стартовал час назад, omp — только что, pi не запущен вовсе
  proc_fixture "$BATS_TEST_TMPDIR/proc" \
    "101:1:7200:/usr/bin/opencode2" \
    "102:1:10:bun $CENTER_HOME/.bun/bin/omp"
  mkdir -p "$CENTER_HOME/.omp/agent" "$CENTER_HOME/.pi/agent" "$CENTER_HOME/.config/opencode"
  printf '{"mcpServers":{}}' >"$CENTER_HOME/.omp/agent/mcp.json"
  printf '{"mcpServers":{}}' >"$CENTER_HOME/.pi/agent/mcp.json"
  printf '{"mcp":{}}' >"$CENTER_HOME/.config/opencode/opencode.json"
  # omp стартовал позже правки своего конфига: он видит актуальные записи, врать про него нельзя
  # час назад: touch -d есть только в GNU, поэтому метку считаем сами
  stamp="$(date -d '1 hour ago' +%Y%m%d%H%M 2>/dev/null || date -v-1H +%Y%m%d%H%M)"
  touch -t "$stamp" "$CENTER_HOME/.omp/agent/mcp.json"

  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$VSTUBS/registry.json" CENTER_PROJECTS_ROOT="$VPROJECTS" \
      CENTER_PLATFORM=linux CENTER_PROC_ROOT="$BATS_TEST_TMPDIR/proc" node "$CENTER/bin/center.mjs" verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"запись новее запуска"* ]]
  [[ "$output" == *"opencode: запись новее запуска клиента"* ]]
  [[ "$output" == *"тулы появятся после перезапуска (opencode2 service restart / новый сеанс omp, pi)"* ]]
  [[ "$output" != *"omp: запись новее запуска клиента"* ]]

  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$VSTUBS/registry.json" CENTER_PROJECTS_ROOT="$VPROJECTS" \
      CENTER_PLATFORM=linux CENTER_PROC_ROOT="$BATS_TEST_TMPDIR/proc" node "$CENTER/bin/center.mjs" verify --json
  [ "$status" -eq 0 ]
  local json="$output"
  run bash -c 'printf "%s" "$1" | jq -r "[(.mcp.opencode.session_stale|tostring), (.mcp.omp.session_stale|tostring), (.mcp.pi|has(\"session_stale\")|tostring), (.summary.sessions_stale|tostring), (.sessions[0].client)] | join(\"|\")"' _ "$json"
  # у pi процесса нет — поля нет вовсе: «не знаю» честнее выдумки
  [ "$output" = "true|false|false|1|opencode" ]
}

@test "check зовёт гейт доков, если файл есть, а отсутствие гейта проваливает полный прогон" {
  stub_env
  # сквозная проверка хаба — заглушка: этот тест про гейт доков, а не про сам прогон тестов
  mkdir -p "$PROJECTS/skills-hub/contrib"
  printf '#!/usr/bin/env bash\nprintf "хаб: проверка прошла\\n"\n' >"$PROJECTS/skills-hub/contrib/skills-hub-check.sh"
  chmod +x "$PROJECTS/skills-hub/contrib/skills-hub-check.sh"
  check_center() {
    run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$STUBS/registry-ok.json" CENTER_PROJECTS_ROOT="$PROJECTS" \
        CENTER_DOCS_CHECK="$1" node "$CENTER/bin/center.mjs" check "$2"
  }

  # гейта нет — полный check обязан покраснеть
  check_center "$BATS_TEST_TMPDIR/нет-такого.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"хаб: проверка прошла"* ]]
  [[ "$output" == *"гейта доков нет"* ]]

  # явный best-effort сохраняет мягкий режим для диагностики
  check_center "$BATS_TEST_TMPDIR/нет-такого.sh" --best-effort
  [ "$status" -eq 0 ]
  [[ "$output" == *"best-effort"* ]]

  # гейт есть и расходится с фактом — сквозная проверка не зелёная, и видно, что именно он сказал
  printf '#!/usr/bin/env bash\nprintf "README станции alpha: сказано 5, на деле 3\\n"\nexit 1\n' >"$BATS_TEST_TMPDIR/bad-docs.sh"
  check_center "$BATS_TEST_TMPDIR/bad-docs.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"сказано 5, на деле 3"* ]]

  # гейт есть и сходится — проверка зелёная
  printf '#!/usr/bin/env bash\nprintf "числа и списки в доках сходятся с фактом\\n"\n' >"$BATS_TEST_TMPDIR/ok-docs.sh"
  check_center "$BATS_TEST_TMPDIR/ok-docs.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"числа и списки в доках сходятся с фактом"* ]]
}

@test "check: на Windows полный прогон идёт через .sh и настоящий Git Bash" {
  command -v bash >/dev/null 2>&1 || skip "bash не установлен"
  stub_env
  mkdir -p "$PROJECTS/skills-hub/contrib"
  # полный coverage определяет shell-скрипт; PowerShell-обёртка остаётся отдельной точкой входа
  printf '#!/usr/bin/env bash\nprintf "hub: sh check\\n"\n' >"$PROJECTS/skills-hub/contrib/skills-hub-check.sh"
  printf '#Requires -Version 7.0\nWrite-Output "hub: ps1 check"\n' >"$PROJECTS/skills-hub/contrib/skills-hub-check.ps1"
  printf '#!/usr/bin/env bash\nprintf "docs: gate\\n"\n' >"$BATS_TEST_TMPDIR/gate.sh"

  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$STUBS/registry-ok.json" CENTER_PROJECTS_ROOT="$PROJECTS" \
      CENTER_PLATFORM=win32 CENTER_DOCS_CHECK="$BATS_TEST_TMPDIR/gate.sh" node "$CENTER/bin/center.mjs" check
  [ "$status" -eq 0 ]
  [[ "$output" == *"hub: sh check"* ]]
  [[ "$output" == *"docs: gate"* ]]
  [[ "$output" != *"hub: ps1 check"* ]]
}

@test "win32: сверка идёт через .ps1-соседа проекта, а не через bash" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"
  stub_env
  # рядом с bin/upd.sh кладём его Windows-форму: на win32 центр обязан взять именно её
  cat >"$PROJECTS/updater/bin/upd.ps1" <<'EOF'
#!/usr/bin/env pwsh
Add-Content -Path $env:STUB_LOG -Value ("ps1 " + ($args -join " "))
Write-Output '{"ok":true,"schema":1,"summary":{"current":1,"changed":2,"missing":3}}'
EOF

  run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$STUBS/registry-ok.json" CENTER_PROJECTS_ROOT="$PROJECTS" \
      CENTER_PLATFORM=win32 node "$CENTER/bin/center.mjs" outdated
  [ "$status" -eq 0 ]
  [[ "$output" == *"updater"*"обновить"* ]]
  [ "$(cat "$STUB_LOG")" = "ps1 outdated --json" ]
}

@test "win32: заглушка WSL не считается bash — сверка честно говорит, что нечем запустить" {
  stub_env
  # .ps1-соседа у updater нет, а «bash» в PATH — подделка, ведущая себя как заглушка WSL:
  # печатает инструкцию про дистрибутив и выходит с нулём (именно так она и врёт про успех)
  local fake="$BATS_TEST_TMPDIR/fake"
  mkdir -p "$fake"
  cat >"$fake/bash.exe" <<'EOF'
#!/usr/bin/env bash
printf 'Подсистема Windows для Linux не имеет установленных дистрибутивов.\n'
exit 0
EOF
  chmod +x "$fake/bash.exe"

  run env -u XDG_CONFIG_HOME PATH="$fake" PATHEXT=".exe" CENTER_REGISTRY="$STUBS/registry-ok.json" \
      CENTER_PROJECTS_ROOT="$PROJECTS" CENTER_PLATFORM=win32 "$(command -v node)" "$CENTER/bin/center.mjs" outdated
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет настоящего bash"* ]]
  [[ "$output" != *"сверка не разобрана"* ]]
  [ ! -s "$STUB_LOG" ]
}

@test "win32: prereqs видит инструменты в PATH через ; и не выдумывает «не хватает»" {
  local dir="$BATS_TEST_TMPDIR/winbin"
  mkdir -p "$dir"
  local tool
  for tool in node npm git gh jq curl bats shellcheck; do
    if [ "$tool" = node ]; then
      printf '@echo off\r\necho v22.23.1\r\nexit /b 0\r\n' >"$dir/$tool.CMD"
    else
      printf '@echo off\r\nexit /b 0\r\n' >"$dir/$tool.CMD"
    fi
  done

  run env PATH="$dir" PATHEXT=".COM;.EXE;.BAT;.CMD" CENTER_PLATFORM=win32 "$(command -v node)" "$CENTER/bin/center.mjs" prereqs
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok   node"* ]]
  [[ "$output" == *"ok   npm"* ]]
  [[ "$output" == *"предпосылки на месте"* ]]
  [[ "$output" != *"НЕТ  node"* ]]
  [[ "$output" != *"не хватает:"* ]]

  # Store alias: statSync получает EACCES, но accessSync(X_OK) и запуск через алиас живы.
  local alias_dir="$BATS_TEST_TMPDIR/win-pwsh-alias"
  mkdir -p "$alias_dir"
  ln -sf "$(command -v node)" "$alias_dir/node"
  printf '#!/bin/sh\nprintf "PowerShell 7.6.6\\n"\n' >"$alias_dir/pwsh.exe"
  chmod +x "$alias_dir/pwsh.exe"
  cat >"$BATS_TEST_TMPDIR/deny-pwsh-stat.cjs" <<'EOF'
const fs = require("node:fs");
const realStatSync = fs.statSync;
fs.statSync = function (path, ...args) {
  if (String(path).toLowerCase().endsWith("pwsh.exe")) {
    const error = new Error("simulated WindowsApps reparse point");
    error.code = "EACCES";
    throw error;
  }
  return realStatSync.call(this, path, ...args);
};
require("node:module").syncBuiltinESMExports();
EOF
  run env PATH="$alias_dir" PATHEXT=".exe" CENTER_PLATFORM=win32 \
    NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-pwsh-stat.cjs" \
    "$(command -v node)" "$CENTER/bin/center.mjs" prereqs
  [ "$status" -eq 1 ]
  [[ "$output" == *"ok   pwsh"* ]]
  [[ "$output" == *"$alias_dir/pwsh.exe"* ]]
  [[ "$output" == *"PowerShell 7.6.6"* ]]
  [[ "$output" != *"НЕТ  pwsh"* ]]

  # Найденный, но нерабочий alias не должен проходить как ok и попадать в psRunner.
  local bad_dir="$BATS_TEST_TMPDIR/win-pwsh-broken"
  mkdir -p "$bad_dir"
  ln -sf "$(command -v node)" "$bad_dir/node"
  printf '#!/bin/sh\nexit 1\n' >"$bad_dir/pwsh.exe"
  chmod +x "$bad_dir/pwsh.exe"
  run env PATH="$bad_dir" PATHEXT=".exe" CENTER_PLATFORM=win32 \
    NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-pwsh-stat.cjs" \
    "$(command -v node)" "$CENTER/bin/center.mjs" prereqs
  [ "$status" -eq 1 ]
  [[ "$output" == *"pwsh"* ]]
  [[ "$output" == *"не ответил"* ]]
  [[ "$output" != *"ok   pwsh"* ]]
}

@test "win32: PATH из Git Bash (через :) тоже находит инструменты" {
  local dir="$BATS_TEST_TMPDIR/gitbash"
  mkdir -p "$dir"
  printf '@echo off\r\necho v22.23.1\r\nexit /b 0\r\n' >"$dir/node.CMD"

  # Git Bash отдаёт ту же переменную через «:»: разбор «по платформе» нашёл бы ноль каталогов
  run env PATH="$dir:/usr/bin" PATHEXT=".COM;.EXE;.BAT;.CMD" CENTER_PLATFORM=win32 "$(command -v node)" "$CENTER/bin/center.mjs" prereqs
  [[ "$output" == *"ok   node         $dir/node.CMD"* ]]
}

@test "win32: план fresh зовёт .ps1-обёртки и честно пропускает шаги без своей формы" {
  run env CENTER_PLATFORM=win32 node "$CENTER/bin/center.mjs" fresh
  [ "$status" -eq 0 ]
  [[ "$output" == *"0. снос: cleanup-station clean-all --yes"* ]]
  [[ "$output" == *"шаг «скилл переезда» на этой ОС пропущен"* ]]
  [[ "$output" == *"шаг «часовая автопроверка» на этой ОС пропущен"* ]]
  [[ "$output" == *"шаг «сторож и бэкап набора» на этой ОС пропущен"* ]]
  [[ "$output" == *"mcp-station/bin/keys.ps1 import"* ]]
  [[ "$output" != *"skills-hub/contrib/install-units.sh &&"* ]]
}

@test "win32: план bootstrap называет PowerShell-обёртки, а не bash" {
  run env CENTER_PLATFORM=win32 node "$CENTER/bin/center.mjs" bootstrap
  [ "$status" -eq 0 ]
  [[ "$output" == *"pwsh -NoProfile -File skills-hub/contrib/install-links.ps1"* ]]
  [[ "$output" == *"cli-station.ps1"* ]]
  [[ "$output" == *"на Windows этого шага нет"* ]]
  [[ "$output" != *"bash skills-hub/contrib/install-links.sh"* ]]
}

# ── отказ по контракту: неизвестная команда/флаг и битый реестр ────────────────────────────────

@test "неизвестная команда или флаг — отказ по контракту, а не молчаливый status с нулём" {
  run node "$CENTER/bin/center.mjs" frobnicate
  [ "$status" -eq 1 ]
  [[ "$output" == *"неизвестная команда frobnicate"* ]]

  run node "$CENTER/bin/center.mjs" --frobnicate
  [ "$status" -eq 1 ]
  [[ "$output" == *"неизвестный флаг --frobnicate"* ]]

  # флаг перед командой не подменяет её на status: команду берём из первого слова-команды
  run node "$CENTER/bin/center.mjs" --dry-run bootstrap
  [ "$status" -eq 0 ]
  [[ "$output" != *"диск: "* ]]
  [[ "$output" == *"остаётся руками"* ]]

  # мусор в значении флага — своя строка и код 2 (это не «неизвестный флаг», а неверное значение)
  run node "$CENTER/bin/center.mjs" logs mcp-station --tail ноль
  [ "$status" -eq 2 ]
  [[ "$output" == *"--tail принимает число строк"* ]]
}

@test "битый реестр — строка контракта и код 1, а не стектрейс" {
  printf '{ это не json\n' >"$BATS_TEST_TMPDIR/registry-broken.json"
  run env CENTER_REGISTRY="$BATS_TEST_TMPDIR/registry-broken.json" node "$CENTER/bin/center.mjs" status
  [ "$status" -eq 1 ]
  [[ "$output" == *"реестр не разобран"* ]]
  [[ "$output" == *"registry-broken.json"* ]]
  [[ "$output" != *"SyntaxError"* ]]

  # реестр разобран, но списка проектов в нём нет — тоже строка контракта
  printf '{"projects":{}}\n' >"$BATS_TEST_TMPDIR/registry-nolist.json"
  run env CENTER_REGISTRY="$BATS_TEST_TMPDIR/registry-nolist.json" node "$CENTER/bin/center.mjs" status
  [ "$status" -eq 1 ]
  [[ "$output" == *"поле projects — не список проектов"* ]]
  [[ "$output" != *"TypeError"* ]]
}

# ── сторож набора (bin/sentinel.sh): диск DATA и ссылки в $HOME ─────────────────────────────────

# Заглушка сторожа: подменённый дом с одной ссылкой и реестр, который её объявляет. Живой дом не
# трогается, поэтому проверка не зависит от того, что лежит в настоящем $HOME.
sentinel_env() { # $1 — куда ведёт ссылка
  SENT="$BATS_TEST_TMPDIR/sentinel"
  mkdir -p "$SENT/home/.agents/skills"
  rm -f "$SENT/home/.agents/skills/ghost"
  ln -s "$1" "$SENT/home/.agents/skills/ghost"
  cat >"$SENT/registry.json" <<'EOF'
{"projects":[{"name":"proj","what":"заглушка","expectLinks":[{"link":"$HOME/.agents/skills/ghost","into":"proj"}]}]}
EOF
}

@test "sentinel: живой набор — код 0 и одна строка отчёта" {
  # набор лежит на диске DATA (отдельное устройство) — это и есть проверяемое состояние;
  # дом берём настоящий: подменённый CENTER_HOME из setup() сделал бы живые ссылки мёртвыми
  run env -u CENTER_HOME bash "$CENTER/bin/sentinel.sh"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | wc -l)" -eq 1 ]
  [[ "$output" == *"ссылок целых"* ]]
  [[ "$output" == *"версия набора"* ]]

  run env -u CENTER_HOME bash "$CENTER/bin/sentinel.sh" --json
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -r "[.ok, .mounted, (.links.total == .links.ok), (.problems | length)] | join(\"|\")"' _ "$output"
  [ "$output" = "true|true|true|0" ]

  # режим таймера: пока всё живо — молчит
  run env -u CENTER_HOME bash "$CENTER/bin/sentinel.sh" --quiet
  [ "$status" -eq 0 ]
  [ -z "$output" ]

  # PowerShell-обёртка идёт в тот же движок: тот же вердикт и тот же код
  if command -v pwsh >/dev/null 2>&1; then
    run env -u CENTER_HOME pwsh -NoProfile -File "$CENTER/bin/sentinel.ps1" --json
    [ "$status" -eq 0 ]
    run bash -c 'printf "%s" "$1" | jq -r "[.ok, .mounted] | join(\"|\")"' _ "$output"
    [ "$output" = "true|true" ]
  fi
}

@test "sentinel: мёртвая ссылка названа, цель вне набора — тоже" {
  sentinel_env "$BATS_TEST_TMPDIR/нет-такой-цели"
  run env CENTER_HOME="$SENT/home" CENTER_REGISTRY="$SENT/registry.json" bash "$CENTER/bin/sentinel.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"ghost"* ]]
  [[ "$output" == *"мёртвая ссылка"* ]]
  [[ "$output" == *"proj"* ]]

  # в режиме таймера проблема видна: молчание оставляет юнит зелёным, а ссылки мёртвыми
  run env CENTER_HOME="$SENT/home" CENTER_REGISTRY="$SENT/registry.json" bash "$CENTER/bin/sentinel.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"мёртвая ссылка"* ]]

  # цель жива, но лежит вне набора: после пропажи диска такая ссылка не оживёт
  mkdir -p "$BATS_TEST_TMPDIR/вне-набора"
  sentinel_env "$BATS_TEST_TMPDIR/вне-набора"
  run env CENTER_HOME="$SENT/home" CENTER_REGISTRY="$SENT/registry.json" bash "$CENTER/bin/sentinel.sh" --json
  [ "$status" -eq 1 ]
  [[ "$output" == *"вне набора"* ]]

  # битый реестр — это проблема сторожа, а не стектрейс
  printf '{ не json\n' >"$SENT/registry.json"
  run env CENTER_HOME="$SENT/home" CENTER_REGISTRY="$SENT/registry.json" bash "$CENTER/bin/sentinel.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"реестр не разобран"* ]]
}

# ── бэкап набора (center backup) ───────────────────────────────────────────────────────────────

@test "backup: отказывается писать на тот же диск и пишет архив с .sha256 на другом" {
  # цель внутри набора — это тот же диск: отказ ДО любых записей
  local inside="$CENTER/../backup-test-$$"
  run bash "$CENTER/bin/center.sh" backup --to "$inside"
  [ "$status" -eq 1 ]
  [[ "$output" == *"тот же диск — это не бэкап"* ]]
  [ ! -e "$inside" ]
  rm -rf "$inside"

  # план ничего не пишет и не создаёт каталог цели
  local dry="$BATS_TEST_TMPDIR/backup-dry"
  run bash "$CENTER/bin/center.sh" backup --dry-run --to "$dry"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ничего не пишу"* ]]
  [ ! -e "$dry" ]

  if [ "$(stat -c %d "$BATS_TEST_TMPDIR")" = "$(stat -c %d "$CENTER/..")" ]; then
    skip "тестовый каталог на том же устройстве, что набор: бэкап тут отвергнут по делу"
  fi

  # цель на другом устройстве: архив, контрольная сумма рядом и читаемое оглавление
  local out="$BATS_TEST_TMPDIR/backup-out"
  run bash "$CENTER/bin/center.sh" backup --to "$out" --keep 2
  [ "$status" -eq 0 ]
  [[ "$output" == *"sha256:"* ]]
  [[ "$output" == *"оглавление:"* ]]
  local archive
  archive="$(ls "$out"/*.tar.zst "$out"/*.tar.gz 2>/dev/null | head -1)"
  [ -f "$archive" ]
  [ -f "$archive.sha256" ]

  run bash -c 'cd "$1" && sha256sum -c ./*.sha256' _ "$out"
  [ "$status" -eq 0 ]
  # и сумма в файле — от этого архива (текст «OK» sha256sum переводится локалью, поэтому сверяем хеш)
  [ "$(cut -d' ' -f1 <"$archive.sha256")" = "$(sha256sum "$archive" | cut -d' ' -f1)" ]

  run tar -tf "$archive"
  [ "$status" -eq 0 ]
  [[ "$output" == *"command-center/registry.json"* ]]
  [[ "$output" == *"/.git/"* ]]      # .git — и корневой, и подпроектов — в бэкап входит
  [[ "$output" != *"node_modules"* ]]
  [[ "$output" != *"__pycache__"* ]]

  # ротация: держим один архив — старый уходит вместе со своей суммой
  sleep 1.1
  run bash "$CENTER/bin/center.sh" backup --to "$out" --keep 1
  [ "$status" -eq 0 ]
  [[ "$output" == *"оставлено 1"* ]]
  [ "$(ls "$out"/*.tar.zst "$out"/*.tar.gz 2>/dev/null | wc -l)" -eq 1 ]
  [ "$(ls "$out"/*.sha256 | wc -l)" -eq 1 ]

  run bash "$CENTER/bin/center.sh" backup --json --to "$out" --keep 1
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -r "[.ok, (.bytes > 0), (.sha256 | length == 64), (.version | length > 0), (.entries > 0), (.excludes | length > 0)] | join(\"|\")"' _ "$output"
  [ "$output" = "true|true|true|true|true|true" ]
}

@test "backup: неудачный tar не оставляет финальный архив или .partial" {
  local out="$BATS_TEST_TMPDIR/backup-partial"
  local fakebin="$BATS_TEST_TMPDIR/fake-tar-bin"
  mkdir -p "$fakebin"
  cat >"$fakebin/tar" <<'EOF'
#!/usr/bin/env bash
set -eu
archive=""
previous=""
for arg in "$@"; do
  if [[ "$previous" == "-cf" ]]; then archive="$arg"; fi
  previous="$arg"
done
if [[ -n "$archive" ]]; then
  printf 'partial\n' >"$archive"
  exit 1
fi
exec /usr/bin/tar "$@"
EOF
  chmod +x "$fakebin/tar"

  run env PATH="$fakebin:$PATH" bash "$CENTER/bin/center.sh" backup --force-same-disk --to "$out"
  [ "$status" -eq 1 ]
  [ ! -e "$out" ] || [ -z "$(find "$out" -maxdepth 1 -type f -print -quit)" ]
}

@test "release: refuses dirty tree and explicit allow-dirty creates manifest" {
  local out="$BATS_TEST_TMPDIR/release-out"
  run bash "$CENTER/bin/center.sh" release --force-same-disk --to "$out"
  [ "$status" -eq 1 ]
  [[ "$output" == *"несохранённые правки"* || "$output" == *"dirty"* ]]
  [ ! -e "$out" ]

  run bash "$CENTER/bin/center.sh" release --allow-dirty --force-same-disk --to "$out"
  [ "$status" -eq 0 ]
  local archive manifest
  archive="$(ls "$out"/AGGG-*.tar.zst "$out"/AGGG-*.tar.gz 2>/dev/null | head -1)"
  manifest="$archive.manifest.json"
  [ -f "$archive" ]
  [ -f "$archive.sha256" ]
  [ -f "$manifest" ]
  run bash -c 'jq -e "[.version, (.root.commit != null), (.projects | length > 0), (.archiveSha256 | length == 64), ([.projects[] | select(.name == \"camoufox-research\") | .commit] | length == 1)] | all" "$1" >/dev/null' _ "$manifest"
  [ "$status" -eq 0 ]
  run tar -tf "$archive"
  [ "$status" -eq 0 ]
  [[ "$output" == *"command-center/registry.json"* ]]
  [[ "$output" != *"/.git/"* ]]
  [[ "$output" != *"wiki.db"* ]]
  [[ "$output" != *"багрепорт.md"* ]]
  [[ "$output" != *".envrc"* ]]
}

# ── сторожа в статусе и обёртка таймера: видно ли, что таймеры живы ────────────────────────────

@test "status --strict красный, если таймеры не активны" {
  stub_env
  stub_center "$STUBS/registry-ok.json" status --strict
  [ "$status" -eq 1 ]
  [[ "$output" == *"сторожа"* ]]
}

@test "status: строка про сторожей — юниты, таймер и последний прогон от systemd" {
  stub_env

  # юнитов нет — строка зовёт их поставить, а не молчит «всё хорошо»
  stub_center "$STUBS/registry-ok.json" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"сторожа"* ]]
  [[ "$output" == *"юнита нет: поставь bash contrib/install-units.sh"* ]]

  local units="$CENTER_HOME/.config/systemd/user"
  mkdir -p "$units/timers.target.wants" "$CENTER_HOME/.config/center" "$BATS_TEST_TMPDIR/bin"
  for unit in center-sentinel center-backup; do
    printf '[Unit]\n' >"$units/$unit.service"
    printf '[Timer]\n' >"$units/$unit.timer"
    ln -s "../$unit.timer" "$units/timers.target.wants/$unit.timer"
  done
  printf '%s\n' "$BATS_TEST_TMPDIR/local-target" >"$CENTER_HOME/.config/center/backup.target"

  # systemctl подменён: отвечает так же, как настоящий (Key=Value построчно)
  cat >"$BATS_TEST_TMPDIR/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${3:-}" in
  center-sentinel.timer) printf 'ActiveState=active\nUnitFileState=enabled\nLastTriggerUSec=Tue 2026-09-22 23:16:03 EEST\n' ;;
  center-sentinel.service) printf 'Result=success\nExecMainExitTimestamp=Tue 2026-09-22 23:16:03 EEST\n' ;;
  center-backup.timer) printf 'ActiveState=active\nUnitFileState=enabled\nLastTriggerUSec=Tue 2026-09-22 03:30:00 EEST\n' ;;
  center-backup.service) printf 'Result=failed\nExecMainExitTimestamp=Tue 2026-09-22 03:30:00 EEST\n' ;;
  *) printf 'UnitFileState=disabled\nActiveState=inactive\nResult=success\nExecMainExitTimestamp=\n' ;;
esac
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/systemctl"
  PATH="$BATS_TEST_TMPDIR/bin:$PATH"

  stub_center "$STUBS/registry-ok.json" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok   сторож набора"* ]]
  [[ "$output" == *"прогон 23:16:03 — success"* ]]
  # упавший ночной прогон виден строкой и зовёт в журнал — это и есть «сторож за сторожем»
  [[ "$output" == *"нет  ночной бэкап"* ]]
  [[ "$output" == *"прогон 03:30:00 — failed"* ]]
  [[ "$output" == *"journalctl --user -u center-backup"* ]]
  [[ "$output" == *"целей 1"* ]]
}

@test "обёртка таймера: бэкап идёт по целям, одна неудача не отменяет остальные" {
  local root="$BATS_TEST_TMPDIR/wrap"
  local fake="$root/center"
  mkdir -p "$fake/bin" "$root/home/.config/center"
  # обёртка считает диск примонтированным, когда рядом с центром лежит VERSION (и это не корневая ФС)
  printf '5.3.0\n' >"$root/VERSION"

  cat >"$fake/bin/center.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$WRAP_LOG"
if [[ -n "${WRAP_FAIL:-}" && "$*" == *"$WRAP_FAIL"* ]]; then
  printf 'центр: отказ по делу\n' >&2
  exit 1
fi
EOF
  chmod +x "$fake/bin/center.sh"

  sed "s|@CENTER@|$fake|" "$CENTER/contrib/center-local.sh.in" >"$root/center-local.sh"
  chmod +x "$root/center-local.sh"
  export WRAP_LOG="$root/log"
  : >"$WRAP_LOG"

  # две цели: локальная копия и оффлайн-носитель, у второй свой --keep
  printf '%s\n%s\n# комментарий\n\n' "$root/local" "$root/offline 5" >"$root/home/.config/center/backup.target"
  run env HOME="$root/home" XDG_CONFIG_HOME= bash "$root/center-local.sh" backup
  [ "$status" -eq 0 ]
  [[ "$(cat "$WRAP_LOG")" == *"--to $root/local"* ]]
  [[ "$(cat "$WRAP_LOG")" == *"--to $root/offline --keep 5"* ]]

  # первая цель отказывает: вторая всё равно взята, код 1 — юнит упадёт видимо
  printf '%s\n%s\n' "$root/offline" "$root/local" >"$root/home/.config/center/backup.target"
  : >"$WRAP_LOG"
  run env HOME="$root/home" XDG_CONFIG_HOME= WRAP_FAIL="$root/offline" bash "$root/center-local.sh" backup
  [ "$status" -eq 1 ]
  [[ "$output" == *"не забэкапилась"* ]]
  [[ "$(cat "$WRAP_LOG")" == *"--to $root/local"* ]]

  # целей нет — честный отказ, а не «забэкапил в никуда»
  printf '# только комментарий\n\n' >"$root/home/.config/center/backup.target"
  run env HOME="$root/home" XDG_CONFIG_HOME= bash "$root/center-local.sh" backup
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет ни одного пути"* ]]
}

@test "обёртка бэкапа принимает путь с пробелами через формат path|keep" {
  local root="$BATS_TEST_TMPDIR/wrap-space"
  local fake="$root/center"
  mkdir -p "$fake/bin" "$root/home/.config/center"
  printf '5.3.0\n' >"$root/VERSION"
  cat >"$fake/bin/center.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$WRAP_LOG"
EOF
  chmod +x "$fake/bin/center.sh"
  sed "s|@CENTER@|$fake|" "$CENTER/contrib/center-local.sh.in" >"$root/center-local.sh"
  chmod +x "$root/center-local.sh"
  export WRAP_LOG="$root/log"
  : >"$WRAP_LOG"
  printf '%s|5\n' "$root/offline disk" >"$root/home/.config/center/backup.target"
  run env HOME="$root/home" XDG_CONFIG_HOME= bash "$root/center-local.sh" backup
  [ "$status" -eq 0 ]
  [[ "$(cat "$WRAP_LOG")" == *"--to $root/offline disk --keep 5"* ]]
}

# ── восстановление набора (center restore) ─────────────────────────────────────────────────────

@test "restore: живой набор не трогает и требует пустой каталог" {
  # настоящий архив тут не нужен: отказы обязаны случиться ДО распаковки, и это и проверяем
  local fake="$BATS_TEST_TMPDIR/fake.tar.zst"
  printf 'не архив\n' >"$fake"

  local inside="$CENTER/../restore-test-$$"
  run bash "$CENTER/bin/center.sh" restore --from "$fake" --to "$inside"
  [ "$status" -eq 1 ]
  [[ "$output" == *"внутри живого набора"* ]]
  [ ! -e "$inside" ]

  run bash "$CENTER/bin/center.sh" restore --from "$fake" --to "$CENTER/.."
  [ "$status" -eq 1 ]
  [[ "$output" == *"внутри живого набора"* ]]

  # родитель набора тоже отвергается: распаковка легла бы поверх живого набора
  run bash "$CENTER/bin/center.sh" restore --from "$fake" --to "$(cd "$CENTER/../.." && pwd)"
  [ "$status" -eq 1 ]
  [[ "$output" == *"родитель живого набора"* ]]

  local busy="$BATS_TEST_TMPDIR/busy"
  mkdir -p "$busy"
  printf 'x' >"$busy/файл"
  run bash "$CENTER/bin/center.sh" restore --from "$fake" --to "$busy"
  [ "$status" -eq 1 ]
  [[ "$output" == *"не пуст"* ]]

  # каталог без архивов — честный отказ, а не «восстановил из ничего»
  run bash "$CENTER/bin/center.sh" restore --from "$BATS_TEST_TMPDIR" --to "$BATS_TEST_TMPDIR/out"
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет архивов"* ]]
}

@test "restore: свежий архив распаковывается в сторону, копия проходит свои проверки" {
  # бэкап — в тестовый каталог, возможно на том же диске: тут проверяем не правило диска, поэтому --force
  local out="$BATS_TEST_TMPDIR/backups"
  run bash "$CENTER/bin/center.sh" backup --force-same-disk --to "$out"
  [ "$status" -eq 0 ]

  local drill="$BATS_TEST_TMPDIR/drill"
  run bash "$CENTER/bin/center.sh" restore --dry-run --from "$out" --to "$drill"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ничего не распаковываю"* ]]
  [ ! -e "$drill" ]

  run bash "$CENTER/bin/center.sh" restore --from "$out" --to "$drill"
  [ "$status" -eq 0 ]
  [[ "$output" == *"копия живая"* ]]
  [[ "$output" == *"ok   VERSION"* ]]
  [[ "$output" == *"ok   реестр и пути"* ]]
  [[ "$output" == *"ok   гейт доков копии"* ]]

  # копия — это набор, а не куча файлов: версия и реестр у центра на месте
  local set
  set="$(ls -d "$drill"/AGGG* | head -1)"
  [ -f "$set/VERSION" ]
  [ -f "$set/command-center/registry.json" ]
  [ -x "$set/command-center/bin/center.sh" ]

  # битая контрольная сумма останавливает восстановление до распаковки
  local archive
  archive="$(ls "$out"/*.tar.zst "$out"/*.tar.gz | head -1)"
  printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$(basename "$archive")" >"$archive.sha256"
  run bash "$CENTER/bin/center.sh" restore --from "$archive" --to "$BATS_TEST_TMPDIR/drill-broken"
  [ "$status" -eq 1 ]
  [[ "$output" == *"контрольная сумма не сходится"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/drill-broken" ]
}

@test "restore: отсутствие docs-gate в копии отвергается по умолчанию" {
  local out="$BATS_TEST_TMPDIR/restore-no-gate"
  run bash "$CENTER/bin/center.sh" backup --force-same-disk --to "$out"
  [ "$status" -eq 0 ]
  local archive
  archive="$(ls "$out"/*.tar.zst "$out"/*.tar.gz | head -1)"
  local staged="$BATS_TEST_TMPDIR/staged-no-gate"
  mkdir -p "$staged"
  tar -xf "$archive" -C "$staged"
  rm -f "$(find "$staged" -path '*/command-center/bin/docs-check.sh' -print -quit)"
  tar -cf "$out/no-gate.tar.gz" -C "$staged" "$(basename "$(find "$staged" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
  sha256sum "$out/no-gate.tar.gz" | awk '{print $1 "  no-gate.tar.gz"}' >"$out/no-gate.tar.gz.sha256"
  run bash "$CENTER/bin/center.sh" restore --from "$out/no-gate.tar.gz" --to "$BATS_TEST_TMPDIR/no-gate-drill"
  [ "$status" -eq 1 ]
  [[ "$output" == *"гейт доков"* ]]
  [[ ! -e "$BATS_TEST_TMPDIR/no-gate-drill" ]]
}

@test "restore: отсутствие checksum в release-архиве отвергается по умолчанию" {
  local out="$BATS_TEST_TMPDIR/restore-no-checksum"
  run bash "$CENTER/bin/center.sh" backup --force-same-disk --to "$out"
  [ "$status" -eq 0 ]
  local archive
  archive="$(ls "$out"/*.tar.zst "$out"/*.tar.gz | head -1)"
  rm -f "$archive.sha256"
  run bash "$CENTER/bin/center.sh" restore --from "$archive" --to "$BATS_TEST_TMPDIR/no-checksum-drill"
  [ "$status" -eq 1 ]
  [[ "$output" == *"контрольная сумма обязательна"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/no-checksum-drill" ]
}

@test "restore: отказывается от архива с .. до распаковки" {
  local out="$BATS_TEST_TMPDIR/malformed-archive"
  mkdir -p "$out"
  python3 - "$out/AGGG-9.9.9-20260923-000000.tar.gz" <<'PY'
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as archive:
    info = tarfile.TarInfo("AGGG/../../marker")
    data = b"owned"
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))
PY
  sha256sum "$out/AGGG-9.9.9-20260923-000000.tar.gz" | awk '{print $1 "  AGGG-9.9.9-20260923-000000.tar.gz"}' >"$out/AGGG-9.9.9-20260923-000000.tar.gz.sha256"
  run bash "$CENTER/bin/center.sh" restore --from "$out/AGGG-9.9.9-20260923-000000.tar.gz" --to "$BATS_TEST_TMPDIR/malformed-drill"
  [ "$status" -eq 1 ]
  [[ "$output" == *"небезопасный путь"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/marker" ]
  [ ! -e "$BATS_TEST_TMPDIR/malformed-drill" ]
}

# ── doctor: точки входа объявлены для ВСЕХ платформ реестра ────────────────────────────────────

@test "doctor ловит объявленную-но-отсутствующую точку входа чужой платформы" {
  stub_env
  # реестр объявляет windows-точку, которой на диске нет: на Linux её раньше никто не спрашивал
  cat >"$STUBS/registry-win.json" <<'EOF'
{"projects":[
 {"name":"updater","what":"заглушка с битым windows-путём","run":"bin/upd.sh","runWindows":"windows/install.ps1"},
 {"name":"quiet","what":"заглушка с живой windows-точкой","run":"bin/upd.sh","runWindows":"bin/upd.sh"}
]}
EOF
  stub_center "$STUBS/registry-win.json" doctor
  [ "$status" -eq 1 ]
  [[ "$output" == *"updater: точка входа (Windows) windows/install.ps1 — объявлено для win32, файла нет"* ]]
  # живая чужая точка — не строка в отчёте: чужая ОС проверяется только на «объявлено, а файла нет»
  [[ "$output" != *"quiet: точка входа (Windows)"* ]]

  # и на живом реестре такой строки быть не должно: каждая объявленная windows-точка лежит на диске
  run env -u CENTER_HOME node "$CENTER/bin/center.mjs" doctor
  [ "$status" -eq 0 ]
  [[ "$output" != *"объявлено для win32, файла нет"* ]]
}

# ── новые классы гейта доков: строгий режим и покрытие прогона ──────────────────────────────────

@test "гейт доков: .sh без строгого режима — расхождение, исключение с причиной — нет" {
  local root="$BATS_TEST_TMPDIR/disk-strict"
  docs_fixture "$root" 3
  # забытая шапка: set -eu без pipefail (порт рядом, чтобы расхождение было только про строгость)
  printf '#!/usr/bin/env bash\nset -eu\nprintf "работаю\\n"\n' >"$root/alpha/bin/loose.sh"
  printf '#Requires -Version 5.1\nexit 0\n' >"$root/alpha/bin/loose.ps1"

  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"strict: alpha/bin/loose.sh"* ]]
  [[ "$output" == *"без -u или без pipefail"* ]]
  [[ "$output" == *"strict-exceptions.txt"* ]]

  # причина снимает расхождение...
  printf 'alpha/bin/loose.sh|POSIX sh: pipefail там нет как механизма\n' >"$root/command-center/strict-exceptions.txt"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 0 ]
  [[ "$output" == *"сходятся с фактом"* ]]

  # ...а протухшая строка (строгий режим уже поставили) — снова расхождение
  printf '#!/usr/bin/env bash\nset -euo pipefail\nprintf "работаю\\n"\n' >"$root/alpha/bin/loose.sh"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"уже есть set с -u и pipefail"* ]]

  # строку без причины гейт не принимает: формат «путь|причина»
  printf 'alpha/bin/loose.sh\n' >"$root/command-center/strict-exceptions.txt"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"строка 1 без причины"* ]]
}

@test "гейт доков: набор bats вне прогона — расхождение, исключение с причиной — нет" {
  local root="$BATS_TEST_TMPDIR/disk-coverage"
  docs_fixture "$root" 3
  # свой прогон: зовёт только один набор из двух — второй остаётся вне прогона
  printf '@test "ещё один" { true; }\n' >"$root/alpha/tests/extra.bats"
  cat >"$root/skills-hub/contrib/skills-hub-check.sh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf '\n== bats: alpha\n'
(cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../alpha" && bats tests/station.bats) || status=1
EOF
  printf '#Requires -Version 5.1\nexit 0\n' >"$root/skills-hub/contrib/skills-hub-check.ps1"

  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"coverage: alpha/tests/extra.bats"* ]]
  [[ "$output" == *"check-coverage-exceptions.txt"* ]]

  printf 'alpha/tests/extra.bats|набор гоняет сам проект\n' >"$root/command-center/check-coverage-exceptions.txt"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 0 ]
  [[ "$output" == *"сходятся с фактом"* ]]

  # а если набор уже в прогоне, строка протухла — и это расхождение
  printf 'alpha/tests/station.bats|набор гоняет сам проект\n' >"$root/command-center/check-coverage-exceptions.txt"
  run env DOCS_CHECK_ROOT="$root" bash "$CENTER/bin/docs-check.sh" --quiet
  [ "$status" -eq 1 ]
  [[ "$output" == *"уже зовётся прогоном"* ]]
}

@test "гейт доков: в фактах видно строгий режим и покрытие прогона" {
  # состояние чужих доков тут не проверяем: кейс про то, что факты новых классов посчитаны
  run bash "$CENTER/bin/docs-check.sh" --json
  run bash -c 'printf "%s" "$1" | jq -r "[(.facts.strict_sh > 0), (.facts.strict_exceptions > 0), (.facts.strict_violations >= 0), (.facts.bats_covered > 0), (.facts.coverage_exceptions > 0), (.facts.bats_files_all > 0)] | join(\"|\")"' _ "$output"
  [ "$output" = "true|true|true|true|true|true" ]

  run bash "$CENTER/bin/docs-check.sh"
  [[ "$output" == *"строгий режим — .sh"* ]]
  [[ "$output" == *"покрытие прогона — наборов bats на диске"* ]]
}

@test "outdated: unknown в сводке станции — провал сверки, а не «свежо»" {
  stub_env
  # заглушка отвечает так, как станция, которая не смогла спросить: строки без ответа и unknown в сводке
  mkdir -p "$PROJECTS/doubtful/bin"
  cat >"$PROJECTS/doubtful/bin/upd.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${UNKNOWN_KIND:-count}" in
  count) printf '{"ok":true,"schema":1,"plugins":[{"name":"x","status":"unknown"}],"summary":{"current":1,"unknown":2}}\n' ;;
  nan)   printf '{"ok":true,"schema":1,"plugins":[{"name":"x","status":"unknown"}],"summary":{"current":1,"unknown":null}}\n' ;;
  zero)  printf '{"ok":true,"schema":1,"plugins":[{"name":"x","status":"current"}],"summary":{"current":1,"unknown":0}}\n' ;;
esac
EOF
  chmod +x "$PROJECTS/doubtful/bin/upd.sh"
  cat >"$STUBS/registry-unknown.json" <<'EOF'
{"projects":[{"name":"doubtful","what":"заглушка: сверка не досчиталась","outdated":"bin/upd.sh outdated --json","outdatedUnit":"плагин"}]}
EOF
  doubtful() {
    run env -u XDG_CONFIG_HOME CENTER_REGISTRY="$STUBS/registry-unknown.json" CENTER_PROJECTS_ROOT="$PROJECTS" \
        UNKNOWN_KIND="$1" node "$CENTER/bin/center.mjs" "${@:2}"
  }

  # сводка says unknown — это провал сверки: «обновить» тут соврало бы, «свежо» — тем более
  doubtful count outdated --json
  [ "$status" -eq 1 ]
  run bash -c 'printf "%s" "$1" | jq -r "[.ok, (.projects[0].status), (.projects[0].detail | test(\"без ответа\"))] | join(\"|\")"' _ "$output"
  [ "$output" = "false|unknown|true" ]

  doubtful count outdated
  [ "$status" -eq 1 ]
  [[ "$output" == *"doubtful"*"сверка не удалась"* ]]
  [[ "$output" == *"сверка не удалась 1"* ]]

  # счёт, который не сосчитался (в JSON это null), — та же история: молчаливого «свежо» быть не должно
  doubtful nan outdated --json
  [ "$status" -eq 1 ]
  [[ "$output" == *"сверка не удалась"* ]]

  # а честный ноль в unknown ничего не ломает: сверка прошла, изменений нет
  doubtful zero outdated --json
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -r "[.ok, (.projects[0].status), .projects[0].detail] | join(\"|\")"' _ "$output"
  [ "$output" = "true|current|изменений нет" ]

  # в status тот же провал виден строкой, а не нулём
  doubtful count status
  [ "$status" -eq 0 ]
  [[ "$output" == *"doubtful"*"↻ сверка не удалась"* ]]
}
