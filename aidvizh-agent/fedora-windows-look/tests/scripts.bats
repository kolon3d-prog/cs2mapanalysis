#!/usr/bin/env bats
# Тесты скриптов fedora-windows-look. Скрипты — bash под Linux, поэтому и проверки такие:
# синтаксис, shellcheck, безопасные режимы (--help/--json/--dry-run), отсутствие разрушительных команд.
# Ничего в системе не меняем: sudo подменён заглушкой, которая падает и пишет в лог.
# Запуск: bats tests/scripts.bats

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export REPO
  export SUDO_LOG="$BATS_TEST_TMPDIR/sudo.log"
  : >"$SUDO_LOG"
  mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/home"
  cat >"$BATS_TEST_TMPDIR/bin/sudo" <<EOS
#!/usr/bin/env bash
printf 'sudo %s\n' "\$*" >>"$SUDO_LOG"
exit 1
EOS
  chmod +x "$BATS_TEST_TMPDIR/bin/sudo"
  cd "$BATS_TEST_TMPDIR"
}

@test "все скрипты — bash с валидным синтаксисом" {
  local file
  for file in "$REPO"/scripts/*.sh; do
    run head -1 "$file"
    [ "$output" = "#!/usr/bin/env bash" ]
    run bash -n "$file"
    [ "$status" -eq 0 ]
  done
}

@test "shellcheck без замечаний (диалект bash)" {
  command -v shellcheck >/dev/null 2>&1 || skip "shellcheck не установлен"
  run shellcheck -s bash -S warning "$REPO"/scripts/*.sh
  [ "$status" -eq 0 ]
}

@test "preflight --json отдаёт валидный JSON и ничего не меняет" {
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash "$REPO/scripts/preflight.sh" --json
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -ge 5 ]
  run bash -c 'printf "%s\n" "$1" | jq -s "length >= 5 and all(.[]; type == \"object\")"' _ "$output"
  [ "$output" = "true" ]
  [ ! -s "$SUDO_LOG" ]
}

@test "audit --help печатает справку и не трогает систему" {
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash "$REPO/scripts/audit.sh" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Read-only"* ]]
  [ ! -s "$SUDO_LOG" ]
}

@test "apply-скрипты в --dry-run не зовут sudo" {
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash "$REPO/scripts/apply-zram.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"done"* ]]

  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash "$REPO/scripts/apply-windows-look.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"done"* ]]

  [ ! -s "$SUDO_LOG" ]
}

@test "в скриптах нет разрушительных rm -rf" {
  run grep -rnE 'rm -rf (/|~)([[:space:]]|$|\*)' "$REPO/scripts"
  [ "$status" -ne 0 ]
}

@test "install.sh ставит скилл симлинками в оба каталога" {
  run env HOME="$BATS_TEST_TMPDIR/home" sh "$REPO/install.sh"
  [ "$status" -eq 0 ]
  [ -L "$BATS_TEST_TMPDIR/home/.agents/skills/fedora-windows-look" ]
  [ -L "$BATS_TEST_TMPDIR/home/.config/opencode/skills/fedora-windows-look" ]
  [ "$(physical "$BATS_TEST_TMPDIR/home/.agents/skills/fedora-windows-look")" = "$(physical "$REPO")" ]

  run env HOME="$BATS_TEST_TMPDIR/home" sh "$REPO/install.sh"
  [[ "$output" == *"ok"* ]]

  run env HOME="$BATS_TEST_TMPDIR/home" sh "$REPO/install.sh" --dry-run
  [[ "$output" == *"dry-run"* ]]
}

@test "в репозитории нет абсолютных пользовательских путей" {
  local checker="$REPO/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

# Физический путь без GNU-специфики: на macOS `readlink -f` нет, а сравнивать ссылки надо.
# Раскручиваем ссылку вручную и нормализуем каталог через `cd -P` — тогда обе стороны сравнения
# приводятся к одному виду, и системный симлинк над домом (/var → /private/var) не мешает.
physical() {
  local path="$1" link hops=0
  while [ -L "$path" ] && [ "$hops" -lt 40 ]; do
    link="$(readlink "$path")"
    case "$link" in
      /*) path="$link" ;;
      *) path="$(dirname "$path")/$link" ;;
    esac
    hops=$((hops + 1))
  done
  printf '%s/%s\n' "$(cd "$(dirname "$path")" && pwd -P)" "$(basename "$path")"
}
