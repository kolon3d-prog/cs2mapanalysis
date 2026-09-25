#!/usr/bin/env bats
# Тесты центра памяти: подменяются HOME, каталог заметок и станция MCP.
# Реальные конфиги и настоящая память не трогаются.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export MEMORY_STATION_HOME="$BATS_TEST_TMPDIR/home"
  export BASIC_MEMORY_HOME="$BATS_TEST_TMPDIR/notes"
  export BASIC_MEMORY_CONFIG_DIR="$BATS_TEST_TMPDIR/cfg"
  mkdir -p "$MEMORY_STATION_HOME" "$BASIC_MEMORY_HOME" "$BASIC_MEMORY_CONFIG_DIR"
  # клиенты: opencode должен существовать, иначе ссылку на скилл ставить некуда
  mkdir -p "$MEMORY_STATION_HOME/.config/opencode"

  # заглушка станции MCP: печатает вызов и делает конфиги клиентов с basic-memory
  export MCP_STATION_DIR="$BATS_TEST_TMPDIR/mcp-station"
  mkdir -p "$MCP_STATION_DIR/catalog" "$MCP_STATION_DIR/bin"
  printf '{ "name": "basic-memory" }\n' >"$MCP_STATION_DIR/catalog/basic-memory.json"
  cat >"$MCP_STATION_DIR/bin/mcp-station.sh" <<'EOS'
#!/usr/bin/env bash
printf 'mcp-station вызван: %s\n' "$*"
mkdir -p "$MEMORY_STATION_HOME/.omp/agent" "$MEMORY_STATION_HOME/.pi/agent" "$MEMORY_STATION_HOME/.config/opencode"
printf '{"mcpServers":{"basic-memory":{}}}\n' >"$MEMORY_STATION_HOME/.omp/agent/mcp.json"
printf '{"mcpServers":{"basic-memory":{}}}\n' >"$MEMORY_STATION_HOME/.pi/agent/mcp.json"
printf '{"mcp":{"basic-memory":{}}}\n' >"$MEMORY_STATION_HOME/.config/opencode/opencode.json"
EOS
  chmod +x "$MCP_STATION_DIR/bin/mcp-station.sh"
  cd "$BATS_TEST_TMPDIR"
}

@test "note пишет markdown-заметку, search её находит" {
  run bash "$STATION/bin/memory-station.sh" note "решили держать память в basic-memory, потому что markdown и без ключей" --folder=projects --title="Выбор памяти"
  [ "$status" -eq 0 ]
  [ -f "$BASIC_MEMORY_HOME/projects/Выбор памяти.md" ] || [ "$(find "$BASIC_MEMORY_HOME" -name '*.md' | wc -l)" -ge 1 ]

  run bash "$STATION/bin/memory-station.sh" search "basic-memory"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Выбор памяти"* ]]
}

@test "check: без записи в каталоге MCP — ругается" {
  rm "$MCP_STATION_DIR/catalog/basic-memory.json"
  run bash "$STATION/bin/memory-station.sh" check
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет записи в каталоге MCP"* ]]
}

@test "check: без памяти в конфигах клиентов — ругается" {
  mkdir -p "$MEMORY_STATION_HOME/.omp/agent"
  printf '{"mcpServers":{}}\n' >"$MEMORY_STATION_HOME/.omp/agent/mcp.json"
  run bash "$STATION/bin/memory-station.sh" check
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет basic-memory"* ]]
}

@test "install: папки, скилл, MCP в клиентах; повтор без изменений" {
  run bash "$STATION/bin/memory-station.sh" install
  [ "$status" -eq 0 ]
  for folder in code life projects; do [ -d "$BASIC_MEMORY_HOME/$folder" ]; done
  [ -L "$MEMORY_STATION_HOME/.agents/skills/memory" ]
  [ -L "$MEMORY_STATION_HOME/.config/opencode/skills/memory" ]
  [[ "$output" == *"mcp-station вызван: install basic-memory"* ]]

  run bash "$STATION/bin/memory-station.sh" install
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже стоит"* ]]
  [[ "$output" == *"уже есть"* ]]

  # Windows без Developer Mode: каталоги тоже нельзя связать symlink-ом.
  # Станция должна поставить копии и не срывать весь fresh.
  rm -rf "$MEMORY_STATION_HOME/.agents/skills/memory" \
         "$MEMORY_STATION_HOME/.config/opencode/skills/memory"
  cat >"$BATS_TEST_TMPDIR/deny-memory-symlink.cjs" <<'EOF'
const fs = require("node:fs");
fs.symlinkSync = function () {
  const error = new Error("simulated directory symlink privilege error");
  error.code = "EPERM";
  throw error;
};
require("node:module").syncBuiltinESMExports();
EOF
  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-memory-symlink.cjs" \
    bash "$STATION/bin/memory-station.sh" install
  [ "$status" -eq 0 ]
  [ -d "$MEMORY_STATION_HOME/.agents/skills/memory" ]
  [ ! -L "$MEMORY_STATION_HOME/.agents/skills/memory" ]
  [ -d "$MEMORY_STATION_HOME/.config/opencode/skills/memory" ]
  [ ! -L "$MEMORY_STATION_HOME/.config/opencode/skills/memory" ]
  [[ "$output" == *"копия"* ]]
}

@test "install --dry-run ничего не создаёт" {
  run bash "$STATION/bin/memory-station.sh" install --dry-run
  [ "$status" -eq 0 ]
  [ ! -d "$BASIC_MEMORY_HOME/code" ]
  [ ! -L "$MEMORY_STATION_HOME/.agents/skills/memory" ]
}

@test "status показывает путь заметок и клиентов" {
  run bash "$STATION/bin/memory-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"$BASIC_MEMORY_HOME"* ]]
  [[ "$output" == *"клиенты"* ]]
}

@test "в станции нет абсолютных путей к диску" {
  run bash -c "grep -rnE '/(home|run/media)/' \"$STATION/bin\" \"$STATION/skills\" 2>/dev/null | grep -v 'BASIC_MEMORY_HOME' | wc -l"
  [ "$output" -eq 0 ]
}
