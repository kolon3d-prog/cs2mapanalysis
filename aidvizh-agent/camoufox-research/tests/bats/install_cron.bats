#!/usr/bin/env bats
# install_cron.sh: `--dry` НЕ имеет права писать crontab ни в какой комбинации.
#
# Урок 21.09: флаги лежали в одной переменной MODE, поэтому `--dry
# --keep-timings` терял --dry (побеждал последний матч) и ПИСАЛ crontab, а
# опечатка `--dryy` молча считалась обычной установкой.
#
# Герметичность: фальшивый `crontab` в PATH (реальный недостижим) логирует
# каждый вызов. ЧТЕНИЕ (`-l`) в `--keep-timings` разрешено — оно и нужно,
# чтобы сохранить чужие времена; ЗАПИСЬ (`crontab <файл>`) запрещена.
# Кэш владельца не трогаем: CAMOUFOX_CACHE_DIR → BATS_TEST_TMPDIR.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO/scripts/install_cron.sh"
  BASH_BIN="$(command -v bash)"
  STUB="$BATS_TEST_TMPDIR/bin"
  CALLS="$BATS_TEST_TMPDIR/crontab-calls.log"
  OLD="$BATS_TEST_TMPDIR/old-crontab"
  CACHE="$BATS_TEST_TMPDIR/cache"
  HOME_STUB="$BATS_TEST_TMPDIR/home"
  mkdir -p "$STUB" "$CACHE" "$HOME_STUB"
  : > "$OLD" # пустой старый crontab по умолчанию

  cat > "$STUB/crontab" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$CALLS"
if [ "\${1:-}" = "-l" ]; then cat "$OLD"; fi
exit 0
EOF
  chmod +x "$STUB/crontab"
}

run_cron() {
  run env PATH="$STUB:/usr/bin:/bin" HOME="$HOME_STUB" TMPDIR="$BATS_TEST_TMPDIR" \
      CAMOUFOX_CACHE_DIR="$CACHE" CAMOUFOX_REPO="$REPO" \
      "$BASH_BIN" "$SCRIPT" "$@"
}

@test "--dry без --keep-timings не зовёт crontab вообще" {
  run_cron --dry

  [ "$status" -eq 0 ]
  [ ! -e "$CALLS" ]
  [[ "$output" == *"НЕ применены"* ]]
  [[ "$output" == *health_pulse.py* ]] # пульс здоровья — часть расписания
}

@test "--dry --keep-timings читает crontab, но НИ РАЗУ не пишет" {
  printf '5 5 * * * CAMOUFOX_REPO="/x" bash -c "cd /x && python scripts/watchdog_search.py"\n' > "$OLD"
  run_cron --dry --keep-timings

  [ "$status" -eq 0 ]
  [ -s "$CALLS" ] # чтение состоялось — иначе проверка записи была бы пустой
  [ "$(grep -cv '^-l$' "$CALLS")" -eq 0 ] # все вызовы — только чтение
  [[ "$output" == *"НЕ применены"* ]]
}

@test "--keep-timings сохраняет своё время пользователя" {
  printf '5 5 * * * CAMOUFOX_REPO="/x" bash -c "cd /x && python scripts/watchdog_search.py"\n' > "$OLD"
  run_cron --dry --keep-timings

  [[ "$output" == *"5 5 * * *"* ]]  # моё время не перезаписано дефолтом
  [[ "$output" != *"7 9,21"* ]]
}

@test "--keep-timings на пустом crontab берёт дефолт (grep без совпадений не роняет)" {
  run_cron --dry --keep-timings

  [ "$status" -eq 0 ]
  [[ "$output" == *"7 9,21"* ]]
}

@test "опечатка в флаге отвергнута и crontab не тронут" {
  run_cron --dryy

  [ "$status" -eq 2 ]
  [ ! -e "$CALLS" ]
  [[ "$output" == *"неизвестный флаг"* ]]
}

@test "нет crontab в системе — честный отказ, а не падение посреди работы" {
  # Git-Bash/Windows и минимальные контейнеры: бинарника нет. Страх — только
  # на пути к установке, поэтому проверяем ДО temp-файлов: ни мусора, ни
  # «command not found» в середине. PATH тут пуст (stub с фейком не берём).
  mkdir -p "$BATS_TEST_TMPDIR/no-crontab"
  run env PATH="$BATS_TEST_TMPDIR/no-crontab" HOME="$HOME_STUB" TMPDIR="$BATS_TEST_TMPDIR" \
      CAMOUFOX_CACHE_DIR="$CACHE" CAMOUFOX_REPO="$REPO" "$BASH_BIN" "$SCRIPT" --dry

  [ "$status" -ne 0 ]
  [[ "$output" == *crontab* ]]
  [ ! -e "$CALLS" ]
}
