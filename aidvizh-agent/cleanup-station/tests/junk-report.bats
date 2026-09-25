#!/usr/bin/env bats
# Тесты отчёта по мусору (junk-report): находит кэши/свалки/артефакты в корне,
# по умолчанию не лезет в .venv/.git, --strict превращает находки в код возврата.
# Диск подменяется фикстурой (BATS_TEST_TMPDIR) — реальные данные не трогаются.
# Запуск: bats tests/junk-report.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export DISK="$BATS_TEST_TMPDIR/disk"
  rm -rf "$DISK"
  mkdir -p "$DISK"
}

@test "чистый диск: мусора нет, strict даёт rc=0" {
  mkdir -p "$DISK/station-a/bin"
  : >"$DISK/station-a/bin/tool.sh"
  run node "$STATION/bin/junk-report.mjs" "$DISK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"мусор: 0 МБ"* ]]

  run node "$STATION/bin/junk-report.mjs" "$DISK" --strict
  [ "$status" -eq 0 ]
}

@test "находит кэши, свалки и артефакты в корне" {
  mkdir -p "$DISK/station-a/__pycache__" "$DISK/station-a/.mypy_cache" "$DISK/_dump"
  : >"$DISK/station-a/__pycache__/mod.pyc"
  : >"$DISK/station-a/.mypy_cache/data.json"
  : >"$DISK/_dump/report.json"
  : >"$DISK/leftover-report.json"

  run node "$STATION/bin/junk-report.mjs" "$DISK" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *"_dump"* ]]
  [[ "$output" == *"__pycache__"* ]]
  [[ "$output" == *"leftover-report.json"* ]]
}

@test "strict: находки дают rc=1" {
  mkdir -p "$DISK/_dump"
  run node "$STATION/bin/junk-report.mjs" "$DISK" --strict
  [ "$status" -eq 1 ]
}

@test "по умолчанию .venv пропускается, с --all — считается" {
  mkdir -p "$DISK/station-a/.venv/lib/__pycache__"
  : >"$DISK/station-a/.venv/lib/__pycache__/x.pyc"

  run node "$STATION/bin/junk-report.mjs" "$DISK" --json
  [ "$status" -eq 0 ]
  [[ "$output" != *".venv/lib/__pycache__"* ]]

  run node "$STATION/bin/junk-report.mjs" "$DISK" --all --json
  [ "$status" -eq 0 ]
  [[ "$output" == *".venv/lib/__pycache__"* ]]
}

@test "несуществующий каталог: честный rc=2" {
  run node "$STATION/bin/junk-report.mjs" "$BATS_TEST_TMPDIR/nope"
  [ "$status" -eq 2 ]
  [[ "$output" == *"нет каталога"* ]]
}
