---
name: camoufox-research-rails
description: >-
  Рельсы MCP-сервера camoufox-research: правка кода не видна без переустановки
  пакета, кампания висит в running, свежий кэш роняет старт, ошибка тула не
  отличима от ответа, fetch отдаёт file:// или локальный адрес, экспорт не
  пишет наружу, пульс спамит уведомлениями. Триггеры: кампания зависла,
  research_cancel, research_resume, isError, «ошибка:» в ответе, terms_wave,
  academic, file://, 127.0.0.1, SSRF, CAMOUFOX_ALLOW_FILE,
  CAMOUFOX_ALLOW_PRIVATE, CAMOUFOX_ALLOW_ANY_PATH, HEALTH_PULSE_NOTIFY,
  notify-send спам, страж URL, отказ экспорта, stale-кампания, старая копия
  пакета, --reinstall-package, uv pip install, свежий кэш, exports, mcpdrive,
  soak, зомби, утечка, ~/.cache/camoufox-research, CAMOUFOX_CAPS,
  CAMOUFOX_CACHE_DIR.
metadata:
  opencode/autoinvoke: true
---

# camoufox-research — рельсы

Правки живут в клоне репозитория, а MCP поднимает УСТАНОВЛЕННУЮ копию пакета: пока её не переустановил, проверяешь старый код — и «баг не воспроизвёлся» ничего не значит.

## Где что лежит

Каталог клона — только код (единицы мегабайт): всё изменяемое живёт в рантайме, поэтому клон можно снести и склонировать заново без потерь.

- Окружение: `$CAMOUFOX_VENV` → `~/.venvs/camoufox-research` (`bin/python`; на Windows `Scripts\python.exe`). Раньше venv стоял в клоне и переезжал вместе с ним — теперь он в рантайме.
- Состояние (кэш, кампании, отчёты, логи): `$CAMOUFOX_CACHE_DIR` → `~/.cache/camoufox-research` — живые данные владельца: читать можно, чистить/удалять нет. Одна переменная переносит ВСЁ состояние (тест `tests/test_paths_env.py`), а не один каталог.
- Каталог состояния по умолчанию — платформенный: Linux `~/.cache`, macOS `~/Library/Caches`, Windows `%LOCALAPPDATA%\Cache`.
- Клиент (opencode) стартует скрипт из рантайм-окружения (`~/.venvs/camoufox-research/bin/camoufox-research`) — это установленная копия, НЕ каталог репозитория. Клиент держит строку запуска в памяти: после смены окружения нужен reconnect.
- Браузер Camoufox — `~/.cache/camoufox` (общий на машину, качается один раз).
- Вентили: профиль тулов `CAMOUFOX_CAPS` (`research,browser,session,vision`; `ping`/`stats` видны всегда), `CAMOUFOX_VENV`, `CAMOUFOX_CACHE_DIR`, финальные отчёты `CAMOUFOX_REPORT_DIR` (по умолчанию — `exports`).

## Рельс 1 — правка не видна агенту

Причина всегда одна: в `site-packages` рантайм-окружения лежит прошлая сборка, а `git pull`/правка файла её не меняет. `scripts/install.sh` делает это сам (и `--reinstall-package` тоже); руками из корня клона:

```bash
uv pip install --python ~/.venvs/camoufox-research/bin/python --reinstall-package camoufox-research .
```

- `--reinstall-package` обязателен: pip/uv отдаёт колесо из кэша и бодро пишет «installed», оставляя старый код (грабля 26 в `docs/landmines.md`).
- Проверяй по файлу, а не по выводу: `grep -c "<новая строка>" ~/.venvs/camoufox-research/lib/*/site-packages/camoufox_research/<модуль>.py`.
- Дальше — reconnect клиента. Убитый вручную MCP-процесс сам не пересоздаётся: тулы у клиента просто исчезают.

## Рельс 2 — кампания: свежий кэш и зависание

- Свежий кэш: `start()` открывает лог в `~/.cache/camoufox-research/exports` ДО спавна воркера. Каталога не было → `FileNotFoundError` на первой секунде, строка кампании осталась `running` и заперла очередь. Теперь каталог создаёт `_paths()`; на старой копии пакета просто сделай `mkdir -p ~/.cache/camoufox-research/exports`.
- «Закон одного инстанса»: `running`-кампания не даёт стартовать следующей. Снимать не руками в sqlite, а `research_cancel(camp_id)` — переводит в `failed`, лог оставляет для разбора.
- Авто-сброс: при следующем `start` кампания, чей лог молчит дольше `CAMOUFOX_CAMPAIGN_STALE_MIN` (30 мин), освобождается сама; живая — не трогается.
- Двойной запуск по той же теме — это `research_resume` (доборка partial/failed с места), не второй `research_start`.
- Готовность — файл-маркер `exports/cmp_<id>.json`, а не поллинг.

## Рельс 3 — волна термов и академия

- `terms_wave=True` (по умолчанию): терм обязан встретиться в ≥2 РАЗНЫХ источниках (df≥2); одиночное слово уходит только с якорем базового запроса. До этого пять голых слов (`audio`, `blend`…) уводили волну в музыкальные сайты — жаловаться на «мусор в цитатах» без этой проверки бессмысленно.
- `academic=False` (по умолчанию): канал arXiv/Crossref/Wiki включай ТОЛЬКО под научную тему. Он гейтится (≥2 общих значимых токена, дефис = разделитель), но не бесплатен (+3 HTTP на волну) и на неакадемической теме тянет мусор под видом tier 0.
- Оба флага едут из тула `research_start` в воркер через ACTION-обёртку и argv фонового раннера — в схеме БД их нет, поэтому проверяй на живом вызове, а не только юнитом `start()`.

## Рельс 4 — ошибка тула = `isError=true`

`isError` — единственный контракт: ошибка воркера приходит исключением SDK (`ToolError`), а не строкой. Ветвись по `isError`, а не по поиску «ошибка:» в тексте; раньше SDK отдавал такую строку как успешный результат с `isError=false`, и retry не срабатывал. Внутренний ABI (`_parse`, auth-гейт, rate-limit) по-прежнему пишет префикс «ошибка:» — мост превращает его в исключение в одном месте.

## Рельс 5 — страж URL

Разрешены только `http(s)` на публичный адрес. Режутся: `file://`, литеральные приватные IP, короткие/числовые формы (`127.1`, `2130706433`), `*.local/.internal/.lan/.home.arpa/.localhost`, `169.254.169.254` (SSRF чужим браузером — метаданные облака, роутеры, свои сервисы). DNS не резолвится намеренно (гонка TOCTOU). Страж стоит на всех входах (`_goto`, `_fetch_bytes`, `check_links`, загрузки) и проверяет URL ДО кэша — иначе `file:///etc/passwd`, прочитанный раньше, вернулся бы из кэша мимо стража.

Осознанные вентили (только для отладки, не «чтобы прошло»): `CAMOUFOX_ALLOW_FILE=1`, `CAMOUFOX_ALLOW_PRIVATE=1`.

## Рельс 6 — куда пишет экспорт

`export(..., path=)` и `citation_report(camp_id, path=)` пишут ТОЛЬКО внутрь каталога экспорта. Раньше управляемое содержимым страницы имя файла дотягивалось до `~/.cache/camoufox-research/config.env`, который cron-скрипты подключают через `.` — то есть текст со страницы превращался в исполнение кода от владельца. Обход — `CAMOUFOX_ALLOW_ANY_PATH=1`, это осознанное решение, а не лечение «отказалось писать».

## Рельс 7 — уведомления пульса

Уведомления на рабочий стол — opt-in: `HEALTH_PULSE_NOTIFY=1`. По умолчанию пульс молчит и пишет только `health-pulse.log` + файл ALERT. Повтор того же вердикта гасится окном `HEALTH_PULSE_NOTIFY_REPEAT_MIN` (1440 мин). На Linux нужны ещё `DISPLAY`/`WAYLAND_DISPLAY` и `DBUS_SESSION_BUS_ADDRESS` — «не приходит уведомление» чаще всего это, а не поломка. Если спамит `notify-send`, смотри, кто именно зовёт: сам пульс или `~/.local/bin/clip`.

## Где смотреть состояние

- `~/.cache/camoufox-research/`: `cache.db` (кампании/источники/дельты), `exports/` (логи и маркеры кампаний), `research/` (архив отчётов + `INDEX.md`), `watchdog.log`, `memory.md`.
- `python scripts/mcp_probe.py` — живое рукопожатие и реальное число тулов; `--json` для машинной проверки.
- Правки в пакете не валидируются без переустановки (рельс 1) — сначала переустановка, потом диагностика.

## Живые проверки (точечно)

```bash
# драйвер живёт внутри репо; артефакты прогонов уезжают в рантайм (CAMOUFOX_DEV_DIR)
~/.venvs/camoufox-research/bin/python scripts/mcp_drive.py . '[{"op":"ping"},{"tool":"research_status","args":{"camp_id":"cmp_..."}}]'
~/.venvs/camoufox-research/bin/python scripts/mcp_drive.py . '[{"op":"tools"}]'   # реальный список тулов
~/.venvs/camoufox-research/bin/python scripts/soak_probe.py 3      # зомби/сироты/зависания/RSS-утечка
```

- `mcp_drive.py <repo> '<план>'` — план это JSON-массив шагов (`{"tool":…,"args":…}`, `{"op":"tools"}`, `{"op":"ping"}`), полный ответ — флагом `--full`; отчёты по умолчанию в `$CAMOUFOX_DEV_DIR` (`~/.cache/camoufox-research/dev`), не рядом с боевыми каталогами.
- Один браузер на машину: два параллельных прогона = `write EPIPE` и осиротевшие процессы. Тесты кампаний — по одному, в фоне (shell-таймаут убивает группу вместе с браузером).
- `soak_probe.py` судит по `/proc`: зомби, сироты, вызов дольше 90 с = зависание, +250 МБ RSS на итерацию = утечка. Код возврата 1 — есть находки (годится для CI).

## Рядом

Этот скилл — про «почему оно так себя ведёт и что с этим делать». Соседние — про другое:

- `camoufox-research-ops` — поставить, обновить, диагностировать, почистить (окружение, установщики, скрипты, мусор).
- `camoufox-research-deep-research` — как выжимать полноту корпуса и качество цитат.
- `camoufox-research-automation` — живая вкладка: логин, формы, скролл, сеть, скачивание; там же профиль `CAMOUFOX_CAPS` с session-тулами.

## Границы

- Живой кэш владельца не чистить и не «починить» — сносить данные вместо разбора причины.
- Не переустанавливать пакет, пока чужой агент/тест ходит в тот же venv: подмена кода под работающим процессом даёт ложные падения.
- Детали и остальные грабли: `docs/landmines.md` (26 проверенных пунктов), `docs/agent-usage.md`, `research/public/skills/mcp-camoufox-ops.md`, `README.md`.

---

**AGGG [Distro] Firmware** · автор — **@hilartem** (Telegram). Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
