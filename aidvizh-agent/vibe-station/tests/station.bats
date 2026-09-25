#!/usr/bin/env bats
# Тесты станции vibe: install/status/remove на подменённом конфиге opencode —
# server plugin, TUI footer и три файла агентов режима. Ни сети, ни реального конфига.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export VIBE_CONFIG_DIR="$BATS_TEST_TMPDIR/config"
  export VIBE_ALLOW_UNSCANNED_CONFIG=1
  export HOME="$BATS_TEST_TMPDIR/home"
  export VIBE_SKILLS_DIR="$BATS_TEST_TMPDIR/home/.agents/skills"
  mkdir -p "$HOME" "$VIBE_CONFIG_DIR/plugins"
  LINK="$VIBE_CONFIG_DIR/plugins/vibe-station.ts"
  TUI_LINK="$VIBE_CONFIG_DIR/plugins/vibe-station-tui"
  AGENT_DIR="$VIBE_CONFIG_DIR/agent"
  SOURCE="$STATION/plugin/opencode/vibe.ts"
  TUI_SOURCE="$STATION/plugin/opencode-tui"
}

@test "status на пустом конфиге: ссылки нет, код 0" {
  run bash "$STATION/bin/vibe-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"не стоит (install)"* ]]
}

@test "неизвестный OpenCode config override не устанавливается молча" {
  run env VIBE_CONFIG_DIR="$BATS_TEST_TMPDIR/other-config" VIBE_ALLOW_UNSCANNED_CONFIG=0 \
    bash "$STATION/bin/vibe-station.sh" install
  [ "$status" -eq 1 ]
  [[ "$output" == *"VIBE_CONFIG_DIR"* ]]
  [[ "$output" == *"XDG_CONFIG_HOME"* ]]
}

@test "PowerShell отклоняет неизвестный OpenCode config override" {
  if ! command -v pwsh >/dev/null 2>&1; then skip "pwsh недоступен"; fi
  run env VIBE_CONFIG_DIR="$BATS_TEST_TMPDIR/other-config-ps" VIBE_ALLOW_UNSCANNED_CONFIG=0 \
    pwsh -NoProfile -NonInteractive -File "$STATION/bin/vibe-station.ps1" install
  [ "$status" -eq 1 ]
  [[ "$output" == *"VIBE_CONFIG_DIR"* ]]
  [[ "$output" == *"XDG_CONFIG_HOME"* ]]
}

@test "install ставит plugin, agent files (пять) и skill режима, status их видит" {
  run bash "$STATION/bin/vibe-station.sh" install
  [ "$status" -eq 0 ]
  [ -L "$LINK" ]
  [ "$(readlink "$LINK")" = "$SOURCE" ]
  [ -L "$TUI_LINK" ]
  [ "$(readlink "$TUI_LINK")" = "$TUI_SOURCE" ]
  for name in vibe-director vibe-fast vibe-good vibe-audit-fast vibe-audit-good; do
    [ -L "$AGENT_DIR/$name.md" ]
    [ "$(readlink "$AGENT_DIR/$name.md")" = "$STATION/agent/$name.md" ]
  done
  [ -L "$VIBE_SKILLS_DIR/vibe-mode" ]
  [ "$(readlink "$VIBE_SKILLS_DIR/vibe-mode")" = "$STATION/skill" ]
  [ -f "$VIBE_SKILLS_DIR/vibe-mode/SKILL.md" ]
  # клиентский слой opencode2: без него скилл в клиенте не виден (палитра @)
  [ -L "$VIBE_CONFIG_DIR/skills/vibe-mode" ]
  [ -f "$VIBE_CONFIG_DIR/skills/vibe-mode/SKILL.md" ]

  run bash "$STATION/bin/vibe-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"стоит, указывает в станцию"* ]]
  [[ "$output" == *"агент vibe-director"* ]]
}

@test "PowerShell install ставит server plugin по правильному пути" {
  if ! command -v pwsh >/dev/null 2>&1; then skip "pwsh недоступен"; fi
  run env HOME="$HOME" VIBE_CONFIG_DIR="$VIBE_CONFIG_DIR" VIBE_SKILLS_DIR="$VIBE_SKILLS_DIR" \
    pwsh -NoProfile -NonInteractive -File "$STATION/bin/vibe-station.ps1" install
  [ "$status" -eq 0 ]
  [ -L "$LINK" ]
  [ "$(readlink "$LINK")" = "$SOURCE" ]
  [ -L "$TUI_LINK" ]
  [ "$(readlink "$TUI_LINK")" = "$TUI_SOURCE" ]
}

@test "install откладывает чужой файл, а не затирает его" {
  mkdir -p "$AGENT_DIR"
  printf 'чужой плагин\n' >"$LINK"
  printf 'чужой агент\n' >"$AGENT_DIR/vibe-fast.md"

  run bash "$STATION/bin/vibe-station.sh" install
  [ "$status" -eq 0 ]
  [[ "$output" == *"чужой файл отложен"* ]]
  [ -L "$LINK" ]
  [ -L "$AGENT_DIR/vibe-fast.md" ]

  backup="$(find "$VIBE_CONFIG_DIR" -name '*.bak-*' -type f | sort)"
  [ -n "$backup" ]
  grep -rq "чужой плагин" "$VIBE_CONFIG_DIR"
  grep -rq "чужой агент" "$VIBE_CONFIG_DIR"
}

@test "install не затирает чужую symlink" {
  external="$BATS_TEST_TMPDIR/external-tui"
  mkdir -p "$external"
  ln -s "$external" "$TUI_LINK"

  run bash "$STATION/bin/vibe-station.sh" install
  [ "$status" -eq 0 ]
  [ "$(readlink "$TUI_LINK")" = "$TUI_SOURCE" ]
  backup="$(find "$VIBE_CONFIG_DIR/plugins" -maxdepth 1 -type l -name 'vibe-station-tui.bak-*' | head -1)"
  [ -n "$backup" ]
  [ "$(readlink "$backup")" = "$external" ]
}

@test "PowerShell install не затирает чужую symlink" {
  if ! command -v pwsh >/dev/null 2>&1; then skip "pwsh недоступен"; fi
  external="$BATS_TEST_TMPDIR/external-tui-ps"
  mkdir -p "$external"
  pwsh -NoProfile -NonInteractive -Command "New-Item -ItemType SymbolicLink -Path '$TUI_LINK' -Target '$external' | Out-Null"

  run env HOME="$HOME" VIBE_CONFIG_DIR="$VIBE_CONFIG_DIR" VIBE_SKILLS_DIR="$VIBE_SKILLS_DIR" \
    pwsh -NoProfile -NonInteractive -File "$STATION/bin/vibe-station.ps1" install
  [ "$status" -eq 0 ]
  [ "$(readlink "$TUI_LINK")" = "$TUI_SOURCE" ]
  backup="$(find "$VIBE_CONFIG_DIR/plugins" -maxdepth 1 -type l -name 'vibe-station-tui.bak-*' | head -1)"
  [ -n "$backup" ]
  [ "$(readlink "$backup")" = "$external" ]
}

@test "PowerShell remove снимает все ссылки станции" {
  if ! command -v pwsh >/dev/null 2>&1; then skip "pwsh недоступен"; fi
  env HOME="$HOME" VIBE_CONFIG_DIR="$VIBE_CONFIG_DIR" VIBE_SKILLS_DIR="$VIBE_SKILLS_DIR" \
    pwsh -NoProfile -NonInteractive -File "$STATION/bin/vibe-station.ps1" install >/dev/null
  run env HOME="$HOME" VIBE_CONFIG_DIR="$VIBE_CONFIG_DIR" VIBE_SKILLS_DIR="$VIBE_SKILLS_DIR" \
    pwsh -NoProfile -NonInteractive -File "$STATION/bin/vibe-station.ps1" remove
  [ "$status" -eq 0 ]
  [ ! -e "$LINK" ]
  [ ! -e "$TUI_LINK" ]
  [ ! -e "$AGENT_DIR/vibe-good.md" ]
  [ ! -e "$VIBE_SKILLS_DIR/vibe-mode" ]
  [ ! -e "$VIBE_CONFIG_DIR/skills/vibe-mode" ]
}

@test "remove снимает свою ссылку и не трогает чужой файл" {
  bash "$STATION/bin/vibe-station.sh" install >/dev/null

  run bash "$STATION/bin/vibe-station.sh" remove
  [ "$status" -eq 0 ]
  [[ "$output" == *"снято"* ]]
  [ ! -e "$LINK" ]
  [ ! -e "$TUI_LINK" ]
  [ ! -e "$AGENT_DIR/vibe-good.md" ]
  [ ! -e "$VIBE_SKILLS_DIR/vibe-mode" ]
  [ ! -e "$VIBE_CONFIG_DIR/skills/vibe-mode" ]

  mkdir -p "$AGENT_DIR"
  printf 'чужой плагин\n' >"$LINK"
  run bash "$STATION/bin/vibe-station.sh" remove
  [ "$status" -eq 1 ]
  [[ "$output" == *"файл, не ссылка станции"* ]]
  grep -q "чужой плагин" "$LINK"
}
