#!/usr/bin/env bats
# Тесты станции плагинов pi: каталог → состояние pi → install/update/remove через сам pi.
# Ни сети, ни настоящего pi: pi и npm подменены заглушками, агент-каталог — временный.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export PI_PLUGINS_STATION_HOME="$BATS_TEST_TMPDIR/home"
  export PI_PLUGINS_STATION_AGENT="$BATS_TEST_TMPDIR/agent"
  export PI_PLUGINS_STATION_CATALOG="$BATS_TEST_TMPDIR/catalog.json"
  export PI_PLUGINS_STATION_PI="$BATS_TEST_TMPDIR/bin/pi"
  export PI_LOG="$BATS_TEST_TMPDIR/pi.log"
  export PI_AGENT="$PI_PLUGINS_STATION_AGENT"
  mkdir -p "$PI_PLUGINS_STATION_HOME" "$PI_PLUGINS_STATION_AGENT" "$BATS_TEST_TMPDIR/bin"

  cat >"$PI_PLUGINS_STATION_CATALOG" <<'JSON'
[
  { "name": "alpha", "source": "npm:alpha", "what": "первый плагин" },
  { "name": "beta", "source": "npm:beta", "what": "второй плагин" },
  { "name": "scoped", "source": "npm:@acme/scoped", "what": "плагин со скоупом" }
]
JSON

  # Заглушка pi: пишет вызовы в лог и правит состояние так, как это делает настоящий.
  cat >"$PI_PLUGINS_STATION_PI" <<'JS'
#!/usr/bin/env node
const { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } = require("node:fs");
const { join, dirname } = require("node:path");
const [cmd, source] = process.argv.slice(2);
const agent = process.env.PI_AGENT;
const settings = join(agent, "settings.json");
const name = (source || "").replace(/^npm:/, "");
const mod = join(agent, "npm/node_modules", name);
const log = process.env.PI_LOG;
if (log) require("node:fs").appendFileSync(log, `${cmd} ${source}\n`);
const read = () => (existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {});
const write = (doc) => { mkdirSync(dirname(settings), { recursive: true }); writeFileSync(settings, JSON.stringify(doc, null, 2)); };
const manifest = (version) => { mkdirSync(mod, { recursive: true }); writeFileSync(join(mod, "package.json"), JSON.stringify({ name, version })); };
if (cmd === "install") { const d = read(); d.packages = [...new Set([...(d.packages || []), source])]; write(d); manifest("1.0.0"); }
else if (cmd === "remove") { const d = read(); d.packages = (d.packages || []).filter((s) => s !== source); write(d); rmSync(mod, { recursive: true, force: true }); }
else if (cmd === "update") { manifest("2.0.0"); }
else if (cmd === "list") { process.stdout.write("User packages:\n"); }
process.exit(0);
JS
  chmod +x "$PI_PLUGINS_STATION_PI"

  # Заглушка npm: последняя версия пакета — из NPM_STUB_LATEST, либо из NPM_STUB_MAP («имя=версия,…»).
  # NPM_STUB_FAIL — реестр недоступен, NPM_STUB_SLEEP — npm молчит (проверка таймаута пробы).
  cat >"$BATS_TEST_TMPDIR/bin/npm" <<'SH'
#!/usr/bin/env bash
if [[ -n "${NPM_STUB_SLEEP:-}" ]]; then sleep "$NPM_STUB_SLEEP" >/dev/null 2>&1; fi
if [[ -n "${NPM_STUB_FAIL:-}" ]]; then
  printf 'npm ERR! code ENOTFOUND\nnpm ERR! network request failed\n' >&2
  exit 1
fi
if [[ -n "${NPM_STUB_MAP:-}" ]]; then
  for pair in ${NPM_STUB_MAP//,/ }; do
    if [[ "${pair%%=*}" == "${2:-}" ]]; then
      printf '%s\n' "${pair#*=}"
      exit 0
    fi
  done
fi
printf '%s\n' "${NPM_STUB_LATEST:-1.0.0}"
SH
  chmod +x "$BATS_TEST_TMPDIR/bin/npm"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  unset NPM_STUB_LATEST NPM_STUB_MAP NPM_STUB_FAIL NPM_STUB_SLEEP

  cd "$BATS_TEST_TMPDIR"
}

@test "list показывает каталог и что из него стоит" {
  run bash "$STATION/bin/pi-plugins-station.sh" install alpha
  [ "$status" -eq 0 ]

  run bash "$STATION/bin/pi-plugins-station.sh" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"alpha"*"стоит 1.0.0"* ]]
  [[ "$output" == *"beta"*"нет"* ]]
  [[ "$output" == *"второй плагин"* ]]
}

@test "install зовёт pi для отсутствующих и идемпотентен" {
  run bash "$STATION/bin/pi-plugins-station.sh" install all
  [ "$status" -eq 0 ]
  [ "$(grep -c '^install npm:' "$PI_LOG")" = "3" ]
  [ "$(grep -c '^install npm:@acme/scoped' "$PI_LOG")" = "1" ]

  run bash "$STATION/bin/pi-plugins-station.sh" install all
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже стоит 1.0.0"* ]]
  [ "$(grep -c '^install npm:' "$PI_LOG")" = "3" ]

  run bash "$STATION/bin/pi-plugins-station.sh" install alpha
  [[ "$output" == *"уже стоит"* ]]
}

@test "status различает стоит, объявлен без файлов и нет; код 1 при нехватке" {
  bash "$STATION/bin/pi-plugins-station.sh" install all >/dev/null
  run bash "$STATION/bin/pi-plugins-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"из каталога не стоит: 0 из 3"* ]]

  # объявлен, но файлы пропали — это не «стоит»
  rm -rf "$PI_PLUGINS_STATION_AGENT/npm/node_modules/beta"
  run bash "$STATION/bin/pi-plugins-station.sh" status
  [ "$status" -eq 1 ]
  [[ "$output" == *"beta"*"объявлен, файлов нет"* ]]

  run bash "$STATION/bin/pi-plugins-station.sh" status --json
  [ "$status" -eq 1 ]
  [ "$(printf '%s' "$output" | jq -r '.missing')" = "1" ]

  # чужой плагин в settings виден отдельно
  node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.packages.push("npm:чужой");fs.writeFileSync(p,JSON.stringify(d,null,2))' "$PI_PLUGINS_STATION_AGENT/settings.json"
  run bash "$STATION/bin/pi-plugins-station.sh" status
  [[ "$output" == *"не из каталога станции"*"npm:чужой"* ]]
}

@test "update зовёт pi только для стоящих" {
  bash "$STATION/bin/pi-plugins-station.sh" install alpha >/dev/null
  run bash "$STATION/bin/pi-plugins-station.sh" update all
  [ "$status" -eq 0 ]
  [ "$(grep -c '^update npm:alpha' "$PI_LOG")" = "1" ]
  [ "$(grep -c '^update npm:beta' "$PI_LOG")" = "0" ]
  [[ "$output" == *"beta"*"не стоит — пропускаю"* ]]

  run bash "$STATION/bin/pi-plugins-station.sh" list
  [[ "$output" == *"alpha"*"стоит 2.0.0"* ]]
}

@test "remove снимает и идемпотентен" {
  bash "$STATION/bin/pi-plugins-station.sh" install beta >/dev/null
  run bash "$STATION/bin/pi-plugins-station.sh" remove beta
  [ "$status" -eq 0 ]
  [ "$(grep -c '^remove npm:beta' "$PI_LOG")" = "1" ]
  run bash "$STATION/bin/pi-plugins-station.sh" remove beta
  [[ "$output" == *"и так нет"* ]]
}

@test "dry-run ничего не зовёт и не меняет" {
  run bash "$STATION/bin/pi-plugins-station.sh" install all --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$PI_LOG" ] || [ ! -s "$PI_LOG" ]
  [ ! -e "$PI_PLUGINS_STATION_AGENT/settings.json" ]

  run bash "$STATION/bin/pi-plugins-station.sh" update all --dry-run
  [[ "$output" == *"dry-run"* ]]
}

@test "outdated сверяет стоящие версии с npm по контракту центра" {
  bash "$STATION/bin/pi-plugins-station.sh" install all >/dev/null
  run env NPM_STUB_LATEST=1.0.0 bash "$STATION/bin/pi-plugins-station.sh" outdated --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.summary.current')" = "3" ]
  [ "$(printf '%s' "$output" | jq -r '.summary.behind')" = "0" ]
  [ "$(printf '%s' "$output" | jq -r '.summary.missing')" = "0" ]

  run env NPM_STUB_LATEST=9.9.9 bash "$STATION/bin/pi-plugins-station.sh" outdated
  [ "$status" -eq 0 ]
  [[ "$output" == *"отстали: 3"* ]]
  [[ "$output" == *"есть новее"* ]]

  # снятый плагин — это missing, а не behind
  bash "$STATION/bin/pi-plugins-station.sh" remove beta >/dev/null
  run env NPM_STUB_LATEST=9.9.9 bash "$STATION/bin/pi-plugins-station.sh" outdated --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.summary.missing')" = "1" ]
  [ "$(printf '%s' "$output" | jq -r '.summary.behind')" = "2" ]
  [ "$(printf '%s' "$output" | jq -r '.plugins[] | select(.name == "beta") | .status')" = "missing" ]
}

@test "verify ловит дубль, плохой source и пустой каталог" {
  run bash "$STATION/bin/pi-plugins-station.sh" verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"каталог в порядке"* ]]

  printf '[{"name":"a","source":"git:github.com/x/y","what":"w"},{"name":"a","source":"npm:a","what":"w"},{"name":"b","source":"npm:b"}]\n' \
    >"$PI_PLUGINS_STATION_CATALOG"
  run bash "$STATION/bin/pi-plugins-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"source не npm:"* ]]
  [[ "$output" == *"дубль в каталоге: a"* ]]
  [[ "$output" == *"b: нет what"* ]]

  printf '[]\n' >"$PI_PLUGINS_STATION_CATALOG"
  run bash "$STATION/bin/pi-plugins-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"каталог пуст"* ]]
}

@test "verify ловит битый settings.json pi" {
  printf '{ это не json\n' >"$PI_PLUGINS_STATION_AGENT/settings.json"
  run bash "$STATION/bin/pi-plugins-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"не разбирается как JSON"* ]]
}

@test "ошибки: нет имени в каталоге, неизвестный флаг" {
  run bash "$STATION/bin/pi-plugins-station.sh" install гамма
  [ "$status" -eq 1 ]
  [[ "$output" == *"в каталоге нет гамма"* ]]

  run bash "$STATION/bin/pi-plugins-station.sh" list --json
  [ "$status" -eq 0 ]

  run bash "$STATION/bin/pi-plugins-station.sh" list --нетакого
  [ "$status" -eq 2 ]
}

@test "падение pi видно по коду возврата" {
  printf '#!/usr/bin/env node\nprocess.exit(3)\n' >"$PI_PLUGINS_STATION_PI"
  chmod +x "$PI_PLUGINS_STATION_PI"
  run bash "$STATION/bin/pi-plugins-station.sh" install alpha
  [ "$status" -eq 1 ]
  [[ "$output" == *"провалов: 1"* ]]
}

@test "реальный каталог цел и без абсолютных путей" {
  unset PI_PLUGINS_STATION_CATALOG PI_PLUGINS_STATION_AGENT PI_PLUGINS_STATION_HOME PI_PLUGINS_STATION_PI
  run bash "$STATION/bin/pi-plugins-station.sh" verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"13 плагинов"* ]]

  run bash "$STATION/bin/pi-plugins-station.sh" list --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r 'length')" = "13" ]
  [ "$(printf '%s' "$output" | jq -r '[.[] | select(.source | startswith("npm:") | not)] | length')" = "0" ]

  local checker="$STATION/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$STATION/bin" "$STATION/tests"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "windows: PowerShell-обёртка работает и -WhatIf ничего не зовёт" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  run env PI_PLUGINS_STATION_HOME="$PI_PLUGINS_STATION_HOME" PI_PLUGINS_STATION_AGENT="$PI_PLUGINS_STATION_AGENT" \
    PI_PLUGINS_STATION_CATALOG="$PI_PLUGINS_STATION_CATALOG" PI_PLUGINS_STATION_PI="$PI_PLUGINS_STATION_PI" \
    pwsh -NoProfile -File "$STATION/bin/pi-plugins-station.ps1" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"alpha"* ]]

  run env PI_PLUGINS_STATION_HOME="$PI_PLUGINS_STATION_HOME" PI_PLUGINS_STATION_AGENT="$PI_PLUGINS_STATION_AGENT" \
    PI_PLUGINS_STATION_CATALOG="$PI_PLUGINS_STATION_CATALOG" PI_PLUGINS_STATION_PI="$PI_PLUGINS_STATION_PI" \
    pwsh -NoProfile -File "$STATION/bin/pi-plugins-station.ps1" install all -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$PI_PLUGINS_STATION_AGENT/settings.json" ]
}

@test "outdated честен, когда npm недоступен: unknown вместо «свежих», код 0" {
  bash "$STATION/bin/pi-plugins-station.sh" install all >/dev/null

  run env NPM_STUB_FAIL=1 bash "$STATION/bin/pi-plugins-station.sh" outdated
  [ "$status" -eq 0 ]
  [[ "$output" == *"не смог узнать"* ]]
  [[ "$output" == *"свежих: 0, отстали: 0, не смог узнать: 3, не стоит: 0"* ]]
  [[ "$output" != *"свежих: 3"* ]]

  run env NPM_STUB_FAIL=1 bash "$STATION/bin/pi-plugins-station.sh" outdated --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.summary.unknown')" = "3" ]
  [ "$(printf '%s' "$output" | jq -r '.summary.current')" = "0" ]
  [ "$(printf '%s' "$output" | jq -r '.plugins[] | select(.name == "alpha") | .status')" = "unknown" ]
}

@test "outdated не висит на молчащем npm: проба обрывается таймаутом" {
  bash "$STATION/bin/pi-plugins-station.sh" install all >/dev/null

  run env NPM_STUB_SLEEP=5 PI_PLUGINS_STATION_NPM_TIMEOUT=400 bash "$STATION/bin/pi-plugins-station.sh" outdated
  [ "$status" -eq 0 ]
  [[ "$output" == *"не смог узнать: 3"* ]]
}

@test "outdated: версия новее даёт «есть новее», равная — свежо" {
  bash "$STATION/bin/pi-plugins-station.sh" install all >/dev/null

  run env NPM_STUB_MAP="alpha=9.9.9,beta=1.0.0" bash "$STATION/bin/pi-plugins-station.sh" outdated
  [ "$status" -eq 0 ]
  [[ "$output" == *"alpha"*"1.0.0 → 9.9.9"*"есть новее"* ]]
  [[ "$output" == *"свежих: 2, отстали: 1, не смог узнать: 0, не стоит: 0"* ]]
  [[ "$output" != *"beta"*"есть новее"* ]]
}
