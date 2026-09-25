#!/usr/bin/env bats
# Тесты станции установки CLI: каталог → выбор метода → запуск → проверка.
# Сеть и пакетные менеджеры подменены заглушками, PATH сужается — реальные установки не идут.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export STUB_LOG="$BATS_TEST_TMPDIR/stub.log"
  : >"$STUB_LOG"

  # отдельный PATH для станции: заглушки вместо пакетных менеджеров.
  # Сам bats работает с обычным PATH — узкий отдаём только движку через env.
  export BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN"
  # движок win32-веток зовём по абсолютному пути: его PATH — с разделителем `;`, шелл-поиск там не работает
  NODE="$(command -v node)"
  export NODE
  local tool
  for tool in bash sh node jq grep sed ln rm cat mkdir cut tr readlink dirname basename; do
    [[ -n "$(command -v "$tool" 2>/dev/null)" ]] && ln -sf "$(command -v "$tool")" "$BIN/$tool"
  done
  for tool in npm bun curl; do
    cat >"$BIN/$tool" <<EOS
#!/usr/bin/env bash
printf '%s %s\n' "$tool" "\$*" >>"\$STUB_LOG"
exit 0
EOS
    chmod +x "$BIN/$tool"
  done
  cd "$BATS_TEST_TMPDIR"

  # домашний склад бинарей (~/.local/bin, ~/bin) тоже изолируем: иначе тест видит живой дом машины,
  # а движок с недавних пор смотрит и туда — «нет в PATH» должно значить «нет нигде»
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
}

@test "list показывает три CLI и их методы" {
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"omp"* ]]
  [[ "$output" == *"pi"* ]]
  [[ "$output" == *"opencode"* ]]
  [[ "$output" == *"методы"* ]]
}

@test "каталог покрывает linux, macOS и Windows" {
  run node -e '
const { readdirSync, readFileSync } = require("node:fs");
const dir = process.argv[1];
const rows = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
for (const row of rows) {
  for (const platform of ["linux", "darwin", "win32"]) {
    if (!row.methods[platform] || row.methods[platform].length === 0) throw new Error(`${row.name}: нет методов для ${platform}`);
  }
  if (!row.verify?.command) throw new Error(`${row.name}: нет verify.command`);
}
console.log(`проверено CLI: ${rows.length}`);
' "$STATION/catalog"
  [ "$status" -eq 0 ]
  [[ "$output" == *"проверено CLI: 3"* ]]
}

@test "status: ставит ok и версию, отсутствующий — говорит нет" {
  cat >"$BIN/omp" <<'EOS'
#!/usr/bin/env bash
echo "omp/9.9.9"
EOS
  chmod +x "$BIN/omp"

  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" status
  [ "$status" -eq 1 ]          # pi и opencode в PATH нет
  [[ "$output" == *"omp/9.9.9"* ]]
  [[ "$output" == *"pi"*"нет"* ]]
}

@test "авто-выбор уважает requires: без npm берётся bun" {
  rm -f "$BIN/npm"
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" install omp --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"метод bun"* ]]
  [[ "$output" != *"метод npm"* ]]
}

@test "install --method npm запускает нужную команду пакетного менеджера" {
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" install pi --method npm
  [ "$status" -eq 1 ]          # заглушка ничего не поставила, значит проверка честно падает
  grep -q "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1" "$STUB_LOG"
  [[ "$output" == *"ведёт"* || "$output" == *"не найден ни в PATH"* ]]
}

@test "npm с недоступным глобальным префиксом ставится в домашний ~/.local (без root)" {
  cat >"$BIN/npm" <<'EOS'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >>"$STUB_LOG"
printf 'prefix=%s\n' "$npm_config_prefix" >>"$STUB_LOG"
if [ "$1 $2" = "prefix -g" ]; then printf '%s\n' "$UNWRITABLE"; exit 0; fi
exit 0
EOS
  chmod +x "$BIN/npm"

  run env PATH="$BIN" UNWRITABLE="$BATS_TEST_TMPDIR/no-such-prefix" bash "$STATION/bin/cli-station.sh" install pi --method npm
  [ "$status" -eq 1 ]          # заглушка ничего не поставила — проверка после установки честно падает
  [[ "$output" == *"недоступен на запись"* ]]
  grep -q "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1" "$STUB_LOG"
  grep -q "prefix=$HOME/.local" "$STUB_LOG"
}

@test "канал opencode: dev по умолчанию, latest по флагу, неизвестный — ошибка" {
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" install opencode --dry-run
  [[ "$output" == *"метод npm-dev"* ]]

  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" install opencode --dry-run --channel latest
  [[ "$output" == *"метод npm-latest"* ]]

  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" install opencode --dry-run --channel bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет канала bogus"* ]]
  [[ "$output" == *"dev, latest"* ]]
}

@test "dry-run ничего не запускает" {
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -s "$STUB_LOG" ]
}

@test "неизвестный метод — понятная ошибка" {
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" install pi --method не-тот
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет метода"* ]]
}

@test "doctor показывает инструменты и доступные методы" {
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"платформа"* ]]
  [[ "$output" == *"pi: доступно"* ]]
}

@test "в проекте нет абсолютных путей" {
  local checker="$STATION/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$STATION"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "windows: PowerShell-обёртка работает и -WhatIf ничего не запускает" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  run env PATH="$BIN:$PATH" pwsh -NoProfile -File "$STATION/bin/cli-station.ps1" status --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"name": "omp"'* ]]

  : >"$STUB_LOG"
  run env PATH="$BIN:$PATH" pwsh -NoProfile -File "$STATION/bin/cli-station.ps1" -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  # ни одна установочная команда не должна была выполниться (в лог пишут только заглушки)
  ! grep -q "install -g" "$STUB_LOG"
}

@test "doctor показывает реальный npm-префикс, а не «неизвестен»" {
  local dir="$BATS_TEST_TMPDIR/npm-prefix"
  mkdir -p "$dir"
  cat >"$dir/npm" <<EOS
#!/usr/bin/env bash
printf '%s\n' "$BATS_TEST_TMPDIR/npm-g"
exit 0
EOS
  chmod +x "$dir/npm"

  run env PATH="$dir:$PATH" bash "$STATION/bin/cli-station.sh" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"npm        $dir/npm — префикс $BATS_TEST_TMPDIR/npm-g"* ]]
  [[ "$output" != *"префикс неизвестен"* ]]
}

# --- win32-ветки движка. Живой Windows нет: подменяем платформу (CLI_STATION_PLATFORM=win32),
# PATH с разделителем `;`, PATHEXT и подложенные файлы. Проверяется разбор путей и ветвлений, а не
# запуск на настоящей Windows.

@test "win32: which находит npm.cmd по PATHEXT среди каталогов PATH через ;" {
  local one="$BATS_TEST_TMPDIR/win-one" two="$BATS_TEST_TMPDIR/win-two"
  mkdir -p "$one" "$two"
  printf '#!/bin/sh\nexit 0\n' >"$one/npm"
  printf '@echo off\r\nexit /b 0\r\n' >"$one/npm.cmd"

  run env PATH="$one;$two" PATHEXT=".COM;.EXE;.BAT;.CMD" CLI_STATION_PLATFORM=win32 "$NODE" "$STATION/bin/cli-station.mjs" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"npm        $one/npm.cmd"* ]]
  [[ "$output" != *"npm        $one/npm "* ]]
  # npm.cmd — это .cmd: путь и команда видны, а запуск идёт через cmd.exe /c
  [[ "$output" == *"cmd.exe /c $one/npm.cmd config get prefix"* ]]
}

@test "win32: заглушка в WindowsApps не считается установленным CLI" {
  local wa="$BATS_TEST_TMPDIR/winapps/WindowsApps"
  mkdir -p "$wa"
  printf '@echo off\r\necho поставь дистрибутив\r\n' >"$wa/pi.cmd"

  run env PATH="$wa" PATHEXT=".COM;.EXE;.BAT;.CMD" CLI_STATION_PLATFORM=win32 "$NODE" "$STATION/bin/cli-station.mjs" status --json
  [[ "$output" == *'"name": "pi"'* ]]
  [[ "$output" == *'"installed": false'* ]]
  [[ "$output" == *'"error": "нет в PATH: pi"'* ]]
}

@test "win32: провал запуска .cmd несёт текст команды и ENOENT" {
  local dir="$BATS_TEST_TMPDIR/win-cmd"
  mkdir -p "$dir"
  printf '@echo off\r\nexit /b 0\r\n' >"$dir/pi.cmd"

  run env PATH="$dir" PATHEXT=".COM;.EXE;.BAT;.CMD" CLI_STATION_PLATFORM=win32 "$NODE" "$STATION/bin/cli-station.mjs" status --json
  [[ "$output" == *'"installed": false'* ]]
  [[ "$output" == *'"error": "не удалось запустить cmd.exe /c '"$dir"'/pi.cmd --version: ENOENT"'* ]]
}

@test "win32: .ps1 из verify запускается через psRunner" {
  local dir="$BATS_TEST_TMPDIR/win-ps1" catalog="$BATS_TEST_TMPDIR/catalog-ps1" store="$BATS_TEST_TMPDIR/WindowsApps"
  mkdir -p "$dir" "$catalog" "$store"
  printf 'Write-Output "9.9.9"\r\n' >"$dir/psi.ps1"
  printf '#!/bin/sh\nexit 0\n' >"$store/pwsh.exe"
  chmod +x "$store/pwsh.exe"
  cat >"$BATS_TEST_TMPDIR/deny-store-stat.cjs" <<'EOF'
const fs = require("node:fs");
const realStatSync = fs.statSync;
fs.statSync = function (path, ...args) {
  if (String(path).toLowerCase().endsWith("pwsh.exe")) {
    const error = new Error("simulated Store alias reparse point");
    error.code = "EACCES";
    throw error;
  }
  return realStatSync.call(this, path, ...args);
};
require("node:module").syncBuiltinESMExports();
EOF
  cat >"$catalog/psi.json" <<'EOS'
{
  "name": "psi",
  "description": "тестовая запись: проверка версии скриптом PowerShell",
  "verify": { "command": "psi", "args": ["--version"] },
  "methods": { "win32": [{ "id": "noop", "argv": ["psi"] }] }
}
EOS

  run env PATH="$store:$dir" PATHEXT=".COM;.EXE;.BAT;.CMD;.PS1" CLI_STATION_CATALOG="$catalog" CLI_STATION_PLATFORM=win32 \
    NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-store-stat.cjs" "$NODE" "$STATION/bin/cli-station.mjs" status --json
  [[ "$output" == *'"code": 0'* ]]
  [[ "$output" == *"$store/pwsh.exe -NoProfile -File $dir/psi.ps1 --version"* ]]
  [[ "$output" != *"-ExecutionPolicy Bypass"* ]]
}

@test "win32: движок не зовёт bash из PATH" {
  local dir="$BATS_TEST_TMPDIR/no-bash"
  mkdir -p "$dir"
  cat >"$dir/bash" <<'EOS'
#!/bin/bash
printf 'bash %s\n' "$*" >>"$STUB_LOG"
exit 0
EOS
  chmod +x "$dir/bash"
  : >"$STUB_LOG"

  run env PATH="$dir" CLI_STATION_PLATFORM=win32 "$NODE" "$STATION/bin/cli-station.mjs" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"платформа: Windows"* ]]
  [ ! -s "$STUB_LOG" ]
}

@test "win32: PATH из Git Bash (через :) тоже находит npm.cmd — разделитель по виду строки" {
  local dir="$BATS_TEST_TMPDIR/gitbash"
  mkdir -p "$dir"
  printf '@echo off\r\nexit /b 0\r\n' >"$dir/npm.cmd"

  # Git Bash отдаёт ту же переменную через «:» и путями /c/...: разбор «по платформе» нашёл бы ноль каталогов
  run env PATH="$dir:/usr/bin" PATHEXT=".COM;.EXE;.BAT;.CMD" CLI_STATION_PLATFORM=win32 "$NODE" "$STATION/bin/cli-station.mjs" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"$dir/npm.cmd"* ]]
}

@test "win32: установка зовёт npm.cmd через cmd.exe /c, а не спавнит шим напрямую" {
  local dir="$BATS_TEST_TMPDIR/win-install"
  mkdir -p "$dir"
  printf '@echo off\r\nexit /b 0\r\n' >"$dir/npm.cmd"

  run env PATH="$dir" PATHEXT=".COM;.EXE;.BAT;.CMD" CLI_STATION_PLATFORM=win32 "$NODE" "$STATION/bin/cli-station.mjs" install pi --method npm --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"cmd.exe /c $dir/npm.cmd install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1"* ]]
}

@test "домашний склад ~/.local/bin: не в PATH — всё равно найден, назван и предупреждён" {
  local store="$HOME/.local/bin"
  mkdir -p "$store"
  cat >"$store/omp" <<'EOS2'
#!/usr/bin/env bash
echo "omp/7.7.7"
EOS2
  chmod +x "$store/omp"

  # status: бинарь со склада виден, хоть PATH о каталоге и не знает
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" status omp
  [ "$status" -eq 0 ]
  [[ "$output" == *"$store/omp"* ]]
  [[ "$output" == *"omp/7.7.7"* ]]

  # install: установщик-заглушка «сработал», бинарь со склада — поставлено + честное замечание про PATH
  run env PATH="$BIN" bash "$STATION/bin/cli-station.sh" install omp --method bun
  [ "$status" -eq 0 ]
  [[ "$output" == *"поставлено: $store/omp"* ]]
  [[ "$output" == *"не в PATH этой оболочки"* ]]
  [[ "$output" == *"export PATH=\"$store:"* ]]
}
