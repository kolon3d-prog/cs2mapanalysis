#!/usr/bin/env bats
# Оффлайн-набор skills-hub: curl, npx и gh подменены заглушками из tests/stubs,
# HOME изолирован — реальные ~/.agents, симлинки и сеть не трогаются.
# Запуск: bats tests/hub.bats

setup() {
  HUB="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export HUB
  export FIXTURES="$BATS_TEST_DIRNAME/fixtures"
  export STUB_LOG="$BATS_TEST_TMPDIR/stub.log"
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  export HOME="$BATS_TEST_TMPDIR/home"
  unset STUB_SLEEP FIXTURE_SEARCH FIXTURE_SKILLSMP SKILLS_TIMEOUT SKILLS_HTTP_TIMEOUT
  mkdir -p "$HOME"
  : >"$STUB_LOG"
  cd "$BATS_TEST_TMPDIR"
}

manager() {
  bash "$HUB/skills-manager.sh" "$@"
}

@test "sources перечисляет четыре маркета" {
  run manager sources
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 4 ]
  [[ "${lines[0]}" == skills-sh* ]]
}

@test "skills-sh: выдача отсортирована по установкам и уважает --limit" {
  run manager search pdf --limit 2
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 4 ]
  [[ "${lines[0]}" == "acme/tools@popular"* ]]
  [[ "${lines[2]}" == "vercel-labs/json-render@react-pdf"* ]]
}

@test "skills-sh: пустая выдача — одна строка без ошибки" {
  run env FIXTURE_SEARCH=skills-sh-empty.json bash "$HUB/skills-manager.sh" search nothing-matches-this
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "nothing found for: nothing-matches-this" ]]
}

@test "skills-sh: --json отдаёт разобранный JSON" {
  run bash -c 'bash "$1" search pdf --json --limit 1 | jq -r ".skills[0].name"' _ "$HUB/skills-manager.sh"
  [ "$status" -eq 0 ]
  [ "$output" = "popular" ]
}

@test "skillsmp: один ref — одна строка, совпадение по имени выше звёзд" {
  run manager search scraper --source skillsmp --limit 5
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "acme/tools@scraper"* ]]
  [ "$(printf '%s\n' "${lines[@]}" | grep -c 'acme/tools@dupe')" -eq 1 ]
}

@test "--source all: дубли между маркетами схлопываются" {
  run manager search pdf --source all --limit 5
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "${lines[@]}" | grep -c 'acme/tools@shared')" -eq 1 ]
  [[ "${lines[${#lines[@]} - 1]}" == "(скрыто дублей: 1)" ]]
}

@test "list: CLI получает -g" {
  run manager list
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "Global Skills" ]]
  grep -q '^skills list -g' "$STUB_LOG"
}

@test "list: неизвестный флаг не проглатывается" {
  run manager list --nope
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown flag"* ]]
}

@test "inspect --source auto: owner/repo@skill уходит в skills-sh" {
  run manager inspect acme/tools@fixture --source auto
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "source: skills-sh" ]]
  [[ "$output" == *"name: fixture"* ]]
}

@test "inspect --source auto: слаг без слэша уходит в clawhub" {
  run manager inspect fixture-slug --source auto
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "source: clawhub" ]]
  [[ "$output" == *"name: fixture"* ]]
}

@test "search --source auto объясняет, что auto только для пакетов" {
  run manager search pdf --source auto
  [ "$status" -eq 1 ]
  [[ "$output" == *"--source auto применим только к inspect/install"* ]]
}

@test "install --project: lock и папка скилла внутри проекта" {
  run manager install acme/tools@fixture --project
  [ "$status" -eq 0 ]
  [[ "$output" == *"locked: $PWD/skills-lock.json"* ]]
  [[ "$output" == *"skill:  $PWD/.agents/skills/fixture"* ]]
  [ -f "$PWD/.agents/skills/fixture/SKILL.md" ]
}

@test "search --source bogus: понятная ошибка" {
  run manager search pdf --source bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"unknown source: bogus"* ]]
}

@test "skillsmp: --sort принимает только stars и recent" {
  run manager search pdf --source skillsmp --sort bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"--sort принимает stars или recent"* ]]
}

@test "install-links: создаёт оба симлинка на чистом доме, повтор идемпотентен" {
  run bash "$HUB/contrib/install-links.sh"
  [ "$status" -eq 0 ]
  [ -L "$HOME/.local/bin/skills-manager" ]
  [ -L "$HOME/.agents/skills/skills-ops" ]
  [ "$(physical "$HOME/.local/bin/skills-manager")" = "$(physical "$HUB/skills-manager.sh")" ]

  run bash "$HUB/contrib/install-links.sh"
  [[ "$output" == *"уже ведёт сюда"* ]]
}

@test "install-links --dry-run ничего не создаёт" {
  run bash "$HUB/contrib/install-links.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$HOME/.local/bin/skills-manager" ]
}

@test "doctor: пустой HOME — два FAIL и код возврата 1" {
  run manager doctor
  [ "$status" -eq 1 ]
  [ "$(printf '%s\n' "${lines[@]}" | grep -c 'FAIL')" -eq 2 ]
  [[ "$output" == *"doctor: проблем 2"* ]]
}

@test "таймаут npx: ошибка вместо зависания" {
  run env STUB_SLEEP=5 SKILLS_TIMEOUT=1 bash "$HUB/skills-manager.sh" list
  [ "$status" -eq 1 ]
  [[ "$output" == *"не ответил за 1с"* ]]
}

@test "install --project через github: папка скилла и SKILL.md" {
  run manager install acme/tools@shared --source github --project
  [ "$status" -eq 0 ]
  [[ "$output" == *"skill:  $PWD/.agents/skills/shared"* ]]
  [ -f "$PWD/.agents/skills/shared/SKILL.md" ]
}

@test "MCP: handshake, четыре тула, поиск и отказ на плохом source" {
  run bash -c '
    printf "%s\n" \
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"bats\",\"version\":\"0\"}}}" \
      "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" \
      "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}" \
      "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"skills_search\",\"arguments\":{\"query\":\"pdf\",\"limit\":2}}}" \
      "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"skills_search\",\"arguments\":{\"query\":\"pdf\",\"source\":\"bogus\"}}}" |
      node "$1"
  ' _ "$HUB/mcp/server.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *"2025-06-18"* ]]
  [[ "$output" == *"skills_inspect"* ]]
  [[ "$output" == *"acme/tools@popular"* ]]
  [[ "$output" == *"must be one of"* ]]
}

@test "MCP: таймаут skills-manager завершает запрос, а не оставляет Promise pending" {
  run env MCP_SKILLS_HUB_TIMEOUT_MS=100 STUB_SLEEP=2 STUB_LOG="$BATS_TEST_TMPDIR/timeout.log" timeout 5 bash -c '
    printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"skills_list\",\"arguments\":{}}}" |
    node "$1"
  ' _ "$HUB/mcp/server.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *"timeout after 100ms"* ]]
}

@test "MCP: skills_find и skills_show ищут по установленным скиллам без сети" {
  # фикстура: свой дом и своя коллекция — ни сети, ни реальных ~/.agents не трогаем
  local home="$BATS_TEST_TMPDIR/skills-home" coll="$BATS_TEST_TMPDIR/skills-collection"
  mkdir -p "$home/.agents/skills/pager-skill" "$coll/alpha"
  {
    printf -- '---\nname: pager-skill\ndescription: >-\n'
    printf '  Дежурство: разбудить дежурного, если процесс завис.\n'
    printf '  Вторая строка описания.\n'
    printf -- '---\n\n## Как будить\n\nзвонок в pager\n'
  } >"$home/.agents/skills/pager-skill/SKILL.md"
  printf -- '---\nname: alpha\ndescription: тестовый скилл коллекции\n---\n\nтело\n' \
    >"$coll/alpha/SKILL.md"

  run env SKILLS_STATION_HOME="$home" SKILLS_STATION_COLLECTION="$coll" SKILLS_STATION_CWD="$BATS_TEST_TMPDIR" \
    bash -c '
      printf "%s\n" \
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"bats\",\"version\":\"0\"}}}" \
        "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" \
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}" \
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"skills_find\",\"arguments\":{\"query\":\"завис\",\"limit\":5}}}" \
        "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"skills_show\",\"arguments\":{\"name\":\"pager-skill\"}}}" \
        "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"skills_find\",\"arguments\":{\"query\":\"коллекции\"}}}" \
        "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"skills_show\",\"arguments\":{\"name\":\"нет-такого\"}}}" |
        node "$1"
    ' _ "$HUB/mcp/server.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *"2025-06-18"* ]]
  [[ "$output" == *'"name":"skills_find"'* ]]
  [[ "$output" == *'"name":"skills_show"'* ]]
  # блочное описание скилла найдено и показано, режим и слой видны
  [[ "$output" == *"pager-skill"* ]]
  [[ "$output" == *"Дежурство"* ]]
  [[ "$output" == *"звонок в pager"* ]]
  # поиск видит и коллекцию станции, а не только слои клиента
  [[ "$output" == *"alpha"* ]]
  # неизвестное имя — понятный отказ с подсказками, а не пустой ответ
  [[ "$output" == *"Похожие"* ]]
  [[ "$output" == *'"isError":true'* ]]
}

@test "MCP: движок станции находится и когда хаб запущен через симлинк" {
  # клиенты держат хаб ссылкой (~/.agents/skills/skills-ops) — путь до станции не должен теряться
  local link="$BATS_TEST_TMPDIR/link-hub" home="$BATS_TEST_TMPDIR/link-home"
  ln -s "$HUB" "$link"
  mkdir -p "$home/.agents/skills/link-skill"
  printf -- '---\nname: link-skill\ndescription: скилл за ссылкой\n---\n\nтело\n' \
    >"$home/.agents/skills/link-skill/SKILL.md"

  run env SKILLS_STATION_HOME="$home" SKILLS_STATION_COLLECTION="$BATS_TEST_TMPDIR/no-collection" \
    SKILLS_STATION_CWD="$BATS_TEST_TMPDIR" \
    bash -c '
      printf "%s\n" \
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"skills_find\",\"arguments\":{\"query\":\"link-skill\"}}}" |
        node --preserve-symlinks "$1"
    ' _ "$link/mcp/server.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *"link-skill"* ]]
  [[ "$output" != *"движок поиска по установленным скиллам не найден"* ]]
}

@test "без npx: понятная ошибка вместо загадочного сбоя" {
  local minimal="$BATS_TEST_TMPDIR/minimal"
  mkdir -p "$minimal"
  local bin
  for bin in bash sed jq node cat dirname readlink; do
    ln -sf "$(command -v "$bin")" "$minimal/$bin"
  done
  run env PATH="$minimal" bash "$HUB/skills-manager.sh" list
  [ "$status" -eq 1 ]
  [[ "$output" == *"не найден npx"* ]]
}

@test "windows: -WhatIf ничего не меняет" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"
  local home="$BATS_TEST_TMPDIR/whatif"
  mkdir -p "$home"

  run pwsh -NoProfile -File "$HUB/windows/install.ps1" -AgentHome "$home" -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"What if:"* ]]
  [ -z "$(find "$home" -mindepth 1 -print -quit)" ]
}

@test "windows: install.ps1 ставит связи, shim и MCP-регистрацию, второй раз — идемпотентно" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"
  local home="$BATS_TEST_TMPDIR/winhome"
  mkdir -p "$home"

  run pwsh -NoProfile -File "$HUB/windows/install.ps1" -AgentHome "$home"
  [ "$status" -eq 0 ]
  [ -e "$home/.agents/skills/skills-ops/skills-manager.sh" ]
  grep -q "skills-manager.sh" "$home/.local/bin/skills-manager.cmd"

  # MCP-регистрация нативная: node плюс путь к серверу. Шелла в конфиге Windows нет, а `bash` из PATH
  # там обычно заглушка WSL — запись через `bash -lc` давала бы мёртвый сервер
  run bash -c 'jq -r ".mcp[\"skills-hub\"].command[0]" "$1"' _ "$home/.config/opencode/opencode.json"
  [ "$output" = "node" ]
  run bash -c 'jq -r ".mcp[\"skills-hub\"].command[1] | endswith(\"server.mjs\")" "$1"' _ "$home/.config/opencode/opencode.json"
  [ "$output" = "true" ]
  run bash -c 'jq -r ".permission[\"skills-hub_skills_install\"]" "$1"' _ "$home/.config/opencode/opencode.json"
  [ "$output" = "ask" ]
  run bash -c 'jq -r ".mcpServers[\"skills-hub\"].command" "$1"' _ "$home/.omp/agent/mcp.json"
  [ "$output" = "node" ]
  run bash -c 'jq -r ".mcpServers[\"skills-hub\"].args[0] | endswith(\"server.mjs\")" "$1"' _ "$home/.omp/agent/mcp.json"
  [ "$output" = "true" ]
  run bash -c 'jq -r ".tools.approval[\"mcp__skills_hub_skills_install\"]" "$1"' _ "$home/.omp/agent/mcp.json"
  [ "$output" = "prompt" ]

  local before
  before="$(md5sum "$home/.config/opencode/opencode.json" "$home/.omp/agent/mcp.json" "$home/.local/bin/skills-manager.cmd")"
  run pwsh -NoProfile -File "$HUB/windows/install.ps1" -AgentHome "$home"
  [ "$status" -eq 0 ]
  [[ "$output" == *"already configured (opencode)"* ]]
  [[ "$output" != *"updated "* ]]
  [ "$before" = "$(md5sum "$home/.config/opencode/opencode.json" "$home/.omp/agent/mcp.json" "$home/.local/bin/skills-manager.cmd")" ]
}

@test "ps1: нативные команды хаба, ссылки, сканер путей и часовая проверка под pwsh" {
  # набор лежит в tests/hub-ps1.ps1 и запускается и напрямую на Windows, без bats
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"
  run pwsh -NoProfile -File "$HUB/tests/hub-ps1.ps1"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ps1 tests: ok"* ]]
}

@test "shellcheck: скрипты хаба без замечаний" {
  command -v shellcheck >/dev/null 2>&1 || skip "shellcheck не установлен"
  run shellcheck -x -S warning "$HUB/skills-manager.sh" "$HUB"/markets/*.sh "$HUB"/contrib/*.sh "$HUB"/tests/stubs/*
  [ "$status" -eq 0 ]
}

@test "в скриптах и доках хаба нет абсолютных путей" {
  local roots=("$HUB")
  local bundle="$BATS_TEST_DIRNAME/../../agent-bundle"
  [[ -d "$bundle" ]] && roots+=("$bundle")

  run bash "$HUB/contrib/check-paths.sh" "${roots[@]}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "сканер путей: параметризованный путь ловится так же, как литеральный" {
  # Строки собираются из кусков нарочно: литерал в этом файле сделал бы грязным сам хаб — его
  # сканирует соседний тест, а помечать свои тесты маркером "path-guard: ok" было бы ложью.
  local dir="$BATS_TEST_TMPDIR/paths" prefix="/home/" dollar='$USER' braces='${HOME}' percent='%USERNAME%'
  mkdir -p "$dir"
  {
    printf 'mount = %s%s/DATA\n' "$prefix" "$dollar"
    printf 'nested = %s%s/Pictures\n' "$prefix" "$braces"
    printf 'win = C:\\Users\\%s\\app\n' "$percent"
    printf 'doc = %s<user>/проект\n' "$prefix"
    printf 'guarded = %sadmin1/DATA  # path-guard: ok\n' "$prefix"
  } >"$dir/notes.txt"

  run bash "$HUB/contrib/check-paths.sh" "$dir"
  [ "$status" -eq 1 ]
  [ "$(printf '%s\n' "$output" | grep -c 'notes.txt')" -eq 3 ]
  [[ "$output" == *'$USER/DATA'* ]]
  [[ "$output" == *'${HOME}/Pictures'* ]]
  # плейсхолдер в угловых скобках и помеченная строка нарушением не считаются
  [[ "$output" != *'doc = <user>'* ]]
  [[ "$output" != *'guarded = '* ]]
}

# Физический путь без GNU-специфики: на macOS `readlink -f` нет, а сравнивать ссылки надо.
# Раскручиваем ссылку вручную и нормализуем каталог через `cd -P` — тогда обе стороны сравнения
# приводятся к одному виду, и системный симлинк над домом (/var → /private/var) не мешает.
physical() {
  local path="$1" link hops=0
  while [ -L "$path" ] && [ "$hops" -lt 40 ]; do
    link="$(readlink "$path")"
    case "$link" in
      /*) path="$link" ;;
      *) path="$(dirname "$path")/$link" ;;
    esac
    hops=$((hops + 1))
  done
  printf '%s/%s\n' "$(cd "$(dirname "$path")" && pwd -P)" "$(basename "$path")"
}

@test "check-spec: валидный скилл проходит, чужое имя валит" {
  mkdir -p "$BATS_TEST_TMPDIR/spec/good" "$BATS_TEST_TMPDIR/spec/bad"
  cat >"$BATS_TEST_TMPDIR/spec/good/SKILL.md" <<'EOF'
---
name: good
description: Use when проверяешь спеку — валидный скилл.
---

шаги
EOF
  run node "$HUB/contrib/check-spec.mjs" "$BATS_TEST_TMPDIR/spec/good"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ошибок: 0"* ]]

  cat >"$BATS_TEST_TMPDIR/spec/bad/SKILL.md" <<'EOF'
---
name: not-the-dir
description: Use when проверяешь спеку.
---

шаги
EOF
  run node "$HUB/contrib/check-spec.mjs" "$BATS_TEST_TMPDIR/spec/bad"
  [ "$status" -eq 1 ]
  [[ "$output" == *"≠ директория"* ]]
}

@test "check-spec: --strict валит на предупреждениях, обычный режим — нет" {
  mkdir -p "$BATS_TEST_TMPDIR/spec/quiet"
  cat >"$BATS_TEST_TMPDIR/spec/quiet/SKILL.md" <<'EOF'
---
name: quiet
description: Описание без слова-триггера, но с запасом по длине.
---

шаги
EOF
  run node "$HUB/contrib/check-spec.mjs" "$BATS_TEST_TMPDIR/spec/quiet"
  [ "$status" -eq 0 ]

  run node "$HUB/contrib/check-spec.mjs" "$BATS_TEST_TMPDIR/spec/quiet" --strict
  [ "$status" -eq 1 ]
}

@test "check-spec: команда хаба проверяет каталог по спеке" {
  mkdir -p "$BATS_TEST_TMPDIR/spec/ok"
  cat >"$BATS_TEST_TMPDIR/spec/ok/SKILL.md" <<'EOF'
---
name: ok
description: Use when гоняешь спеку через команду хаба.
---

шаги
EOF
  run manager check-spec "$BATS_TEST_TMPDIR/spec"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ошибок: 0"* ]]
}
