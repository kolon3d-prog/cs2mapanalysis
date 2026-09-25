# Плагины клиентов: слэш-команда `/center`

Одна слэш-команда `/center` в трёх клиентах (opencode2, omp, pi): зовёт центр и показывает его вывод
как есть — человеческим текстом, без JSON-простыни. Отдельно — сводка состояния на старте сессии
(там, где для неё есть дешёвое место).

Своей логики у плагина нет: он не читает реестр и не знает про связи — только запускает `center`
с таймаутом под команду. Подробности, таблица таймаутов и грабли — `../plugin/README.md`; код —
`../plugin/lib/center.ts` (ядро и список команд), `../plugin/agent/center.ts` (расширение omp и pi),
`../plugin/opencode/center.ts` (плагин opencode2).

## Поставить и снять

    command-center/contrib/install-plugins.sh [install|uninstall|status] [--dry-run]

На Windows то же самое делает сосед на PowerShell (обе обёртки идут в один движок
`contrib/install-plugins.mjs`, поэтому ставят и печатают одно и то же):

    pwsh -File command-center/contrib/install-plugins.ps1 install
    pwsh -File command-center/contrib/install-plugins.ps1 status

То же по шагам:

    command-center/contrib/install-plugins.sh install      # ссылки в каталоги трёх клиентов
    command-center/contrib/install-plugins.sh status       # что стоит и куда ведёт
    command-center/contrib/install-plugins.sh uninstall    # снять только свои ссылки
    command-center/contrib/install-plugins.sh install --dry-run   # показать, ничего не трогая

Скрипт идемпотентен: ссылка уже ведёт сюда — не делает ничего; на месте ссылки чужой файл — уезжает
в `.bak`, а не в мусор. Тип связи движок называет честно: символическая ссылка, иначе junction
(бывает только у каталогов), иначе копия — и тогда сказано прямо, что копия за правками в станции
не следит и установку надо повторить после обновления плагина. Пока копия записана, повторный
`install` обновляет её на месте (`status` показывает «копия устарела: повтори install»). После установки
начни сессию клиента заново: список команд клиент снимает
на старте, поэтому в идущей сессии `/center` не появится — ровно та причина, по которой центр
показывает `session_stale` в `center ps --json`.

## Команды

Семь, все — обёртка над центром: `/center status`, `/center verify`, `/center outdated`,
`/center update`, `/center ps`, `/center logs`, `/center docs`. `logs` требует имя проекта
(`/center logs mcp-station --tail 20`), `docs` умеет тему (`/center docs 07-verify`).
Список команд плагина сверяется с движком центра гейтом `../bin/docs-check.sh` (на Windows — тот же
гейт в обёртке `../bin/docs-check.ps1`: движок один): команды, которой
у центра нет, в плагине быть не может.

Проверка — `bats plugin/tests/plugins.bats` (ядро, обёртки под каждый клиент, установка и снятие
симлинков на подменённом доме; сеть и реальные конфиги не трогаются).
