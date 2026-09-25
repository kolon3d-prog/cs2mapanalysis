#!/usr/bin/env bats
# Тесты станции прошивок: каталог персон → файлы клиентов (omp/pi/opencode).
# Домашний каталог и каталог прошивок подменяются; реальные конфиги не трогаются.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export PROMPT_STATION_HOME="$BATS_TEST_TMPDIR/home"
  export PROMPT_STATION_PERSONAS="$BATS_TEST_TMPDIR/personas"
  unset PI_CODING_AGENT_DIR XDG_CONFIG_HOME PROMPT_STATION_OVERLAY
  mkdir -p "$PROMPT_STATION_HOME" "$PROMPT_STATION_PERSONAS"

  printf 'ты — тестовый дак. отвечай коротко.\n' >"$PROMPT_STATION_PERSONAS/duck.txt"
  printf 'ты — тестовый физик.\n' >"$PROMPT_STATION_PERSONAS/feynman.md"
  cd "$BATS_TEST_TMPDIR"
}

@test "list показывает прошивки каталога" {
  run bash "$STATION/bin/prompt-station.sh" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"duck"* ]]
  [[ "$output" == *"feynman"* ]]
  [[ "$output" == *"тестовый дак"* ]]
}

@test "show отдаёт текст прошивки, ошибка — на незнакомое имя" {
  run bash "$STATION/bin/prompt-station.sh" show duck
  [ "$status" -eq 0 ]
  [[ "$output" == *"ты — тестовый дак"* ]]

  run bash "$STATION/bin/prompt-station.sh" show нетакой
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет прошивки"* ]]
}

@test "flash кладёт прошивку во все три клиента" {
  run bash "$STATION/bin/prompt-station.sh" flash duck
  [ "$status" -eq 0 ]
  [ -f "$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md" ]
  [ -f "$PROMPT_STATION_HOME/.pi/agent/APPEND_SYSTEM.md" ]
  [ -f "$PROMPT_STATION_HOME/.config/opencode/AGENTS.md" ]
  run diff -q "$PROMPT_STATION_PERSONAS/duck.txt" "$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md"
  [ "$status" -eq 0 ]
  run diff -q "$PROMPT_STATION_PERSONAS/duck.txt" "$PROMPT_STATION_HOME/.config/opencode/AGENTS.md"
  [ "$status" -eq 0 ]
}

@test "flash идемпотентен и не плодит бэкапы" {
  bash "$STATION/bin/prompt-station.sh" flash duck >/dev/null
  run bash "$STATION/bin/prompt-station.sh" flash duck
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже прошито"* ]]
  [[ "$output" != *"пишу"* ]]
  [ ! -e "$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md.bak" ]
}

@test "замена чужого файла уходит в .bak" {
  mkdir -p "$PROMPT_STATION_HOME/.config/opencode"
  printf 'свои прежние инструкции\n' >"$PROMPT_STATION_HOME/.config/opencode/AGENTS.md"

  run bash "$STATION/bin/prompt-station.sh" flash duck --client opencode
  [ "$status" -eq 0 ]
  [ "$(cat "$PROMPT_STATION_HOME/.config/opencode/AGENTS.md.bak")" = "свои прежние инструкции" ]
}

@test "flash не затирает исходный .bak при двух прошивках" {
  mkdir -p "$PROMPT_STATION_HOME/.config/opencode"
  printf 'исходный файл\n' >"$PROMPT_STATION_HOME/.config/opencode/AGENTS.md"

  bash "$STATION/bin/prompt-station.sh" flash duck --client opencode >/dev/null
  bash "$STATION/bin/prompt-station.sh" flash feynman --client opencode >/dev/null

  [ "$(cat "$PROMPT_STATION_HOME/.config/opencode/AGENTS.md.bak")" = "исходный файл" ]
  [ "$(cat "$PROMPT_STATION_HOME/.config/opencode/AGENTS.md.bak.1")" = "$(cat "$PROMPT_STATION_PERSONAS/duck.txt")" ]
}

@test "личный оверлей дописывается при flash и учитывается в verify/status" {
  mkdir -p "$PROMPT_STATION_HOME/.agents"
  printf 'о собеседнике: тестовый человек.\n' >"$PROMPT_STATION_HOME/.agents/persona-overlay.md"

  run bash "$STATION/bin/prompt-station.sh" flash duck
  [ "$status" -eq 0 ]
  run cat "$PROMPT_STATION_HOME/.config/opencode/AGENTS.md"
  [[ "$output" == *"ты — тестовый дак"* ]]
  [[ "$output" == *"тестовый человек"* ]]

  run bash "$STATION/bin/prompt-station.sh" verify duck
  [ "$status" -eq 0 ]

  run bash "$STATION/bin/prompt-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"+оверлей"* ]]
}

@test "пустой оверлей игнорируется, прошивка ровно как в каталоге" {
  mkdir -p "$PROMPT_STATION_HOME/.agents"
  printf '   \n' >"$PROMPT_STATION_HOME/.agents/persona-overlay.md"

  bash "$STATION/bin/prompt-station.sh" flash duck >/dev/null
  run diff -q "$PROMPT_STATION_PERSONAS/duck.txt" "$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md"
  [ "$status" -eq 0 ]
  run bash "$STATION/bin/prompt-station.sh" status
  [[ "$output" != *"+оверлей"* ]]
}

@test "target=system пишет SYSTEM.md и не трогает APPEND_SYSTEM.md" {
  bash "$STATION/bin/prompt-station.sh" flash duck --target append >/dev/null
  run bash "$STATION/bin/prompt-station.sh" flash feynman --target system --client omp
  [ "$status" -eq 0 ]
  [ -f "$PROMPT_STATION_HOME/.omp/agent/SYSTEM.md" ]
  run diff -q "$PROMPT_STATION_PERSONAS/feynman.md" "$PROMPT_STATION_HOME/.omp/agent/SYSTEM.md"
  [ "$status" -eq 0 ]
  run diff -q "$PROMPT_STATION_PERSONAS/duck.txt" "$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md"
  [ "$status" -eq 0 ]
}

@test "revert возвращает прежнее из .bak, а без бэкапа удаляет файл" {
  mkdir -p "$PROMPT_STATION_HOME/.pi/agent"
  printf 'было раньше\n' >"$PROMPT_STATION_HOME/.pi/agent/APPEND_SYSTEM.md"
  bash "$STATION/bin/prompt-station.sh" flash duck --client pi >/dev/null

  run bash "$STATION/bin/prompt-station.sh" revert --client pi
  [ "$status" -eq 0 ]
  [ "$(cat "$PROMPT_STATION_HOME/.pi/agent/APPEND_SYSTEM.md")" = "было раньше" ]

  # а если бэкапа не было — файл просто удаляется
  rm -f "$PROMPT_STATION_HOME/.pi/agent/APPEND_SYSTEM.md" "$PROMPT_STATION_HOME/.pi/agent/APPEND_SYSTEM.md.bak"
  bash "$STATION/bin/prompt-station.sh" flash duck --client pi >/dev/null
  run bash "$STATION/bin/prompt-station.sh" revert --client pi
  [ "$status" -eq 0 ]
  [ ! -e "$PROMPT_STATION_HOME/.pi/agent/APPEND_SYSTEM.md" ]
}

@test "verify отличает прошитое от чужого" {
  bash "$STATION/bin/prompt-station.sh" flash duck >/dev/null
  run bash "$STATION/bin/prompt-station.sh" verify duck
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok"* ]]

  printf 'кто-то переписал\n' >"$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md"
  run bash "$STATION/bin/prompt-station.sh" verify duck
  [ "$status" -eq 1 ]
  [[ "$output" == *"не то"* ]]
}

@test "status показывает имя прошивки и код возврата" {
  bash "$STATION/bin/prompt-station.sh" flash duck >/dev/null
  run bash "$STATION/bin/prompt-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"прошито: duck"* ]]

  rm -f "$PROMPT_STATION_HOME/.pi/agent/APPEND_SYSTEM.md"
  run bash "$STATION/bin/prompt-station.sh" status
  [ "$status" -eq 1 ]
  [[ "$output" == *"пусто"* ]]
}

@test "status показывает расширения persona/sysprompt и предупреждает о конфликте" {
  run bash "$STATION/bin/prompt-station.sh" status
  [ "$status" -eq 1 ]                                                    # прошивки нет ни у кого
  [[ "$output" == *"расширения persona: omp=нет pi=нет opencode=нет"* ]]
  [[ "$output" == *"расширения sysprompt: omp=нет pi=нет opencode=нет"* ]]
  [[ "$output" == *"<system-reminder>"* ]]                               # честная строка: оба пишут в system
  [[ "$output" == *"приоритета между ними нет"* ]]

  run bash "$STATION/bin/prompt-station.sh" install-ext --client omp
  [ "$status" -eq 0 ]
  run bash "$STATION/bin/prompt-station.sh" status
  [[ "$output" == *"расширения persona: omp=есть pi=нет opencode=нет"* ]]
  [[ "$output" == *"расширения sysprompt: omp=нет pi=нет opencode=нет"* ]]
}

@test "агентский каталог уважает PI_CODING_AGENT_DIR" {
  run env PI_CODING_AGENT_DIR="$BATS_TEST_TMPDIR/agentdir" bash "$STATION/bin/prompt-station.sh" flash duck --client omp
  [ "$status" -eq 0 ]
  [ -f "$BATS_TEST_TMPDIR/agentdir/APPEND_SYSTEM.md" ]
  [ ! -e "$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md" ]
}

@test "ошибки: нет такой прошивки, нет такого клиента, плохой target" {
  run bash "$STATION/bin/prompt-station.sh" flash нетакой
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет прошивки"* ]]

  run bash "$STATION/bin/prompt-station.sh" flash duck --client sun
  [ "$status" -eq 1 ]
  [[ "$output" == *"неизвестный клиент"* ]]

  run bash "$STATION/bin/prompt-station.sh" flash duck --target что-то
  [ "$status" -eq 1 ]
  [[ "$output" == *"--target принимает append или system"* ]]
}

@test "dry-run ничего не пишет" {
  run bash "$STATION/bin/prompt-station.sh" flash duck --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md" ]
  [ ! -e "$PROMPT_STATION_HOME/.config/opencode/AGENTS.md" ]
}

@test "расширение смены персоны на ходу: команда, инжект, off (bun, без модели)" {
  command -v bun >/dev/null 2>&1 || skip "bun не установлен"
  cat >"$BATS_TEST_TMPDIR/persona-ext.ts" <<'TS'
import persona from "EXT_PATH";

let command: any;
let event: any;
const notes: string[] = [];
const api = {
  registerCommand: (_name: string, options: any) => { command = options.handler; },
  on: (_name: string, handler: any) => { event = handler; return () => {}; },
};
(persona as any)(api);

const ctx = { sessionManager: { getSessionId: () => "s1" }, ui: { notify: (text: string) => notes.push(text) } };
await command("feynman", ctx);
const on = (await event({ payload: { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] } }, ctx)) as any;
const injected = on.messages.some((m: any) => m.role === "system" && String(m.content).includes("тестовый физик"));

await command("off", ctx);
const off = await event({ payload: { messages: [{ role: "user", content: "hi" }] } }, ctx);
await command("", ctx);
console.log(`on=${notes.some((n) => n.includes("включена"))} injected=${injected} off=${off === undefined} list=${notes.some((n) => n.includes("feynman"))}`);
TS
  sed -i "s|EXT_PATH|$STATION/shared/persona.ts|" "$BATS_TEST_TMPDIR/persona-ext.ts"
  run env PERSONA_DIR="$PROMPT_STATION_PERSONAS" bun "$BATS_TEST_TMPDIR/persona-ext.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"on=true"* ]]
  [[ "$output" == *"injected=true"* ]]
  [[ "$output" == *"off=true"* ]]
  [[ "$output" == *"list=true"* ]]
}

@test "расширение работает через симлинк: путь к прошивкам не врёт" {
  command -v bun >/dev/null 2>&1 || skip "bun не установлен"
  local extdir="$BATS_TEST_TMPDIR/extensions"
  mkdir -p "$extdir"
  ln -sfn "$STATION/shared/persona.ts" "$extdir/persona.ts"
  cat >"$BATS_TEST_TMPDIR/link-check.ts" <<'TS'
import persona from "LINK_PATH";
let command: any;
const notes: string[] = [];
(persona as any)({
  registerCommand: (_n: string, o: any) => { command = o.handler; },
  on: () => () => {},
});
await command("", { sessionManager: { getSessionId: () => "s" }, ui: { notify: (t: string) => notes.push(t) } });
const line = notes.at(-1) ?? "";
console.log(`knows=${line.includes("duck")} dir=${line.includes("пуст") ? "пуст" : "непуст"}`);
TS
  sed -i "s|LINK_PATH|$extdir/persona.ts|" "$BATS_TEST_TMPDIR/link-check.ts"
  run env PERSONA_DIR="$PROMPT_STATION_PERSONAS" bun "$BATS_TEST_TMPDIR/link-check.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"knows=true"* ]]
  [[ "$output" == *"dir=непуст"* ]]
}

@test "плагин opencode: команда, системный инжект и off (bun)" {
  command -v bun >/dev/null 2>&1 || skip "bun не установлен"
  cat >"$BATS_TEST_TMPDIR/oc-persona.ts" <<'TS'
import plugin from "PLUGIN_PATH";
const hooks: Record<string, (input: any) => void> = {};
await (plugin as any).setup({ session: { hook: async (name: string, handler: any) => { hooks[name] = handler; } } });
const prompt = { sessionID: "s", prompt: { text: "<persona>duck</persona>" } };
hooks.prompt(prompt);
const context = { sessionID: "s", system: [] as { text: string }[] };
hooks.context(context);
console.log(`on=${prompt.prompt.text.includes("включена")} injected=${context.system.some((i) => String(i.text).includes("ты —"))}`);
TS
  sed -i "s|PLUGIN_PATH|$STATION/opencode/dev/plugin/persona.ts|" "$BATS_TEST_TMPDIR/oc-persona.ts"
  run env PERSONA_DIR="$PROMPT_STATION_PERSONAS" bun "$BATS_TEST_TMPDIR/oc-persona.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"on=true"* ]]
  [[ "$output" == *"injected=true"* ]]
}

@test "install-ext ставит расширение в каталоги клиентов" {
  run bash "$STATION/bin/prompt-station.sh" install-ext
  [ "$status" -eq 0 ]
  [ -L "$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts" ]
  [ -L "$PROMPT_STATION_HOME/.pi/agent/extensions/persona.ts" ]
  [ -L "$PROMPT_STATION_HOME/.config/opencode/plugins/persona.ts" ]
  [ -L "$PROMPT_STATION_HOME/.config/opencode/commands/persona.md" ]
  [ "$(physical "$PROMPT_STATION_HOME/.pi/agent/extensions/persona.ts")" = "$(physical "$STATION/shared/persona.ts")" ]

  run bash "$STATION/bin/prompt-station.sh" install-ext --dry-run
  [[ "$output" == *"dry-run"* ]]

  # Windows без Developer Mode: файловая ссылка EPERM, поэтому станция обязана
  # поставить копии и прямо сказать, что это копии.
  rm -f "$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts" \
        "$PROMPT_STATION_HOME/.pi/agent/extensions/persona.ts" \
        "$PROMPT_STATION_HOME/.config/opencode/plugins/persona.ts" \
        "$PROMPT_STATION_HOME/.config/opencode/commands/persona.md"
  cat >"$BATS_TEST_TMPDIR/deny-symlink.cjs" <<'EOF'
const fs = require("node:fs");
fs.symlinkSync = function () {
  const error = new Error("simulated symlink privilege error");
  error.code = "EPERM";
  throw error;
};
require("node:module").syncBuiltinESMExports();
EOF
  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-symlink.cjs" \
    bash "$STATION/bin/prompt-station.sh" install-ext
  [ "$status" -eq 0 ]
  [ ! -L "$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts" ]
  [ -f "$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts" ]
  [ ! -L "$PROMPT_STATION_HOME/.pi/agent/extensions/persona.ts" ]
  [ -f "$PROMPT_STATION_HOME/.pi/agent/extensions/persona.ts" ]
  [ ! -L "$PROMPT_STATION_HOME/.config/opencode/plugins/persona.ts" ]
  [ -f "$PROMPT_STATION_HOME/.config/opencode/plugins/persona.ts" ]
  [ ! -L "$PROMPT_STATION_HOME/.config/opencode/commands/persona.md" ]
  [ -f "$PROMPT_STATION_HOME/.config/opencode/commands/persona.md" ]
  [[ "$output" == *"копия"* ]]

  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-symlink.cjs" \
    bash "$STATION/bin/prompt-station.sh" install-ext
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже стоит (копия совпадает)"* ]]
  printf '\n// устаревшая копия\n' >>"$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts"
  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-symlink.cjs" \
    bash "$STATION/bin/prompt-station.sh" install-ext
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен --force"* ]]

  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-symlink.cjs" \
    bash "$STATION/bin/prompt-station.sh" install-ext --force
  [ "$status" -eq 0 ]
  [[ "$output" == *"копия"* ]]
  run diff -q "$STATION/shared/persona.ts" "$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts"
  [ "$status" -eq 0 ]
  run bash "$STATION/bin/prompt-station.sh" status
  [[ "$output" == *"omp=копия"* ]]
}

@test "install-ext не заменяет чужое расширение без --force" {
  mkdir -p "$PROMPT_STATION_HOME/.omp/agent/extensions"
  printf 'чужое расширение\n' >"$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts"

  run bash "$STATION/bin/prompt-station.sh" install-ext --client omp
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен --force"* ]]
  [ "$(cat "$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts")" = "чужое расширение" ]

  run bash "$STATION/bin/prompt-station.sh" install-ext --client omp --force
  [ "$status" -eq 0 ]
  [ "$(cat "$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts.bak")" = "чужое расширение" ]
  [ -L "$PROMPT_STATION_HOME/.omp/agent/extensions/persona.ts" ]
}

@test "в проекте нет абсолютных путей" {
  local checker="$STATION/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$STATION"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "windows: PowerShell-обёртка и -WhatIf" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  run pwsh -NoProfile -File "$STATION/bin/prompt-station.ps1" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"duck"* ]]

  run pwsh -NoProfile -File "$STATION/bin/prompt-station.ps1" flash duck -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$PROMPT_STATION_HOME/.omp/agent/APPEND_SYSTEM.md" ]
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
