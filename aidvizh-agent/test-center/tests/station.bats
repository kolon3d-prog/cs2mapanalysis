#!/usr/bin/env bats
# Тесты тест-центра: прогон наборов, пропуск недоступных, багрепорт при сбое.
# Багрепорт пишется в подменённый путь, реальные прогоны не запускаются.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export TEST_CENTER_HOME="$BATS_TEST_TMPDIR/home"
  export TEST_CENTER_REPORT="$BATS_TEST_TMPDIR/багрепорт.md"
  mkdir -p "$TEST_CENTER_HOME"
  cd "$BATS_TEST_TMPDIR"
}

@test "status перечисляет наборы и инструменты" {
  run bash "$STATION/bin/test-center.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"система:"* ]]
  [[ "$output" == *"набор smoke:"* ]]
  [[ "$output" == *"набор model:"* ]]
  [[ "$output" == *"набор persona:"* ]]
}

@test "smoke проходит на этой машине" {
  command -v node >/dev/null || skip "нет node"
  run bash "$STATION/bin/test-center.sh" run --only=smoke --no-model
  [ "$status" -eq 0 ]
  [[ "$output" == *"сбоев 0"* ]]
  [[ "$output" == *"ok   центр: состояние"* ]]
}

@test "сбой шага пишет багрепорт с командой и кодом" {
  # вики-MCP ищется по подменённому HOME — его там нет, шаг обязан упасть
  run bash "$STATION/bin/test-center.sh" run --only=wiki --no-model
  [ "$status" -eq 1 ]
  [ -f "$TEST_CENTER_REPORT" ]
  run grep -c "Багрепорт" "$TEST_CENTER_REPORT"
  [ "$output" -ge 1 ]
  run grep -c "Команда" "$TEST_CENTER_REPORT"
  [ "$output" -ge 1 ]
  run grep -c "Код возврата" "$TEST_CENTER_REPORT"
  [ "$output" -ge 1 ]
  run grep -c "Что проверить" "$TEST_CENTER_REPORT"
  [ "$output" -ge 1 ]
  [[ "$(cat "$TEST_CENTER_REPORT")" == *"wiki-station"* ]]
}

@test "report показывает последнюю запись, clear её убирает" {
  bash "$STATION/bin/test-center.sh" run --only=wiki --no-model >/dev/null 2>&1 || true
  run bash "$STATION/bin/test-center.sh" report
  [ "$status" -eq 0 ]
  [[ "$output" == *"записей:"* ]]

  run bash "$STATION/bin/test-center.sh" clear
  [ "$status" -eq 0 ]
  run bash "$STATION/bin/test-center.sh" report
  [[ "$output" == *"багрепортов нет"* ]]
}

@test "недоступный набор пропускается, а не падает" {
  # подсовываем PATH без bats и omp: наборы должны быть пропущены
  run env TEST_CENTER_FORCE_MISSING=bats,omp bash "$STATION/bin/test-center.sh" run --only=bats,model --no-model
  [ "$status" -eq 0 ]
  [[ "$output" == *"пропущен"* ]]
}

@test "persona: без omp набор пропускается, а не падает" {
  run env TEST_CENTER_FORCE_MISSING=omp bash "$STATION/bin/test-center.sh" run --only=persona
  [ "$status" -eq 0 ]
  [[ "$output" == *"набор persona: пропущен"* ]]
}

@test "run --dry-run печатает план и ничего не запускает" {
  # заглушка на omp: тронули бы модель — она оставила бы след
  local stub="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$stub"
  printf '#!/bin/sh\ntouch "%s/omp-called"\nexit 0\n' "$BATS_TEST_TMPDIR" >"$stub/omp"
  chmod +x "$stub/omp"

  run env PATH="$stub:$PATH" bash "$STATION/bin/test-center.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"набор model: шагов 1"* ]]
  [[ "$output" == *"модель отвечает (omp -p)"* ]]
  [[ "$output" == *"ничего не запущено"* ]]
  [[ "$output" != *"ok  "* ]]
  [ ! -e "$BATS_TEST_TMPDIR/omp-called" ]
  [ ! -e "$TEST_CENTER_REPORT" ]
}

@test "run --dry-run: план можно сузить до одного набора" {
  run bash "$STATION/bin/test-center.sh" run --only=smoke --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"набор smoke: шагов"* ]]
  [[ "$output" != *"набор model"* ]]
}

@test "json-вывод содержит результаты шагов" {
  run bash "$STATION/bin/test-center.sh" run --only=smoke --no-model --json
  [ "$status" -eq 0 ]
  run bash -c 'printf "%s" "$1" | jq -e ".results | length > 0"' _ "$output"
  [ "$output" = "true" ]
}

@test "check проверяет предпосылки станции" {
  run bash "$STATION/bin/test-center.sh" check
  [ "$status" -eq 0 ]
  [[ "$output" == *"проверка пройдена"* ]]
}

@test "в станции нет абсолютных путей к диску" {
  run bash -c "grep -rnE '/(home|run/media)/' \"$STATION/bin\" \"$STATION/probes\" 2>/dev/null | wc -l"
  [ "$output" -eq 0 ]
}
