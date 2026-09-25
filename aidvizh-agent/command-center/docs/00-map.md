# Карта диска

Диск (`AGGG`) — источник правды: репозитории, станции, персоны, коллекция скиллов и эти доки.
В домашнем каталоге — только ссылки и конфиги; данные лежат на диске.

    AGGG/
      command-center/     реестр проектов (и их платформы), проверка связей, гейт доков и платформ, эти доки
      cli-station/        установка самих CLI (omp, pi, opencode)
      mcp-station/        каталог MCP-серверов, ключи, пул, регистрация в клиентах
      memory-station/     память агента: markdown-заметки + SQLite, одна на три клиента
      wiki-station/       центр вики: каталог, журнал, поиск FTS5, MCP-доступ;
                          библиотека — в wiki-station/wiki/Wiki VibeCoding (посты по темам ai/coding/tools)
      test-center/        сквозная проверка на любой ОС + багрепорт.md
      skills-hub/         поиск/установка скиллов из четырёх маркетов + MCP-сервер
      skills-station/     коллекция сторонних скиллов, раскладка по слоям
      spec-station/       спек-режим: скилл spec-mode и команды /spec* (Kiro spec mode + spec-kit)
      pi-plugins-station/ сторонние плагины pi: каталог npm-пакетов, ставятся самим pi
      modes-station/      автономные режимы /goal и /loop для opencode2 (плагин)
      vibe-station/       режим директора /vibe для opencode2: воркер-сессии fast/good (плагин)
      prompt-station/     прошивка персон + смена персоны на ходу
      sysprompt/          команда /prompt — вброс текста в системную роль
      cleanup-station/    снос и подготовка к чистой установке
      personas/           тексты персон (источник для prompt-station)
      agent-bundle/       как развернуть всё это на новой машине (README + harness/*)
      fedora-windows-look/  скилл переезда на новый ПК (bash, Linux)
      camoufox-research/  MCP-сервер и инструментарий веб-ресёрча (браузер Camoufox,
                          поиск, корпусы источников); установщик — свой, из клона
      totp/               код TOTP из одного секрета
      (dump — НЕ здесь: временные файлы и отчёты живут в
       ~/.local/state/command-center/dump; правило 21.09)

Связи (их проверяет `center doctor`):

    skills-hub        → ~/.local/bin/skills-manager, ~/.agents/skills/skills-ops
    spec-station      → ~/.agents/skills/spec-mode, commands/*.md с /spec* в трёх клиентах
    pi-plugins-station → состояние pi: ~/.pi/agent/settings.json (packages) и ~/.pi/agent/npm/node_modules
    modes-station     → ~/.config/opencode/plugins/modes-station.ts (плагин /goal и /loop)
    vibe-station      → ~/.config/opencode/plugins/vibe-station.ts (плагин /vibe)
    prompt-station    → ~/.omp|~/.pi/agent/extensions/persona.ts, opencode/plugins/persona.ts
    sysprompt         → extensions/plugins sysprompt в трёх клиентах
    fedora-windows-look → ~/.agents/skills/fedora-windows-look
    camoufox-research → ~/.agents/skills/camoufox-research-{rails,deep-research,automation,ops}/SKILL.md
                      → сервер camoufox в MCP-конфигах клиентов (ставит mcp-station)
    mcp-station       → mcpServers в ~/.omp/agent/mcp.json, ~/.pi/agent/mcp.json, opencode.json
    memory-station    → ~/.agents/skills/memory, ~/basic-memory (заметки), запись через mcp-station
    wiki-station      → ~/.agents/skills/wiki, ~/.agents/wiki-station (MCP-сервер вики), вики как проект basic-memory
    test-center       → ничего не линкует: гоняет станции и пишет багрепорт.md

«Есть ли запись» и «работает ли соединение» — разные проверки: `center doctor` читает конфиги и ссылки
(статика), `center verify` поднимает серверы по протоколу MCP в трёх средах (живой хендшейк, спавнит
настоящие серверы — часть поднимает браузер; см. [07-verify](07-verify.md)).

Обновление (обновляет `center update`, сверяет `center outdated`, см. 09-release.md):

  mcp-station       → bin/mcp-station.sh update (reconcile) + сверка outdated --json
  cli-station, skills-station, spec-station, pi-plugins-station, modes-station, vibe-station, memory-station,
  wiki-station → свой install (идемпотентен)
  sysprompt, omp-zen-free, camoufox-research, fedora-windows-look → установщик из клона
  skills-hub, prompt-station, personas, agent-bundle, totp, test-center,
  cleanup-station, dump → команды нет; в реестре updateNote с причиной

---

**AGGG [Distro] Firmware** · автор и владелец — **@hilartem** (Telegram), разработчик и CEO — AGGG-omp.
Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
Сделано для AGGG [Distro] Firmware. Запрещено распространять. Максимальная эффективность — в сообществе AGGG [Distro] Firmware и INSIDER AGGG (с чатом) или при личном общении: без знания системы и опыта это лишь референс. Полный текст — `NOTICE.md`.
