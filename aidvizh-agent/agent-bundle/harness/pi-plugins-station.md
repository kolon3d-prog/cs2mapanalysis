# pi-plugins-station

Станция сторонних плагинов `pi`: каталог проверенных npm-пакетов, которые ставятся штатной командой
`pi install`. Своего установщика нет — станция читает состояние pi и отдаёт установку, обновление и
снятие самому pi.

## Что где лежит

- `catalog.json` — 13 плагинов: имя, источник `npm:<пакет>`, короткое описание (снято с npm-карточек);
- состояние держит **pi**, и станция его не копирует:
  - `~/.pi/agent/settings.json`, поле `packages` — объявленные источники;
  - `~/.pi/agent/npm/node_modules/<имя>` — файлы пакетов;
- «стоит» = объявлен **и** файлы на месте. «Объявлен, файлов нет» — отдельное состояние, `pi list` его
  не показывает.

Агент-каталог берётся из `$PI_PLUGINS_STATION_AGENT`, иначе `$PI_AGENT_DIR`, иначе `$PI_CODING_AGENT_DIR`,
иначе `~/.pi/agent`.

## Команды

    "$S"/bin/pi-plugins-station.sh list                       каталог и что стоит
    "$S"/bin/pi-plugins-station.sh status [--json]            стоит / объявлен без файлов / нет + чужое
    "$S"/bin/pi-plugins-station.sh install [имена…|all] [--dry-run]
    "$S"/bin/pi-plugins-station.sh update  [имена…|all] [--dry-run]
    "$S"/bin/pi-plugins-station.sh remove  [имена…|all] [--dry-run]
    "$S"/bin/pi-plugins-station.sh outdated [--json]          версии против npm
    "$S"/bin/pi-plugins-station.sh verify [--json]            целостность каталога и состояния

Windows — `pwsh -File bin/pi-plugins-station.ps1 install all`; `-WhatIf` = `--dry-run`.

`center bootstrap` зовёт `install all` после спек-режима; `center update` — `update all`; `center outdated`
читает `outdated --json` (формат как у `mcp-station`: `summary` с `current`/`behind`/`unknown`/`missing`,
код 0; `unknown` — npm не ответил, это не «свежо»).

## Почему нет pi-opencode-free

Делает то же, что наш `../omp-zen-free` — открывает бесплатные модели OpenCode в pi. Он не патчит `fetch`,
но поднимает свой провайдер и ставит свои заголовки клиента, а наш патч работает на уровне `fetch` и видит
запросы любого провайдера к `opencode.ai`, поэтому переписал бы его `User-Agent`. Два механизма на одном
шлюзе — лишний риск без выигрыша. Нужен безключевой путь — ставится вручную, станция его не навязывает.

## Проверка

    bin/pi-plugins-station.sh verify     # каталог: name, source npm:, what, без дублей; settings.json читается
    bin/pi-plugins-station.sh status     # что стоит, что объявлено без файлов, что лишнее
    bats tests/station.bats              # 16 тестов

тесты подменяют `pi` и `npm` заглушками и агент-каталог — ни сети, ни настоящих установок.

## Грабли

- **Плагины читаются на старте сессии** — после установки нужен новый сеанс pi.
- **Проектный слой отдельный**: `pi install -l` пишет в `.pi/settings.json` проекта; станция ставит только
  в пользовательский слой.
- **Обновление станции ≠ обновление плагинов**: каталог правится руками, версии двигает `update`.
- **Падение `pi` видно по коду**: `install`/`update`/`remove` возвращают 1, если `pi` не отработал, и
  печатают число провалов.
