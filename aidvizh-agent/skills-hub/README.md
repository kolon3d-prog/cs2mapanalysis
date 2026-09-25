# skills-hub

Единый вход в маркеты агентских скиллов: поиск, просмотр, установка.
Роутер `skills-manager.sh` + автономные адаптеры в `markets/`.

## Зависимости

bash, curl, jq, node/npx. Для `--source github` — GitHub CLI 2.90+ с логином (`gh auth status`). Для тестов — `bats` (`dnf install bats`).

На Windows те же команды есть нативно в PowerShell 7 (`skills-manager.ps1`): там нужны node/npx, `gh` для `--source github` и bash (Git Bash или WSL) — только для `--source clawhub`, MCP-сервера и bash-движка. Подробности — в таблице «что где работает» ниже.

## Установка

Из каталога проекта:

    ./contrib/install-links.sh          # оба симлинка, идемпотентно, есть --dry-run
    ln -sfn "$PWD/skills-manager.sh" ~/.local/bin/skills-manager   # то же руками, если нужно
    ln -sfn "$PWD" ~/.agents/skills/skills-ops

Первый симлинк даёт команду `skills-manager`, второй регистрирует скилл `skills-ops` для агента.
Папка переехала — пересоздать оба из нового каталога.

В pwsh то же самое, плюс проверка и снятие:

    pwsh -File contrib/install-links.ps1 status   # что с обеими ссылками
    pwsh -File contrib/install-links.ps1          # создать: symlink, без прав — junction, дальше копия
    pwsh -File contrib/install-links.ps1 remove   # снять (чужое не трогает)

## Команды

    skills-manager search <query>   [--source NAME|all] [--limit N] [--owner O] [--json]
    skills-manager inspect <pkg>    [--source NAME|auto] [--full]
    skills-manager install <pkg>    [--source NAME|auto] [--project]
    skills-manager check-spec      [path] [--strict] [--quiet]
    skills-manager list             [--source NAME]
    skills-manager doctor
    skills-manager sources

`--source` по умолчанию `skills-sh`. Для `search` можно `--source all` — опросит все маркеты подряд (по необходимости: медленнее, часть маркетов шумная или с rate-limit); одинаковые скиллы из разных маркетов схлопываются в одну строку.

`--source auto` — источник по форме пакета: `owner/repo@skill` идёт сначала в `skills-sh`, потом в `github`; слаг без слэша — в `clawhub`. Нужен там, где ref пришёл из индекса (`skillsmp`) и его иначе пришлось бы помнить руками.

`doctor` проверяет окружение: зависимости, оба симлинка (бинарь и скилл), пути в MCP-конфигах, `gh auth`. Начинается с него любая диагностика «команда не работает».

`check-spec` валидирует `SKILL.md` по спеке agentskills.io: обязательные `name`/`description`, `name` равен имени каталога, бюджеты тела (500 строк, 8 KB для Codex), триггер в описании, битые относительные ссылки. Без пути проверяет `~/.agents/skills`; можно ткнуть коллекцию или один скилл. Ошибки (FAIL) валят код возврата, предупреждения — нет; `--strict` валит и на них. Тот же движок гоняется по коллекции в `contrib/skills-hub-check.sh` и в git-хуке набора, а после `install` он мягко показывает несоответствия, не отменяя установку.

`list` без флагов показывает глобальные скиллы (`~/.agents/skills`) — там, куда ставит `install`. У npx-адаптеров таймаут 180с, переопределяется `SKILLS_TIMEOUT`; у HTTP-запросов к индексам — 30с (`SKILLS_HTTP_TIMEOUT`, соединение не дольше 10с).

## Маркеты

| source    | что это              | команда установки под капотом              | поиск | fetch | install | list |
|-----------|----------------------|--------------------------------------------|-------|-------|---------|------|
| skills-sh | skills.sh (Vercel)   | `npx skills add <owner/repo@skill>`        | да    | да    | да      | да   |
| github    | GitHub + gh skill    | `gh skill install <repo> <skill>`          | да    | да    | да      | да   |
| clawhub   | ClawHub (OpenClaw)   | `npx clawhub install <slug>`               | да    | да    | да      | да   |
| skillsmp  | индекс SkillsMP      | нет, только поиск                          | да    | -     | -       | -    |

`fetch` — это внутренняя команда для `inspect`: отдаёт SKILL.md в stdout, роутер печатает выжимку (meta + зависимости/права) или весь файл по `--full`.

`<pkg>` зависит от маркета: `owner/repo@skill` для skills-sh и github, слаг (`puppeteer`, `@owner/slug`, `skills-sh:owner/repo/skill`) для clawhub.

`github`-поиск идёт через GitHub code search API: квота 10 запросов/мин на аккаунт, один `gh skill search` тратит 3 запроса (варианты формулировки). При «GitHub API rate limit exceeded» подождать ~минуту — токен и scopes тут ни при чём.

## Куда ставится

- по умолчанию глобально: `~/.agents/skills` (канонический каталог агента);
- `--project`: `./.agents/skills` относительно текущего каталога;
- локи: skills-sh — `~/.agents/.skill-lock.json` или `./skills-lock.json`, clawhub — `<workdir>/.clawhub/lock.json`, github пишет файлы без своего лока (пиннинг версий через `gh skill install --pin`, флаг адаптер не пробрасывает — зови gh напрямую).

Удаление: skills-sh — `npx skills remove <skill> -g -y`, clawhub — `npx clawhub uninstall <slug> --workdir ~ --yes`, github — удалить папку вручную.

## Прямой вызов адаптеров

Каждый файл в `markets/` — самостоятельный скрипт с контрактом `search / fetch / install / list`:

    markets/skillsmp.sh search "web scraping" --limit 5
    markets/github.sh search puppeteer --json
    markets/clawhub.sh fetch puppeteer

## MCP (stdio)

Для MCP-клиентов без shell: `mcp/server.mjs` — тонкая stdio-обёртка над роутером, node без зависимостей.

Шесть тулов: `skills_search`, `skills_inspect`, `skills_list`, `skills_install` — те же команды (подтверждение установки остаётся на стороне клиента), плюс два локальных, без сети и без базы: `skills_find(query, limit?)` и `skills_show(name)` — поиск и чтение **установленных** скиллов прямо в сессии: список скиллов в контексте агента фиксируется на старте, поэтому созданный или обновлённый скилл иначе для агента невидим.

Регистрация в opencode (глобальный `opencode.json`, секция `mcp.servers`):

    "skills-hub": {
      "type": "local",
      "command": ["bash", "-lc", "exec node \"$HOME/.agents/skills/skills-ops/mcp/server.mjs\""]
    }

Любой другой stdio-клиент подключается тем же `command`. Сервер резолвит `skills-manager.sh` относительно собственного файла — PATH и симлинк `skills-manager` ему не нужны.

Установка чужого скилла идёт с полными правами агента, поэтому в клиентах стоит закрыть её подтверждением: в opencode — `"skills-hub_skills_install": "ask"` в настройках тулов, в omp — политика на имя тула `mcp__skills_hub_skills_install`:

    tools:
      approval:
        mcp__skills_hub_skills_install: prompt

## Тесты

    sudo dnf install bats ShellCheck   # fedora; на других системах пакеты bats-core и shellcheck
    bats tests/hub.bats

    pwsh -NoProfile -File tests/hub-ps1.ps1   # набор для .ps1-скриптов, bats не нужен

набор оффлайновый: `curl`, `npx` и `gh` подменены заглушками из `tests/stubs`, ответы маркетов лежат в `tests/fixtures`, `HOME` изолирован — реальные `~/.agents`, симлинки и сеть не трогаются. HTTP-ветки pwsh-версии проверяются так же оффлайн: фикстуры отдаёт `tests/market-server.mjs` (node, без зависимостей), тесты подставляют его адрес в `SKILLS_API_URL`/`SKILLSMP_API_URL`. `bats tests/hub.bats` зовёт pwsh-набор одним тестом и пропускает его, если pwsh нет — а сам `tests/hub-ps1.ps1` запускается и напрямую на Windows.

покрыто: разбор и сортировка выдачи, `--limit`, `--json`, схлопывание дублей в `skillsmp` и в `--source all`, резолв `--source auto` в обе стороны, `list -g`, установка с `--project` через skills-sh и через github, `doctor` при пустом `HOME`, MCP-сервер (handshake, список тулов, поиск, отказ на плохом source), таймаут npx, отсутствие npx в PATH, установщик для Windows (если в PATH есть `pwsh`), `shellcheck -S warning` по всем скриптам и `contrib/check-paths.sh` — сканер пользовательских абсолютных путей по хабу и по соседнему `agent-bundle` (шаблоны юнитов `@HUB@` держат это честным; имя пользователя в пути может быть параметром — `$USER`, `${USER}`, `%USERNAME%` — и такой путь ловится так же, как литеральный, а плейсхолдер вида `/home/<user>` — нет). в pwsh-наборе то же самое для `.ps1`: `help`/`sources`, поиск по HTTP-фикстурам с сортировкой и `--limit`, `--json`, пустая выдача, ранжирование SkillsMP, `--source all`, `list`/`install` через заглушки `npx`/`gh`, `--source auto` в обе стороны, неизвестный source и флаг, `doctor` на пустом и на полном доме, таймаут npx, ссылки хаба (создание, идемпотентность, `status`, `remove`, `-DryRun`), сканер путей (чистое дерево, грязное дерево, маркер `path-guard: ok`, пропуск `collection/`) и часовая проверка (хаб без движка, `-Quick`).

## Автопроверка (systemd user)

Юниты в `contrib/` лежат шаблонами (`*.in` с `@HUB@`) — абсолютных путей в репозитории нет. Ставит их скрипт:

    ./contrib/install-units.sh
    systemctl --user enable --now skills-hub-check.timer
    systemctl --user start skills-hub-check.service
    journalctl --user -u skills-hub-check -n 20

гоняется `doctor`, набор `bats tests/hub.bats` — включая shellcheck и проверку, что в скриптах хаба не завелись абсолютные пути, — спека коллекции и наборы соседних станций с диска (`sysprompt`, `mcp-station`, `cli-station`, `prompt-station`, `skills-station`, `memory-station`, `wiki-station`, `spec-station`, `pi-plugins-station`, `modes-station`, `fedora-windows-look`, `omp-zen-free`, `command-center` вместе с набором плагинов, `cleanup-station` вместе с отчётом о мусоре, `test-center`), плюс логика драйвера режимов `modes-station` (node или bun, вне bats); отсутствующий набор — честная строка «набор не найден — пропуск», а не падение. Четыре набора `camoufox-research/tests/bats/*` в прогон не входят: они поднимают браузер — их строки лежат в `command-center/check-coverage-exceptions.txt`. диск отключён — юнит пропускается по `ConditionPathExists` (это успешный пропуск, а не падение). при включённом linger (`loginctl enable-linger $USER`) проверка идёт и без логина. Если движка рядом нет (`skills-manager.sh` не найден) — прогон печатает «skills-hub не на месте: <путь>» и падает с кодом 1: сам скрипт лежит на том же диске, поэтому это сломанная установка, а не отсутствующий диск.

у той же проверки есть pwsh-двойник — `contrib/skills-hub-check.ps1`: он гоняет `skills-manager.ps1 doctor`, набор хаба (если есть `bats`), центр (`status`/`doctor`/`outdated`/`verify`) и docs-гейт через bash, а про Unix-only части (systemd-юнит, cron, POSIX-наборы соседних станций) говорит честной строкой с готовой командой `schtasks`. `-Quick` пропускает тяжёлые шаги (bats, `outdated`, `verify`, docs-гейт). Нет `skills-manager.ps1` — та же честная строка «skills-hub is not in place: <путь>» и код 1.

    pwsh -File contrib/skills-hub-check.ps1
    pwsh -File contrib/skills-hub-check.ps1 -Quick

## Windows

На Windows у хаба два пути: нативный pwsh-CLI (`skills-manager.ps1` — те же команды без bash) и прежний bash-движок (`skills-manager.sh`, он же внутри MCP-сервера). bash в PATH — **Git for Windows** (в комплекте с самим Git) либо WSL — нужен для `--source clawhub`, MCP-сервера и набора `bats`; ссылки, сканер путей и часовая проверка есть и в pwsh (`contrib/install-links.ps1`, `contrib/check-paths.ps1`, `contrib/skills-hub-check.ps1`). Установка одним скриптом:

    pwsh -File windows/install.ps1                 # Hub = каталог, откуда запущен скрипт
    pwsh -File windows/install.ps1 -Hub D:\AGGG\skills-hub -AgentHome $HOME

что делает: проверяет bash и node, создаёт `%USERPROFILE%\.agents\skills\skills-ops` (symlink, а без прав — junction), кладёт `skills-manager.cmd` в `%USERPROFILE%\.local\bin`, дописывает MCP-регистрацию в `opencode.json` и `mcp.json` и ставит гейт подтверждения на установку. повторный запуск ничего не дублирует; конфиги правит `windows/set-mcp-entry.mjs` — он делает `.bak` и не перезаписывает файл, если значения уже на месте.

MCP-регистрация та же, что на Linux (`bash -lc 'exec node "$HOME/..."'`) — под Git Bash это работает без правок. Руководству клиентов перезапуск обязателен: конфиг читается на старте.

отдельно про пути: адаптеры ищут не только `npx`/`gh`, но и `npx.cmd`/`gh.exe` — в Git Bash это спасает, когда Node и GitHub CLI отдают только Windows-обёртки. если ни одного нет, команда падает с внятным «не найден npx…», а не с ENOENT.

### Нативная PowerShell-версия

`skills-manager.ps1` — не обёртка над bash, а вторая реализация тех же команд: поиск идёт прямо в HTTP-API маркетов (`Invoke-RestMethod`), `fetch`/`install`/`list` — через `npx skills` и `gh skill`, разбор `SKILL.md`, ранжирование SkillsMP и схлопывание дублей в `--source all` повторены в pwsh. Одна копия всё же осталась одна: `--source clawhub` зовёт `markets/clawhub.sh` через bash — так адаптер не расходится сам с собой; без bash команда говорит одной строкой, что поставить, и не падает стеком.

    pwsh -File skills-manager.ps1 search pdf --limit 5
    pwsh -File skills-manager.ps1 inspect acme/tools@pdf --full
    pwsh -File skills-manager.ps1 install acme/tools@pdf --project
    pwsh -File skills-manager.ps1 list
    pwsh -File skills-manager.ps1 doctor
    pwsh -File skills-manager.ps1 sources

`doctor` в pwsh-версии проверяет то же, что и bash-версия: зависимости (node/npx — обязательные, gh/bash/bats — по желанию), обе ссылки хаба и пути в MCP-конфигах, и печатает `doctor: ok` либо `doctor: problems N`.

### Что где работает

Проверено на обеих сторонах: «нативно» — работает без bash; «Git Bash» — нужен bash в PATH (Git for Windows или WSL); «Unix-only» — на Windows не подделывается.

| что | Windows (pwsh 7) | Linux / macOS |
|-----|------------------|----------------|
| `search` (skills-sh, skillsmp) | нативно: HTTP-API маркетов | нативно: curl-адаптеры |
| `search --source github` | нативно: `gh skill search` | нативно: `gh skill search` |
| `search --source all` | нативно, кроме clawhub (см. ниже) | нативно |
| `search/inspect/install/list --source clawhub` | **Git Bash**: зовёт `markets/clawhub.sh` | нативно: тот же адаптер |
| `inspect` / `install` / `list` (skills-sh) | нативно: `npx skills` | нативно: `npx skills` |
| `inspect` / `install` / `list` (github) | нативно: `gh skill` | нативно: `gh skill` |
| `doctor`, `sources` | нативно | нативно |
| `contrib/install-links.ps1` / `.sh` | symlink, без прав — junction, дальше копия; есть `status` и `remove` | симлинки |
| `contrib/check-paths.ps1` / `.sh` | нативно, тот же вывод и коды возврата | нативно |
| `contrib/skills-hub-check.ps1` / `.sh` | doctor + bats + центр (`status`/`doctor`/`outdated`/`verify`) + docs-гейт; `-Quick` — без тяжёлых шагов | то же плюс systemd-юнит |
| `contrib/install-units.sh` | **Unix-only**: systemd user-юнит и таймер | нативно |
| `mcp/server.mjs` | **Git Bash**: сервер node, но команды он зовёт через bash-движок | нативно |
| `tests/hub.bats` | **Git Bash**: bats — это bash | нативно |
| `tests/hub-ps1.ps1` | нативно, bats не нужен | нативно |

Что это значит на практике:

- **на Windows без bash** работают: поиск, `inspect`, `install`, `list`, `doctor`, `sources`, ссылки и сканер путей — всё это есть в pwsh;
- **без bash не работают**: `--source clawhub`, MCP-сервер (он зовёт bash-движок) и `bats`-набор — им нужен Git for Windows или WSL;
- **Unix-only**: systemd-юнит и таймер часовой автопроверки (`contrib/install-units.sh`); на Windows ту же роль играет Task Scheduler (`schtasks /Create /SC HOURLY ... skills-hub-check.ps1`) — это печатает и сам `skills-hub-check.ps1`.

## Границы

- Скиллы исполняются с полными правами агента: перед установкой чужого скилла смотреть `inspect`.
- `skillsmp` — только индекс: из выдачи берёшь `owner/repo@skill` и ставишь через `--source skills-sh` или `--source github`.
- Не брал в адаптеры: agentskill.sh и skild (реестры лежат), LobeHub Market (требует registration/login), agent-skills-cli (интерактивный TUI), ctx7 (skills-команды deprecated), Tencent SkillHub (`curl | bash` без аудита).
- Проект живёт на сменном диске: без него ломается симлинк скилла `skills-ops`, а через него и MCP-регистрация. Что именно отвалилось — `skills-manager doctor`.

---

**AGGG [Distro] Firmware** · автор и владелец — **@hilartem** (Telegram), разработчик и CEO — AGGG-omp.
Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
Сделано для AGGG [Distro] Firmware. Запрещено распространять. Максимальная эффективность — в сообществе AGGG [Distro] Firmware и INSIDER AGGG (с чатом) или при личном общении: без знания системы и опыта это лишь референс. Полный текст — `NOTICE.md`.
