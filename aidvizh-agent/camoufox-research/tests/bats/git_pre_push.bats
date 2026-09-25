#!/usr/bin/env bats
# git-pre-push.sh: страж публикации. Что уходит в открытый репо, решает он.
#
# Урок 21.09: на НОВОМ бранче скрипт брал несуществующую `$REPO_HASH_EMPTY`,
# `git diff ""...HEAD` молча давал пустой список — и пуш проходил без единой
# проверки. Поэтому фикстура — настоящий git-репозиторий в BATS_TEST_TMPDIR,
# а план подаётся на stdin в формате git pre-push:
#   local_ref local_sha remote_ref remote_sha
# Для нового бранча remote_sha = 40 нулей.
#
# Герметичность: у фикстуры свой HOME и GIT_CONFIG_*/NOSYSTEM — чужие
# ~/.gitconfig и core.hooksPath не влияют; репозиторий владельца не трогаем.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO/scripts/git-pre-push.sh"
  BASH_BIN="$(command -v bash)"
  HOME_STUB="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME_STUB"
  ZERO="$(printf '0%.0s' $(seq 40))"
}

mgit() { # git в песочнице: свой HOME, никаких чужих конфигов
  env HOME="$HOME_STUB" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
      GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
      GIT_AUTHOR_NAME=bats GIT_AUTHOR_EMAIL=bats@test \
      GIT_COMMITTER_NAME=bats GIT_COMMITTER_EMAIL=bats@test \
      git "$@"
}

new_repo() { # $1 = каталог; $2.. = пути файлов фикстуры (по одному на аргумент)
  local dir="$1" f
  shift
  mkdir -p "$dir"
  mgit -C "$dir" init -q -b main
  for f in "$@"; do
    mkdir -p "$dir/$(dirname "$f")"
    echo "фикстура" > "$dir/$f"
  done
  mgit -C "$dir" add -A
  mgit -C "$dir" commit -qm "bats fixture"
  mgit -C "$dir" rev-parse HEAD
}

pre_push() { # $1 = репозиторий, $2 = sha нового бранча; stdin — план git
  local dir="$1" sha="$2" old="$PWD"
  local plan
  plan="$(printf 'refs/heads/new\t%s\trefs/heads/new\t%s\n' "$sha" "$ZERO")"
  cd "$dir"
  run env HOME="$HOME_STUB" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
      GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
      "$BASH_BIN" "$SCRIPT" <<< "$plan"
  cd "$old"
}

@test "новый бранч с research/private.md — СТОП (rc 1) и файл назван" {
  sha="$(new_repo "$BATS_TEST_TMPDIR/bad" research/private.md)"
  pre_push "$BATS_TEST_TMPDIR/bad" "$sha"

  [ "$status" -eq 1 ]
  [[ "$output" == *research/private.md* ]]
}

@test "новый бранч только с витриной (research/public/**) — пропуск" {
  sha="$(new_repo "$BATS_TEST_TMPDIR/ok" research/public/report.md)"
  pre_push "$BATS_TEST_TMPDIR/ok" "$sha"

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "витрина вместе с метриками — пропуск" {
  sha="$(new_repo "$BATS_TEST_TMPDIR/mixed" research/public/a.md metrics/usage.md)"
  pre_push "$BATS_TEST_TMPDIR/mixed" "$sha"

  [ "$status" -eq 0 ]
}

@test "границы allow-листа (--classify, без git): приватное — BLOCK" {
  run "$BASH_BIN" "$SCRIPT" --classify research/private.md
  [ "$status" -eq 3 ]
  [ "$output" = "BLOCK" ]

  # *.md не разрешаем вслепую: ловушка 28.08 — приватный research/*.md уходил
  run "$BASH_BIN" "$SCRIPT" --classify notes/private.md
  [ "$status" -eq 3 ]

  # runtime-алерт живёт в metrics/, но в git ему нельзя
  run "$BASH_BIN" "$SCRIPT" --classify metrics/budget-alert.txt
  [ "$status" -eq 3 ]
}

@test "границы allow-листа (--classify): витрина, метрики, код — ALLOW" {
  run "$BASH_BIN" "$SCRIPT" --classify research/public/report.md
  [ "$status" -eq 0 ]
  [ "$output" = "ALLOW" ]

  run "$BASH_BIN" "$SCRIPT" --classify metrics/usage-weekly.txt
  [ "$status" -eq 0 ]

  run "$BASH_BIN" "$SCRIPT" --classify docs/landmines.md
  [ "$status" -eq 0 ]
}
