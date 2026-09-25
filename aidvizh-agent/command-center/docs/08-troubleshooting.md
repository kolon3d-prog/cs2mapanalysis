# Грабли и лечение

- **Диск переехал / папка переименована** (`DATA/11` → `DATA/AGGG`): молча ломаются симлинки и MCP-регистрации.
  Симптом — `skills-manager` не найден, тесты падают. Лечение: `center doctor`, затем
  `skills-hub/contrib/install-links.sh` и `center run mcp-station install` (путь в конфигах держим через `$HOME`).
- **Установка на чистой машине упала на `fresh`**:
  - `npm error code EACCES` на `/usr/local/lib/node_modules` — Fedora-пакет держит глобальный префикс npm
    под root. Станция проверяет префикс и сама ставит с `npm_config_prefix=~/.local`; если ставил вручную —
    `npm config set prefix "$HOME/.local"`, и `~/.local/bin` должен быть в PATH.
  - `mcp-station` просил ключ (`EXA_API_KEY` и т.п.) при установке — больше не просит: без ключа opencode
    получает `{env:VAR}`, после `keys.sh import` повтори `mcp-station install`.
  - `prereqs` ругался на `pwsh` — на linux/macOS он не нужен и установку не блокирует (обёртки Windows).
- **Windows: `bash` в PATH — заглушка WSL.** На чистой Windows `bash.exe` из `…\WindowsApps\` печатает
  «поставь дистрибутив» и выходит с нулём, поэтому «bash есть» и «сервер ответил» оказываются ложью:
  `center outdated` пишет «сверка не удалась» с этим текстом, `mcp-station check` — «в PATH нет bash»,
  `verify` — `no-handshake` за 70 мс вместо живой проверки. Лечение в наборе уже есть, и оно такое:
  команды проектов на Windows зовутся своими `.ps1-обёртками` (у каждого `.sh` есть сосед), а если шаг
  без пары (systemd-таймер, Linux-only станция) — он честно пропускается строкой. Настоящий bash нужен
  только шагам без Windows-формы, и тогда он ищется по абсолютному пути (Git for Windows:
  `C:\Program Files\Git\bin\bash.exe`) и проверяется ответом `GNU bash`; заглушка не принимается.
  Задать свой bash можно `AGGG_BASH` (центр — ещё и `CENTER_BASH`). Если `pwsh` (7) нет, обёртки
  запускаются встроенным `powershell.exe` — они написаны под 5.1.
- **Windows: в конфиг клиента попала Unix-форма записи MCP** (например её написал установщик проекта):
  `mcp-station status` показывает её как `foreign`, `verify` — `spawn-failed`. Наша запись в Unix-форме
  (`bash -lc …`) на Windows узнаётся как своя и переписывается нативным `argvWindows` при
  `mcp-station install`/`update`; чужая (со своим абсолютным путём) не трогается без имени.
- **«MCP не отвечает» — как понять, что именно сломалось**: `center doctor` говорит только «запись в
  конфиге есть», а работает ли соединение — показывает `center verify`. Разбор по состояниям сервера:
  - `spawn-failed` — сервер не поднялся: нет записи в конфиге этого клиента (ставит `mcp-station install`),
    нет команды (`npx`/`node` не в PATH) или нет ключа (`mcp-station/bin/keys.sh list`, затем повторный
    `mcp-station install`); что видит станция — `center run mcp-station check`;
  - `no-handshake` — процесс запустился, но по протоколу не ответил: сервер печатает в stdout что-то
    своё (логи, баннер) и мешает JSON-RPC; проверь его запуск вручную, как он записан в конфиге;
  - `timeout` — не успел за `--timeout` (по умолчанию 20 с): тяжёлые серверы (`playwright`,
    `chrome-devtools`, `stealth-browser`, `camoufox`) поднимают браузер. Дай больше времени
    (`center verify --timeout 60`) или исключи их (`--exclude playwright,chrome-devtools`);
  - `http-error` — http-сервер ответил ошибкой: обычно ключ или заголовок (`401`/`403`), у opencode
    заголовок собирается при установке — переустанови сервер после `keys.sh import`.
  Харнесса нет (`omp — НЕТ` в выводе `verify`) — ставь клиентов: `center run cli-station install`.
  Проверка спавнит настоящие серверы: если нужен быстрый прогон — `center verify wiki basic-memory`
  или `--exclude` тяжёлых.
- **`403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`** в omp/pi: шлюз
  OpenCode Go/Zen не пускает чужие харнессы. Расширение `omp-zen-free` повторяет заголовками то, что
  делает апстримный PR (issue #12306): `omp-zen-free/install.sh` (или `install.ps1`), затем новая сессия.
  Проверка: `ZEN_HEADERS_DEBUG=1 omp -p 'привет' --model opencode-go/deepseek-flash` и строка в
  `<tmpdir>/zen-free-tier-headers.log`. Если пришло `401 CreditsError`/`402 Insufficient funds` — это
  баланс аккаунта, а не гейт: нужен другой ключ.
- **Ссылка вместо копии**: в Git Bash `ln -s` может создать копию — используй PowerShell-обёртки станций
  (`*-station.ps1`) или `MSYS=winsymlinks:nativestrict`.
- **Расширение не грузится после симлинка**: относительные импорты в расширении разъезжаются. Наши
  расширения самодостаточные (`prompt-station/shared/persona.ts`), путь к данным считают через `realpathSync`.
- **`jq` может оказаться не jq**: в оболочке агента команда `jq` иногда подменена встроенной реализацией
  (`jaq`), а скрипты зовут системный `/usr/bin/jq` — поведение `scan`/regex различается. Правишь адаптеры —
  гоняй набор тестов, а не только интерактивную команду.
- **Поиск виснет**: у npx-адаптеров таймаут 180 с (`SKILLS_TIMEOUT`), у HTTP-запросов — 30 с (`SKILLS_HTTP_TIMEOUT`).
- **Хочешь с нуля**: `cleanup-station clean-all --yes`, дальше `center bootstrap` по шагам.
- **«Что устарело?» / «Обнови меня»**: `center outdated` зовёт объявленные сверки проектов, `center update`
  — их команды обновления. Если по проекту видно `unknown`, значит сверки у него нет (в `detail` — одна
  строка почему): устаревание без машинной сверки не угадывают, а честно помечают. Машинная сверка сегодня
  есть у `mcp-station` и `pi-plugins-station` (`outdated --json`).
- **`update` не тронул проект, а написал «в плане только показана»**: команда не объявила флаг
  «ничего не менять» — центр не зовёт её всерьёз в режиме `--dry-run`. Убери `--dry-run`, и она выполнится;
  или добавь флаг в саму команду проекта (`--dry-run` / `-WhatIf`), и центр подхватит его в плане.
- **`update` упал после обновления**: код возврата — это ещё и приговор `doctor`, который центр прогоняет
  после настоящего обновления. Смотри строки `FAIL` в выводе: чаще всего установщик увёл симлинк или не
  переписал MCP-регистрацию.
- **Не помнишь, что где**: `center links`, `center docs 00-map`, README соответствующего проекта.
- **Откуда взялась версия набора**: `center version` (состав и ритуал) и `docs/09-release.md`; `VERSION`
  правится руками по релизу, автоинкремента нет.
