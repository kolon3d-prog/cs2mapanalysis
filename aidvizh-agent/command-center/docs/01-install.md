# Установка с нуля

Порядок, который проверен на этой машине. **Заколдованный круг один**: команда `center` появляется
шагом 1, а показать план может только она — поэтому сам первый вызов идёт от файла:

    command-center/contrib/install-links.sh   # шаг 1: команда center в PATH (идемпотентно, есть --dry-run)

    center prereqs      # что есть в системе; node обязателен — на нём движки станций
    center bootstrap    # полный план: 22 шага с точными командами
    center fresh        # если ставим начисто: снос прежнего и сразу установкой одной командой

Без шага 1 всё то же самое вызывается от файла: `command-center/bin/center.sh prereqs`.
На Windows вместо симлинка кладётся `center.cmd` — `pwsh -File command-center/contrib/install-links.ps1`.

`prereqs` на linux/macOS не требует `pwsh`: обёртки на PowerShell нужны только Windows.
`center.ps1` работает на встроенном PowerShell 5.1, но полный `center check` на Windows запускает
Unix-прогон через настоящий Git Bash. Отдельная `skills-hub/contrib/skills-hub-check.ps1` требует
PowerShell 7. `npm`, если его глобальный префикс недоступен без root (Fedora: `/usr/local`),
станция сама уводит в `~/.local` — см. `cli-station doctor`.

Проверка предпосылок — своя, без `command -v` через bash: PATH обходится с расширениями `PATHEXT`,
у найденного инструмента спрашивается версия, поэтому «есть» здесь значит «запускается». Блокируют
установку только node, npm (или bun), git и gh; `jq` и `curl` — по платформе (на Windows маркеты идут
через PowerShell, а `curl.exe` входит в систему); `bats` и `shellcheck` нужны тестам и линту и потому
показаны справочно — их отсутствие `fresh` не останавливает.

шаги: предпосылки → `cli-station install` (агенты) → `skills-hub/contrib/install-links.sh` (симлинки хаба)
→ `skills-station install all` (коллекция скиллов) → `spec-station install` (спек-режим: скилл `spec-mode`
и команды `/spec*`) → `modes-station install` (режимы `/goal` и `/loop` в opencode2) →
`vibe-station install` (режим директора `/vibe` в opencode2: плагин, агенты режима, скилл `vibe-mode`) →
`pi-plugins-station install all` (сторонние плагины pi) → `mcp-station install` (регистрации)
→ `memory-station install --bootstrap-uv` (память: uv с astral.sh, если его нет, + basic-memory + MCP)
→ `wiki-station install` (вики: скилл + база поиска + проект в basic-memory) → ключи
(`mcp-station/bin/keys.sh import`, затем повторный `mcp-station install`, чтобы opencode получил значения
из файла) → `prompt-station flash duck` и `install-ext` → `sysprompt install.sh all`
→ `fedora-windows-look/install.sh` → `omp-zen-free/install.sh` (расширение для omp/pi: бесплатный тариф
OpenCode Go/Zen вне клиента OpenCode) → `skills-hub/contrib/install-units.sh` (часовая автопроверка)
→ `center verify` (живая проверка MCP: стоят ли харнессы и отвечают ли серверы во всех трёх средах —
спавнит настоящие серверы, часть поднимает браузер, поэтому шаг отдельный и с таймаутом; тяжёлые
`camoufox` и `stealth-browser` в проверке `fresh` пропускаются — они отдельными командами)
→ `center check` (сквозная проверка).

Отдельно от цепочки — тяжёлые MCP: `camoufox-research` (веб-ресёрч) ставится своим установщиком из клона —
`center run camoufox-research` или `center activate camoufox-research`; `stealth-browser` — сборкой
`mcp-station/bin/stealth-setup.sh` (git + uv). В шаги `fresh` они не входят: установка тянет браузер
(~663 МБ) и отдельное окружение, а регистрацию серверов `mcp-station install` сделает и до неё
(сервер скажет в stderr, что окружения нет, пока проект не поставлен).

Отладочные MCP (`gdb`, `frida-mcp`, `bpftrace`, `wireshark-mcp`, `mitmproxy-mcp`, `lldb`, `radare2`) встают
как core, но живут после сборки рантаймов: `mcp-station/bin/debug-setup.sh` (venv'ы — uv,
`bpftrace-mcp-server` — cargo, мост lldb в `~/.local/bin`; системные пакеты скрипт только называет).
В проверке `fresh` они пропущены — до сборки запись честно падает с подсказкой, а не отвечает по протоколу.
Полный разбор линии — `mcp-station/docs/DEBUG-RE-GAPS.md`.

**Заселение на занятую машину.** Если агентская среда уже есть (свои скиллы, свои MCP-серверы,
настройки клиентов), ставить надо рядом, а не поверх: `center fresh --yes --no-cleanup` — тот же план,
но шаг «снос прежнего» пропускается. Чужое при этом остаётся чужим: `mcp-station` не трогает записи,
которые не её (говорит «не трогаю, это не наша запись»), прошивка персоны кладёт копию рядом (`.bak`,
вернуть — `prompt-station revert`). Отличить первое заселение от повторного можно по следу набора —
команде `center` в `~/.local/bin` (её ставит шаг 1).

Что ставится автоматически: бинарники клиентов, все ссылки в домашнем каталоге, скиллы, MCP-регистрации,
прошивка персоны, расширения, память (`memory-station install` — basic-memory + MCP; `uv`, если его нет,
ставится сам по `--bootstrap-uv`) и вики
(`wiki-station install` — поисковая база + проект в basic-memory). Что остаётся руками: логины провайдеров, ключи сервисов
и повторный `mcp-station install` после импорта, первый перезапуск
клиентов (`opencode2 service restart`, новый сеанс omp/pi), шаги самого скилла `fedora-windows-look`,
и **предпосылки** — `center prereqs` их только диагностирует.

Проверка после установки: `center doctor` (связи), `center check` (все наборы тестов), затем в клиенте —
`/persona` и `/prompt` (если ставили).

**Готовый архив для чужой машины** собирается из диска: `../dist/build.sh` (пароль задаётся при сборке,
публикуется в канале `t.me/aidvizh_hub`; сам пароль ни в архиве, ни в скрипте не хранится). Внутри архива
та же система и точка входа `./install.sh` (Windows — `install.ps1`), которая делает `center prereqs` и
дальше по машине: пустая — `center fresh --yes`; занятая без следа набора — `center fresh --yes --no-cleanup`
(ставит рядом, ничего не снося); набор уже стоит — покажет `--update`/`--reset` и выйдет.
