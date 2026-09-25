#!/usr/bin/env bats
# Тесты станции спек-режима: скилл spec-mode по слоям + слэш-команды по клиентам.
# Дом, источник скилла и каталог команд подменяются на временные — реальные клиенты не трогаются.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export SPEC_STATION_HOME="$BATS_TEST_TMPDIR/home"
  export SPEC_STATION_SOURCE="$BATS_TEST_TMPDIR/skill"
  export SPEC_STATION_COMMANDS="$BATS_TEST_TMPDIR/commands"
  export SPEC_STATION_CWD="$BATS_TEST_TMPDIR/проект"
  unset XDG_CONFIG_HOME OMP_AGENT_DIR PI_CODING_AGENT_DIR
  mkdir -p "$SPEC_STATION_HOME" "$SPEC_STATION_CWD"

  mkdir -p "$SPEC_STATION_SOURCE"
  printf -- '---\nname: spec-mode\ndescription: спек-режим: требования, дизайн, задачи\n---\n\nтело\n' \
    >"$SPEC_STATION_SOURCE/SKILL.md"
  for kind in references templates; do mkdir -p "$SPEC_STATION_SOURCE/$kind"; done
  for name in spec-protocol ears feature-spec bugfix-spec quick-spec analyze-requirements tasks-and-waves correctness steering spec-kit; do
    printf 'справочник %s\n' "$name" >"$SPEC_STATION_SOURCE/references/$name.md"
  done
  for name in requirements design tasks bugfix; do
    printf 'шаблон %s\n' "$name" >"$SPEC_STATION_SOURCE/templates/$name.md"
  done

  mkdir -p "$SPEC_STATION_COMMANDS"
  for name in spec spec-new spec-quick spec-bugfix spec-analyze spec-tasks; do
    printf -- '---\ndescription: команда %s\n---\n\n$ARGUMENTS\n' "$name" >"$SPEC_STATION_COMMANDS/$name.md"
  done

  cd "$BATS_TEST_TMPDIR"
}

@test "list показывает режимы, шаблоны и команды" {
  run bash "$STATION/bin/spec-station.sh" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"spec-mode"* ]]
  [[ "$output" == *"ears.md"* ]]
  [[ "$output" == *"requirements.md"* ]]
  [[ "$output" == *"/spec-new"* ]]
  [[ "$output" == *"/spec-bugfix"* ]]
}

@test "install ставит скилл ссылкой в глобальный слой" {
  run bash "$STATION/bin/spec-station.sh" install --client none
  [ "$status" -eq 0 ]
  [ -L "$SPEC_STATION_HOME/.agents/skills/spec-mode" ]
  [ -e "$SPEC_STATION_HOME/.agents/skills/spec-mode/SKILL.md" ]
  [ -e "$SPEC_STATION_HOME/.agents/skills/spec-mode/references/ears.md" ]
}

@test "install --mode copy кладёт независимую копию с подкаталогами" {
  run bash "$STATION/bin/spec-station.sh" install --client none --mode copy
  [ "$status" -eq 0 ]
  [ ! -L "$SPEC_STATION_HOME/.agents/skills/spec-mode" ]
  [ -f "$SPEC_STATION_HOME/.agents/skills/spec-mode/templates/tasks.md" ]

  run bash "$STATION/bin/spec-station.sh" install --client none --mode copy
  [[ "$output" == *"копия совпадает"* ]]

  # копия независима от источника
  rm "$SPEC_STATION_SOURCE/references/ears.md"
  [ -s "$SPEC_STATION_HOME/.agents/skills/spec-mode/references/ears.md" ]
}

@test "install --layer project и --dir кладут скилл по своим путям" {
  run bash "$STATION/bin/spec-station.sh" install --layer project --client none
  [ "$status" -eq 0 ]
  [ -L "$SPEC_STATION_CWD/.agents/skills/spec-mode" ]

  run bash "$STATION/bin/spec-station.sh" install --dir "$BATS_TEST_TMPDIR/свой/путь" --client none
  [ "$status" -eq 0 ]
  [ -L "$BATS_TEST_TMPDIR/свой/путь/spec-mode" ]

  run bash "$STATION/bin/spec-station.sh" install --layer omp --client none
  [ "$status" -eq 0 ]
  [ -L "$SPEC_STATION_HOME/.omp/agent/skills/spec-mode" ]
}

@test "команды ставятся во всех живых клиентов, отсутствующие пропускаются" {
  mkdir -p "$SPEC_STATION_HOME/.omp/agent" "$SPEC_STATION_HOME/.config/opencode"
  run bash "$STATION/bin/spec-station.sh" install
  [ "$status" -eq 0 ]
  [ -L "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]
  [ -L "$SPEC_STATION_HOME/.config/opencode/commands/spec-quick.md" ]
  [[ "$output" == *"claude"*"клиента нет"* ]]
  [ ! -e "$SPEC_STATION_HOME/.claude/commands/spec.md" ]

  # На Windows без Developer Mode файловые symlink-и запрещены. Каталог скилла
  # остаётся junction/dir-ссылкой, а команды обязаны честно откатиться в копии.
  rm -rf "$SPEC_STATION_HOME/.agents/skills/spec-mode" \
         "$SPEC_STATION_HOME/.config/opencode/skills/spec-mode" \
         "$SPEC_STATION_HOME/.omp/agent/commands"
  cat >"$BATS_TEST_TMPDIR/deny-file-symlink.cjs" <<'EOF'
const fs = require("node:fs");
fs.symlinkSync = function () {
  const error = new Error("simulated symlink privilege error");
  error.code = "EPERM";
  throw error;
};
require("node:module").syncBuiltinESMExports();
EOF
  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-file-symlink.cjs" \
    bash "$STATION/bin/spec-station.sh" install --client omp
  [ "$status" -eq 0 ]
  [[ "$output" == *"копия"* ]]
  [ -d "$SPEC_STATION_HOME/.agents/skills/spec-mode" ]
  [ ! -L "$SPEC_STATION_HOME/.agents/skills/spec-mode" ]
  [ ! -L "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]
  [ -f "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]
  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-file-symlink.cjs" \
    bash "$STATION/bin/spec-station.sh" install --client omp
  [ "$status" -eq 0 ]
  [[ "$output" == *"копия совпадает"* ]]
  printf '\nобновлённый источник\n' >>"$SPEC_STATION_COMMANDS/spec.md"
  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-file-symlink.cjs" \
    bash "$STATION/bin/spec-station.sh" install --client omp
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен --force"* ]]

  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-file-symlink.cjs" \
    bash "$STATION/bin/spec-station.sh" install --client omp --force
  [ "$status" -eq 0 ]
  [[ "$output" == *"обновляю копию"* ]]
  [ -f "$SPEC_STATION_HOME/.omp/agent/commands/spec.md.bak" ]
  run diff -q "$SPEC_STATION_COMMANDS/spec.md" "$SPEC_STATION_HOME/.omp/agent/commands/spec.md"
  [ "$status" -eq 0 ]
  run bash "$STATION/bin/spec-station.sh" status --client omp
  [ "$status" -eq 0 ]
  [[ "$output" == *"копи"* ]]
}

@test "явный --client создаёт каталог, --client none не трогает команды" {
  run bash "$STATION/bin/spec-station.sh" install --client omp,opencode
  [ "$status" -eq 0 ]
  [ -e "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]
  [ -e "$SPEC_STATION_HOME/.config/opencode/commands/spec.md" ]
  [ ! -e "$SPEC_STATION_HOME/.pi/agent/commands/spec.md" ]

  rm -rf "$SPEC_STATION_HOME/.agents/skills/spec-mode" "$SPEC_STATION_HOME/.omp/agent/commands"
  run bash "$STATION/bin/spec-station.sh" install --client none
  [ "$status" -eq 0 ]
  [ -e "$SPEC_STATION_HOME/.agents/skills/spec-mode/SKILL.md" ]
  [ ! -e "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]
}

@test "повторная установка идемпотентна, чужое не заменяется без --force" {
  bash "$STATION/bin/spec-station.sh" install --client omp >/dev/null
  run bash "$STATION/bin/spec-station.sh" install --client omp
  [[ "$output" == *"уже стоит"* ]]

  rm -rf "$SPEC_STATION_HOME/.agents/skills/spec-mode"
  mkdir -p "$SPEC_STATION_HOME/.agents/skills/spec-mode"
  printf -- '---\nname: spec-mode\ndescription: чужое\n---\n' >"$SPEC_STATION_HOME/.agents/skills/spec-mode/SKILL.md"
  run bash "$STATION/bin/spec-station.sh" install --client none
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен --force"* ]]
  run cat "$SPEC_STATION_HOME/.agents/skills/spec-mode/SKILL.md"
  [[ "$output" == *"чужое"* ]]

  run bash "$STATION/bin/spec-station.sh" install --client none --force
  [ "$status" -eq 0 ]
  [ -d "$SPEC_STATION_HOME/.agents/skills/spec-mode.bak" ]
  run diff -q "$SPEC_STATION_SOURCE/SKILL.md" "$SPEC_STATION_HOME/.agents/skills/spec-mode/SKILL.md"
  [ "$status" -eq 0 ]
}

@test "битая symlink команда требует --force и сохраняется в backup" {
  mkdir -p "$SPEC_STATION_HOME/.omp/agent/commands"
  ln -s "$BATS_TEST_TMPDIR/нет-такой-команды.md" "$SPEC_STATION_HOME/.omp/agent/commands/spec.md"

  run bash "$STATION/bin/spec-station.sh" install --client omp
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен --force"* ]]
  [ -L "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]

  run bash "$STATION/bin/spec-station.sh" install --client omp --force
  [ "$status" -eq 0 ]
  [ -L "$SPEC_STATION_HOME/.omp/agent/commands/spec.md.bak" ]
  [ -L "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]
}

@test "чужая команда не заменяется без --force, а с force остаётся в backup" {
  mkdir -p "$SPEC_STATION_HOME/.omp/agent/commands"
  printf 'чужая команда\n' >"$SPEC_STATION_HOME/.omp/agent/commands/spec.md"

  run bash "$STATION/bin/spec-station.sh" install --client omp
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен --force"* ]]
  [ "$(cat "$SPEC_STATION_HOME/.omp/agent/commands/spec.md")" = "чужая команда" ]

  run bash "$STATION/bin/spec-station.sh" install --client omp --force
  [ "$status" -eq 0 ]
  [ "$(cat "$SPEC_STATION_HOME/.omp/agent/commands/spec.md.bak")" = "чужая команда" ]
}

@test "remove снимает и скилл и команды, dry-run ничего не трогает" {
  bash "$STATION/bin/spec-station.sh" install --client omp >/dev/null
  run bash "$STATION/bin/spec-station.sh" remove --client omp --dry-run
  [[ "$output" == *"dry-run"* ]]
  [ -e "$SPEC_STATION_HOME/.agents/skills/spec-mode" ]
  [ -e "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]

  run bash "$STATION/bin/spec-station.sh" remove --client omp
  [ "$status" -eq 0 ]
  [ ! -e "$SPEC_STATION_HOME/.agents/skills/spec-mode" ]
  [ ! -e "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]
}

@test "status показывает слой и команды, ловит битую ссылку" {
  bash "$STATION/bin/spec-station.sh" install --client omp >/dev/null
  run bash "$STATION/bin/spec-station.sh" status --client omp
  [ "$status" -eq 0 ]
  [[ "$output" == *"ссылка →"* ]]
  [[ "$output" == *"6/6"* ]]

  rm "$SPEC_STATION_SOURCE/SKILL.md"
  run bash "$STATION/bin/spec-station.sh" status --client omp
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет SKILL.md"* ]]
}

@test "клиентский слой — зеркало канонического, а не станции" {
  mkdir -p "$SPEC_STATION_HOME/.config/opencode/skills"
  run bash "$STATION/bin/spec-station.sh" install --client none
  [ "$status" -eq 0 ]
  [[ "$output" == *"[global]"* ]]
  [[ "$output" == *"[opencode]"* ]]
  [ "$(readlink "$SPEC_STATION_HOME/.agents/skills/spec-mode")" = "$SPEC_STATION_SOURCE" ]
  [ "$(readlink "$SPEC_STATION_HOME/.config/opencode/skills/spec-mode")" = "$SPEC_STATION_HOME/.agents/skills/spec-mode" ]

  run bash "$STATION/bin/spec-station.sh" status --client none
  [ "$status" -eq 0 ]
  [[ "$output" != *"не туда"* ]]
}

@test "у pi команды идут в prompts, а не в commands" {
  mkdir -p "$SPEC_STATION_HOME/.pi/agent"
  run bash "$STATION/bin/spec-station.sh" install --client pi
  [ "$status" -eq 0 ]
  [ -e "$SPEC_STATION_HOME/.pi/agent/prompts/spec.md" ]
  [ ! -e "$SPEC_STATION_HOME/.pi/agent/commands" ]

  run bash "$STATION/bin/spec-station.sh" status --client pi
  [ "$status" -eq 0 ]
  [[ "$output" == *"6/6"* ]]
}

@test "команды клиента не делают его живым слоем скилла" {
  run bash "$STATION/bin/spec-station.sh" install --client omp
  [ "$status" -eq 0 ]
  [[ "$output" != *"[omp]"* ]]
  [ -e "$SPEC_STATION_HOME/.omp/agent/commands/spec.md" ]
  [ ! -e "$SPEC_STATION_HOME/.omp/agent/skills" ]
}

@test "verify проходит на целой станции и ругается на дыры" {
  run bash "$STATION/bin/spec-station.sh" verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"станция в порядке"* ]]

  rm "$SPEC_STATION_SOURCE/references/ears.md"
  run bash "$STATION/bin/spec-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет references/ears.md"* ]]

  printf 'справочник ears\n' >"$SPEC_STATION_SOURCE/references/ears.md"
  rm "$SPEC_STATION_SOURCE/templates/tasks.md"
  run bash "$STATION/bin/spec-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет templates/tasks.md"* ]]

  printf 'шаблон tasks\n' >"$SPEC_STATION_SOURCE/templates/tasks.md"
  printf -- '---\nname: spec-mode\n---\n' >"$SPEC_STATION_SOURCE/SKILL.md"
  run bash "$STATION/bin/spec-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет description"* ]]
}

@test "verify ругается на команду без description и на пустой каталог команд" {
  printf -- '---\ndescription: команда\n---\n' >"$SPEC_STATION_COMMANDS/spec.md".broken
  mv "$SPEC_STATION_COMMANDS/spec.md".broken "$SPEC_STATION_COMMANDS/spec.md"
  printf 'без фронтматтера\n' >"$SPEC_STATION_COMMANDS/spec-new.md"
  run bash "$STATION/bin/spec-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"commands/spec-new.md: нет description"* ]]

  printf -- '---\ndescription: команда\n---\n' >"$SPEC_STATION_COMMANDS/spec-new.md"
  rm -rf "$SPEC_STATION_COMMANDS"
  run bash "$STATION/bin/spec-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет команд"* ]]
}

@test "ошибки: плохой слой, плохой клиент, плохой режим, лишний аргумент" {
  run bash "$STATION/bin/spec-station.sh" install --layer луна
  [ "$status" -eq 1 ]
  [[ "$output" == *"--layer принимает"* ]]

  run bash "$STATION/bin/spec-station.sh" install --client slack
  [ "$status" -eq 1 ]
  [[ "$output" == *"--client принимает"* ]]

  run bash "$STATION/bin/spec-station.sh" install --mode копия
  [ "$status" -eq 1 ]
  [[ "$output" == *"--mode принимает"* ]]

  run bash "$STATION/bin/spec-station.sh" install лишнее
  [ "$status" -eq 1 ]
  [[ "$output" == *"лишний аргумент"* ]]

  run bash "$STATION/bin/spec-station.sh" --json list
  [ "$status" -eq 0 ]
}

@test "реальная станция цела и без абсолютных путей в скриптах" {
  unset SPEC_STATION_SOURCE SPEC_STATION_COMMANDS SPEC_STATION_HOME SPEC_STATION_CWD
  run bash "$STATION/bin/spec-station.sh" verify
  [ "$status" -eq 0 ]
  run bash "$STATION/bin/spec-station.sh" list --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"references"'* ]]
  [[ "$output" == *'"commands"'* ]]

  local checker="$STATION/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$STATION/bin" "$STATION/tests"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "windows: PowerShell-обёртка работает и -WhatIf ничего не ставит" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  run env SPEC_STATION_HOME="$SPEC_STATION_HOME" SPEC_STATION_SOURCE="$SPEC_STATION_SOURCE" \
    SPEC_STATION_COMMANDS="$SPEC_STATION_COMMANDS" \
    pwsh -NoProfile -File "$STATION/bin/spec-station.ps1" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"spec-mode"* ]]

  run env SPEC_STATION_HOME="$SPEC_STATION_HOME" SPEC_STATION_SOURCE="$SPEC_STATION_SOURCE" \
    SPEC_STATION_COMMANDS="$SPEC_STATION_COMMANDS" \
    pwsh -NoProfile -File "$STATION/bin/spec-station.ps1" install --client omp -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$SPEC_STATION_HOME/.agents/skills/spec-mode" ]
}
