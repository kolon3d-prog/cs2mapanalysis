#!/usr/bin/env bats
# Тесты станции режимов: install/status/remove на подменённом конфиге opencode.
# Ни сети, ни реального конфига: MODES_CONFIG_DIR — временный каталог, HOME — тоже.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export MODES_CONFIG_DIR="$BATS_TEST_TMPDIR/config"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME" "$MODES_CONFIG_DIR/plugins"
  LINK="$MODES_CONFIG_DIR/plugins/modes-station.ts"
  SOURCE="$STATION/plugin/opencode/modes.ts"
}

@test "status на пустом конфиге: ссылки нет, код 0" {
  run bash "$STATION/bin/modes-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"не стоит (install)"* ]]
}

@test "install ставит ссылку на плагин, status её видит" {
  run bash "$STATION/bin/modes-station.sh" install
  [ "$status" -eq 0 ]
  [ -L "$LINK" ]
  [ "$(readlink "$LINK")" = "$SOURCE" ]

  run bash "$STATION/bin/modes-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"состояние: стоит, указывает на плагин"* ]]
}

@test "install откладывает чужой файл, а не затирает его" {
  printf 'чужой плагин\n' >"$LINK"

  run bash "$STATION/bin/modes-station.sh" install
  [ "$status" -eq 0 ]
  [[ "$output" == *"чужой файл отложен"* ]]
  [ -L "$LINK" ]

  backup="$(find "$MODES_CONFIG_DIR/plugins" -name 'modes-station.ts.bak-*' -type f)"
  [ -n "$backup" ]
  grep -q "чужой плагин" "$backup"
}

@test "remove снимает свою ссылку и не трогает чужой файл" {
  bash "$STATION/bin/modes-station.sh" install >/dev/null

  run bash "$STATION/bin/modes-station.sh" remove
  [ "$status" -eq 0 ]
  [[ "$output" == *"снято"* ]]
  [ ! -e "$LINK" ]

  printf 'чужой плагин\n' >"$LINK"
  run bash "$STATION/bin/modes-station.sh" remove
  [ "$status" -eq 1 ]
  [[ "$output" == *"файл, не ссылка станции"* ]]
  grep -q "чужой плагин" "$LINK"
}
