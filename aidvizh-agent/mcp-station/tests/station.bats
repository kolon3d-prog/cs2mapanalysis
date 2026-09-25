#!/usr/bin/env bats
# Тесты станции поставки MCP: каталог с тирами → конфиги omp/pi и opencode, состояние, update/rollback.
# Домашний каталог подменяется (MCP_STATION_HOME), реальные конфиги и секреты не трогаются.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export MCP_STATION_HOME="$BATS_TEST_TMPDIR/home"
  export SECRETS_FILE="$MCP_STATION_HOME/.config/opencode/secrets/env"
  export STATE_FILE="$MCP_STATION_HOME/.local/state/mcp-station/installed.json"
  unset XDG_CONFIG_HOME PI_CODING_AGENT_DIR MCP_STATION_SECRETS MCP_STATION_OPENCODE_HEADERS MCP_STATION_CATALOG
  mkdir -p "$(dirname "$SECRETS_FILE")"
  cat >"$SECRETS_FILE" <<'ENV'
OPENROUTER_API_KEY=test-openrouter
FIRECRAWL_API_KEY=test-firecrawl
TAVILY_API_KEY=test-tavily
SERPER_API_KEY=test-serper
EXA_API_KEY=test-exa
LAZYWEB_TOKEN=test-lazyweb
ENV
  # станция проверяет, что файлы MCP-серверов существуют: делаем заглушку skills-hub
  mkdir -p "$MCP_STATION_HOME/.agents/skills/skills-ops/mcp"
  printf '// заглушка\n' >"$MCP_STATION_HOME/.agents/skills/skills-ops/mcp/server.mjs"
  # и заглушку stealth-browser (он собирается локально, см. bin/stealth-setup.sh)
  mkdir -p "$MCP_STATION_HOME/.agents/mcp/stealth-browser-mcp/venv/bin" \
           "$MCP_STATION_HOME/.agents/mcp/stealth-browser-mcp/src"
  printf '#!/bin/sh\n' >"$MCP_STATION_HOME/.agents/mcp/stealth-browser-mcp/venv/bin/python"
  chmod +x "$MCP_STATION_HOME/.agents/mcp/stealth-browser-mcp/venv/bin/python"
  printf '# заглушка\n' >"$MCP_STATION_HOME/.agents/mcp/stealth-browser-mcp/src/server.py"
  # и заглушку MCP-сервера вики (его ставит wiki-station)
  mkdir -p "$MCP_STATION_HOME/.agents/wiki-station/mcp"
  printf '// заглушка\n' >"$MCP_STATION_HOME/.agents/wiki-station/mcp/server.mjs"
  cd "$BATS_TEST_TMPDIR"
}

# Копия каталога, в которую тест может внести правку: станция видит её через MCP_STATION_CATALOG.
catalog_copy() {
  CATALOG_TWIN="$BATS_TEST_TMPDIR/catalog-twin"
  rm -rf "$CATALOG_TWIN"
  cp -r "$STATION/catalog" "$CATALOG_TWIN"
  export CATALOG_TWIN
}

core_count() {
  jq -r 'select(.tier == "core") | .name' "$STATION"/catalog/*.json | wc -l
}

keyed_count() {
  jq -r 'select(.tier == "keyed") | .name' "$STATION"/catalog/*.json | wc -l
}

@test "list показывает каталог с тирами" {
  run bash "$STATION/bin/mcp-station.sh" list
  [ "$status" -eq 0 ]
  # число строк равно числу файлов каталога: новый сервер в каталоге не ломает тест
  [ "${#lines[@]}" -eq "$(ls "$STATION"/catalog/*.json | wc -l | tr -d ' ')" ]
  [[ "$output" == *"skills-hub"* ]]
  [[ "$output" == *"lazyweb"* ]]
  [[ "$output" == *"core"* ]]
  [[ "$output" == *"keyed"* ]]
}

@test "справка: список тиров берётся из каталога, а не держится в тексте" {
  run bash "$STATION/bin/mcp-station.sh" --help
  [ "$status" -eq 0 ]
  # блок «Тиры:» обязан назвать каждую запись каталога: список в справке устаревал молча
  # (восемь имён при пятнадцати записях), теперь его собирает tierLine() из каталога
  local block name
  block="$(printf '%s\n' "$output" | sed -n '/^Тиры:/,/^Проверки/p')"
  for file in "$STATION"/catalog/*.json; do
    name="$(jq -r .name "$file")"
    if [[ "$block" != *"$name"* ]]; then
      echo "в справке нет записи каталога: $name"
      return 1
    fi
  done
}

@test "тир каталога согласован с ключами: keyed тогда и только тогда, когда есть ключ" {
  local file tier vars
  for file in "$STATION"/catalog/*.json; do
    tier="$(jq -r .tier "$file")"
    # сколько переменных требует запись: requiresEnv у stdio + env у http-заголовков
    vars="$(jq -r '[(.requiresEnv // [])[], ((.headers // {}) | to_entries[] | .value.env)] | map(select(. != null)) | length' "$file")"
    case "$tier" in
      core|keyed) ;;
      *) echo "$file: tier=$tier (нужен core или keyed)"; false ;;
    esac
    if [ "$vars" -eq 0 ]; then
      [ "$tier" = "core" ] || { echo "$file: tier=$tier, но ключей не требует — сервер уедет в базовый набор"; false; }
    else
      [ "$tier" = "keyed" ] || { echo "$file: tier=$tier, но требует ключ ($vars) — ключ ставился бы по умолчанию"; false; }
    fi
  done
}

@test "install без аргументов ставит только core и не ставит keyed" {
  run bash "$STATION/bin/mcp-station.sh"
  [ "$status" -eq 0 ]
  local n
  n="$(core_count)"
  run bash -c 'jq -r ".mcpServers | keys | length" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "$n" ]
  run bash -c 'jq -r ".mcp | keys | length" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "$n" ]
  run bash -c 'jq -r ".mcpServers | keys | length" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [ "$output" = "$n" ]
  # ни одного сервера с ключом
  run bash -c 'jq -r "[.mcpServers | keys[] | select(. == \"exa\" or . == \"tavily\" or . == \"firecrawl\")] | length" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "0" ]
}

@test "install: гейты подтверждения из каталога — opencode ask, omp prompt, pi без механизма" {
  run bash "$STATION/bin/mcp-station.sh"
  [ "$status" -eq 0 ]
  run bash -c 'jq -r ".permission[\"skills-hub_skills_install\"]" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "ask" ]
  run bash -c 'jq -r ".tools.approval[\"mcp__skills_hub_skills_install\"]" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "prompt" ]
  run bash -c 'jq -r ".tools.approval // \"none\"" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [ "$output" = "none" ]

  # повторная установка гейты не дублирует и файлы не трогает
  run bash -c 'sha256sum "$1" | cut -d" " -f1' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  local before="$output"
  run bash "$STATION/bin/mcp-station.sh"
  [ "$status" -eq 0 ]
  run bash -c 'sha256sum "$1" | cut -d" " -f1' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "$before" ]
}

@test "install --profile keyed без ключей не ставит и говорит одной строкой, что делать" {
  rm -f "$SECRETS_FILE"
  run bash "$STATION/bin/mcp-station.sh" install --profile keyed
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен ключ EXA_API_KEY"* ]]
  [[ "$output" == *"bin/keys.sh add exa"* ]]
  [[ "$output" == *"повтори mcp-station install exa"* ]]
  # строка про ключ — одна на сервер, а не на каждого клиента
  [ "$(printf '%s\n' "$output" | grep -c 'нужен ключ EXA_API_KEY')" -eq 1 ]
  [ ! -e "$MCP_STATION_HOME/.omp/agent/mcp.json" ]
  [ ! -e "$MCP_STATION_HOME/.local/state/mcp-station/installed.json" ]
  # станция завела пустой файл ключей (иначе непонятно, куда класть ключ) и сказала, чем его положить
  [ -f "$SECRETS_FILE" ]
  [ ! -s "$SECRETS_FILE" ]
  [[ "$output" == *"файл ключей"*"заведён пустым"* ]]
  [ "$(stat -c %a "$SECRETS_FILE" 2>/dev/null || stat -f %Lp "$SECRETS_FILE")" = "600" ]
}

@test "install --profile keyed с ключами ставит все keyed-серверы" {
  run bash "$STATION/bin/mcp-station.sh" install --profile keyed
  [ "$status" -eq 0 ]
  local n
  n="$(keyed_count)"
  run bash -c 'jq -r ".mcpServers | keys | length" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "$n" ]
  run bash -c 'jq -r ".mcpServers.tavily.command" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "bash" ]
  run bash -c 'jq -r ".mcp.exa.type" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "remote" ]
}

@test "install --profile all ставит весь каталог в оба клиента в их формате" {
  run bash "$STATION/bin/mcp-station.sh" install --profile all
  [ "$status" -eq 0 ]
  [ -f "$MCP_STATION_HOME/.omp/agent/mcp.json" ]
  [ -f "$MCP_STATION_HOME/.config/opencode/opencode.json" ]

  run bash -c 'jq -r ".mcpServers[\"skills-hub\"].command" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "bash" ]
  run bash -c 'jq -r ".mcp[\"skills-hub\"].type" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "local" ]
  run bash -c 'jq -r ".mcpServers.exa.type" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "http" ]
  run bash -c 'jq -r ".mcp.exa.type" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "remote" ]
  run bash -c 'jq -r ".mcpServers | keys | length" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "$(ls "$STATION"/catalog/*.json | wc -l | tr -d ' ')" ]
}

@test "install идемпотентен" {
  bash "$STATION/bin/mcp-station.sh" --profile all >/dev/null
  local before
  before="$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.config/opencode/opencode.json")"

  run bash "$STATION/bin/mcp-station.sh" --profile all
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже стоит"* ]]
  [[ "$output" != *"записан"* ]]
  [ "$before" = "$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.config/opencode/opencode.json")" ]
}

@test "dry-run не пишет ничего" {
  run bash "$STATION/bin/mcp-station.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$MCP_STATION_HOME/.omp/agent/mcp.json" ]
  [ ! -e "$MCP_STATION_HOME/.config/opencode/opencode.json" ]
}

@test "remove снимает сервер у обоих клиентов" {
  bash "$STATION/bin/mcp-station.sh" >/dev/null
  run bash "$STATION/bin/mcp-station.sh" remove skills-hub
  [ "$status" -eq 0 ]
  run bash -c 'jq -r ".mcpServers | has(\"skills-hub\")" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "false" ]
  run bash -c 'jq -r ".mcp | has(\"skills-hub\")" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "false" ]
  run bash -c 'jq -r ".mcpServers | has(\"wiki\")" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "true" ]
}

@test "camoufox: ставится во все три клиента, повтор не меняет, remove снимает" {
  run bash "$STATION/bin/mcp-station.sh" install camoufox
  [ "$status" -eq 0 ]

  run bash -c 'jq -r ".mcpServers[\"camoufox\"].command" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "bash" ]
  run bash -c 'jq -r ".mcpServers[\"camoufox\"].args[0]" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [ "$output" = "-lc" ]
  run bash -c 'jq -r ".mcp[\"camoufox\"].type" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "local" ]
  run bash -c 'jq -r ".mcp[\"camoufox\"].command | length" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "3" ]

  # окружение в рантайме ставится отдельно: установка записи его не требует
  [ ! -e "$MCP_STATION_HOME/.venvs/camoufox-research" ]

  local before
  before="$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.pi/agent/mcp.json" \
    "$MCP_STATION_HOME/.config/opencode/opencode.json")"
  run bash "$STATION/bin/mcp-station.sh" install camoufox
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже стоит"* ]]
  [ "$before" = "$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.pi/agent/mcp.json" \
    "$MCP_STATION_HOME/.config/opencode/opencode.json")" ]

  run bash "$STATION/bin/mcp-station.sh" remove camoufox
  [ "$status" -eq 0 ]
  run bash -c 'jq -r ".mcp | has(\"camoufox\")" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "false" ]
  run bash -c 'jq -r ".mcpServers | has(\"camoufox\")" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [ "$output" = "false" ]
  run bash -c 'jq -r ".mcpServers | length" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "0" ]
}

@test "camoufox: без окружения в рантайме подсказывает установщик, с окружением — стартует" {
  bash "$STATION/bin/mcp-station.sh" install camoufox >/dev/null
  local script
  script="$(jq -r '.mcpServers["camoufox"].args[1]' "$MCP_STATION_HOME/.omp/agent/mcp.json")"

  # venv нет — клиент получает внятную причину и шаг установки, а не молчание
  run env HOME="$MCP_STATION_HOME" bash -c "$script"
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет окружения в рантайме"* ]]
  [[ "$output" == *"scripts/install.sh"* ]]

  # появилось окружение — запускается консольный скрипт с профилем по умолчанию
  mkdir -p "$MCP_STATION_HOME/.venvs/camoufox-research/bin"
  cat >"$MCP_STATION_HOME/.venvs/camoufox-research/bin/camoufox-research" <<'SH'
#!/usr/bin/env bash
printf 'caps=%s\n' "${CAMOUFOX_CAPS:-}"
SH
  chmod +x "$MCP_STATION_HOME/.venvs/camoufox-research/bin/camoufox-research"

  run env HOME="$MCP_STATION_HOME" bash -c "$script"
  [ "$status" -eq 0 ]
  # дефолт записи — профиль агента целиком: ресёрч, чтение страниц, живая вкладка, картинки
  [ "$output" = "caps=research,browser,session,vision" ]

  # заданный снаружи профиль станция не перетирает
  run env HOME="$MCP_STATION_HOME" CAMOUFOX_CAPS=probe bash -c "$script"
  [ "$status" -eq 0 ]
  [ "$output" = "caps=probe" ]
}

@test "check: файлы и ключи на месте, пропажа — сообщается" {
  run bash "$STATION/bin/mcp-station.sh" check
  [ "$status" -eq 0 ]

  mv "$MCP_STATION_HOME/.agents/skills/skills-ops/mcp/server.mjs" "$BATS_TEST_TMPDIR/keep.mjs"
  run bash "$STATION/bin/mcp-station.sh" check skills-hub
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет файла"* ]]

  # сервер с локальной сборкой проверяется так же: пропал файл — check ругается
  mv "$MCP_STATION_HOME/.agents/mcp/stealth-browser-mcp/src/server.py" "$BATS_TEST_TMPDIR/keep.py"
  run bash "$STATION/bin/mcp-station.sh" check stealth-browser
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет файла"* ]]
  mv "$BATS_TEST_TMPDIR/keep.py" "$MCP_STATION_HOME/.agents/mcp/stealth-browser-mcp/src/server.py"

  mv "$SECRETS_FILE" "$SECRETS_FILE.gone"
  run bash "$STATION/bin/mcp-station.sh" check firecrawl
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет файла ключей"* ]]
}

@test "ключи не утекают в конфиг omp, а opencode получает их из файла" {
  bash "$STATION/bin/mcp-station.sh" install lazyweb >/dev/null
  run bash -c 'jq -r ".mcpServers.lazyweb.headers.Authorization" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [[ "$output" == '!set -a;'* ]]
  [[ "$output" != *"test-lazyweb"* ]]
  run bash -c 'jq -r ".mcp.lazyweb.headers.Authorization" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "Bearer test-lazyweb" ]
}

@test "keyed без ключа не ставится, а после keys.sh add ставится по повторной команде" {
  rm -f "$SECRETS_FILE"
  run bash "$STATION/bin/mcp-station.sh" install exa
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет ключа"* ]] || [[ "$output" == *"нужен ключ EXA_API_KEY"* ]]
  [ ! -e "$MCP_STATION_HOME/.config/opencode/opencode.json" ]

  # ключ завели — та же команда ставит запись, opencode получает значение из файла
  printf 'EXA_API_KEY=test-exa\n' >"$SECRETS_FILE"
  run bash "$STATION/bin/mcp-station.sh" install exa
  [ "$status" -eq 0 ]
  [[ "$output" == *"записан"* ]]
  run bash -c 'jq -r ".mcp.exa.headers[\"x-api-key\"]" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "test-exa" ]
  # omp подставляет значение на старте сервера, ключа в конфиге нет
  run bash -c 'jq -r ".mcpServers.exa.headers[\"x-api-key\"]" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [[ "$output" == '!set -a;'* ]]
}

@test "dry-run без ключей ничего не пишет и говорит, чего не хватает" {
  rm -f "$SECRETS_FILE"
  run bash "$STATION/bin/mcp-station.sh" install exa --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"EXA_API_KEY"* ]]
  [ ! -e "$MCP_STATION_HOME/.config/opencode/opencode.json" ]
  [ ! -e "$STATE_FILE" ]
}

@test "status показывает тир и свежесть" {
  bash "$STATION/bin/mcp-station.sh" install skills-hub >/dev/null
  run bash "$STATION/bin/mcp-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"нет из каталога"* ]]
  [[ "$output" == *"core"* ]]
  [[ "$output" == *"актуально"* ]]

  # расхождение видно сразу: испортили запись — «устарело», подложили чужую — «чужое»
  jq '.mcpServers["skills-hub"].args[1] = "подменено"' "$MCP_STATION_HOME/.omp/agent/mcp.json" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$MCP_STATION_HOME/.omp/agent/mcp.json"
  jq '.mcpServers["manual-thing"] = {command: "nope"}' "$MCP_STATION_HOME/.omp/agent/mcp.json" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$MCP_STATION_HOME/.omp/agent/mcp.json"
  run bash "$STATION/bin/mcp-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"устарело"* ]]
  [[ "$output" == *"чужое"* ]]
  [[ "$output" == *"вне каталога: manual-thing (чужое, не трогаю)"* ]]
}

@test "outdated: пустой HOME — всё missing, сводка и JSON по контракту" {
  run bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$status" -eq 0 ]
  local total
  total="$(ls "$STATION"/catalog/*.json | wc -l | tr -d ' ')"
  [ "$(jq -r .ok <<<"$output")" = "false" ]   # ok — «расхождений нет»: пустой дом весь missing
  [ "$status" -eq 0 ]                          # расхождение — не падение движка: JSON отдан, код 0
  [ "$(jq -r .schema <<<"$output")" = "1" ]
  [ "$(jq -r .catalog <<<"$output")" = "$total" ]
  [ "$(jq -r .state_file <<<"$output")" = "$STATE_FILE" ]
  [ "$(jq -r .summary.missing <<<"$output")" = "$total" ]
  [ "$(jq -r .summary.current <<<"$output")" = "0" ]
  # форма записи сервера — как в контракте
  [ "$(jq -r '.servers[0] | keys | sort | join(",")' <<<"$output")" = "clients,name,status,tier,why" ]
  [ "$(jq -r '.servers[] | select(.name == "exa") | .tier' <<<"$output")" = "keyed" ]
  [ "$(jq -r '.servers[] | select(.name == "exa") | .status' <<<"$output")" = "missing" ]
  [ "$(jq -r '.servers[] | select(.name == "exa") | .clients | map(.client + ":" + .state) | join(",")' <<<"$output")" = "omp:absent,opencode:absent,pi:absent" ]
}

@test "outdated ловит missing, changed, orphan и foreign" {
  bash "$STATION/bin/mcp-station.sh" >/dev/null                     # core
  run bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r .summary.current <<<"$output")" = "$(core_count)" ]
  [ "$(jq -r .summary.missing <<<"$output")" = "$(keyed_count)" ]

  # чужая запись: так пишет camoufox установщик проекта — абсолютным путём к venv
  jq --arg exe "$BATS_TEST_TMPDIR/venvs/camoufox-research/bin/camoufox-research" \
    '.mcpServers.camoufox = {command: $exe}' "$MCP_STATION_HOME/.omp/agent/mcp.json" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$MCP_STATION_HOME/.omp/agent/mcp.json"
  run bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r '.servers[] | select(.name == "camoufox") | .status' <<<"$output")" = "foreign" ]
  [ "$(jq -r '.servers[] | select(.name == "camoufox") | .clients[] | select(.client == "omp") | .state' <<<"$output")" = "foreign" ]
  [[ "$(jq -r '.servers[] | select(.name == "camoufox") | .why' <<<"$output")" == *"не наша запись"* ]]

  # каталог-двойник: у wiki другой argv, inspo в каталоге больше нет
  catalog_copy
  jq '.argv[2] = "exec node \"$HOME/.agents/wiki-station/mcp/other.mjs\""' "$CATALOG_TWIN/wiki.json" >"$BATS_TEST_TMPDIR/w.json"
  mv "$BATS_TEST_TMPDIR/w.json" "$CATALOG_TWIN/wiki.json"
  rm "$CATALOG_TWIN/inspo.json"
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.servers[] | select(.name == "wiki") | .status' <<<"$output")" = "changed" ]
  [[ "$(jq -r '.servers[] | select(.name == "wiki") | .why' <<<"$output")" == *"каталог изменился: argv"* ]]
  [ "$(jq -r '.servers[] | select(.name == "inspo") | .status' <<<"$output")" = "orphan" ]
  [ "$(jq -r .summary.orphan <<<"$output")" = "1" ]
  [ "$(jq -r .summary.foreign <<<"$output")" = "1" ]
  [ "$(jq -r .summary.changed <<<"$output")" = "1" ]

  # человекочитаемый вывод говорит то же самое
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" outdated
  [[ "$output" == *"changed  wiki"* ]]
  [[ "$output" == *"orphan   inspo"* ]]
  [[ "$output" == *"foreign  camoufox"* ]]
}

@test "update: переписывает изменившееся, добавляет недостающее, идемпотентен" {
  bash "$STATION/bin/mcp-station.sh" >/dev/null
  local before
  before="$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.config/opencode/opencode.json" "$MCP_STATION_HOME/.pi/agent/mcp.json")"

  # нечего делать — второй прогон ничего не пишет: ни конфигов, ни состояния
  local state_before
  state_before="$(md5sum "$STATE_FILE")"
  run bash "$STATION/bin/mcp-station.sh" update
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже стоит"* ]]
  [ "$before" = "$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.config/opencode/opencode.json" "$MCP_STATION_HOME/.pi/agent/mcp.json")" ]
  [ "$state_before" = "$(md5sum "$STATE_FILE")" ]

  # каталог изменился (без semver — по содержимому записи)
  catalog_copy
  jq '.argv[2] = "exec node \"$HOME/.agents/wiki-station/mcp/other.mjs\""' "$CATALOG_TWIN/wiki.json" >"$BATS_TEST_TMPDIR/w.json"
  mv "$BATS_TEST_TMPDIR/w.json" "$CATALOG_TWIN/wiki.json"

  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" update --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"будет переписан"* ]]
  [[ "$output" == *"каталог изменился: argv"* ]]
  [ "$before" = "$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.config/opencode/opencode.json" "$MCP_STATION_HOME/.pi/agent/mcp.json")" ]

  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" update
  [ "$status" -eq 0 ]
  [[ "$output" == *"переписан"* ]]
  run bash -c 'jq -r ".mcpServers.wiki.args[1]" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [[ "$output" == *"other.mjs"* ]]

  # после перезаписи состояние снова сходится с каталогом
  local after
  after="$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.config/opencode/opencode.json" "$MCP_STATION_HOME/.pi/agent/mcp.json")"
  [ "$before" != "$after" ]
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" update
  [ "$status" -eq 0 ]
  [[ "$output" != *"переписан"* ]]
  [ "$after" = "$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.config/opencode/opencode.json" "$MCP_STATION_HOME/.pi/agent/mcp.json")" ]
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r '.summary | .current + .changed + .missing' <<<"$output")" = "$(ls "$CATALOG_TWIN"/*.json | wc -l | tr -d ' ')" ]

  # чужая запись обновлением не перетирается, но и не мешает остальным
  jq --arg exe "$BATS_TEST_TMPDIR/venvs/camoufox-research/bin/camoufox-research" \
    '.mcpServers.camoufox = {command: $exe}' "$MCP_STATION_HOME/.omp/agent/mcp.json" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$MCP_STATION_HOME/.omp/agent/mcp.json"
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" update
  [ "$status" -eq 0 ]
  [[ "$output" == *"не трогаю, это не наша запись"* ]]
  run bash -c 'jq -r ".mcpServers.camoufox.command" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [[ "$output" == *"camoufox-research"* ]]
}

@test "update --prune снимает сироту и не трогает чужие записи" {
  bash "$STATION/bin/mcp-station.sh" install inspo >/dev/null
  jq --arg exe "$BATS_TEST_TMPDIR/venvs/camoufox-research/bin/camoufox-research" \
    '.mcpServers.camoufox = {command: $exe} | .mcpServers["manual-thing"] = {command: "nope"}' \
    "$MCP_STATION_HOME/.omp/agent/mcp.json" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$MCP_STATION_HOME/.omp/agent/mcp.json"

  catalog_copy
  rm "$CATALOG_TWIN/inspo.json"   # inspo больше не в каталоге — наша запись стала сиротой

  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r '.servers[] | select(.name == "inspo") | .status' <<<"$output")" = "orphan" ]
  [ "$(jq -r '.servers[] | select(.name == "manual-thing") | .status' <<<"$output")" = "foreign" ]

  # без --yes и без терминала сирот не снимаем — честный отказ
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash -c '"$1" update --prune < /dev/null' _ "$STATION/bin/mcp-station.sh"
  [ "$status" -eq 1 ]
  run bash -c 'jq -r ".mcpServers | has(\"inspo\")" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "true" ]

  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" update --prune --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"снят: в каталоге его больше нет"* ]]
  run bash -c 'jq -r ".mcpServers | has(\"inspo\")" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "false" ]
  # чужое осталось на месте — и то, что в каталоге есть, и то, чего в нём нет
  run bash -c 'jq -r ".mcpServers.camoufox.command" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [[ "$output" == *"camoufox-research"* ]]
  run bash -c 'jq -r ".mcpServers | has(\"manual-thing\")" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "true" ]
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r .summary.orphan <<<"$output")" = "0" ]
  [ "$(jq -r .summary.foreign <<<"$output")" = "2" ]
}

@test "rollback возвращает конфиги и состояние к прошлому снимку" {
  bash "$STATION/bin/mcp-station.sh" install skills-hub >/dev/null
  bash "$STATION/bin/mcp-station.sh" install camoufox >/dev/null
  run bash "$STATION/bin/mcp-station.sh" remove camoufox
  [ "$status" -eq 0 ]
  run bash -c 'jq -r ".mcpServers | has(\"camoufox\")" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "false" ]

  run bash "$STATION/bin/mcp-station.sh" rollback
  [ "$status" -eq 0 ]
  [[ "$output" == *"возвращён к снимку"* ]]
  run bash -c 'jq -r ".mcpServers | has(\"camoufox\")" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "true" ]
  # состояние тоже вернулось: запись снова признаётся своей
  run bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r '.servers[] | select(.name == "camoufox") | .status' <<<"$output")" = "current" ]

  # дальше откат снимает установку целиком, а когда снимков нет — честно говорит об этом
  run bash "$STATION/bin/mcp-station.sh" rollback
  [ "$status" -eq 0 ]
  run bash -c 'jq -r ".mcpServers | has(\"camoufox\")" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "false" ]
  run bash "$STATION/bin/mcp-station.sh" rollback
  [ "$status" -eq 0 ]
  [ ! -e "$MCP_STATION_HOME/.omp/agent/mcp.json" ]
  run bash "$STATION/bin/mcp-station.sh" rollback
  [ "$status" -eq 1 ]
  [[ "$output" == *"откатывать нечего"* ]]
}

@test "состояние станции лежит в рантайме и описывает отпечатки" {
  bash "$STATION/bin/mcp-station.sh" install skills-hub >/dev/null
  [ -f "$STATE_FILE" ]
  local tier clients print
  tier="$(jq -r '.servers["skills-hub"].tier' "$STATE_FILE")"
  clients="$(jq -r '.servers["skills-hub"].clients | keys | join(",")' "$STATE_FILE")"
  print="$(jq -r '.servers["skills-hub"].clients.omp.fingerprint | length' "$STATE_FILE")"
  [ "$(jq -r .schema "$STATE_FILE")" = "1" ]
  [ "$(jq -r '.catalog_hash | length' "$STATE_FILE")" = "64" ]
  [ "$tier" = "core" ]
  [ "$clients" = "omp,opencode,pi" ]
  [ "$print" = "64" ]
  # состояние не в репозитории и не в конфигах клиентов
  [ ! -e "$STATION/installed.json" ]
  [ "$(jq -r '.mcpServers["skills-hub"] | has("fingerprint")' "$MCP_STATION_HOME/.omp/agent/mcp.json")" = "false" ]
}

@test "в проекте нет абсолютных путей" {
  local checker="$STATION/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$STATION"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "keys: несколько ключей на сервер, маскирование, удаление" {
  run bash "$STATION/bin/keys.sh" add exa --key exa-a
  [ "$status" -eq 0 ]
  [[ "$output" == *"EXA_API_KEY_2"* ]]

  run bash "$STATION/bin/keys.sh" add exa --key exa-b
  [[ "$output" == *"EXA_API_KEY_3"* ]]

  run bash "$STATION/bin/keys.sh" list
  [[ "$output" == *"EXA_API_KEY_3"* ]]
  [[ "$output" != *"test-exa"* ]]
  [[ "$output" != *"exa-a"* ]]

  run bash "$STATION/bin/keys.sh" remove exa
  [ "$status" -eq 0 ]
  run bash -c 'grep -c "^EXA_API_KEY_3=" "$1" || true' _ "$SECRETS_FILE"
  [ "$output" = "0" ]
  run bash -c 'grep -c "^EXA_API_KEY_2=" "$1"' _ "$SECRETS_FILE"
  [ "$output" = "1" ]
  # права файла ключей: GNU stat -c, BSD stat -f (на macOS -c нет)
  perms="$(stat -c %a "$SECRETS_FILE" 2>/dev/null || stat -f %Lp "$SECRETS_FILE")"
  [ "$perms" = "600" ]
}

@test "keypool: при отказе ключа переключается на рабочий" {
  local port=$((20000 + RANDOM % 10000))
  local dir="$BATS_TEST_TMPDIR/pool"
  mkdir -p "$dir/catalog"
  cat >"$dir/fake-http.mjs" <<'JS'
import { createServer } from "node:http";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.headers["x-api-key"] !== "good") {
      res.writeHead(401).end("nope");
      return;
    }
    const message = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true, key: "good" } }));
  });
});
server.listen(Number(process.env.PORT), "127.0.0.1");
JS
  cat >"$dir/catalog/fake.json" <<JSON
{
  "name": "fake",
  "kind": "http",
  "tier": "keyed",
  "description": "фейковый http-MCP",
  "url": "http://127.0.0.1:$port/mcp",
  "headers": { "x-api-key": { "env": "FAKE_KEY" } },
  "clients": ["omp", "opencode"]
}
JSON
  printf 'FAKE_KEY=bad\nFAKE_KEY_2=good\n' >"$dir/secrets.env"
  PORT="$port" node "$dir/fake-http.mjs" &
  local server_pid=$!
  sleep 1

  run env PORT="$port" MCP_STATION_CATALOG="$dir/catalog" MCP_STATION_SECRETS="$dir/secrets.env" \
    bash -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}" | node "$1"/bin/keypool.mjs --server fake' _ "$STATION"
  kill "$server_pid" 2>/dev/null || true

  [ "$status" -eq 0 ]
  [[ "$output" == *'"key":"good"'* ]]
  [[ "$output" == *"пробую следующий"* ]]
}

@test "keypool сериализует два stdio-запроса" {
  local port=$((40000 + RANDOM % 10000))
  local dir="$BATS_TEST_TMPDIR/pool-order"
  mkdir -p "$dir/catalog"
  cat >"$dir/order-http.mjs" <<'JS'
import { createServer } from "node:http";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const message = JSON.parse(body);
    const send = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
    };
    if (message.id === 1) setTimeout(send, 150);
    else send();
  });
});
server.listen(Number(process.env.PORT), "127.0.0.1");
JS
  cat >"$dir/catalog/fake.json" <<JSON
{"name":"fake","kind":"http","tier":"keyed","url":"http://127.0.0.1:$port/mcp","headers":{"x-api-key":{"env":"FAKE_KEY"}},"clients":["omp"]}
JSON
  printf 'FAKE_KEY=good\n' >"$dir/secrets.env"
  cat >"$dir/send.mjs" <<'JS'
process.stdout.write('{"jsonrpc":"2.0","id":1,"method":"first"}\n');
setTimeout(() => process.stdout.write('{"jsonrpc":"2.0","id":2,"method":"second"}\n'), 20);
JS
  PORT="$port" node "$dir/order-http.mjs" &
  local server_pid=$!
  sleep 1

  run env PORT="$port" MCP_STATION_CATALOG="$dir/catalog" MCP_STATION_SECRETS="$dir/secrets.env" \
    bash -c 'node "$1" | node "$2" --server fake' _ "$dir/send.mjs" "$STATION/bin/keypool.mjs"
  kill "$server_pid" 2>/dev/null || true

  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | jq -r '.id' | paste -sd, -)" = "1,2" ]
}

@test "keypool не повторяет запрос после HTTP 400" {
  local port=$((50000 + RANDOM % 10000))
  local dir="$BATS_TEST_TMPDIR/pool-400"
  mkdir -p "$dir/catalog"
  cat >"$dir/status-http.mjs" <<'JS'
import { createServer } from "node:http";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const message = JSON.parse(body);
    if (req.headers["x-api-key"] === "bad") {
      res.writeHead(400).end("bad request");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { key: "good" } }));
  });
});
server.listen(Number(process.env.PORT), "127.0.0.1");
JS
  cat >"$dir/catalog/fake.json" <<JSON
{"name":"fake","kind":"http","tier":"keyed","url":"http://127.0.0.1:$port/mcp","headers":{"x-api-key":{"env":"FAKE_KEY"}},"clients":["omp"]}
JSON
  printf 'FAKE_KEY=bad\nFAKE_KEY_2=good\n' >"$dir/secrets.env"
  PORT="$port" node "$dir/status-http.mjs" &
  local server_pid=$!
  sleep 1

  run env PORT="$port" MCP_STATION_CATALOG="$dir/catalog" MCP_STATION_SECRETS="$dir/secrets.env" \
    bash -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\"}" | node "$1" --server fake' _ "$STATION/bin/keypool.mjs"
  kill "$server_pid" 2>/dev/null || true

  [ "$status" -eq 0 ]
  [[ "$output" == *"HTTP 400"* ]]
  [[ "$output" != *'"key":"good"'* ]]
}

@test "keypool обрывает fetch по MCP_STATION_HTTP_TIMEOUT_MS" {
  local port=$((30000 + RANDOM % 10000))
  local dir="$BATS_TEST_TMPDIR/pool-timeout"
  mkdir -p "$dir/catalog"
  cat >"$dir/hang-http.mjs" <<'JS'
import { createServer } from "node:http";
const server = createServer((_req, _res) => {});
server.listen(Number(process.env.PORT), "127.0.0.1");
JS
  cat >"$dir/catalog/fake.json" <<JSON
{"name":"fake","kind":"http","tier":"keyed","url":"http://127.0.0.1:$port/mcp","headers":{"x-api-key":{"env":"FAKE_KEY"}},"clients":["omp"]}
JSON
  printf 'FAKE_KEY=good\n' >"$dir/secrets.env"
  PORT="$port" node "$dir/hang-http.mjs" &
  local server_pid=$!
  sleep 1

  run env PORT="$port" MCP_STATION_HTTP_TIMEOUT_MS=100 MCP_STATION_CATALOG="$dir/catalog" MCP_STATION_SECRETS="$dir/secrets.env" \
    timeout 3 bash -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\"}" | node "$1" --server fake' _ "$STATION/bin/keypool.mjs"
  kill "$server_pid" 2>/dev/null || true

  [ "$status" -eq 0 ]
  [[ "$output" == *"ни один ключ"* ]]
}

@test "keypool round-robin: два ключа используются по кругу" {
  local port=$((30000 + RANDOM % 10000))
  local dir="$BATS_TEST_TMPDIR/rr"
  mkdir -p "$dir/catalog"
  cat >"$dir/echo-http.mjs" <<'JS'
import { createServer } from "node:http";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const message = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { seen: req.headers["x-api-key"] } }));
  });
});
server.listen(Number(process.env.PORT), "127.0.0.1");
JS
  cat >"$dir/catalog/fake.json" <<JSON
{
  "name": "fake",
  "kind": "http",
  "tier": "keyed",
  "description": "эхо ключа",
  "url": "http://127.0.0.1:$port/mcp",
  "headers": { "x-api-key": { "env": "FAKE_KEY" } },
  "clients": ["omp"]
}
JSON
  printf 'FAKE_KEY=k1\nFAKE_KEY_2=k2\n' >"$dir/secrets.env"
  PORT="$port" node "$dir/echo-http.mjs" &
  local server_pid=$!
  sleep 1

  run env MCP_STATION_CATALOG="$dir/catalog" MCP_STATION_SECRETS="$dir/secrets.env" MCP_STATION_POOL_STRATEGY=round-robin \
    bash -c 'printf "%s\n%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"b\"}" | node "$1"/bin/keypool.mjs --server fake' _ "$STATION"
  kill "$server_pid" 2>/dev/null || true

  [ "$status" -eq 0 ]
  [[ "$output" == *'"seen":"k1"'* ]]
  [[ "$output" == *'"seen":"k2"'* ]]
}

@test "install --pool: http-серверы идут через шим пула ключей" {
  run bash "$STATION/bin/mcp-station.sh" install exa --pool
  [ "$status" -eq 0 ]
  [ -x "$MCP_STATION_HOME/.local/bin/mcp-keypool" ]

  run bash -c 'jq -r ".mcpServers.exa.command" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "bash" ]
  run bash -c 'jq -r ".mcpServers.exa.args[1]" "$1"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [[ "$output" == *"mcp-keypool"* ]]
  run bash -c 'jq -r ".mcp.exa.command[1]" "$1"' _ "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "-lc" ]
  # повтор с --pool ничего не переписывает
  local before
  before="$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json")"
  run bash "$STATION/bin/mcp-station.sh" install exa --pool
  [ "$status" -eq 0 ]
  [ "$before" = "$(md5sum "$MCP_STATION_HOME/.omp/agent/mcp.json")" ]
}

@test "install --client pi: mcp.json для pi-mcp-adapter, http без type" {
  run bash "$STATION/bin/mcp-station.sh" install --profile all --client pi
  [ "$status" -eq 0 ]
  [ -f "$MCP_STATION_HOME/.pi/agent/mcp.json" ]

  run bash -c 'jq -r ".mcpServers | keys | length" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [ "$output" = "$(ls "$STATION"/catalog/*.json | wc -l | tr -d ' ')" ]
  run bash -c 'jq -r ".mcpServers[\"skills-hub\"].command" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [ "$output" = "bash" ]
  run bash -c 'jq -r ".mcpServers.exa | has(\"type\")" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [ "$output" = "false" ]
  run bash -c 'jq -r ".mcpServers.exa.url" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [[ "$output" == https://mcp.exa.ai/* ]]
  run bash -c 'jq -r ".mcpServers.exa.headers[\"x-api-key\"]" "$1"' _ "$MCP_STATION_HOME/.pi/agent/mcp.json"
  [[ "$output" == '!set -a;'* ]]
  # у omp (тот же файл каталога, другой клиент) файл не тронут
  [ ! -e "$MCP_STATION_HOME/.omp/agent/mcp.json" ]
}

@test "pi: файл принимается парсером самого адаптера" {
  local adapter="$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter/dist/config.js"
  [[ -f "$adapter" ]] || skip "pi-mcp-adapter не установлен"
  bash "$STATION/bin/mcp-station.sh" install --profile all --client pi >/dev/null

  run node -e "
import('$adapter').then((m) => {
  const cfg = m.loadMcpConfig('$MCP_STATION_HOME/.pi/agent/mcp.json');
  console.log(Object.keys(cfg.mcpServers).sort().join(','));
}).catch((error) => { console.error(error.message); process.exit(1); });
"
  [ "$status" -eq 0 ]
  # ожидаемый набор берём из каталога: тест проверяет парсер, а не состав каталога
  expected="$(jq -r .name "$STATION"/catalog/*.json | sort | paste -sd, -)"
  [ "$output" = "$expected" ]
}

@test "windows: keys.ps1 и станция работают под pwsh" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  run pwsh -NoProfile -File "$STATION/bin/mcp-station.ps1" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills-hub"* ]]

  run pwsh -NoProfile -File "$STATION/bin/mcp-station.ps1" -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$MCP_STATION_HOME/.omp/agent/mcp.json" ]

  run pwsh -NoProfile -File "$STATION/bin/keys.ps1" add exa --key exa-win
  [ "$status" -eq 0 ]
  run pwsh -NoProfile -File "$STATION/bin/keys.ps1" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"EXA_API_KEY"* ]]
}

# ---------------------------------------------------------------- verify: живое рукопожатие

# Заглушки MCP-серверов для verify. Каждая пишет свой pid (а good — ещё и pid своего ребёнка) в
# STUB_PIDS: по этим pid тест проверяет, что после прогона не осталось сирот.
stub_servers() {
  STUBS="$BATS_TEST_TMPDIR/stubs"
  export STUBS
  export STUB_PIDS="$BATS_TEST_TMPDIR/stub-pids"
  mkdir -p "$STUBS"
  : >"$STUB_PIDS"

  # отвечает по протоколу; держит внука, чтобы проверить, что гасится вся группа процессов
  cat >"$STUBS/good.mjs" <<'JS'
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const child = spawn("sleep", ["300"], { stdio: "ignore" });
appendFileSync(process.env.STUB_PIDS, `${child.pid}\n`);
appendFileSync(process.env.STUB_PIDS, `${process.pid}\n`);
const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0" } } });
    } else if (message.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] } });
    }
  }
});
JS

  # молчит и не умирает: так выглядит сервер, который не успел подняться
  cat >"$STUBS/silent.mjs" <<'JS'
import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_PIDS, `${process.pid}\n`);
setInterval(() => {}, 1000);
JS

  # падает с кодом 1: так выглядит несобранный сервер
  cat >"$STUBS/crash.mjs" <<'JS'
import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_PIDS, `${process.pid}\n`);
process.stderr.write("заглушка упала: нет окружения в рантайме\n");
process.exit(1);
JS

  # мусор в stdout: stdout — это протокол, посторонняя строка считается поломкой
  cat >"$STUBS/junk.mjs" <<'JS'
import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_PIDS, `${process.pid}\n`);
process.stdout.write("это не JSON-RPC, а мусор\n");
setInterval(() => {}, 1000);
JS
}

# Конфиги трёх клиентов с записями ровно такими, какими их получит клиент: у omp и pi — command+args,
# у opencode — command массивом. Аргументы — пары «имя:скрипт».
verify_clients() {
  local dir="$MCP_STATION_HOME" omp="{}" pi="{}" oc="{}" pair name script
  mkdir -p "$dir/.omp/agent" "$dir/.pi/agent" "$dir/.config/opencode"
  for pair in "$@"; do
    name="${pair%%:*}"
    script="${pair#*:}"
    omp="$(jq -c --arg n "$name" --arg s "exec node $script" '. + {($n): {command: "bash", args: ["-lc", $s]}}' <<<"$omp")"
    pi="$(jq -c --arg n "$name" --arg s "exec node $script" '. + {($n): {command: "bash", args: ["-lc", $s]}}' <<<"$pi")"
    oc="$(jq -c --arg n "$name" --arg s "exec node $script" '. + {($n): {type: "local", command: ["bash", "-lc", $s]}}' <<<"$oc")"
  done
  printf '%s\n' "$omp" | jq '{mcpServers: .}' >"$dir/.omp/agent/mcp.json"
  printf '%s\n' "$pi" | jq '{mcpServers: .}' >"$dir/.pi/agent/mcp.json"
  printf '%s\n' "$oc" | jq '{mcp: .}' >"$dir/.config/opencode/opencode.json"
}

# Свои записи для verify: каталог-двойник с теми же заглушками. Без него станция видит записи,
# поставленные не ей (состояния нет), и честно считает их чужими — а тест проверяет наши провалы.
own_stubs() { # пары «имя:скрипт», как у verify_clients
  catalog_copy
  local pair name script
  for pair in "$@"; do
    name="${pair%%:*}"
    script="${pair#*:}"
    jq -n --arg name "$name" --arg script "exec node $script" \
      '{name: $name, kind: "stdio", tier: "core", description: "заглушка verify",
        argv: ["bash", "-lc", $script], clients: ["omp", "opencode", "pi"]}' \
      >"$CATALOG_TWIN/$name.json"
  done
  export MCP_STATION_CATALOG="$CATALOG_TWIN"
}

@test "verify: рукопожатие по каждому клиенту — connected, timeout, spawn-failed, no-handshake" {
  stub_servers
  own_stubs "good:$STUBS/good.mjs" "silent:$STUBS/silent.mjs" "crash:$STUBS/crash.mjs" "junk:$STUBS/junk.mjs"
  verify_clients "good:$STUBS/good.mjs" "silent:$STUBS/silent.mjs" "crash:$STUBS/crash.mjs" "junk:$STUBS/junk.mjs"

  local out rc=0
  out="$(bash "$STATION/bin/mcp-station.sh" verify --timeout 2 --json 2>"$BATS_TEST_TMPDIR/progress.txt")" || rc=$?
  [ "$rc" -eq 1 ]
  [ "$(jq -r .ok <<<"$out")" = "false" ]
  [ "$(jq -r .schema <<<"$out")" = "1" ]
  [ "$(jq -r .timeout <<<"$out")" = "2" ]
  [ "$(jq -r '.clients | length' <<<"$out")" = "3" ]
  [ "$(jq -r '.clients[0].client' <<<"$out")" = "omp" ]
  [ "$(jq -r '.clients[0].label' <<<"$out")" = "omp/pi" ]
  [ "$(jq -r '.clients[0].file' <<<"$out")" = "$MCP_STATION_HOME/.omp/agent/mcp.json" ]
  [ "$(jq -r '.clients[0].installed | sort | join(",")' <<<"$out")" = "crash,good,junk,silent" ]
  # у каждой записи своё состояние, а у отвечающей видно сервер и число тулов
  [ "$(jq -r '.clients[0].servers[] | select(.name == "good") | .state' <<<"$out")" = "connected" ]
  [ "$(jq -r '.clients[0].servers[] | select(.name == "good") | .tools' <<<"$out")" = "3" ]
  [ "$(jq -r '.clients[0].servers[] | select(.name == "good") | .server' <<<"$out")" = "stub 1.0" ]
  [ "$(jq -r '.clients[0].servers[] | select(.name == "silent") | .state' <<<"$out")" = "timeout" ]
  [ "$(jq -r '.clients[0].servers[] | select(.name == "silent") | .error' <<<"$out")" = "нет ответа на initialize" ]
  [ "$(jq -r '.clients[0].servers[] | select(.name == "crash") | .state' <<<"$out")" = "spawn-failed" ]
  [[ "$(jq -r '.clients[0].servers[] | select(.name == "crash") | .error' <<<"$out")" == *"кодом 1"* ]]
  [ "$(jq -r '.clients[0].servers[] | select(.name == "junk") | .state' <<<"$out")" = "no-handshake" ]
  # запись сервера — строго по контракту, и её видно у видящего клиента тоже
  [ "$(jq -r '.clients[0].servers[0] | keys | sort | join(",")' <<<"$out")" = "error,ms,name,ours,server,state,tools" ]
  [ "$(jq -r '[.clients[].servers[] | select(.name == "good") | .state] | unique | join(",")' <<<"$out")" = "connected" ]
  [ "$(jq -c .summary <<<"$out")" = '{"total":12,"connected":3,"failed":9,"failed_ours":9,"foreign_failed":0}' ]
  # прогресс не мешает машинному выводу: в --json он уходит в stderr, stdout остаётся чистым JSON
  [[ "$(cat "$BATS_TEST_TMPDIR/progress.txt")" == *"проверяю"* ]]

  # человекочитаемый вывод говорит то же самое, с миллисекундами и числом тулов
  run bash "$STATION/bin/mcp-station.sh" verify good --timeout 2
  [ "$status" -eq 0 ]
  [[ "$output" == *"good: connected"* ]]
  [[ "$output" == *"тулов 3"* ]]
  [[ "$output" == *"итог: проверок 3, connected 3, не поднялось 0"* ]]
}

@test "verify: имена и --exclude выбирают подмножество, отсутствующая запись видна" {
  stub_servers
  own_stubs "good:$STUBS/good.mjs" "silent:$STUBS/silent.mjs"
  verify_clients "good:$STUBS/good.mjs" "silent:$STUBS/silent.mjs"

  # только good: всё поднялось — код возврата 0
  run bash "$STATION/bin/mcp-station.sh" verify good --timeout 5
  [ "$status" -eq 0 ]
  [[ "$output" == *"good: connected"* ]]
  [[ "$output" != *"silent"* ]]

  # --exclude выкидывает тяжёлое из полного прогона
  run bash "$STATION/bin/mcp-station.sh" verify --exclude silent --timeout 2
  [ "$status" -eq 0 ]
  [[ "$output" == *"good: connected"* ]]
  [[ "$output" != *"silent"* ]]

  # без --exclude молчащая запись упирается в таймаут, и это видно в коде возврата
  run bash "$STATION/bin/mcp-station.sh" verify --timeout 1
  [ "$status" -eq 1 ]
  [[ "$output" == *"silent: timeout"* ]]

  # на длинном ожидании видно, почему висит: сервер поднимает браузер, это долго
  run bash "$STATION/bin/mcp-station.sh" verify silent --client omp --timeout 6
  [ "$status" -eq 1 ]
  [[ "$output" == *"поднимаю браузер, это долго"* ]]

  # имени нет в конфиге — поднимать нечего, и это тоже провал, а не молчание
  run bash "$STATION/bin/mcp-station.sh" verify ghost --timeout 2
  [ "$status" -eq 1 ]
  [[ "$output" == *"ghost: spawn-failed"* ]]
  [[ "$output" == *"записи нет"* ]]
}

@test "verify: после прогона не остаётся сирот (по /proc)" {
  stub_servers
  own_stubs "good:$STUBS/good.mjs" "silent:$STUBS/silent.mjs"
  verify_clients "good:$STUBS/good.mjs" "silent:$STUBS/silent.mjs"

  run bash "$STATION/bin/mcp-station.sh" verify --timeout 2
  [ "$status" -eq 1 ]
  # каждая заглушка записала свой pid, а good — ещё и pid своего ребёнка
  [ "$(wc -l <"$STUB_PIDS")" -ge 8 ]

  local pid left alive
  for _ in $(seq 1 30); do
    alive=0
    while read -r pid; do
      [ -e "/proc/$pid" ] && alive=1
    done <"$STUB_PIDS"
    [ "$alive" -eq 0 ] && break
    sleep 0.1
  done
  left=""
  while read -r pid; do
    [ -e "/proc/$pid" ] && left="$left $pid"
  done <"$STUB_PIDS"
  if [ -n "$left" ]; then
    printf 'остались жить после verify:%s\n' "$left"
    kill -9 $left 2>/dev/null || true
    false
  fi
}

# Наша ли запись — не догадка, а сверка с состоянием станции и каталогом. У ICP уже есть свои
# MCP-записи, и их провал не должен валить проверку дома (Б1: aggg-beside.log — дом жив, FRESH_RC=1).
@test "verify: своя упала, чужая упала — наш провал один, чужой отдельной строкой" {
  stub_servers
  own_stubs "ours-crash:$STUBS/crash.mjs"
  run bash "$STATION/bin/mcp-station.sh" install ours-crash --client omp
  [ "$status" -eq 0 ]
  # чужая запись: покупатель завёл сам, станция её не ставила (в состоянии её нет)
  jq --arg s "exec node $STUBS/crash.mjs" \
    '.mcpServers["my-own-server"] = {command: "bash", args: ["-lc", $s]}' \
    "$MCP_STATION_HOME/.omp/agent/mcp.json" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$MCP_STATION_HOME/.omp/agent/mcp.json"

  local out rc=0
  out="$(bash "$STATION/bin/mcp-station.sh" verify --client omp --timeout 2 --json 2>/dev/null)" || rc=$?
  [ "$rc" -eq 1 ]                                   # наша упала — код 1
  [ "$(jq -r '.summary.failed_ours' <<<"$out")" = "1" ]
  [ "$(jq -r '.summary.foreign_failed' <<<"$out")" = "1" ]
  [ "$(jq -r '.summary.failed' <<<"$out")" = "2" ]  # failed — сумма: совместимость
  [ "$(jq -r '.clients[0].servers[] | select(.name == "ours-crash") | .ours' <<<"$out")" = "true" ]
  [ "$(jq -r '.clients[0].servers[] | select(.name == "my-own-server") | .ours' <<<"$out")" = "false" ]
  [ "$(jq -r '.foreign_failures | length' <<<"$out")" = "1" ]

  run bash "$STATION/bin/mcp-station.sh" verify --client omp --timeout 2
  [ "$status" -eq 1 ]
  [[ "$output" == *"не поднялось 1"* ]]
  [[ "$output" == *"чужое, не считаем: omp/my-own-server — spawn-failed"* ]]
}

@test "verify: чужая упала, наша жива — провалов 0 и код 0" {
  stub_servers
  own_stubs "ours-good:$STUBS/good.mjs"
  run bash "$STATION/bin/mcp-station.sh" install ours-good --client omp
  [ "$status" -eq 0 ]
  jq --arg s "exec node $STUBS/crash.mjs" \
    '.mcpServers["my-own-server"] = {command: "bash", args: ["-lc", $s]}' \
    "$MCP_STATION_HOME/.omp/agent/mcp.json" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$MCP_STATION_HOME/.omp/agent/mcp.json"

  local out rc=0
  out="$(bash "$STATION/bin/mcp-station.sh" verify --client omp --timeout 2 --json 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ]
  [ "$(jq -r '.ok' <<<"$out")" = "true" ]
  [ "$(jq -r '.summary.failed_ours' <<<"$out")" = "0" ]
  [ "$(jq -r '.summary.foreign_failed' <<<"$out")" = "1" ]
  [ "$(jq -r '.summary.failed' <<<"$out")" = "1" ]

  run bash "$STATION/bin/mcp-station.sh" verify --client omp --timeout 2
  [ "$status" -eq 0 ]
  [[ "$output" == *"не поднялось 0"* ]]
  [[ "$output" == *"чужое, не считаем: omp/my-own-server — spawn-failed"* ]]
}

@test "verify: состояние не прочитать — принадлежность по каталогу, и это сказано в отчёте" {
  stub_servers
  own_stubs "ours-crash:$STUBS/crash.mjs"
  run bash "$STATION/bin/mcp-station.sh" install ours-crash --client omp
  [ "$status" -eq 0 ]
  jq --arg s "exec node $STUBS/crash.mjs" \
    '.mcpServers["my-own-server"] = {command: "bash", args: ["-lc", $s]}' \
    "$MCP_STATION_HOME/.omp/agent/mcp.json" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$MCP_STATION_HOME/.omp/agent/mcp.json"
  printf 'не json\n' >"$STATE_FILE"   # состояние станции не разобрать — формой не гадаем

  local out rc=0
  out="$(bash "$STATION/bin/mcp-station.sh" verify --client omp --timeout 2 --json 2>/dev/null)" || rc=$?
  [ "$rc" -eq 1 ]  # имя есть в каталоге — запись считаем своей
  [ "$(jq -r '.owners' <<<"$out")" = "catalog" ]
  [ "$(jq -r '.summary.failed_ours' <<<"$out")" = "1" ]
  [ "$(jq -r '.summary.foreign_failed' <<<"$out")" = "1" ]
  [ "$(printf '%s' "$out" | jq --arg file "$STATE_FILE" -r '.state_error | startswith($file)')" = "true" ]
}

@test "verify: запись берётся из конфига клиента, а таймаут — из verifyTimeout каталога" {
  stub_servers
  # каталог-двойник: у записи slow своё поле verifyTimeout (1 с) и ДРУГАЯ команда, чем в конфиге
  CATALOG_TWIN="$BATS_TEST_TMPDIR/catalog-verify"
  rm -rf "$CATALOG_TWIN"
  mkdir -p "$CATALOG_TWIN"
  jq -n --arg script "exec node $STUBS/good.mjs" '{
    name: "slow", kind: "stdio", tier: "core", description: "заглушка",
    argv: ["bash", "-lc", $script], verifyTimeout: 1
  }' >"$CATALOG_TWIN/slow.json"
  verify_clients "slow:$STUBS/silent.mjs"

  local out rc=0 started elapsed
  started="$(date +%s)"
  out="$(env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" verify slow --client omp --timeout 30 --json 2>/dev/null)" || rc=$?
  elapsed=$(( $(date +%s) - started ))
  # поднимаем ровно запись из конфига (она молчит), а ждём по каталогу: 30 с не выжидаем
  [ "$rc" -eq 1 ]
  [ "$(jq -r '.clients[0].servers[0].state' <<<"$out")" = "timeout" ]
  [ "$elapsed" -lt 10 ]
}

@test "verify: http-запись проверяется по протоколу, значения заголовков не печатаются" {
  local port=$((40000 + RANDOM % 10000))
  local dir="$MCP_STATION_HOME"
  mkdir -p "$dir/.omp/agent" "$dir/.pi/agent" "$dir/.config/opencode"
  cat >"$BATS_TEST_TMPDIR/http-stub.mjs" <<'JS'
import { createServer } from "node:http";
createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const message = JSON.parse(body || "{}");
    const key = request.headers["x-api-key"];
    const reply = (result) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") {
      if (key !== "test-http-key") { response.writeHead(401); response.end(); return; }
      reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-stub", version: "2.0" } });
    } else if (message.method === "tools/list") {
      reply({ tools: [{ name: "x" }] });
    } else {
      response.writeHead(202);
      response.end();
    }
  });
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");
JS
  STUB_PORT="$port" node "$BATS_TEST_TMPDIR/http-stub.mjs" &
  local stub_pid=$!
  sleep 1

  local url="http://127.0.0.1:$port/mcp" dead="http://127.0.0.1:9/mcp"
  # каталог-двойник: эти http-записи — наши (url совпадает), иначе станция честно считает их чужими
  CATALOG_TWIN="$BATS_TEST_TMPDIR/catalog-http"
  rm -rf "$CATALOG_TWIN"
  mkdir -p "$CATALOG_TWIN"
  local pair
  for pair in "exa:$url" "dead:$dead" "wrong:$url" "noenv:$url"; do
    jq -n --arg name "${pair%%:*}" --arg url "${pair#*:}" \
      '{name: $name, kind: "http", tier: "keyed", description: "заглушка http",
        url: $url, headers: {"x-api-key": {env: "EXA_API_KEY"}}}' >"$CATALOG_TWIN/${pair%%:*}.json"
  done
  export MCP_STATION_CATALOG="$CATALOG_TWIN"
  # omp и pi подставляют значение заголовка `!`-командой, opencode держит литерал
  jq -n --arg u "$url" --arg d "$dead" '{mcpServers: {
    exa: {type: "http", url: $u, headers: {"x-api-key": "!printf test-http-key"}},
    dead: {type: "http", url: $d, headers: {"x-api-key": "!printf test-http-key"}},
    wrong: {type: "http", url: $u, headers: {"x-api-key": "!printf nope-secret-value"}}}}' >"$dir/.omp/agent/mcp.json"
  jq -n --arg u "$url" --arg d "$dead" '{mcpServers: {
    exa: {url: $u, headers: {"x-api-key": "!printf test-http-key"}},
    dead: {url: $d, headers: {"x-api-key": "!printf test-http-key"}},
    wrong: {url: $u, headers: {"x-api-key": "!printf nope-secret-value"}}}}' >"$dir/.pi/agent/mcp.json"
  jq -n --arg u "$url" --arg d "$dead" '{mcp: {
    exa: {type: "remote", url: $u, headers: {"x-api-key": "test-http-key"}},
    dead: {type: "remote", url: $d, headers: {"x-api-key": "test-http-key"}},
    noenv: {type: "remote", url: $u, headers: {"x-api-key": "{env:MCP_STATION_MISSING_VAR}"}},
    wrong: {type: "remote", url: $u, headers: {"x-api-key": "nope-secret-value"}}}}' >"$dir/.config/opencode/opencode.json"

  run bash "$STATION/bin/mcp-station.sh" verify exa dead wrong --timeout 5
  kill "$stub_pid" 2>/dev/null || true
  [ "$status" -eq 1 ]
  [[ "$output" == *"exa: connected"* ]]
  [[ "$output" == *"http-stub 2.0"* ]]
  [[ "$output" == *"тулов 1"* ]]
  # закрытый порт — сетевая ошибка, отбитый ключ — 401: обе видны как http-error
  [[ "$output" == *"dead: http-error"* ]]
  [[ "$output" == *"wrong: http-error"* ]]
  [[ "$output" == *"HTTP 401"* ]]
  # значения заголовков в вывод не попадают
  [[ "$output" != *"test-http-key"* ]]
  [[ "$output" != *"nope-secret-value"* ]]

  # ссылка {env:VAR} без самой переменной: запись есть, а ключа для неё нет — это http-error
  run bash "$STATION/bin/mcp-station.sh" verify noenv --client opencode --timeout 3
  [ "$status" -eq 1 ]
  [[ "$output" == *"noenv: http-error"* ]]
  [[ "$output" == *"нет значения для заголовка x-api-key"* ]]
}

# ---------------------------------------------------------------- блокировка браузера

# Снимок процессов для теста: свой «/proc» (MCP_STATION_PROC_ROOT), поэтому «запись новее запуска
# клиента» проверяется без запуска настоящих клиентов. Спека — «pid:ppid:секунд-назад:командная строка».
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
    # поля stat как их читает /proc: 4-е — родитель, 22-е — время старта в тиках
    printf '%s (%s) S %s 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 %s 0 0 0\n' \
      "$pid" "${cmd%% *}" "$ppid" "$ticks" >"$root/$pid/stat"
  done
}

# Блокировка браузера живёт в рантайме центра; в тестах — в подменённом доме (MCP_STATION_HOME),
# поэтому путь считается в момент вызова, а не при чтении файла тестов.
browser_lock() { printf '%s\n' "$MCP_STATION_HOME/.local/state/command-center/browser.lock"; }

write_lock() { # $1 — pid, $2 — время старта (ISO), $3 — ttl
  mkdir -p "$(dirname "$(browser_lock)")"
  printf 'pid=%s\nowner=чужой прогон\nrun=браузерные: camoufox\nstarted=%s\nttl=%s\n' \
    "$1" "$2" "${3:-1800}" >"$(browser_lock)"
}

@test "verify берёт блокировку браузера перед браузерными серверами и снимает её после" {
  stub_servers
  # запись camoufox помечена в каталоге как браузерная: её проверка берёт блокировку
  verify_clients "camoufox:$STUBS/good.mjs"

  run bash "$STATION/bin/mcp-station.sh" verify camoufox --client omp --timeout 5
  [ "$status" -eq 0 ]
  [[ "$output" == *"взял блокировку браузера"* ]]
  [[ "$output" == *"camoufox: connected"* ]]
  # после прогона блокировки нет: её снимает тот, кто взял
  [ ! -e "$(browser_lock)" ]

  # небраузерные записи блокировку не трогают: обычная проверка не должна ждать чужой прогон
  write_lock 999999 "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  verify_clients "wiki:$STUBS/good.mjs"
  run bash "$STATION/bin/mcp-station.sh" verify wiki --client omp --timeout 5
  [ "$status" -eq 0 ]
  [[ "$output" != *"блокировку"* ]]
  [ -e "$(browser_lock)" ]
}

@test "verify: браузер занят — не запускает проверку, а говорит, кем занят и как снять" {
  stub_servers
  verify_clients "camoufox:$STUBS/good.mjs"
  write_lock "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  run bash "$STATION/bin/mcp-station.sh" verify camoufox --client omp --timeout 5
  [ "$status" -eq 1 ]
  [[ "$output" == *"браузер занят чужой прогон (браузерные: camoufox): pid $$ с "* ]]
  [[ "$output" == *"снять принудительно: rm $(browser_lock)"* ]]
  # чужую блокировку не тронули и ничего не поднимали
  [ -e "$(browser_lock)" ]
  [[ "$output" != *"проверяю"* ]]

  # в --json отказ тоже машинный: ok:false, причина в error, серверов не проверяли
  local out rc=0
  out="$(bash "$STATION/bin/mcp-station.sh" verify camoufox --client omp --timeout 5 --json 2>/dev/null)" || rc=$?
  [ "$rc" -eq 1 ]
  [ "$(printf '%s' "$out" | jq -r "[(.ok|tostring), (.error | startswith(\"браузер занят\")), (.clients|length|tostring), (.summary.total|tostring)] | join(\"|\")")" = "false|true|0|0" ]
}

@test "verify: протухшая блокировка снимается сама, и это видно в выводе" {
  stub_servers
  verify_clients "camoufox:$STUBS/good.mjs"

  # pid не жив — прогон умер, не сняв за собой блокировку
  write_lock 999999 "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run bash "$STATION/bin/mcp-station.sh" verify camoufox --client omp --timeout 5
  [ "$status" -eq 0 ]
  [[ "$output" == *"блокировка протухла (pid 999999 не жив) — снимаю и беру свою"* ]]
  [[ "$output" == *"camoufox: connected"* ]]
  [ ! -e "$(browser_lock)" ]

  # pid жив, но блокировка старше TTL: тоже протухла (TTL настраиваемый, тут 60 секунд)
  write_lock "$$" "2026-01-01T00:00:00Z" 60
  run env CENTER_BROWSER_LOCK_TTL=60 bash "$STATION/bin/mcp-station.sh" verify camoufox --client omp --timeout 5
  [ "$status" -eq 0 ]
  [[ "$output" == *"блокировка протухла (старше TTL (1 мин)) — снимаю и беру свою"* ]]
  [ ! -e "$(browser_lock)" ]
}

@test "verify --no-lock: явный обход с предупреждением, блокировку не берёт" {
  stub_servers
  verify_clients "camoufox:$STUBS/good.mjs"
  write_lock "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  run bash "$STATION/bin/mcp-station.sh" verify camoufox --client omp --timeout 5 --no-lock
  [ "$status" -eq 0 ]
  [[ "$output" == *"--no-lock: проверяю браузерные серверы (camoufox) без блокировки"* ]]
  [[ "$output" == *"столкнутся"* ]]
  [[ "$output" == *"camoufox: connected"* ]]
  # чужую блокировку обход не снимает: её владелец всё ещё работает
  [ -e "$(browser_lock)" ]
}

# ---------------------------------------------------------------- «зарегистрирован ≠ видно в сессии»

@test "verify: конфиг новее запуска клиента — session_stale, а без процесса клиента поля нет" {
  stub_servers
  verify_clients "wiki:$STUBS/good.mjs"
  # opencode стартовал час назад, omp — только что; pi не запущен
  proc_fixture "$BATS_TEST_TMPDIR/proc" \
    "101:1:7200:/usr/bin/opencode2" \
    "102:1:10:bun $MCP_STATION_HOME/.bun/bin/omp"
  # час назад: touch -d есть только в GNU, поэтому считаем метку сами
  stamp="$(date -d '1 hour ago' +%Y%m%d%H%M 2>/dev/null || date -v-1H +%Y%m%d%H%M)"
  touch -t "$stamp" "$MCP_STATION_HOME/.omp/agent/mcp.json" "$MCP_STATION_HOME/.pi/agent/mcp.json"

  run env MCP_STATION_PROC_ROOT="$BATS_TEST_TMPDIR/proc" \
      bash "$STATION/bin/mcp-station.sh" verify wiki --timeout 5
  [ "$status" -eq 0 ]
  [[ "$output" == *"opencode: запись новее запуска клиента"* ]]
  [[ "$output" == *"тулы появятся после перезапуска (opencode2 service restart / новый сеанс omp, pi)"* ]]
  [[ "$output" != *"omp/pi: запись новее запуска клиента"* ]]

  # --json: прогресс станция пишет в stderr, поэтому берём stdout напрямую (через run он бы слился)
  local out rc=0
  out="$(env MCP_STATION_PROC_ROOT="$BATS_TEST_TMPDIR/proc" \
    bash "$STATION/bin/mcp-station.sh" verify wiki --timeout 5 --json 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ]
  # у pi процесса нет — поля нет вовсе: «не знаю» честнее выдумки
  [ "$(printf '%s' "$out" | jq -r "[(.clients[] | select(.client==\"opencode\") | .session_stale|tostring), (.clients[] | select(.client==\"omp\") | .session_stale|tostring), (.clients[] | select(.client==\"pi\") | has(\"session_stale\")|tostring)] | join(\"|\")")" = "true|false|false" ]

  # снимка процессов нет вовсе (/proc недоступен): про сессии молчим, проверка от этого не падает
  out="$(env MCP_STATION_PROC_ROOT="$BATS_TEST_TMPDIR/нет-такого" \
    bash "$STATION/bin/mcp-station.sh" verify wiki --timeout 5 --json 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ]
  [ "$(printf '%s' "$out" | jq -r "[.clients[] | has(\"session_stale\")] | any | tostring")" = "false" ]
}

# ── Windows: нативный запуск без bash ──────────────────────────────────────────
# MCP_STATION_PLATFORM=win32 прогоняет ветку Windows на Linux — иначе она остаётся непроверенной.
# Повод: на Windows `bash` в PATH оказался заглушкой из дистрибутива WSL: на `-lc` она печатала
# «поставь дистрибутив» и выходила с нулём, поэтому семь записей из восьми были мёртвыми, а check
# молчал зелёным. Правило: на win32 ни один путь станции не спавнит bash из PATH — либо нативная
# ветка (node / cmd.exe / entryenv.mjs), либо настоящий Git Bash, найденный по абсолютному пути и
# проверенный делом (`--version` отвечает «GNU bash»).

@test "win32: запись с argvWindows ставится нативно, а без него и без настоящего bash — не ставится" {
  catalog_copy
  # своя запись без argvWindows (bash) и своя с argvWindows (прямая команда)
  printf '%s\n' '{"name":"withbash","kind":"stdio","tier":"core","description":"нужен bash","argv":["bash","-lc","exec node \"$HOME/x.mjs\""],"clients":["omp","opencode"]}' \
    >"$CATALOG_TWIN/withbash.json"
  printf '%s\n' '{"name":"native","kind":"stdio","tier":"core","description":"нативная команда","argv":["bash","-lc","exec node \"$HOME/x.mjs\""],"argvWindows":["node","$HOME/x.mjs"],"clients":["omp","opencode"]}' \
    >"$CATALOG_TWIN/native.json"
  # PATH как на чистой Windows: настоящего bash нет вовсе
  local empty="$BATS_TEST_TMPDIR/empty-path"
  mkdir -p "$empty"

  run env -u AGGG_BASH -u MCP_STATION_BASH MCP_STATION_PLATFORM=win32 MCP_STATION_CATALOG="$CATALOG_TWIN" \
      PATH="$empty" "$(command -v node)" "$STATION/bin/station.mjs" install withbash native
  [ "$status" -eq 1 ]
  [[ "$output" == *"запись требует bash, а на Windows его нет — дай argvWindows в каталоге или поставь Git for Windows"* ]]
  [[ "$output" == *"не поставлено на этой ОС: withbash"* ]]

  # bash-записи в конфиге нет, нативная — есть, с раскрытым домом и виндовыми разделителями
  run jq -r '.mcpServers | keys | join(",")' "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "native" ]
  run jq -r '.mcpServers.native.command + " " + .mcpServers.native.args[0]' "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [[ "$output" == node* ]]
  [[ "$output" != *'$HOME'* ]]
  # дом раскрыт на момент установки, разделители виндовые (шелла в конфиге Windows нет)
  [[ "$output" == *'\'* ]]

  # у opencode запись нативная по форме: type + массив command
  run jq -r '.mcp.native.type + "|" + (.mcp.native.command | type)' "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "local|array" ]
}

@test "win32: настоящий Git Bash ставится абсолютным путём, а заглушка WSL — нет" {
  catalog_copy
  printf '%s\n' '{"name":"withbash","kind":"stdio","tier":"core","description":"нужен bash","argv":["bash","-lc","exec node \"$HOME/x.mjs\""],"clients":["omp"]}' \
    >"$CATALOG_TWIN/withbash.json"
  local bin="$BATS_TEST_TMPDIR/win-bin" stub="$BATS_TEST_TMPDIR/win-stub"
  local apps="$BATS_TEST_TMPDIR/Microsoft/WindowsApps" empty="$BATS_TEST_TMPDIR/win-empty"
  mkdir -p "$bin" "$stub" "$apps" "$empty"
  # заглушка WSL: печатает инструкцию и выходит с нулём — «запустилось» про неё ничего не значит
  printf '#!/bin/sh\nprintf "Windows Subsystem for Linux has no installed distributions.\\n"\nexit 0\n' >"$stub/bash.exe"
  cp "$stub/bash.exe" "$apps/bash.exe"
  # настоящий bash: отвечает «GNU bash» — по этому признаку он и принимается
  printf '#!/bin/sh\nprintf "GNU bash, version 5.2.26(1)-release\\n"\n' >"$bin/bash.exe"
  chmod +x "$stub/bash.exe" "$apps/bash.exe" "$bin/bash.exe"

  # заглушка отброшена пробой делом, даже когда лежит не в каталоге подстановок
  run env -u AGGG_BASH -u MCP_STATION_BASH MCP_STATION_PLATFORM=win32 MCP_STATION_CATALOG="$CATALOG_TWIN" \
      PATH="$stub;$empty" "$(command -v node)" "$STATION/bin/station.mjs" install withbash
  [ "$status" -eq 1 ]
  [[ "$output" == *"запись требует bash, а на Windows его нет"* ]]

  # каталог подстановок WindowsApps не считается источником bash: там живёт заглушка WSL
  run env -u AGGG_BASH -u MCP_STATION_BASH MCP_STATION_PLATFORM=win32 MCP_STATION_CATALOG="$CATALOG_TWIN" \
      PATH="$apps;$empty" "$(command -v node)" "$STATION/bin/station.mjs" install withbash
  [ "$status" -eq 1 ]
  [[ "$output" == *"запись требует bash, а на Windows его нет"* ]]
  [ ! -e "$MCP_STATION_HOME/.omp/agent/mcp.json" ]

  # настоящий bash виден, каталог подстановок — нет: запись ставится с АБСОЛЮТНЫМ путём к нему
  run env -u AGGG_BASH -u MCP_STATION_BASH MCP_STATION_PLATFORM=win32 MCP_STATION_CATALOG="$CATALOG_TWIN" \
      PATH="$apps;$bin" "$(command -v node)" "$STATION/bin/station.mjs" install withbash
  [ "$status" -eq 0 ]
  run jq -r '.mcpServers.withbash.command' "$MCP_STATION_HOME/.omp/agent/mcp.json"
  [ "$output" = "$bin/bash.exe" ]
  [[ "$output" != "bash" ]]
}

@test "win32: PATH из Git Bash (через «:») тоже разбирается — npm.cmd находится" {
  catalog_copy
  printf '%s\n' '{"name":"npmserver","kind":"stdio","tier":"core","description":"npx-сервер","argv":["npx","-y","thing"],"argvWindows":["npx","-y","thing"],"clients":["omp"]}' \
    >"$CATALOG_TWIN/npmserver.json"
  local bin="$BATS_TEST_TMPDIR/git-bin"
  mkdir -p "$bin"
  : >"$bin/npx.cmd"

  # в Git Bash та же переменная приходит через «:» с путями вида /c/...: разбор по «;» нашёл бы ноль каталогов
  run env MCP_STATION_PLATFORM=win32 MCP_STATION_CATALOG="$CATALOG_TWIN" \
      PATH="$bin:/usr/bin" PATHEXT=".CMD" "$(command -v node)" "$STATION/bin/station.mjs" check npmserver
  [ "$status" -eq 0 ]
  [[ "$output" == *"npmserver"*"ok"* ]]
}

@test "install на win32 ставит нативные записи: entryenv для ключей, cmd.exe для npx, envWindows для профиля" {
  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" install --profile all
  [ "$status" -eq 0 ]
  local omp="$MCP_STATION_HOME/.omp/agent/mcp.json" oc="$MCP_STATION_HOME/.config/opencode/opencode.json"

  # ни одной записи, которую на Windows спавнит bash
  run jq -r '[.mcpServers[].command] | index("bash")' "$omp"
  [ "$output" = "null" ]
  run jq -r '[.mcp[].command | if type == "array" then .[] else empty end] | index("bash")' "$oc"
  [ "$output" = "null" ]

  # сервер с ключом: обёртка entryenv, полезная нагрузка после «--», ключа в конфиге нет
  run jq -r '.mcpServers.firecrawl.command' "$omp"
  [ "$output" = "node" ]
  run jq -r '.mcpServers.firecrawl.args | join(" ")' "$omp"
  [[ "$output" == *"entryenv.mjs -- npx -y firecrawl-mcp@3.25.4"* ]]
  [[ "$output" != *bash* ]]
  [[ "$output" != *test-firecrawl* ]]

  # npx-записи идут через cmd.exe /c: node не спавнит .cmd напрямую (EINVAL)
  run jq -r '.mcpServers["chrome-devtools"].command + " " + .mcpServers["chrome-devtools"].args[0]' "$omp"
  [ "$output" = "cmd.exe /c" ]

  # camoufox: exe из venv проекта и профиль агента в окружении записи (у opencode — environment)
  run jq -r '.mcpServers.camoufox.command' "$omp"
  [[ "$output" == *"Scripts\\camoufox-research.exe"* ]]
  run jq -r '.mcpServers.camoufox.env.CAMOUFOX_CAPS' "$omp"
  [ "$output" = "research,browser,session,vision" ]
  run jq -r '.mcp.camoufox.environment.CAMOUFOX_CAPS' "$oc"
  [ "$output" = "research,browser,session,vision" ]

  # заголовки http на Windows — литерал из файла ключей: `!`-подстановку там никто не выполнит
  run jq -r '.mcpServers.exa.headers["x-api-key"]' "$omp"
  [ "$output" = "test-exa" ]
  run jq -r '.mcp.exa.headers["x-api-key"]' "$oc"
  [ "$output" = "test-exa" ]
  # явное «пусть клиент видит переменную» остаётся доступным и на win32
  run env MCP_STATION_PLATFORM=win32 MCP_STATION_OMP_HEADERS=env bash "$STATION/bin/mcp-station.sh" install exa
  [ "$status" -eq 0 ]
  run jq -r '.mcpServers.exa.headers["x-api-key"]' "$omp"
  [ "$output" = "{env:EXA_API_KEY}" ]
}

@test "update на win32 переписывает Unix-форму записи как свою, а чужое не трогает" {
  local omp="$MCP_STATION_HOME/.omp/agent/mcp.json"
  # так запись выглядит после установки на Unix: bash -lc с файлом ключей
  bash "$STATION/bin/mcp-station.sh" install firecrawl >/dev/null
  run jq -r '.mcpServers.firecrawl.command' "$omp"
  [ "$output" = "bash" ]

  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" update firecrawl
  [ "$status" -eq 0 ]
  [[ "$output" == *"Unix-форма записи (bash -lc) заменена нативной"* ]]
  [[ "$output" != *"не трогаю"* ]]
  run jq -r '.mcpServers.firecrawl.command' "$omp"
  [ "$output" = "node" ]
  run jq -r '.mcpServers.firecrawl.args | join(" ")' "$omp"
  [[ "$output" == *"entryenv.mjs -- npx -y firecrawl-mcp@3.25.4"* ]]

  # настоящее чужое (запись установщика проекта с абсолютным путём к venv) остаётся нетронутым
  jq --arg exe "$BATS_TEST_TMPDIR/venvs/camoufox-research/Scripts/camoufox-research.exe" \
    '.mcpServers.camoufox = {command: $exe}' "$omp" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$omp"
  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" update firecrawl camoufox
  [ "$status" -eq 0 ]
  [[ "$output" == *"не трогаю, это не наша запись"* ]]
  run jq -r '.mcpServers.camoufox.command' "$omp"
  [[ "$output" == *"camoufox-research.exe"* ]]
}

@test "бэкапы конфигов: рядом остаются последние пять, остальные уезжают в рантайм" {
  local omp="$MCP_STATION_HOME/.omp/agent/mcp.json"
  local dump="$MCP_STATION_HOME/.local/state/mcp-station/dump"
  bash "$STATION/bin/mcp-station.sh" install wiki >/dev/null
  # ручные копии владельца: под правило `<имя конфига>.bak` они попадают, чужие имена — нет
  printf 'чужое\n' >"$MCP_STATION_HOME/.omp/agent/other.json.bak"
  local i
  for i in 1 2 3 4 5 6 7; do
    printf 'ручной бэкап %s\n' "$i" >"$omp.bak-$i"
    touch -t "2026010${i}0000" "$omp.bak-$i"      # свежесть по возрастанию: 7 — самый свежий
  done

  run bash "$STATION/bin/mcp-station.sh" install inspo
  [ "$status" -eq 0 ]
  [[ "$output" == *"старые .bak перенесены в рантайм: 3"* ]]
  # рядом остались пять самых свежих, остальные лежат в рантайме, а не удалены
  run bash -c 'ls "$1".bak* | wc -l' _ "$omp"
  [ "$output" = "5" ]
  run bash -c 'ls "$1" | wc -l' _ "$dump"
  [ "$output" = "3" ]
  run bash -c 'ls "$1"/mcp.json.bak-1' _ "$dump"
  [ -f "$dump/mcp.json.bak-1" ]
  # чужой файл рядом не наш: его не трогали
  [ -f "$MCP_STATION_HOME/.omp/agent/other.json.bak" ]
}

@test "entryenv: ключи из файла попадают в окружение, без файла — честный отказ" {
  local dir="$BATS_TEST_TMPDIR/entryenv"
  mkdir -p "$dir"

  # файла ключей нет: команда не запускается, причина сказана строкой
  run env MCP_STATION_SECRETS="$dir/нет-такого" node "$STATION/bin/entryenv.mjs" -- node -e "console.log('выполнилось')"
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет файла ключей"* ]]
  [[ "$output" != *"выполнилось"* ]]

  printf 'FIRECRAWL_API_KEY=test-entryenv\n' >"$dir/secrets.env"
  # с файлом команда запускается и видит переменную — как на Unix после `set -a; . file; set +a`
  run env MCP_STATION_SECRETS="$dir/secrets.env" node "$STATION/bin/entryenv.mjs" -- node -e "process.stdout.write('ключ=' + process.env.FIRECRAWL_API_KEY)"
  [ "$status" -eq 0 ]
  [ "$output" = "ключ=test-entryenv" ]

  # значение из файла важнее унаследованного — иначе ключ из окружения перебивал бы файл ключей
  run env MCP_STATION_SECRETS="$dir/secrets.env" FIRECRAWL_API_KEY=из-окружения \
      node "$STATION/bin/entryenv.mjs" -- node -e "process.stdout.write(process.env.FIRECRAWL_API_KEY)"
  [ "$status" -eq 0 ]
  [ "$output" = "test-entryenv" ]

  # код возврата сервера отдаётся наружу как есть
  run env MCP_STATION_SECRETS="$dir/secrets.env" node "$STATION/bin/entryenv.mjs" -- node -e "process.exit(3)"
  [ "$status" -eq 3 ]
}

@test "entryenv на win32: .cmd-команда идёт через cmd.exe" {
  local dir="$BATS_TEST_TMPDIR/entryenv-win"
  mkdir -p "$dir/bin"
  printf 'FIRECRAWL_API_KEY=test-entryenv\n' >"$dir/secrets.env"
  # подложенные npx.cmd и cmd.exe: проверяем, что обёртка зовёт именно cmd.exe /c
  : >"$dir/bin/npx.cmd"
  cat >"$dir/bin/cmd.exe" <<'SH'
#!/bin/sh
printf 'cmd: %s\n' "$*"
SH
  chmod +x "$dir/bin/cmd.exe"

  run env MCP_STATION_PLATFORM=win32 MCP_STATION_SECRETS="$dir/secrets.env" \
      PATH="$dir/bin" PATHEXT=".CMD" "$(command -v node)" "$STATION/bin/entryenv.mjs" -- npx -y firecrawl-mcp@3.25.4
  [ "$status" -eq 0 ]
  [[ "$output" == "cmd: /c "*"npx.cmd -y firecrawl-mcp@3.25.4" ]]
}

@test "verify на win32: запись с bash без настоящего bash — spawn-failed с причиной, а не мусор заглушки" {
  local empty="$BATS_TEST_TMPDIR/win-empty"
  mkdir -p "$empty" "$MCP_STATION_HOME/.omp/agent"
  # такую запись оставила установка на Unix: наша же Unix-форма (`bash -lc …`), а bash на этой машине нет
  jq -n --slurpfile entry "$STATION/catalog/wiki.json" \
    '{mcpServers: {"wiki": {command: $entry[0].argv[0], args: $entry[0].argv[1:]}}}' \
    >"$MCP_STATION_HOME/.omp/agent/mcp.json"

  run env -u AGGG_BASH -u MCP_STATION_BASH MCP_STATION_PLATFORM=win32 PATH="$empty" \
      "$(command -v node)" "$STATION/bin/station.mjs" verify wiki --client omp --timeout 5
  [ "$status" -eq 1 ]
  [[ "$output" == *"wiki: spawn-failed"* ]]
  [[ "$output" == *"нет настоящего bash"* ]]

  # в машинном виде это причина, а не no-handshake с мусором: поднимать заглушку станция не станет
  local out rc=0
  out="$(env -u AGGG_BASH -u MCP_STATION_BASH MCP_STATION_PLATFORM=win32 PATH="$empty" \
    "$(command -v node)" "$STATION/bin/station.mjs" verify wiki --client omp --timeout 5 --json 2>/dev/null)" || rc=$?
  [ "$rc" -eq 1 ]
  [ "$(printf '%s' "$out" | jq -r '.clients[0].servers[0].state')" = "spawn-failed" ]
  [ "$(printf '%s' "$out" | jq -r '.clients[0].servers[0].error | startswith("нет настоящего bash")')" = "true" ]
}

@test "verify на win32: значение `!`-заголовка берётся из файла ключей, а не выполнением строки" {
  mkdir -p "$MCP_STATION_HOME/.omp/agent"
  # такую подстановку пишет станция на Unix; на Windows её некому выполнить
  jq -n '{mcpServers: {"exa": {type: "http", url: "http://127.0.0.1:9/mcp",
    headers: {"x-api-key": "!set -a; . \"$HOME/.config/opencode/secrets/env\"; set +a; printf %s \"$EXA_API_KEY\""}}}}' \
    >"$MCP_STATION_HOME/.omp/agent/mcp.json"
  # каталог-двойник: url тот же — запись наша, её провал валит проверку
  CATALOG_TWIN="$BATS_TEST_TMPDIR/catalog-win-exa"
  rm -rf "$CATALOG_TWIN"
  mkdir -p "$CATALOG_TWIN"
  jq -n '{name: "exa", kind: "http", tier: "keyed", description: "заглушка",
    url: "http://127.0.0.1:9/mcp", headers: {"x-api-key": {env: "EXA_API_KEY"}}}' >"$CATALOG_TWIN/exa.json"
  export MCP_STATION_CATALOG="$CATALOG_TWIN"

  # ключ взят из файла: дошли до сети и упёрлись в закрытый порт, а не в «нечем раскрыть заголовок»
  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" verify exa --client omp --timeout 5
  [ "$status" -eq 1 ]
  [[ "$output" == *"exa: http-error"* ]]
  [[ "$output" != *"не удалось получить значение заголовка"* ]]
  [[ "$output" != *"test-exa"* ]]   # значение наружу не печатается

  # переменной в файле нет — говорим причиной, а не «подстановка не выполнилась»
  printf 'TAVILY_API_KEY=test-tavily\n' >"$BATS_TEST_TMPDIR/other-secrets"
  run env MCP_STATION_PLATFORM=win32 MCP_STATION_SECRETS="$BATS_TEST_TMPDIR/other-secrets" \
      bash "$STATION/bin/mcp-station.sh" verify exa --client omp --timeout 5
  [ "$status" -eq 1 ]
  [[ "$output" == *"не удалось получить значение заголовка x-api-key"* ]]
}

@test "win32: суженный владельцем профиль camoufox не перетирается, а пул идёт через свой шим" {
  local omp="$MCP_STATION_HOME/.omp/agent/mcp.json"
  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" install camoufox
  [ "$status" -eq 0 ]

  # владелец сузил профиль в записи клиента: это его решение, а не расхождение с каталогом
  jq '.mcpServers.camoufox.env.CAMOUFOX_CAPS = "research,browser"' "$omp" >"$BATS_TEST_TMPDIR/j.json"
  mv "$BATS_TEST_TMPDIR/j.json" "$omp"
  local before
  before="$(md5sum "$omp")"
  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" update camoufox
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже стоит"* ]]
  [[ "$output" != *"переписан"* ]]
  run jq -r '.mcpServers.camoufox.env.CAMOUFOX_CAPS' "$omp"
  [ "$output" = "research,browser" ]
  [ "$before" = "$(md5sum "$omp")" ]

  # пул ключей ставится через свой шим: в записи нет ни bash, ни Unix-пути
  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" install exa --pool
  [ "$status" -eq 0 ]
  [ -x "$MCP_STATION_HOME/.local/bin/mcp-keypool.cmd" ]
  run jq -r '.mcpServers.exa.command + " " + (.mcpServers.exa.args | join(" "))' "$omp"
  [[ "$output" == "cmd.exe /c "* ]]
  [[ "$output" == *"mcp-keypool.cmd exa" ]]
  [[ "$output" != *bash* ]]
}

@test "update починяет запись, попавшую не в свою форму (opencode с command+args без type)" {
  catalog_copy
  printf '%s\n' '{"name":"native","kind":"stdio","tier":"core","description":"нативная команда","argv":["bash","-lc","exec node \"$HOME/x.mjs\""],"argvWindows":["node","$HOME/x.mjs"],"clients":["opencode"]}' \
    >"$CATALOG_TWIN/native.json"
  # такую запись оставила старая версия/рука: форма omp-вида внутри opencode, без type
  mkdir -p "$MCP_STATION_HOME/.config/opencode"
  cat >"$MCP_STATION_HOME/.config/opencode/opencode.json" <<'JSON'
{"mcp":{"native":{"command":"node","args":["$HOME/x.mjs"]}}}
JSON

  run env MCP_STATION_PLATFORM=win32 MCP_STATION_CATALOG="$CATALOG_TWIN" \
      bash "$STATION/bin/mcp-station.sh" update native
  [ "$status" -eq 0 ]
  # форма починена, а не объявлена чужой
  [[ "$output" != *"не трогаю"* ]]
  run jq -r '.mcp.native.type + "|" + (.mcp.native.command | type)' "$MCP_STATION_HOME/.config/opencode/opencode.json"
  [ "$output" = "local|array" ]
}

@test "check: отсутствующая команда названа; на win32 argvWindows проверяется, а без него — неставимо" {
  catalog_copy
  printf '%s\n' '{"name":"ghost","kind":"stdio","tier":"core","description":"команда, которой нет","argv":["нет-такой-команды"],"clients":["omp"]}' \
    >"$CATALOG_TWIN/ghost.json"
  printf '%s\n' '{"name":"withbash","kind":"stdio","tier":"core","description":"нужен bash","argv":["bash","-lc","exec node \"$HOME/x.mjs\""],"clients":["omp"]}' \
    >"$CATALOG_TWIN/withbash.json"
  # нативная запись: команда есть в PATH (node.exe), файлов-скриптов нет — проверка проходит
  printf '%s\n' '{"name":"native","kind":"stdio","tier":"core","description":"нативная команда","argv":["bash","-lc","exec node \"$HOME/x.mjs\""],"argvWindows":["node","-e","void 0"],"clients":["omp"]}' \
    >"$CATALOG_TWIN/native.json"

  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" check ghost
  [ "$status" -eq 1 ]
  [[ "$output" == *"в PATH нет нет-такой-команды"* ]]

  # на win32 запись без argvWindows помечается неставимой, а не «проверено зелёным»;
  # у записи с argvWindows проверяются её же файлы: команда находится в PATH
  local bin="$BATS_TEST_TMPDIR/win-bin"
  mkdir -p "$bin"
  : >"$bin/node.exe"
  run env -u AGGG_BASH -u MCP_STATION_BASH MCP_STATION_PLATFORM=win32 MCP_STATION_CATALOG="$CATALOG_TWIN" \
      PATH="$bin" PATHEXT=".EXE" "$(command -v node)" "$STATION/bin/station.mjs" check native withbash
  [ "$status" -eq 1 ]
  [[ "$output" == *"native"*"ok"* ]]
  [[ "$output" == *"запись требует bash, а на Windows его нет — дай argvWindows в каталоге или поставь Git for Windows"* ]]

  # запись с argvWindows проходит и тогда, когда на диске лежит её же файл: путь проверяется
  # по isAbsolute (на win32 это и C:\..., и \\server\..., и /...), а не по «начинается с /»
  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" check camoufox
  [ "$status" -eq 1 ]
  [[ "$output" != *"требует bash"* ]]
  # файл берётся из argvWindows (exe рядом с venv проекта), а не из Unix-формы
  [[ "$output" == *"camoufox-research.exe"* ]]

  run env MCP_STATION_PLATFORM=win32 bash "$STATION/bin/mcp-station.sh" check skills-hub
  [ "$status" -eq 1 ]
  [[ "$output" != *"требует bash"* ]]
}

@test "outdated: битое состояние станции — unknown, а не «свежо»" {
  bash "$STATION/bin/mcp-station.sh" >/dev/null
  local total
  total="$(ls "$STATION"/catalog/*.json | wc -l | tr -d ' ')"
  run bash "$STATION/bin/mcp-station.sh" outdated --json
  # пока состояние цело, серверы сосчитаны по трём сторонам
  [ "$(jq -r .summary.unknown <<<"$output")" = "0" ]
  [ "$(jq -r .summary.current <<<"$output")" = "$(core_count)" ]
  # состояние станции — третья сторона сверки: файл испорчен, и вердикт по серверам был бы догадкой
  printf 'это не json\n' >"$STATE_FILE"
  # предупреждение о битом состоянии идёт в stderr, машине оно не мешает — читаем только stdout
  run bash -c '"$1" outdated --json 2>/dev/null' _ "$STATION/bin/mcp-station.sh"
  [ "$status" -eq 0 ]
  [ "$(jq -r .ok <<<"$output")" = "false" ]
  [ "$(jq -r .summary.current <<<"$output")" = "0" ]
  [ "$(jq -r .summary.unknown <<<"$output")" = "$total" ]
  [ "$(jq -r '[.servers[] | select(.status == "unknown")] | length' <<<"$output")" = "$total" ]
  [[ "$(jq -r '.servers[] | select(.name == "camoufox") | .why' <<<"$output")" == *"состояние станции не прочитать"* ]]
  # и человеку это сказано строкой, а не «итог: current 0»
  run bash "$STATION/bin/mcp-station.sh" outdated
  [[ "$output" == *"не смог узнать: $total"* ]]
  [[ "$output" == *"состояние станции не прочитать"* ]]
}

@test "outdated: пустой и нечитаемый каталог — unknown, а не «свежо»" {
  bash "$STATION/bin/mcp-station.sh" >/dev/null
  local rows=$(( $(core_count) + 1 ))   # серверы, о которых знаем, плюс строка самого каталога
  mkdir -p "$BATS_TEST_TMPDIR/empty-catalog"
  run env MCP_STATION_CATALOG="$BATS_TEST_TMPDIR/empty-catalog" bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$status" -eq 0 ]
  [ "$(jq -r .ok <<<"$output")" = "false" ]
  [ "$(jq -r .summary.current <<<"$output")" = "0" ]
  [ "$(jq -r .summary.unknown <<<"$output")" = "$rows" ]
  [ "$(jq -r '.servers[] | select(.name == "(каталог)") | .status' <<<"$output")" = "unknown" ]
  [[ "$(jq -r '.servers[] | select(.name == "(каталог)") | .why' <<<"$output")" == *"каталог пуст"* ]]
  run env MCP_STATION_CATALOG="$BATS_TEST_TMPDIR/empty-catalog" bash "$STATION/bin/mcp-station.sh" outdated
  [[ "$output" == *"не смог узнать: $rows"* ]]

  # каталог, которого нет, — тоже «не смог узнать», и ни один сервер не назван свежим
  run env MCP_STATION_CATALOG="$BATS_TEST_TMPDIR/нет-такого-каталога" bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r .ok <<<"$output")" = "false" ]
  [ "$(jq -r .summary.current <<<"$output")" = "0" ]
  [ "$(jq -r .summary.unknown <<<"$output")" = "$rows" ]

  # запись каталога, которую не разобрать, — своя строка unknown, остальные судятся как обычно
  catalog_copy
  printf 'это не json\n' >"$CATALOG_TWIN/wiki.json"
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r '.servers[] | select(.name == "wiki") | .status' <<<"$output")" = "unknown" ]
  [ "$(jq -r .summary.unknown <<<"$output")" = "1" ]
  [ "$(jq -r '.servers[] | select(.name == "camoufox") | .status' <<<"$output")" = "current" ]

  # для дела пустой или нечитаемый каталог — отказ с причиной, а не молчаливое «готово»
  run env MCP_STATION_CATALOG="$BATS_TEST_TMPDIR/empty-catalog" bash "$STATION/bin/mcp-station.sh" install
  [ "$status" -eq 1 ]
  [[ "$output" == *"каталог пуст"* ]]
  run env MCP_STATION_CATALOG="$BATS_TEST_TMPDIR/нет-такого-каталога" bash "$STATION/bin/mcp-station.sh" update
  [ "$status" -eq 1 ]
  [[ "$output" == *"каталог не прочитать"* ]]
}

@test "install/update кладут снимок до записи, и rollback возвращает конфиг к нему" {
  run bash "$STATION/bin/mcp-station.sh" install skills-hub
  [ "$status" -eq 0 ]
  [ "$(jq -r '.snapshots | length' "$STATE_FILE")" -ge 1 ]
  local before
  before="$(cat "$MCP_STATION_HOME/.omp/agent/mcp.json")"

  # правка каталога: update переписывает запись — снимок обязан лежать в состоянии ДО записи
  catalog_copy
  jq '.argv[2] = "exec node \"$HOME/.agents/skills/skills-ops/mcp/server.mjs\" --new"' "$CATALOG_TWIN/skills-hub.json" >"$BATS_TEST_TMPDIR/s.json"
  mv "$BATS_TEST_TMPDIR/s.json" "$CATALOG_TWIN/skills-hub.json"
  run env MCP_STATION_CATALOG="$CATALOG_TWIN" bash "$STATION/bin/mcp-station.sh" update skills-hub
  [ "$status" -eq 0 ]
  [[ "$output" == *"переписан"* ]]
  [ "$(jq -r '.snapshots | length' "$STATE_FILE")" -ge 2 ]
  # в последнем снимке — прежнее содержимое конфига, а не то, что только что записали
  run bash -c 'jq -r --arg p "$1" ".snapshots[-1].files[\$p]" "$2"' _ "$MCP_STATION_HOME/.omp/agent/mcp.json" "$STATE_FILE"
  [ "$output" = "$before" ]
  [[ "$(jq -r '.snapshots[-1].reason' "$STATE_FILE")" == *"update"* ]]

  run bash "$STATION/bin/mcp-station.sh" rollback
  [ "$status" -eq 0 ]
  [ "$(cat "$MCP_STATION_HOME/.omp/agent/mcp.json")" = "$before" ]
  run bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r '.servers[] | select(.name == "skills-hub") | .status' <<<"$output")" = "current" ]
  # снимки чистятся по лимиту, а не растут без конца
  [ "$(jq -r '.snapshots | length' "$STATE_FILE")" -le 5 ]
}

@test "install не трогает чужие записи и чужие ключи конфига" {
  mkdir -p "$MCP_STATION_HOME/.omp/agent"
  cat >"$MCP_STATION_HOME/.omp/agent/mcp.json" <<'JSON'
{
  "mcpServers": {
    "camoufox": { "command": "/opt/venvs/camoufox-research/bin/camoufox-research" },
    "exa": { "url": "https://чужой.example/mcp" },
    "ручной": { "command": "node", "args": ["$HOME/manual.mjs"] }
  },
  "tools": { "approval": { "mcp__skills_hub_skills_install": "prompt" } }
}
JSON
  local foreign manual
  foreign="$(jq -S '.mcpServers.camoufox, .mcpServers.exa, .mcpServers["ручной"], .tools' "$MCP_STATION_HOME/.omp/agent/mcp.json")"
  manual="$(jq -S '.mcpServers["ручной"]' "$MCP_STATION_HOME/.omp/agent/mcp.json")"

  run bash "$STATION/bin/mcp-station.sh" install
  [ "$status" -eq 0 ]
  # чужое осталось байт в байт (и core-запись проекта, и keyed-запись, и внекаталожная), свои поставлены
  [ "$(jq -S '.mcpServers.camoufox, .mcpServers.exa, .mcpServers["ручной"], .tools' "$MCP_STATION_HOME/.omp/agent/mcp.json")" = "$foreign" ]
  [ "$(jq -r '.mcpServers | has("skills-hub")' "$MCP_STATION_HOME/.omp/agent/mcp.json")" = "true" ]
  [[ "$output" == *"не трогаю, это не наша запись"* ]]

  run bash "$STATION/bin/mcp-station.sh" outdated --json
  [ "$(jq -r '.servers[] | select(.name == "camoufox") | .status' <<<"$output")" = "foreign" ]
  [ "$(jq -r '.servers[] | select(.name == "exa") | .status' <<<"$output")" = "foreign" ]
  [ "$(jq -r '.servers[] | select(.name == "ручной") | .status' <<<"$output")" = "foreign" ]
  [ "$(jq -r '.servers[] | select(.name == "ручной") | .why' <<<"$output")" = "поставлено не станцией: omp" ]

  # забрать чужую запись себе можно только явной командой с именем сервера
  run bash "$STATION/bin/mcp-station.sh" install camoufox
  [ "$status" -eq 0 ]
  [[ "$output" == *"переписан"* ]]
  [ "$(jq -r '.mcpServers.camoufox.command' "$MCP_STATION_HOME/.omp/agent/mcp.json")" = "bash" ]
  # а внекаталожную запись не трогает и явная команда по каталогу
  [ "$(jq -S '.mcpServers["ручной"]' "$MCP_STATION_HOME/.omp/agent/mcp.json")" = "$manual" ]
}

@test "lldb-мост без lldb: называет нехватку и выходит 1, а не молчит" {
  local empty="$BATS_TEST_TMPDIR/empty-path"
  mkdir -p "$empty" "$BATS_TEST_TMPDIR/state"
  run env PATH="$empty" HOME="$BATS_TEST_TMPDIR/home" XDG_RUNTIME_DIR="$BATS_TEST_TMPDIR/state" \
    "$(command -v bash)" "$STATION/bin/lldb-mcp-bridge.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет lldb"* ]]
}

@test "lldb-мост без nc: называет нехватку и выходит 1" {
  local stub="$BATS_TEST_TMPDIR/stub-path"
  mkdir -p "$stub" "$BATS_TEST_TMPDIR/state"
  printf '#!/bin/sh\nexit 0\n' >"$stub/lldb"
  chmod +x "$stub/lldb"
  run env PATH="$stub" HOME="$BATS_TEST_TMPDIR/home" XDG_RUNTIME_DIR="$BATS_TEST_TMPDIR/state" \
    "$(command -v bash)" "$STATION/bin/lldb-mcp-bridge.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет nc"* ]]
}

@test "debug-setup: без системного и uv называет нехватку, а не ставит молча" {
  local empty="$BATS_TEST_TMPDIR/empty-path"
  mkdir -p "$empty"
  run env PATH="$empty" HOME="$BATS_TEST_TMPDIR/home" "$(command -v bash)" "$STATION/bin/debug-setup.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"не хватает системных"* ]]
  [[ "$output" == *"нет uv"* ]]
}
