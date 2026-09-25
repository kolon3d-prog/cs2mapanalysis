# aidvizh agent — установка

Версия 5.5.0 от 2026-09-24 · набор станций для агента: клиенты (omp / pi / opencode2),
MCP-серверы, память, скиллы, персоны, проверки — всё одной командой, с чистой установкой
и без секретов внутри архива.

**Пароль к архиву** публикуется в канале: https://t.me/aidvizh_hub

## Требования

- **node 20+** — движок станций; если нет, установщик попробует поставить сам (dnf/apt/brew; на Windows — winget);
- **7-Zip** — только чтобы распаковать архив: содержимое закрыто AES-256, и `unzip`/`Expand-Archive` его **не откроют**
  (Linux — `p7zip` или `p7zip-full`, macOS — `brew install sevenzip`, Windows — `winget install 7zip.7zip`);
- `bun` и `uv` — установщик доберёт сам (curl-установщики), root не нужен;
- `git`, `gh`, `jq` — нужны хабу скиллов и адаптерам; установщик попробует поставить сам, иначе перечислит недостающее и остановится;
- **Windows**: нужен PowerShell 7 (`pwsh`) — установщик поставит его через winget, если нет; встроенного 5.1 не хватает;
- `bats`, `shellcheck` — только тесты и линт, установку не блокируют;
- Linux / macOS / Windows (Git Bash не обязателен).

## Установка

Архив закрыт AES-256: `unzip` и `Expand-Archive` его не откроют — нужен 7-Zip (см. «Требования»).

Linux / macOS:

    7z x -p'<пароль из канала>' aidvizh-agent-<версия>-<дата>.zip
    cd aidvizh-agent
    ./install.sh

Windows — PowerShell (7-Zip поставлен через winget):

    & "$env:ProgramFiles\7-Zip\7z.exe" x -p"<пароль из канала>" aidvizh-agent-<версия>-<дата>.zip
    cd aidvizh-agent
    pwsh -File install.ps1                  # -Update / -Reset — те же режимы

Сверка архива (sha256 публикуется вместе со ссылкой — в посте/канале):

    sha256sum aidvizh-agent-<версия>-<дата>.zip     # macOS: shasum -a 256

скрипт проверит предпосылки, и дальше режим зависит от того, что уже есть на машине:

    ./install.sh            # первая установка; на занятой машине — ставит рядом, ничего не снося
    ./install.sh --update   # обновить установленное, ничего не снося
    ./install.sh --reset    # снять наше и поставить заново; чужое не трогается

На чистой машине это `center fresh --yes`: установка по шагам — агенты, симлинки хаба, скиллы, MCP,
персона, `/prompt`, автопроверка. Снос (`--reset`) снимает **только наше**: скиллы — ссылки на диск,
MCP-серверы из каталога станции; личные скиллы, свои MCP-записи и конфиги клиентов остаются на месте.

Установщик сам добирает недостающие инструменты и сам ставит станции, которых центр не ставит
(память, вики, stealth, camoufox), а в конце делает живую проверку: ждите строку `дом жив · N c`.
Если что-то не поднялось — скрипт не врёт «готово», а печатает список провалов и выходит с кодом 1.
Чужие MCP-записи (ваши собственные, не из каталога набора) провалами не считаются: набор отвечает за своё.

## После установки

Руками остаётся то, что нельзя положить в архив:

1. **логины провайдеров** — `omp`, `pi` и `opencode2` спрашивают при первом запуске;
2. **ключи сервисов и серверы с ключами** — установщик регистрирует MCP-серверы **без ключей** (`tier=core`, 8 штук: basic-memory, camoufox, chrome-devtools, inspo, playwright, skills-hub, stealth-browser, wiki). Серверы с ключами ставятся отдельно:

       mcp-station/bin/keys.sh import                        # строки VAR=значение со stdin
       mcp-station/bin/mcp-station.sh install --profile keyed

   что попадает в ключевые: exa, firecrawl, jev, lazyweb, serper, tavily. bare `mcp-station install`
   их не поставит намеренно (без ключа бесполезны), а повторный прогон после импорта досыплет значения;
3. **перезапуск клиентов** — `opencode2 service restart`, новый сеанс omp/pi.

## English (quick)

Requirements: node 20+, 7-Zip (the archive is AES-256: plain `unzip`/`Expand-Archive` will not open it),
PowerShell 7 on Windows. Install: unpack with `7z x -p'<password>' aidvizh-agent-<version>-<date>.zip`,
then `cd aidvizh-agent && ./install.sh` (Windows: `pwsh -File install.ps1`). On a busy machine the set
installs beside your setup and removes nothing. Expect the line `дом жив` in ~10–15 minutes on a fast link.
8 of 14 MCP servers need no keys. Support and updates: @hilartem, https://t.me/aidvizh_hub

## Авторство и сообщество

**AGGG [Distro] Firmware** · автор и владелец — **@hilartem** (Telegram), разработчик и CEO — AGGG-omp.
Сообщества: https://t.me/addlist/5mU_0C6bqxY4MDky · https://t.me/aidvizh_hub · https://t.me/aidvizh_lab · https://t.me/aidvizhenie · https://t.me/dvizhforum

Сделано для AGGG [Distro] Firmware. **Запрещено распространять.** Максимальная эффективность — в сообществе
AGGG [Distro] Firmware и INSIDER AGGG (с чатом) или при личном общении: не зная систему и не имея опыта,
вы видите лишь референс и не более. Полный текст — `NOTICE.md` рядом с этим README.

## Что дальше

    command-center/bin/center.sh status     состояние всех проектов
    command-center/bin/center.sh doctor     связи и регистрации
    command-center/bin/center.sh docs       документация системы (docs/ внутри центра)
    command-center/bin/center.sh check      сквозная проверка: все наборы тестов

Обновление — новым архивом: распаковать поверх и запустить `./install.sh --update` (ничего не сносит).
Поставить начисто из архива — `./install.sh --reset`.
