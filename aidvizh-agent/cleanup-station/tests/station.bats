#!/usr/bin/env bats
# Тесты центра сноса: план, навыки по слоям, прошивки, расширения, MCP, CLI, отказы и защита.
# Домашний каталог подменяется (CLEANUP_HOME), данные на диске не трогаются.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export DISK="$(cd "$STATION/.." && pwd)"
  export CLEANUP_HOME="$BATS_TEST_TMPDIR/home"
  export STUB_LOG="$BATS_TEST_TMPDIR/stub.log"
  unset PI_CODING_AGENT_DIR XDG_CONFIG_HOME XDG_STATE_HOME
  : >"$STUB_LOG"
  mkdir -p "$CLEANUP_HOME" "$BATS_TEST_TMPDIR/bin"
  for tool in npm bun; do
    cat >"$BATS_TEST_TMPDIR/bin/$tool" <<EOS
#!/usr/bin/env bash
printf '%s %s\n' "$tool" "\$*" >>"\$STUB_LOG"
exit 0
EOS
    chmod +x "$BATS_TEST_TMPDIR/bin/$tool"
  done
  cd "$BATS_TEST_TMPDIR"
}

@test "plan перечисляет шаги сноса и не трогает диск" {
  run node "$STATION/bin/cleanup.mjs" plan
  [ "$status" -eq 0 ]
  [[ "$output" == *"cli:"* ]]
  [[ "$output" == *"skills:"* ]]
  [[ "$output" == *"mcp:"* ]]
  [[ "$output" == *"не трогаем"* ]]
}

@test "clean-skills: снимает наши ссылки, чужое (копии и ссылки мимо диска) оставляет" {
  mkdir -p "$CLEANUP_HOME/.agents/skills/мой-личный" "$CLEANUP_HOME/.claude/skills/keep" "$BATS_TEST_TMPDIR/чужое-репо"
  ln -sfn "$DISK/skills-station/collection/skill-creator" "$CLEANUP_HOME/.agents/skills/skill-creator"   # наше: ссылка на диск
  ln -sfn "$BATS_TEST_TMPDIR/чужое-репо" "$CLEANUP_HOME/.agents/skills/чужой-скилл"                      # чужое: ссылка мимо диска

  run node "$STATION/bin/cleanup.mjs" clean-skills --layer global --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [[ "$output" == *"снял бы"* ]]
  [ -L "$CLEANUP_HOME/.agents/skills/skill-creator" ]

  run node "$STATION/bin/cleanup.mjs" clean-skills --layer global
  [ "$status" -eq 0 ]
  [ ! -L "$CLEANUP_HOME/.agents/skills/skill-creator" ]   # наша ссылка снята
  [ -d "$CLEANUP_HOME/.agents/skills/мой-личный" ]        # чужая копия цела
  [ -L "$CLEANUP_HOME/.agents/skills/чужой-скилл" ]       # чужая ссылка цела
  [[ "$output" == *"оставляю"* ]]
  [ -d "$CLEANUP_HOME/.claude/skills/keep" ]              # чужой слой не тронут
}

@test "clean-prompts: нашу прошивку снимает, чужой текст оставляет" {
  mkdir -p "$CLEANUP_HOME/.omp/agent" "$CLEANUP_HOME/.pi/agent"
  cp "$DISK/personas/duck.txt" "$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md"
  printf 'мои личные правила, не из персон\n' >"$CLEANUP_HOME/.pi/agent/APPEND_SYSTEM.md"

  run node "$STATION/bin/cleanup.mjs" clean-prompts
  [ "$status" -eq 0 ]
  [[ "$output" == *"прошивка «duck»"* ]]
  [[ "$output" == *"оставляю"* ]]
  [ ! -s "$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md" ]
  [ "$(cat "$CLEANUP_HOME/.pi/agent/APPEND_SYSTEM.md")" = "мои личные правила, не из персон" ]
}

@test "clean-prompts: при .bak рядом прошивку не трогает и говорит «реши руками»" {
  mkdir -p "$CLEANUP_HOME/.omp/agent" "$CLEANUP_HOME/.pi/agent"
  cp "$DISK/personas/duck.txt" "$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md"
  printf 'мои прежние правила\n' >"$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md.bak"
  cp "$DISK/personas/duck.txt" "$CLEANUP_HOME/.pi/agent/APPEND_SYSTEM.md"   # тут .bak нет — снимаем как раньше

  run node "$STATION/bin/cleanup.mjs" clean-prompts
  [ "$status" -eq 0 ]                                                       # не ошибка
  [[ "$output" == *"реши руками"* ]]
  [[ "$output" == *"оставляю $CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md"* ]]
  [ -s "$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md" ]                        # файл на месте
  [ "$(cat "$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md")" = "$(cat "$DISK/personas/duck.txt")" ]  # и не затёрт
  [ "$(cat "$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md.bak")" = "мои прежние правила" ]            # .bak цел
  [ ! -s "$CLEANUP_HOME/.pi/agent/APPEND_SYSTEM.md" ]                       # без .bak — очищено, как раньше

  # dry-run тоже не обещает снятие: говорит ровно то же «реши руками» и ничего не пишет
  cp "$DISK/personas/duck.txt" "$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md"
  run node "$STATION/bin/cleanup.mjs" clean-prompts --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"реши руками"* ]]
  [[ "$output" != *"снял бы"* ]]
  [ -s "$CLEANUP_HOME/.omp/agent/APPEND_SYSTEM.md" ]
}

@test "clean-mcp: снимает серверы из каталога, чужие записи оставляет" {
  mkdir -p "$CLEANUP_HOME/.omp/agent"
  printf '{"mcpServers":{"exa":{"url":"https://example"},"tavily":{"command":"npx"},"my-private":{"command":"mytool"}},"other":1}\n' >"$CLEANUP_HOME/.omp/agent/mcp.json"

  run node "$STATION/bin/cleanup.mjs" clean-mcp --dry-run
  [ "$(jq -r '.mcpServers | length' "$CLEANUP_HOME/.omp/agent/mcp.json")" = "3" ]

  run node "$STATION/bin/cleanup.mjs" clean-mcp
  [ "$status" -eq 0 ]
  [ "$(jq -r '.mcpServers | keys | join(",")' "$CLEANUP_HOME/.omp/agent/mcp.json")" = "my-private" ]  # наши сняты, чужой цел
  [ "$(jq -r '.other' "$CLEANUP_HOME/.omp/agent/mcp.json")" = "1" ]      # чужие ключи целы
  [ -f "$CLEANUP_HOME/.omp/agent/mcp.json.bak" ]
}

@test "clean-mcp: без каталога mcp-station не угадывает, что наше, и не трогает конфиг" {
  mkdir -p "$CLEANUP_HOME/.omp/agent"
  printf '{"mcpServers":{"exa":{"url":"https://example"}}}\n' >"$CLEANUP_HOME/.omp/agent/mcp.json"

  # каталога нет вовсе — честный отказ, конфиг не трогаем
  run env CLEANUP_MCP_CATALOG="$BATS_TEST_TMPDIR/нет-такого" node "$STATION/bin/cleanup.mjs" clean-mcp
  [ "$status" -eq 0 ]
  [[ "$output" == *"отказ"* ]]
  [ "$(jq -r '.mcpServers | length' "$CLEANUP_HOME/.omp/agent/mcp.json")" = "1" ]

  # каталог есть, но пуст: сервер в нём неизвестен — тоже не наше
  mkdir -p "$BATS_TEST_TMPDIR/пусто"
  run env CLEANUP_MCP_CATALOG="$BATS_TEST_TMPDIR/пусто" node "$STATION/bin/cleanup.mjs" clean-mcp
  [ "$status" -eq 0 ]
  [[ "$output" == *"наших нет"* ]]
  [ "$(jq -r '.mcpServers | length' "$CLEANUP_HOME/.omp/agent/mcp.json")" = "1" ]
}

@test "clean-extensions снимает только ссылки на диск" {
  mkdir -p "$CLEANUP_HOME/.pi/agent/extensions" "$CLEANUP_HOME/.local/bin" "$BATS_TEST_TMPDIR/чужое"
  ln -sfn "$DISK/prompt-station/shared/persona.ts" "$CLEANUP_HOME/.pi/agent/extensions/persona.ts"
  ln -sfn "$BATS_TEST_TMPDIR/чужое" "$CLEANUP_HOME/.pi/agent/extensions/чужое"
  ln -sfn "$DISK/skills-hub/skills-manager.sh" "$CLEANUP_HOME/.local/bin/skills-manager"

  run node "$STATION/bin/cleanup.mjs" clean-extensions
  [ "$status" -eq 0 ]
  [ ! -e "$CLEANUP_HOME/.pi/agent/extensions/persona.ts" ]
  [ -L "$CLEANUP_HOME/.pi/agent/extensions/чужое" ]
  [ ! -e "$CLEANUP_HOME/.local/bin/skills-manager" ]
}

@test "clean-cli зовёт пакетные менеджеры и уважает dry-run" {
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" node "$STATION/bin/cleanup.mjs" clean-cli --dry-run
  [ ! -s "$STUB_LOG" ]

  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" node "$STATION/bin/cleanup.mjs" clean-cli
  [ "$status" -eq 0 ]
  grep -q "npm uninstall -g @earendil-works/pi-coding-agent --ignore-scripts" "$STUB_LOG"
  grep -q "bun uninstall -g @oh-my-pi/pi-coding-agent" "$STUB_LOG"
  grep -q "npm uninstall -g @opencode/cli" "$STUB_LOG"
}

@test "clean-all без --yes работает как dry-run" {
  mkdir -p "$CLEANUP_HOME/.agents/skills/x"
  run node "$STATION/bin/cleanup.mjs" clean-all
  [[ "$output" == *"реальное выполнение — с --yes"* ]]
  [ -d "$CLEANUP_HOME/.agents/skills/x" ]
}

@test "отказ работать вне домашнего каталога" {
  run node "$STATION/bin/cleanup.mjs" clean-skills --home / --layer global
  [ "$status" -eq 0 ]
  [[ "$output" == *"отказ"* ]]
}

@test "clean-shims и clean-locks снимают шимы и локи, чужие файлы не трогают" {
  mkdir -p "$CLEANUP_HOME/.local/bin" "$CLEANUP_HOME/.agents"
  printf '#!/bin/sh\n' >"$CLEANUP_HOME/.local/bin/mcp-keypool"
  printf '#!/bin/sh\n' >"$CLEANUP_HOME/.local/bin/чужой-инструмент"
  printf '{"skills":{}}\n' >"$CLEANUP_HOME/.agents/.skill-lock.json"

  run node "$STATION/bin/cleanup.mjs" clean-shims --dry-run
  [ -f "$CLEANUP_HOME/.local/bin/mcp-keypool" ]

  run node "$STATION/bin/cleanup.mjs" clean-shims
  run node "$STATION/bin/cleanup.mjs" clean-locks
  [ "$status" -eq 0 ]
  [ ! -e "$CLEANUP_HOME/.local/bin/mcp-keypool" ]
  [ -f "$CLEANUP_HOME/.local/bin/чужой-инструмент" ]
  [ ! -e "$CLEANUP_HOME/.agents/.skill-lock.json" ]
}

@test "clean-units снимает юниты автопроверки, сторожа и бэкапа вместе с обёрткой" {
  local units="$CLEANUP_HOME/.config/systemd/user" state="$CLEANUP_HOME/.local/state/center"
  mkdir -p "$units/timers.target.wants" "$state/backups" "$CLEANUP_HOME/.config/center"
  for unit in skills-hub-check center-sentinel center-backup; do
    printf '[Unit]\n' >"$units/$unit.service"
    printf '[Timer]\n' >"$units/$unit.timer"
    ln -s "../$unit.timer" "$units/timers.target.wants/$unit.timer"
  done
  printf '#!/usr/bin/env bash\n' >"$state/center-local.sh"
  printf '%s\n' "$state/backups" >"$CLEANUP_HOME/.config/center/backup.target"
  # systemctl подменяем: снос обязан таймеры ВЫКЛЮЧИТЬ, а не только убрать файлы
  cat >"$BATS_TEST_TMPDIR/bin/systemctl" <<EOS
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >>"\$STUB_LOG"
exit 0
EOS
  chmod +x "$BATS_TEST_TMPDIR/bin/systemctl"
  PATH="$BATS_TEST_TMPDIR/bin:$PATH"

  run node "$STATION/bin/cleanup.mjs" clean-units
  [ "$status" -eq 0 ]
  [ ! -e "$units/skills-hub-check.service" ]
  [ ! -e "$units/skills-hub-check.timer" ]
  [ ! -e "$units/center-sentinel.timer" ]
  [ ! -e "$units/center-backup.service" ]
  [ ! -e "$units/timers.target.wants/center-backup.timer" ]
  [ ! -e "$state/center-local.sh" ]
  [[ "$(cat "$STUB_LOG")" == *"disable center-sentinel.timer"* ]]
  [[ "$(cat "$STUB_LOG")" == *"disable center-backup.timer"* ]]
  # данные не наши: цель бэкапа и архивы остаются
  [ -f "$CLEANUP_HOME/.config/center/backup.target" ]
  [ -d "$state/backups" ]
}

@test "состояние и логины снимаются только с --state/--purge" {
  mkdir -p "$CLEANUP_HOME/.omp/agent" "$CLEANUP_HOME/.pi/agent"
  printf 'x' >"$CLEANUP_HOME/.omp/agent/agent.db"
  printf '{}' >"$CLEANUP_HOME/.pi/agent/auth.json"

  run node "$STATION/bin/cleanup.mjs" clean-all --dry-run
  [[ "$output" != *"состояние агента"* ]]
  [[ "$output" != *"логины/секреты"* ]]

  run node "$STATION/bin/cleanup.mjs" clean-all --deep --dry-run
  [[ "$output" == *"состояние агента"* ]]
  [[ "$output" == *"логины/секреты"* ]]
  [ -f "$CLEANUP_HOME/.omp/agent/agent.db" ]

  run node "$STATION/bin/cleanup.mjs" clean-state
  [ "$status" -eq 0 ]
  [ ! -e "$CLEANUP_HOME/.omp/agent/agent.db" ]
  [ -f "$CLEANUP_HOME/.pi/agent/auth.json" ]
}

@test "clean-configs: dry-run сохраняет, без --yes отказывает, с --yes сносит" {
  mkdir -p "$CLEANUP_HOME/.omp/agent" "$CLEANUP_HOME/.pi/agent" "$CLEANUP_HOME/.config/opencode"
  printf 'models: {}\n' >"$CLEANUP_HOME/.omp/agent/config.yml"
  printf '{}\n' >"$CLEANUP_HOME/.pi/agent/settings.json"
  printf '{}\n' >"$CLEANUP_HOME/.config/opencode/opencode.json"

  run node "$STATION/bin/cleanup.mjs" clean-configs --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"будут снесены конфиги клиентов целиком"* ]]
  [ -f "$CLEANUP_HOME/.omp/agent/config.yml" ]

  run node "$STATION/bin/cleanup.mjs" clean-configs
  [ "$status" -eq 1 ]
  [[ "$output" == *"запусти с --yes"* ]]
  [ -f "$CLEANUP_HOME/.pi/agent/settings.json" ]

  run node "$STATION/bin/cleanup.mjs" clean-configs --yes
  [ "$status" -eq 0 ]
  [ ! -e "$CLEANUP_HOME/.omp/agent/config.yml" ]
  [ ! -e "$CLEANUP_HOME/.pi/agent/settings.json" ]
  [ ! -e "$CLEANUP_HOME/.config/opencode/opencode.json" ]
}

@test "в центре сноса нет абсолютных путей" {
  local checker="$DISK/skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$STATION"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "windows: PowerShell-обёртка и -WhatIf" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  run pwsh -NoProfile -File "$STATION/bin/cleanup.ps1" plan
  [ "$status" -eq 0 ]
  [[ "$output" == *"cli:"* ]]

  mkdir -p "$CLEANUP_HOME/.agents/skills/y"
  run env CLEANUP_HOME="$CLEANUP_HOME" pwsh -NoProfile -File "$STATION/bin/cleanup.ps1" clean-skills -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ -d "$CLEANUP_HOME/.agents/skills/y" ]
}
