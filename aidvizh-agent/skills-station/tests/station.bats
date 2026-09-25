#!/usr/bin/env bats
# Тесты станции скиллов: коллекция → слои (глобальный, проектный, клиентский, свой путь).
# Коллекция и дом подменяются на временные — реальные скиллы не трогаются.
# Запуск: bats tests/station.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export SKILLS_STATION_HOME="$BATS_TEST_TMPDIR/home"
  export SKILLS_STATION_COLLECTION="$BATS_TEST_TMPDIR/collection"
  unset XDG_CONFIG_HOME
  mkdir -p "$SKILLS_STATION_HOME" "$SKILLS_STATION_COLLECTION"

  for name in alpha beta; do
    mkdir -p "$SKILLS_STATION_COLLECTION/$name"
    printf -- '---\nname: %s\ndescription: тестовый скилл %s\n---\n\nтело\n' "$name" "$name" >"$SKILLS_STATION_COLLECTION/$name/SKILL.md"
    mkdir -p "$SKILLS_STATION_COLLECTION/$name/extra"
    printf 'helper\n' >"$SKILLS_STATION_COLLECTION/$name/extra/helper.md"
  done
  printf '[{"name":"alpha","source":"acme/skills"},{"name":"beta","source":"acme/skills"}]\n' >"$SKILLS_STATION_COLLECTION/catalog.json"
  cd "$BATS_TEST_TMPDIR"
}

@test "list показывает коллекцию с источниками" {
  run bash "$STATION/bin/skills-station.sh" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"alpha"* ]]
  [[ "$output" == *"acme/skills"* ]]
  [[ "$output" == *"тестовый скилл"* ]]
}

@test "install --layer global ставит ссылками в ~/.agents/skills" {
  run bash "$STATION/bin/skills-station.sh" install all
  [ "$status" -eq 0 ]
  [ -L "$SKILLS_STATION_HOME/.agents/skills/alpha" ]
  [ -e "$SKILLS_STATION_HOME/.agents/skills/alpha/SKILL.md" ]
  [ "$(physical "$SKILLS_STATION_HOME/.agents/skills/beta/SKILL.md")" = "$(physical "$SKILLS_STATION_COLLECTION/beta/SKILL.md")" ]
}

@test "install --mode copy кладёт независимую копию" {
  run bash "$STATION/bin/skills-station.sh" install alpha --mode copy
  [ "$status" -eq 0 ]
  [ ! -L "$SKILLS_STATION_HOME/.agents/skills/alpha" ]
  [ -f "$SKILLS_STATION_HOME/.agents/skills/alpha/extra/helper.md" ]

  run bash "$STATION/bin/skills-station.sh" install alpha --mode copy
  [[ "$output" == *"копия совпадает"* ]]
}

@test "install --layer project кладёт в проект, --dir — по своему пути" {
  run bash "$STATION/bin/skills-station.sh" install alpha --layer project
  [ "$status" -eq 0 ]
  [ -L "$BATS_TEST_TMPDIR/.agents/skills/alpha" ]

  run bash "$STATION/bin/skills-station.sh" install beta --dir "$BATS_TEST_TMPDIR/свой/путь"
  [ "$status" -eq 0 ]
  [ -L "$BATS_TEST_TMPDIR/свой/путь/beta" ]
}

@test "install --layer opencode и --layer claude уважают свои каталоги" {
  run bash "$STATION/bin/skills-station.sh" install alpha --layer opencode
  [ "$status" -eq 0 ]
  [ -L "$SKILLS_STATION_HOME/.config/opencode/skills/alpha" ]

  run bash "$STATION/bin/skills-station.sh" install beta --layer claude
  [ "$status" -eq 0 ]
  [ -L "$SKILLS_STATION_HOME/.claude/skills/beta" ]
}

@test "повторная установка идемпотентна, чужое не заменяется без --force" {
  bash "$STATION/bin/skills-station.sh" install alpha >/dev/null
  run bash "$STATION/bin/skills-station.sh" install alpha
  [[ "$output" == *"уже стоит"* ]]

  rm -rf "$SKILLS_STATION_HOME/.agents/skills/alpha"
  mkdir -p "$SKILLS_STATION_HOME/.agents/skills/alpha"
  printf -- '---\nname: alpha\ndescription: чужое\n---\n' >"$SKILLS_STATION_HOME/.agents/skills/alpha/SKILL.md"
  run bash "$STATION/bin/skills-station.sh" install alpha
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен --force"* ]]
  run cat "$SKILLS_STATION_HOME/.agents/skills/alpha/SKILL.md"
  [[ "$output" == *"чужое"* ]]

  run bash "$STATION/bin/skills-station.sh" install alpha --force
  [ "$status" -eq 0 ]
  [ -d "$SKILLS_STATION_HOME/.agents/skills/alpha.bak" ]
  run diff -q "$SKILLS_STATION_COLLECTION/alpha/SKILL.md" "$SKILLS_STATION_HOME/.agents/skills/alpha/SKILL.md"
  [ "$status" -eq 0 ]
}

@test "чужой symlink не заменяется без --force, а с force остаётся в backup" {
  mkdir -p "$SKILLS_STATION_HOME/.agents/skills" "$BATS_TEST_TMPDIR/other"
  ln -s "$BATS_TEST_TMPDIR/other" "$SKILLS_STATION_HOME/.agents/skills/alpha"

  run bash "$STATION/bin/skills-station.sh" install alpha
  [ "$status" -eq 1 ]
  [[ "$output" == *"нужен --force"* ]]
  [ -L "$SKILLS_STATION_HOME/.agents/skills/alpha" ]

  run bash "$STATION/bin/skills-station.sh" install alpha --force
  [ "$status" -eq 0 ]
  [ -L "$SKILLS_STATION_HOME/.agents/skills/alpha.bak" ]
  [ -L "$SKILLS_STATION_HOME/.agents/skills/alpha" ]
}

@test "status считает стоящее в слое и битые ссылки" {
  bash "$STATION/bin/skills-station.sh" install all >/dev/null
  run bash "$STATION/bin/skills-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"стоит из коллекции: 2"* ]]
  [[ "$output" == *"битых ссылок: 0"* ]]

  rm -rf "$SKILLS_STATION_COLLECTION/beta"
  run bash "$STATION/bin/skills-station.sh" status
  [ "$status" -eq 1 ]
  [[ "$output" == *"битых ссылок: 1"* ]]
}

@test "remove снимает из слоя, dry-run ничего не трогает" {
  bash "$STATION/bin/skills-station.sh" install all >/dev/null
  run bash "$STATION/bin/skills-station.sh" remove alpha --dry-run
  [[ "$output" == *"dry-run"* ]]
  [ -e "$SKILLS_STATION_HOME/.agents/skills/alpha" ]

  run bash "$STATION/bin/skills-station.sh" remove alpha
  [ "$status" -eq 0 ]
  [ ! -e "$SKILLS_STATION_HOME/.agents/skills/alpha" ]
  [ -e "$SKILLS_STATION_HOME/.agents/skills/beta" ]
}

# --- лок записи в слой: тот же файл-лок, что у хаба ---
# Хаб держит записи маркетов в ~/.agents/.skill-lock.json (при --project — <проект>/skills-lock.json).
# Станция берёт тот же путь, но сам JSON не трогает: рядом лежит её файл-владелец.
hub_lock() { printf '%s\n' "$SKILLS_STATION_HOME/.agents/.skill-lock.json"; }

@test "две записи подряд: лок снят, ссылки целы, лок хаба не переписан" {
  mkdir -p "$SKILLS_STATION_HOME/.agents"
  printf '{"version":3,"skills":{"bats-testing-patterns":{"source":"acme/skills"}}}\n' >"$(hub_lock)"
  local before
  before="$(md5sum <"$(hub_lock)")"

  run bash "$STATION/bin/skills-station.sh" install all
  [ "$status" -eq 0 ]
  run bash "$STATION/bin/skills-station.sh" install all
  [ "$status" -eq 0 ]
  [[ "$output" == *"уже стоит"* ]]

  [ -L "$SKILLS_STATION_HOME/.agents/skills/alpha" ]
  [ "$(physical "$SKILLS_STATION_HOME/.agents/skills/beta/SKILL.md")" = "$(physical "$SKILLS_STATION_COLLECTION/beta/SKILL.md")" ]
  run bash "$STATION/bin/skills-station.sh" status
  [ "$status" -eq 0 ]
  [[ "$output" == *"битых ссылок: 0"* ]]

  [ ! -e "$(hub_lock).lock" ]
  [ "$(md5sum <"$(hub_lock)")" = "$before" ]

  # проектный слой — свой лок хаба (skills-lock.json), и он тоже снимается
  run bash "$STATION/bin/skills-station.sh" install alpha --layer project
  [ "$status" -eq 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/skills-lock.json.lock" ]
}

@test "занятый лок слоя: станция не пишет поверх и говорит, кто держит" {
  mkdir -p "$SKILLS_STATION_HOME/.agents"
  printf '{"pid":%s,"started":"%s"}\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$(hub_lock).lock"

  run env SKILLS_STATION_LOCK_WAIT_MS=300 bash "$STATION/bin/skills-station.sh" install all
  [ "$status" -eq 1 ]
  [[ "$output" == *"слой занят"* ]]
  [[ "$output" == *"pid $$"* ]]
  [ ! -e "$SKILLS_STATION_HOME/.agents/skills/alpha" ]
}

@test "протухший лок (мёртвый pid) снимается, и запись проходит" {
  mkdir -p "$SKILLS_STATION_HOME/.agents"
  printf '{"pid":999999,"started":"2020-01-01T00:00:00Z"}\n' >"$(hub_lock).lock"

  run bash "$STATION/bin/skills-station.sh" install alpha
  [ "$status" -eq 0 ]
  [[ "$output" == *"лок слоя протух"* ]]
  [ -L "$SKILLS_STATION_HOME/.agents/skills/alpha" ]
  [ ! -e "$(hub_lock).lock" ]
}

@test "verify ловит скилл без описания" {
  run bash "$STATION/bin/skills-station.sh" verify
  [ "$status" -eq 0 ]

  printf -- '---\nname: beta\n---\n' >"$SKILLS_STATION_COLLECTION/beta/SKILL.md"
  run bash "$STATION/bin/skills-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет description"* ]]
}

@test "скилл ссылкой на свой репозиторий: list, verify, link и copy" {
  local name=gamma
  mkdir -p "$BATS_TEST_TMPDIR/репо"
  printf -- '---\nname: %s\ndescription: скилл ссылкой\n---\n\nтело\n' "$name" >"$BATS_TEST_TMPDIR/репо/$name.md"
  mkdir -p "$SKILLS_STATION_COLLECTION/$name"
  ln -s "$BATS_TEST_TMPDIR/репо/$name.md" "$SKILLS_STATION_COLLECTION/$name/SKILL.md"
  printf '[{"name":"alpha","source":"acme/skills"},{"name":"beta","source":"acme/skills"},{"name":"%s","source":"своё: репо/скиллы"}]\n' \
    "$name" >"$SKILLS_STATION_COLLECTION/catalog.json"

  run bash "$STATION/bin/skills-station.sh" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"$name"* ]]
  [[ "$output" == *"своё: репо/скиллы"* ]]

  run bash "$STATION/bin/skills-station.sh" verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"3 скиллов"* ]]

  run bash "$STATION/bin/skills-station.sh" install "$name" --dir "$BATS_TEST_TMPDIR/слой"
  [ "$status" -eq 0 ]
  [ -L "$BATS_TEST_TMPDIR/слой/$name" ]
  run diff -q "$BATS_TEST_TMPDIR/репо/$name.md" "$BATS_TEST_TMPDIR/слой/$name/SKILL.md"
  [ "$status" -eq 0 ]

  run bash "$STATION/bin/skills-station.sh" install "$name" --dir "$BATS_TEST_TMPDIR/копия" --mode copy
  [ "$status" -eq 0 ]
  [ ! -L "$BATS_TEST_TMPDIR/копия/$name/SKILL.md" ]
  run diff -q "$BATS_TEST_TMPDIR/репо/$name.md" "$BATS_TEST_TMPDIR/копия/$name/SKILL.md"
  [ "$status" -eq 0 ]

  # копия независима от источника: репозиторий пропал, а копия читается
  rm "$BATS_TEST_TMPDIR/репо/$name.md"
  [ -s "$BATS_TEST_TMPDIR/копия/$name/SKILL.md" ]
  run diff -q "$BATS_TEST_TMPDIR/репо/$name.md" "$BATS_TEST_TMPDIR/копия/$name/SKILL.md"
  [ "$status" -ne 0 ]
}

@test "verify ловит битую ссылку на SKILL.md в коллекции" {
  printf -- '---\nname: delta\ndescription: тестовый скилл delta\n---\n\nтело\n' >"$BATS_TEST_TMPDIR/дельта.md"
  mkdir -p "$SKILLS_STATION_COLLECTION/delta"
  ln -s "$BATS_TEST_TMPDIR/дельта.md" "$SKILLS_STATION_COLLECTION/delta/SKILL.md"

  run bash "$STATION/bin/skills-station.sh" verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"3 скиллов"* ]]

  rm "$BATS_TEST_TMPDIR/дельта.md"
  run bash "$STATION/bin/skills-station.sh" verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"битая ссылка"* ]]
}

@test "ошибки: нет скилла, плохой слой, плохой режим" {
  run bash "$STATION/bin/skills-station.sh" install гамма
  [ "$status" -eq 1 ]
  [[ "$output" == *"нет скилла"* ]]

  run bash "$STATION/bin/skills-station.sh" install alpha --layer луна
  [ "$status" -eq 1 ]
  [[ "$output" == *"--layer принимает"* ]]

  run bash "$STATION/bin/skills-station.sh" install alpha --mode копия
  [ "$status" -eq 1 ]
  [[ "$output" == *"--mode принимает"* ]]
}

@test "реальная коллекция цела: скиллы со ссылкой на источник" {
  run bash "$STATION/bin/skills-station.sh" verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"скиллов"* ]]
  run bash "$STATION/bin/skills-station.sh" list --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"source"'* ]]
  [[ "$output" != *'"source": "?"'* ]]
}

@test "в проекте нет абсолютных путей" {
  local checker="$STATION/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$STATION/bin" "$STATION/tests"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}

@test "windows: PowerShell-обёртка работает и -WhatIf ничего не ставит" {
  command -v pwsh >/dev/null 2>&1 || skip "pwsh не установлен"

  run env SKILLS_STATION_HOME="$SKILLS_STATION_HOME" SKILLS_STATION_COLLECTION="$SKILLS_STATION_COLLECTION" \
    pwsh -NoProfile -File "$STATION/bin/skills-station.ps1" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"alpha"* ]]

  run env SKILLS_STATION_HOME="$SKILLS_STATION_HOME" SKILLS_STATION_COLLECTION="$SKILLS_STATION_COLLECTION" \
    pwsh -NoProfile -File "$STATION/bin/skills-station.ps1" install all -WhatIf
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -e "$SKILLS_STATION_HOME/.agents/skills/alpha" ]
}

# --- поиск по установленным скиллам: слои (глобальный, проектный, клиентский, коллекция) ---

# Дом и коллекция уже подменены в setup(); добавляем скиллы, на которых видно каждый вид совпадения.
seed_search_skills() {
  mkdir -p "$SKILLS_STATION_HOME/.agents/skills/browser-skill" "$SKILLS_STATION_HOME/.agents/skills/debug-skill"
  printf -- '---\nname: browser-skill\ndescription: живой браузер для снятия страниц\n---\n\nтело браузера\n' \
    >"$SKILLS_STATION_HOME/.agents/skills/browser-skill/SKILL.md"
  # блочное описание: без разбора блока поиск по описанию слепой, а list печатает «>-»
  {
    printf -- '---\nname: debug-skill\ndescription: >-\n'
    printf '  Разбор зависшего процесса: где смотреть pid, стек и логи.\n'
    printf '  Второй строкой — что делать с зомби.\n'
    printf -- '---\n\nв теле про семафоры\n'
  } >"$SKILLS_STATION_HOME/.agents/skills/debug-skill/SKILL.md"
  mkdir -p "$BATS_TEST_TMPDIR/.agents/skills/project-skill"
  printf -- '---\nname: project-skill\ndescription: скилл проекта\n---\n\nв теле про квазар\n' \
    >"$BATS_TEST_TMPDIR/.agents/skills/project-skill/SKILL.md"
}

@test "find ищет по имени, по блочному описанию и по телу" {
  seed_search_skills

  run bash "$STATION/bin/skills-station.sh" find браузер
  [ "$status" -eq 0 ]
  [[ "$output" == *"browser-skill  [global]"* ]]

  run bash "$STATION/bin/skills-station.sh" find "зависший процесс"
  [ "$status" -eq 0 ]
  [[ "$output" == *"debug-skill"* ]]
  [[ "$output" == *"Разбор зависшего процесса"* ]]

  run bash "$STATION/bin/skills-station.sh" find квазар
  [ "$status" -eq 0 ]
  [[ "$output" == *"project-skill  [project]"* ]]
}

@test "find --json отдаёт контракт: ok, query, count, results" {
  seed_search_skills

  run bash "$STATION/bin/skills-station.sh" find "зависший процесс" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.ok' <<<"$output")" = "true" ]
  [ "$(jq -r '.query' <<<"$output")" = "зависший процесс" ]
  [ "$(jq -r '.count' <<<"$output")" = "1" ]
  [ "$(jq -r '.results[0].name' <<<"$output")" = "debug-skill" ]
  [ "$(jq -r '.results[0].layer' <<<"$output")" = "global" ]
  [ "$(jq -r '.results[0].path' <<<"$output")" = "$SKILLS_STATION_HOME/.agents/skills/debug-skill/SKILL.md" ]
  [[ "$(jq -r '.results[0].description' <<<"$output")" == "Разбор зависшего процесса"* ]]
  [ "$(jq -r '.results[0].score > 0' <<<"$output")" = "true" ]
  [[ "$(jq -r '.results[0].snippet' <<<"$output")" == *семафор* ]]
}

@test "find --limit режет выдачу, пустой запрос перечисляет установленное" {
  seed_search_skills

  run bash "$STATION/bin/skills-station.sh" find "зависший процесс" --limit 1 --json
  [ "$(jq -r '.count' <<<"$output")" = "1" ]

  run bash "$STATION/bin/skills-station.sh" find "" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.query' <<<"$output")" = "" ]
  [ "$(jq -r '.count' <<<"$output")" = "5" ]
  [ "$(jq -r '.results[].name' <<<"$output" | grep -c '^alpha$')" = "1" ]
  [ "$(jq -r '.results[].layer' <<<"$output" | sort -u | tr '\n' ' ')" = "collection global project " ]
}

@test "find: пустая выдача даёт ближайшие имена, а не молчание" {
  seed_search_skills

  run bash "$STATION/bin/skills-station.sh" find "зюбра фыва"
  [ "$status" -eq 1 ]
  [[ "$output" == *"совпадений нет"* ]]
  [[ "$output" == *"ближайшие имена"* ]]

  run bash "$STATION/bin/skills-station.sh" find "зюбра фыва" --json
  [ "$status" -eq 1 ]
  [ "$(jq -r '.count' <<<"$output")" = "0" ]
  [ "$(jq -r '.results | length' <<<"$output")" = "0" ]
  [ "$(jq -r '.suggestions | length > 0' <<<"$output")" = "true" ]

  # опечатка/обрывок имени ведёт к самому скиллу, а не к пустоте
  run bash "$STATION/bin/skills-station.sh" find brauser --json
  [ "$status" -eq 1 ]
  [ "$(jq -r '.suggestions[0].name' <<<"$output")" = "browser-skill" ]
}

@test "find не двоит скилл, видимый и в слое, и в коллекции" {
  bash "$STATION/bin/skills-station.sh" install alpha >/dev/null

  run bash "$STATION/bin/skills-station.sh" find alpha --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.count' <<<"$output")" = "1" ]
  [ "$(jq -r '.results[0].layer' <<<"$output")" = "global" ]
}

@test "show печатает имя, слой, путь, описание и первые строки тела" {
  seed_search_skills

  run bash "$STATION/bin/skills-station.sh" show debug-skill
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "debug-skill [global]"* ]]
  [[ "$output" == *"путь: $SKILLS_STATION_HOME/.agents/skills/debug-skill/SKILL.md"* ]]
  [[ "$output" == *"Разбор зависшего процесса"* ]]
  [[ "$output" == *"в теле про семафоры"* ]]

  # однозначная часть имени тоже годится
  run bash "$STATION/bin/skills-station.sh" show browser
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "browser-skill [global]"* ]]

  run bash "$STATION/bin/skills-station.sh" show нет-такого
  [ "$status" -eq 1 ]
  [[ "$output" == *"похожие"* ]]
}

@test "list показывает первую строку блочного описания, а не маркер блока" {
  # оба вида блока: >- (свёрнутый) и | (литеральный)
  mkdir -p "$SKILLS_STATION_COLLECTION/folded" "$SKILLS_STATION_COLLECTION/piped"
  {
    printf -- '---\nname: folded\ndescription: >-\n'
    printf '  Первая строка свёрнутого описания.\n'
    printf '  Вторая строка уходит дальше.\n'
    printf -- '---\n\nтело\n'
  } >"$SKILLS_STATION_COLLECTION/folded/SKILL.md"
  {
    printf -- '---\nname: piped\ndescription: |\n'
    printf '  Первая строка литерального описания.\n'
    printf '  Вторая строка тоже есть.\n'
    printf -- '---\n\nтело\n'
  } >"$SKILLS_STATION_COLLECTION/piped/SKILL.md"

  run bash "$STATION/bin/skills-station.sh" list
  [ "$status" -eq 0 ]
  [[ "$output" != *">-"* ]]
  [[ "$output" == *"Первая строка свёрнутого описания."* ]]
  [[ "$output" == *"Первая строка литерального описания."* ]]

  # и та же первая строка видна в поиске по описанию, а не маркер блока
  run bash "$STATION/bin/skills-station.sh" find "вторая строка" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.results[].name' <<<"$output" | sort | tr '\n' ' ')" = "folded piped " ]
  [ "$(jq -r '.results[0].description' <<<"$output" | cut -c1-12)" = "Первая строк" ]
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
