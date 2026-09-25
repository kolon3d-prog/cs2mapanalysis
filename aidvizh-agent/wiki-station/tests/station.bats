#!/usr/bin/env bats
# Тесты центра вики: подменяются HOME, реестр вики и команда basic-memory.
# Настоящая вика и реальные конфиги не трогаются.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export WIKI_STATION_HOME="$BATS_TEST_TMPDIR/home"
  export WIKI_STATION_REGISTRY="$BATS_TEST_TMPDIR/wikis.json"
  export WIKI_STATION_ROOT="$BATS_TEST_TMPDIR"
  export WIKI_ROOT="$BATS_TEST_TMPDIR/wiki/Wiki Test"
  mkdir -p "$WIKI_STATION_HOME/.config/opencode" "$WIKI_ROOT/_templates" "$WIKI_ROOT/ai" "$WIKI_ROOT/tools"

  printf '# Index — каталог Wiki\n\n| Пост | Тема | Теги | Дата | Папка |\n|------|------|------|------|-------|\n' >"$WIKI_ROOT/index.md"
  printf '# Log — журнал изменений Wiki\n' >"$WIKI_ROOT/log.md"
  cat >"$WIKI_ROOT/_templates/post.md" <<'EOS'
---
type: Post
title: Заголовок
---
EOS
  cat >"$WIKI_ROOT/ai/good-post.md" <<'EOS'
---
type: Post
title: Хороший пост
description: Про память агента
date: 2026-09-20
tags: [ai, agents, memory]
---
# Хороший пост

Текст про память и агентов.
EOS
  cat >"$WIKI_ROOT/tools/bad-post.md" <<'EOS'
# Без frontmatter

Просто текст про инструменты.
EOS
  printf '| [Хороший пост](ai/good-post.md) | Про память агента | ai, agents, memory | 2026-09-20 | ai/ |\n' >>"$WIKI_ROOT/index.md"
  mkdir -p "$WIKI_ROOT/db-tools"
  cp "$STATION/templates/db-tools/"*.py "$WIKI_ROOT/db-tools/"

  cat >"$WIKI_STATION_REGISTRY" <<EOS
{ "wikis": [ { "name": "Wiki Test", "path": "wiki/Wiki Test", "project": "wiki-test", "created": "2026-09-20" } ] }
EOS

  # заглушка basic-memory: помнит проекты в файле, reindex — успех
  export STUB_STATE="$BATS_TEST_TMPDIR/bm-projects"
  printf '' >"$STUB_STATE"
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  cat >"$BATS_TEST_TMPDIR/bin/basic-memory" <<'EOS'
#!/usr/bin/env bash
# заглушка basic-memory: хранит проекты строками "имя|путь" и отдаёт их в форме настоящего сервера
state="${STUB_STATE:?}"
if [[ "$1 $2" == "tool list-projects" ]]; then
  printf '{"projects":['
  first=1
  while IFS='|' read -r name path; do
    [[ -z "$name" ]] && continue
    [[ $first -eq 1 ]] || printf ','
    printf '{"name":"%s","local_path":"%s"}' "$name" "$path"
    first=0
  done <"$state"
  printf ']}\n'
  exit 0
fi
if [[ "$1 $2" == "project add" ]]; then printf '%s|%s\n' "$3" "$4" >>"$state"; exit 0; fi
if [[ "$1" == "reindex" ]]; then exit 0; fi
exit 1
EOS
  chmod +x "$BATS_TEST_TMPDIR/bin/basic-memory"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  cd "$BATS_TEST_TMPDIR"
}

@test "list показывает вики, посты и темы" {
  run bash "$STATION/bin/wiki-station.sh" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"Wiki Test"* ]]
  [[ "$output" == *"постов: 2"* ]]
  [[ "$output" == *"ai, tools"* ]]
}

@test "search: без базы работает grep-режимом" {
  run bash "$STATION/bin/wiki-station.sh" search "память"
  [ "$status" -eq 0 ]
  [[ "$output" == *"good-post.md"* ]]
}

@test "search: с базой ищет по описанию и тегам" {
  command -v python3 >/dev/null || skip "нет python3"
  run bash "$STATION/bin/wiki-station.sh" build
  [ "$status" -eq 0 ]
  [ -f "$WIKI_ROOT/db/wiki.db" ]
  run bash "$STATION/bin/wiki-station.sh" search "memory" --tags=ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"Хороший пост"* ]]
}

@test "lint ловит пост без frontmatter и отсутствие в индексе" {
  run bash "$STATION/bin/wiki-station.sh" lint
  [ "$status" -eq 0 ]
  [[ "$output" == *"tools/bad-post.md: нет обязательных полей"* ]]
  [[ "$output" == *"tools/bad-post.md: нет строки в index.md"* ]]
  [[ "$output" != *"ai/good-post.md: нет строки"* ]]
}

@test "index пересобирает каталог из frontmatter" {
  run bash "$STATION/bin/wiki-station.sh" index
  [ "$status" -eq 0 ]
  [[ "$output" == *"2 записей"* ]]
  run grep -c "^| \[" "$WIKI_ROOT/index.md"
  [ "$output" = "2" ]
  run grep -c "Хороший пост" "$WIKI_ROOT/index.md"
  [ "$output" = "1" ]
  run grep -c "index.md" "$WIKI_ROOT/log.md"
  [ "$output" = "1" ]
  # повторный прогон без изменений: файл и журнал не трогаются, дубль в log.md не растёт
  run bash "$STATION/bin/wiki-station.sh" index
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже актуален"* ]]
  run grep -c "index.md" "$WIKI_ROOT/log.md"
  [ "$output" = "1" ]
}

@test "index и lint: свёрнутый скаляр не обрывается, дрейф строки виден" {
  cat >"$WIKI_ROOT/ai/folded.md" <<'EOS'
---
type: Post
title: Свёрнутый скаляр
description: Первая строка описания, которая продолжается
  второй строкой и третьей строкой до самого конца.
date: 2026-09-21
tags: [ai, agents]
---
# Свёрнутый скаляр

Текст про свёрнутые скаляры.
EOS
  run bash "$STATION/bin/wiki-station.sh" index
  [ "$status" -eq 0 ]
  run grep "ai/folded.md" "$WIKI_ROOT/index.md"
  [[ "$output" == *"Первая строка описания, которая продолжается второй строкой и третьей строкой до самого конца."* ]]

  run bash "$STATION/bin/wiki-station.sh" lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"разошёлся"* ]]
  [[ "$output" != *"ai/folded.md"* ]]

  # правка строки каталога руками — lint называет расхождение
  sed -i 's/третьей строкой до самого конца/обрыв/' "$WIKI_ROOT/index.md"
  run bash "$STATION/bin/wiki-station.sh" lint
  [ "$status" -eq 0 ]
  [[ "$output" == *"ai/folded.md: index.md разошёлся с постом по «description»"* ]]
}

@test "check: без mcp-проекта ругается, install его заводит" {
  run bash "$STATION/bin/wiki-station.sh" check
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет mcp-проекта wiki-test"* ]]

  run bash "$STATION/bin/wiki-station.sh" install
  [ "$status" -eq 0 ]
  [[ "$output" == *"индекс собран"* ]]
  run bash "$STATION/bin/wiki-station.sh" check
  [ "$status" -eq 0 ]

  # Windows без Developer Mode: каталоги скилла и станции нельзя связать symlink-ом.
  rm -rf "$WIKI_STATION_HOME/.agents/skills/wiki" \
         "$WIKI_STATION_HOME/.config/opencode/skills/wiki" \
         "$WIKI_STATION_HOME/.agents/wiki-station"
  cat >"$BATS_TEST_TMPDIR/deny-wiki-symlink.cjs" <<'EOF'
const fs = require("node:fs");
fs.symlinkSync = function () {
  const error = new Error("simulated directory symlink privilege error");
  error.code = "EPERM";
  throw error;
};
require("node:module").syncBuiltinESMExports();
EOF
  run env NODE_OPTIONS="--require=$BATS_TEST_TMPDIR/deny-wiki-symlink.cjs" \
    bash "$STATION/bin/wiki-station.sh" install
  [ "$status" -eq 0 ]
  [ -d "$WIKI_STATION_HOME/.agents/skills/wiki" ]
  [ ! -L "$WIKI_STATION_HOME/.agents/skills/wiki" ]
  [ -d "$WIKI_STATION_HOME/.config/opencode/skills/wiki" ]
  [ ! -L "$WIKI_STATION_HOME/.config/opencode/skills/wiki" ]
  [ -d "$WIKI_STATION_HOME/.agents/wiki-station" ]
  [ ! -L "$WIKI_STATION_HOME/.agents/wiki-station" ]
  [[ "$output" == *"копия"* ]]
}

@test "new без --path заводит вику в канонном месте станции" {
  run bash "$STATION/bin/wiki-station.sh" new "Wiki Canon"
  [ "$status" -eq 0 ]
  [ -d "$BATS_TEST_TMPDIR/wiki-station/wiki/Wiki Canon" ]
  [ -f "$BATS_TEST_TMPDIR/wiki-station/wiki/Wiki Canon/index.md" ]
}

@test "new заводит вику по конвенциям и пишет в реестр" {
  run bash "$STATION/bin/wiki-station.sh" new "Wiki Second" --path=wiki/Wiki\ Second
  [ "$status" -eq 0 ]
  [ -f "$BATS_TEST_TMPDIR/wiki/Wiki Second/index.md" ]
  [ -f "$BATS_TEST_TMPDIR/wiki/Wiki Second/log.md" ]
  [ -f "$BATS_TEST_TMPDIR/wiki/Wiki Second/_templates/post.md" ]
  [ -f "$BATS_TEST_TMPDIR/wiki/Wiki Second/db-tools/build.py" ]
  run jq -r '.wikis[1].project' "$WIKI_STATION_REGISTRY"
  [ "$output" = "wiki-second" ]
}

@test "MCP wiki_add_post не выпускает topic за пределы вики" {
  local request="$BATS_TEST_TMPDIR/escape.jsonl"
  cat >"$request" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wiki_add_post","arguments":{"title":"Escape","description":"Проверка границы","tags":"ai, security","body":"Текст","topic":"../outside","slug":"escape"}}}
EOF
  run bash -c 'node "$1" < "$2"' _ "$STATION/mcp/server.mjs" "$request"
  [ "$status" -eq 0 ]
  [[ "$output" == *"запрещён абсолютный путь"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/wiki/outside/escape.md" ]

  cat >"$request" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wiki_add_post","arguments":{"title":"Absolute","description":"Проверка абсолютного пути","tags":"ai, security","body":"Текст","topic":"/tmp/aggg-wiki-escape","slug":"absolute"}}}
EOF
  run bash -c 'node "$1" < "$2"' _ "$STATION/mcp/server.mjs" "$request"
  [ "$status" -eq 0 ]
  [[ "$output" == *"абсолютный путь"* ]]
  [ ! -e "/tmp/aggg-wiki-escape/absolute.md" ]
}

@test "в станции нет абсолютных путей к диску" {
  run bash -c "grep -rnE '/(home|run/media)/' \"$STATION/bin\" \"$STATION/skills\" 2>/dev/null | wc -l"
  [ "$output" -eq 0 ]
}
