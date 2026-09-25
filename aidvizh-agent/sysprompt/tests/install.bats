#!/usr/bin/env bats
# Тесты установщиков sysprompt: bash-версия (linux/mac/MSYS) и PowerShell (любая ОС с pwsh).
# HOME/XDG изолируются, реальные конфиги клиентов не трогаются.
# Запуск: bats tests/install.bats

setup() {
  PROJECT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export PROJECT
  export HOME="$BATS_TEST_TMPDIR/home"
  export XDG_CONFIG_HOME="$HOME/.config"
  mkdir -p "$HOME"
  unset MSYSTEM PI_CODING_AGENT_DIR SYSPROMPT_ALLOW_MSYS
  cd "$BATS_TEST_TMPDIR"
}

@test "bash: симлинки в plugins, commands, skills и extensions" {
  run sh "$PROJECT/install.sh" opencode-dev
  [ "$status" -eq 0 ]
  [ -L "$XDG_CONFIG_HOME/opencode/plugins/sysprompt.ts" ]
  [ -L "$XDG_CONFIG_HOME/opencode/commands/prompt.md" ]
  [ -L "$HOME/.agents/skills/sysprompt" ]
  [ "$(physical "$XDG_CONFIG_HOME/opencode/plugins/sysprompt.ts")" = "$(physical "$PROJECT/opencode/dev/plugin/sysprompt.ts")" ]

  run sh "$PROJECT/install.sh" omp
  [ "$status" -eq 0 ]
  [ -L "$HOME/.omp/agent/extensions/sysprompt.ts" ]
  [ "$(physical "$HOME/.omp/agent/extensions/sysprompt.ts")" = "$(physical "$PROJECT/omp/dev/extension/sysprompt.ts")" ]
}

@test "bash: pi получает расширение в свой agent dir" {
  run sh "$PROJECT/install.sh" pi
  [ "$status" -eq 0 ]
  [ -L "$HOME/.pi/agent/extensions/sysprompt.ts" ]
  [ "$(physical "$HOME/.pi/agent/extensions/sysprompt.ts")" = "$(physical "$PROJECT/pi/dev/extension/sysprompt.ts")" ]
}

@test "bash: all ставит во все три клиента" {
  run sh "$PROJECT/install.sh" all
  [ "$status" -eq 0 ]
  [ -L "$HOME/.pi/agent/extensions/sysprompt.ts" ]
  [ -L "$HOME/.omp/agent/extensions/sysprompt.ts" ]
  [ -L "$XDG_CONFIG_HOME/opencode/plugins/sysprompt.ts" ]
}

@test "адаптеры трёх клиентов реализуют один контракт /prompt своими средствами" {
  # omp и pi: команда + хук перед запросом к провайдеру
  run grep -c 'registerCommand("prompt"' "$PROJECT/omp/dev/extension/sysprompt.ts"
  [ "$output" = "1" ]
  run grep -c 'registerCommand("prompt"' "$PROJECT/pi/dev/extension/sysprompt.ts"
  [ "$output" = "1" ]
  run grep -c 'before_provider_request' "$PROJECT/pi/dev/extension/sysprompt.ts"
  [ "$output" = "1" ]
  # opencode: команда разворачивается маркером, плагин режет обёртку и правит prompt
  run grep -c 'sysprompt>\$ARGUMENTS' "$PROJECT/opencode/dev/command/prompt.md"
  [ "$output" = "1" ]
  run grep -c 'context.session.hook("prompt"' "$PROJECT/opencode/dev/plugin/sysprompt.ts"
  [ "$output" = "1" ]
}

@test "omp и pi: близнецы расходятся только строкой импорта (сторож дрейфа)" {
  # Разрешено ровно одно расхождение на файл — первая строка, импорт типа ExtensionAPI:
  #   omp: import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
  #   pi:  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  # Пакеты клиентов разные, всё остальное обязано совпадать: сравниваем нормализованные копии,
  # из которых строки импорта выброшены. Разъехались больше — падаем с diff'ом.
  local omp="$PROJECT/omp/dev/extension/sysprompt.ts"
  local pi="$PROJECT/pi/dev/extension/sysprompt.ts"
  for file in "$omp" "$pi"; do
    run grep -c '^import ' "$file"
    [ "$output" = "1" ]
  done
  grep -v '^import ' "$omp" >"$BATS_TEST_TMPDIR/omp.norm"
  grep -v '^import ' "$pi" >"$BATS_TEST_TMPDIR/pi.norm"
  run diff -u "$BATS_TEST_TMPDIR/omp.norm" "$BATS_TEST_TMPDIR/pi.norm"
  if [ "$status" -ne 0 ]; then
    printf 'близнецы разъехались (сравнение без строк импорта):\n%s\n' "$output" >&3
  fi
  [ "$status" -eq 0 ]
}

@test "pi-расширение реально инжектит текст в системный канал (bun, без модели)" {
  command -v bun >/dev/null 2>&1 || skip "bun не установлен"
  cat >"$BATS_TEST_TMPDIR/probe.ts" <<'TS'
import sysprompt from "PROJECT_PATH/pi/dev/extension/sysprompt.ts";

let handler: any;
let event: any;
const api = {
  registerCommand: (_name: string, options: any) => { handler = options.handler; },
  on: (_name: string, h: any) => { event = h; const off: any = () => {}; return off; },
};
(sysprompt as any)(api);

const notifications: string[] = [];
const ctx = {
  sessionManager: { getSessionId: () => "s1" },
  ui: { notify: (text: string) => notifications.push(text) },
};

await handler("", ctx);
await handler("MARKER_FROM_PROMPT", ctx);
const payload = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] };
const out: any = await event({ payload }, ctx);

const roles = out.messages.map((m: any) => m.role).join(",");
const injected = out.messages.some((m: any) => m.role === "system" && String(m.content).includes("MARKER_FROM_PROMPT"));
console.log(`roles=${roles} injected=${injected} hint=${notifications.some((n) => n.includes("текст пустой"))}`);
TS
  sed -i "s|PROJECT_PATH|$PROJECT|" "$BATS_TEST_TMPDIR/probe.ts"
  run bun "$BATS_TEST_TMPDIR/probe.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"roles=system,system,user"* ]]
  [[ "$output" == *"injected=true"* ]]
  [[ "$output" == *"hint=true"* ]]
}

@test "bash: на MSYS отказывается и отправляет в install.ps1" {
  run env MSYSTEM=MINGW64 sh "$PROJECT/install.sh" omp
  [ "$status" -eq 1 ]
  [[ "$output" == *"install.ps1"* ]]
  [ ! -e "$HOME/.omp/agent/extensions/sysprompt.ts" ]
}

@test "bash: на MSYS с SYSPROMPT_ALLOW_MSYS=1 ставит (осознанные копии)" {
  run env MSYSTEM=MINGW64 SYSPROMPT_ALLOW_MSYS=1 sh "$PROJECT/install.sh" omp
  [ "$status" -eq 0 ]
  [ -e "$HOME/.omp/agent/extensions/sysprompt.ts" ]
}

@test "pwsh: install.ps1 ставит связи в оба клиента и идемпотентен" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"
  local home="$BATS_TEST_TMPDIR/winhome"
  mkdir -p "$home"

  run pwsh -NoProfile -File "$PROJECT/install.ps1" -AgentHome "$home" -ConfigDir "$home/.config/opencode"
  [ "$status" -eq 0 ]
  [ -e "$home/.config/opencode/plugins/sysprompt.ts" ]
  [ -e "$home/.config/opencode/commands/prompt.md" ]
  [ -e "$home/.agents/skills/sysprompt/SKILL.md" ]
  [ -e "$home/.omp/agent/extensions/sysprompt.ts" ]
  [ -e "$home/.pi/agent/extensions/sysprompt.ts" ]
  [ "$(physical "$home/.omp/agent/extensions/sysprompt.ts")" = "$(physical "$PROJECT/omp/dev/extension/sysprompt.ts")" ]
  [ "$(physical "$home/.pi/agent/extensions/sysprompt.ts")" = "$(physical "$PROJECT/pi/dev/extension/sysprompt.ts")" ]

  run pwsh -NoProfile -File "$PROJECT/install.ps1" -AgentHome "$home" -ConfigDir "$home/.config/opencode"
  [ "$status" -eq 0 ]
  [[ "$output" == *"already in place"* ]]
  [[ "$output" != *"(created)"* ]]

  # Контракт center bootstrap: install.ps1 omp — первый позиционный аргумент,
  # а не путь к каталогу проекта.
  local positional_home="$BATS_TEST_TMPDIR/win-positional-omp"
  mkdir -p "$positional_home"
  run pwsh -NoProfile -File "$PROJECT/install.ps1" omp \
    -AgentHome "$positional_home" -ConfigDir "$positional_home/.config/opencode"
  [ "$status" -eq 0 ]
  [ -e "$positional_home/.omp/agent/extensions/sysprompt.ts" ]
  [ ! -e "$positional_home/.pi/agent/extensions/sysprompt.ts" ]
  [ ! -e "$positional_home/.config/opencode/plugins/sysprompt.ts" ]
}

@test "pwsh: -Target pi ставит только расширение pi" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"
  local home="$BATS_TEST_TMPDIR/winpi"
  mkdir -p "$home"

  run pwsh -NoProfile -File "$PROJECT/install.ps1" -AgentHome "$home" -ConfigDir "$home/.config/opencode" -Target pi
  [ "$status" -eq 0 ]
  [ -e "$home/.pi/agent/extensions/sysprompt.ts" ]
  [ ! -e "$home/.omp/agent/extensions/sysprompt.ts" ]
  [ ! -e "$home/.config/opencode/plugins/sysprompt.ts" ]
}

@test "pwsh: -Target omp ставит только расширение" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"
  local home="$BATS_TEST_TMPDIR/wintarget"
  mkdir -p "$home"

  run pwsh -NoProfile -File "$PROJECT/install.ps1" -AgentHome "$home" -ConfigDir "$home/.config/opencode" -Target omp
  [ "$status" -eq 0 ]
  [ -e "$home/.omp/agent/extensions/sysprompt.ts" ]
  [ ! -e "$home/.config/opencode/plugins/sysprompt.ts" ]
}

@test "нет абсолютных путей в проекте" {
  local checker="$PROJECT/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$PROJECT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "pwsh: -WhatIf ничего не меняет" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"
  local home="$BATS_TEST_TMPDIR/whatif"
  mkdir -p "$home"

  run pwsh -NoProfile -File "$PROJECT/install.ps1" -AgentHome "$home" -ConfigDir "$home/.config/opencode" -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"What if:"* ]]
  [ -z "$(find "$home" -mindepth 1 -print -quit)" ]
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
