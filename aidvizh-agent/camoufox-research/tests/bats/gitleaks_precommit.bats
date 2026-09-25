#!/usr/bin/env bats
# gitleaks-precommit.sh: секрет-сканер обязан РОНЯТЬ хук своим же rc.
#
# Урок 21.09: скрипт заканчивался безусловным `exit 0`, поэтому guard-all.sh
# физически не мог остановить коммит — падение сканера затиралось. Проверяем
# ровно поведение (rc и вызов сканера), а не текст скрипта.
#
# Приём: фальшивый `gitleaks` в PATH. PATH отдаётся ЦЕЛИКОМ (реальный сканер
# живёт в ~/.local/bin), поэтому «нет бинарника» — честная проверка, а не
# случайность машины. Маркер вызова держит тесты непустыми: если сканер не
# позвали, тест падает, а не зеленеет от пустого лога.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO/scripts/gitleaks-precommit.sh"
  BASH_BIN="$(command -v bash)"
  STUB="$BATS_TEST_TMPDIR/bin"
  MARK="$BATS_TEST_TMPDIR/called.log"
  HOME_STUB="$BATS_TEST_TMPDIR/home"
  mkdir -p "$STUB" "$HOME_STUB"
}

fake_gitleaks() { # $1 = код возврата, которым «падает» сканер
  cat > "$STUB/gitleaks" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$MARK"
exit $1
EOF
  chmod +x "$STUB/gitleaks"
}

run_guard() { # $1 = PATH для хука (в нём живёт или не живёт gitleaks)
  run env PATH="$1" HOME="$HOME_STUB" "$BASH_BIN" "$SCRIPT"
}

@test "падение gitleaks роняет хук (rc сканера доходит как есть)" {
  fake_gitleaks 1
  run_guard "$STUB"

  [ "$status" -eq 1 ]
  [ -s "$MARK" ] # сканера действительно звали — иначе тест пустой
  grep -q -- "--staged" "$MARK" # сканируем staged, а не весь history
}

@test "rc сканера не подменяется своим (42 ≠ 1)" {
  fake_gitleaks 42
  run_guard "$STUB"

  [ "$status" -eq 42 ]
}

@test "чистый скан пропускает коммит" {
  fake_gitleaks 0
  run_guard "$STUB"

  [ "$status" -eq 0 ]
  [ -s "$MARK" ]
}

@test "нет сканера локально — не блокер, но и не тишина (rc 0 + CI в тексте)" {
  run_guard "$STUB" # STUB пуст: gitleaks нет ни в нём, ни по пути

  [ "$status" -eq 0 ]
  [[ "$output" == *CI* ]]
  [ ! -e "$MARK" ]
}
