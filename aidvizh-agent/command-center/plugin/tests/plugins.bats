#!/usr/bin/env bats
# Плагины центра: ядро, обёртки клиентов и установка симлинков.
#
# Живые клиенты здесь не поднимаются (это дорого и требует их собственных
# сессий) — их подхват проверяется вручную командами из plugin/README.md.
# Что проверяем машинно: вывод ядра, регистрацию команды обёртками и то, что
# установка кладёт ровно три ссылки, идемпотентна, умеет .bak и снимается.

setup() {
  PLUGIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  CENTER="$(cd "$PLUGIN/.." && pwd)"
  INSTALL="$CENTER/contrib/install-plugins.sh"
  # Свой HOME: установку проверяем на копии каталогов, не на живых клиентах.
  FAKE="$BATS_TEST_TMPDIR/home"
  mkdir -p "$FAKE/.config/opencode/plugins" "$FAKE/.omp/agent/extensions" "$FAKE/.pi/agent/extensions"
  RUNTIME=""
  for candidate in bun node; do
    command -v "$candidate" >/dev/null 2>&1 && {
      RUNTIME="$candidate"
      break
    }
  done
}

# Строка прогона ядра: bun ест .ts сразу, node — со снятием типов.
run_ts() {
  if [[ "$RUNTIME" == "bun" ]]; then
    bun run "$@"
  else
    node --experimental-strip-types "$@"
  fi
}

@test "ядро: сводка собирается локально и укладывается в бюджет" {
  [[ -n "$RUNTIME" ]] || skip "нет bun/node"
  run env HOME="$FAKE" "$RUNTIME" -e "1" 2>/dev/null || skip "рантайм $RUNTIME не запускается"
  cat >"$BATS_TEST_TMPDIR/summary.ts" <<EOF
import { summary } from "$PLUGIN/lib/center.ts";
const started = performance.now();
const info = summary();
console.log("ms", (performance.now() - started).toFixed(0));
console.log(info.line);
EOF
  run run_ts "$BATS_TEST_TMPDIR/summary.ts"
  [ "$status" -eq 0 ]
  # Пять обещанных полей: DATA, MCP по клиентам, скиллы, версия набора, устаревание.
  [[ "$output" == *"DATA "* ]]
  [[ "$output" == *"MCP omp "*"/"*"pi "*"/"*"opencode "*"/"* ]]
  [[ "$output" == *"скиллов "* ]]
  [[ "$output" == *"набор "* ]]
  [[ "$output" == *"устарело"* || "$output" == *"расхождений нет"* ]]
  # Сводка на старте сессии должна быть дешёвой: это чтение файлов, не спавн станций.
  local ms
  ms="$(printf '%s\n' "$output" | awk '/^ms /{print $2}')"
  [ "${ms%.*}" -lt 2000 ]
}

@test "ядро: команда без аргумента даёт справку, неизвестная — отказ в одну строку" {
  [[ -n "$RUNTIME" ]] || skip "нет bun/node"
  cat >"$BATS_TEST_TMPDIR/help.ts" <<EOF
import { runCommand } from "$PLUGIN/lib/center.ts";
const help = await runCommand("");
console.log("help", help.ok, help.text.split("\n").length);
const bad = await runCommand("nosuch");
console.log("bad", bad.ok, bad.text.split("\n")[0]);
const needArg = await runCommand("logs");
console.log("logs", needArg.ok, needArg.text);
EOF
  run run_ts "$BATS_TEST_TMPDIR/help.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"help true"* ]]
  [[ "$output" == *"bad false center: нет команды «nosuch»"* ]]
  [[ "$output" == *"logs false center logs: нужен аргумент <проект>"* ]]
}

@test "ядро: разбор аргументов держит кавычки и пробелы" {
  [[ -n "$RUNTIME" ]] || skip "нет bun/node"
  cat >"$BATS_TEST_TMPDIR/args.ts" <<EOF
import { splitArgs } from "$PLUGIN/lib/center.ts";
console.log(JSON.stringify(splitArgs('logs my-proj --tail 5')));
console.log(JSON.stringify(splitArgs('docs "что такое набор"')));
EOF
  run run_ts "$BATS_TEST_TMPDIR/args.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *'["logs","my-proj","--tail","5"]'* ]]
  [[ "$output" == *'["docs","что такое набор"]'* ]]
}

@test "обёртка omp/pi: регистрирует /center и наполняет статусную строку" {
  [[ -n "$RUNTIME" ]] || skip "нет bun/node"
  cat >"$BATS_TEST_TMPDIR/wrapper.ts" <<EOF
import center from "$PLUGIN/agent/center.ts";
const notified: string[] = [];
const statuses: Record<string, string | undefined> = {};
let command: { name: string; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
let started: ((event: unknown, ctx: unknown) => unknown) | undefined;
await center({
  registerCommand: (name, options) => (command = { name, handler: options.handler }),
  on: (event, handler) => (event === "session_start" ? (started = handler) : undefined),
} as never);
const ctx = {
  mode: "rpc",
  hasUI: true,
  ui: { notify: (text: string) => notified.push(text), setStatus: (key: string, text?: string) => (statuses[key] = text) },
  sessionManager: { getSessionId: () => "s" },
};
console.log("command", command!.name);
await command!.handler("nosuch", ctx);
console.log("notify", notified.at(-1)!.split("\n")[0]);
started!({ type: "session_start" }, ctx);
await new Promise((done) => setTimeout(done, 30));
console.log("status", statuses.center);
EOF
  run run_ts "$BATS_TEST_TMPDIR/wrapper.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"command center"* ]]
  [[ "$output" == *"notify center: нет команды «nosuch»"* ]]
  # Сводка уезжает в ту же статусную строку, что и у остальных расширений.
  [[ "$output" == *"status DATA "* ]]
  [[ "$output" == *"скиллов "* ]]
}

@test "обёртка opencode2: регистрирует /center и отдаёт вывод синтетическим сообщением" {
  [[ -n "$RUNTIME" ]] || skip "нет bun/node"
  cat >"$BATS_TEST_TMPDIR/plugin.ts" <<EOF
import plugin from "$PLUGIN/opencode/center.ts";
let definition: { name: string; execute: (input: unknown) => Promise<void> } | undefined;
const messages: { text: string; resume?: boolean }[] = [];
await plugin.setup({
  command: { transform: (callback: (editor: never) => void) => callback({ add: (def: never) => (definition = def) } as never) },
  session: { synthetic: async (input: { text: string; resume?: boolean }) => messages.push(input) },
} as never);
console.log("id", plugin.id, definition!.name);
await definition!.execute({ sessionID: "s", prompt: { text: "nosuch" } });
console.log("first", messages.at(-1)!.resume, messages.at(-1)!.text.split("\n")[0]);
EOF
  run run_ts "$BATS_TEST_TMPDIR/plugin.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"id command-center.plugin center"* ]]
  # resume: false — вывод показывается, но модель не зовём.
  [[ "$output" == *"first false center: нет команды «nosuch»"* ]]
}

@test "файлы станции не содержат абсолютных путей диска" {
  run bash "$CENTER/../skills-hub/contrib/check-paths.sh" "$PLUGIN" "$CENTER/contrib/install-plugins.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"check-paths: чисто"* ]]
}

@test "установка: три ссылки в каталоги клиентов, повтор — без изменений" {
  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" install
  [ "$status" -eq 0 ]
  [ -L "$FAKE/.config/opencode/plugins/center.ts" ]
  [ -L "$FAKE/.omp/agent/extensions/center.ts" ]
  [ -L "$FAKE/.pi/agent/extensions/center.ts" ]
  [ "$(readlink "$FAKE/.config/opencode/plugins/center.ts")" = "$PLUGIN/opencode/center.ts" ]
  [ "$(readlink "$FAKE/.omp/agent/extensions/center.ts")" = "$PLUGIN/agent/center.ts" ]
  [ "$(readlink "$FAKE/.pi/agent/extensions/center.ts")" = "$PLUGIN/agent/center.ts" ]

  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" install
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже ведёт сюда"* ]]
  [[ "$output" != *"кладу"* ]]
}

@test "установка: чужой файл на месте ссылки уезжает в .bak" {
  printf 'export default { id: "someone-else", setup: async () => {} };\n' >"$FAKE/.omp/agent/extensions/center.ts"
  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" install
  [ "$status" -eq 0 ]
  [ -f "$FAKE/.omp/agent/extensions/center.ts.bak" ]
  grep -q "someone-else" "$FAKE/.omp/agent/extensions/center.ts.bak"
  [ -L "$FAKE/.omp/agent/extensions/center.ts" ]
}

@test "снятие: убирает только свои ссылки, .bak оставляет" {
  # На месте двух клиентских файлов — чужие файлы: установка уводит их в .bak.
  printf 'old omp extension\n' >"$FAKE/.omp/agent/extensions/center.ts"
  printf 'old pi extension\n' >"$FAKE/.pi/agent/extensions/center.ts"
  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" install
  [ "$status" -eq 0 ]
  [ -f "$FAKE/.omp/agent/extensions/center.ts.bak" ]
  # Чужую ссылку не трогаем даже при снятии.
  ln -sfn /dev/null "$FAKE/.pi/agent/extensions/other.ts"
  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" uninstall
  [ "$status" -eq 0 ]
  [ ! -e "$FAKE/.config/opencode/plugins/center.ts" ]
  [ ! -L "$FAKE/.omp/agent/extensions/center.ts" ]
  [ ! -L "$FAKE/.pi/agent/extensions/center.ts" ]
  [ -L "$FAKE/.pi/agent/extensions/other.ts" ]
  [ -f "$FAKE/.omp/agent/extensions/center.ts.bak" ]
  grep -q "old omp extension" "$FAKE/.omp/agent/extensions/center.ts.bak"
}

@test "статус: видит ссылки и молчит про чужие" {
  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" install
  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok       opencode"* ]]
  [[ "$output" == *"ok       omp"* ]]
  [[ "$output" == *"ok       pi"* ]]
  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" uninstall
  run env HOME="$FAKE" XDG_CONFIG_HOME= bash "$INSTALL" status
  [[ "$output" == *"нет:     omp"* ]]
}

# Ждём СОБЫТИЕ, а не время: ответ rpc крупный (200–270 КБ) и под нагрузкой приходит не целиком —
# один выстрел с timeout 60 ловил обрыв раньше строки «center», grep не находил её и тест падал
# на пустом счёте, хотя расширение стояло. Опрос с коротким темпом и общим дедлайном; в конце —
# что видели (байты ответа), а не молчаливый ноль.
rpc_sees() {
  local client="$1" type="$2" needle="$3"
  local deadline=$((SECONDS + 90)) out="" bytes=0
  while ((SECONDS < deadline)); do
    out=$(timeout 60 bash -c "printf '%s\n' '{\"type\":\"$type\"}' | $client --mode rpc --no-session 2>/dev/null" || true)
    bytes=${#out}
    grep -qF "$needle" <<<"$out" && return 0
    sleep 0.5
  done
  echo "$client: за дедлайн не увидел «$needle» (последний ответ $bytes байт, клиент отвечал, но без этой строки)" >&2
  return 1
}

@test "живой клиент: расширение появляется в списке команд клиента" {
  # Подхват проверяем их же списком команд — тем, что клиент печатает в rpc-режиме.
  local ready=0
  if command -v pi >/dev/null 2>&1 && [ -L "$HOME/.pi/agent/extensions/center.ts" ]; then
    run rpc_sees pi get_commands '"name":"center"'
    [ "$status" -eq 0 ]
    ready=1
  fi
  if command -v omp >/dev/null 2>&1 && [ -L "$HOME/.omp/agent/extensions/center.ts" ]; then
    run rpc_sees omp get_state '"name":"center"'
    [ "$status" -eq 0 ]
    ready=1
  fi
  [ "$ready" -eq 1 ] || skip "клиенты не стоят на этой машине"
}
