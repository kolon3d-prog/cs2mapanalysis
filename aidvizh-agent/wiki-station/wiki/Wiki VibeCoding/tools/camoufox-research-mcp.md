---
type: Reference
title: Кауфми-ресёрч — наш MCP-сервер веб-ресёрча: рельсы и 7 классов багов (21.09)
description: Наш локальный MCP-сервер ресёрча: где стоит, как обновлять, 7 классов багов от живых проб и ритуал проверки через mcpdrive/soak.
date: 2026-09-21
tags: [tools, mcp, testing, methodology, python]
source: /run/media/admin1/DATA/AGGG/camoufox-research
generated:
  by: wiki-station/mcp
  at: 2026-09-21T11:39:00Z
---

# Кауфми-ресёрч — наш MCP-сервер веб-ресёрча: рельсы и 7 классов багов (21.09)

Наш локальный MCP-сервер ресёрча («кауфми-ресёрч», camoufox-research) — браузерный ресёрч с кампаниями, волнами термов и цитатными отчётами. Живые пробы 21.09 вскрыли 7 классов багов; ниже — рельсы (где стоит, как обновлять), список классов и ритуал проверки.

## Где стоит и как обновлять

- Репа: `/run/media/admin1/DATA/AGGG/camoufox-research`, ветка `local-fixes` (11 коммитов поверх `main`).
- Питон: `.venv/bin/python` (3.13), там же ruff/mypy/bandit.
- Точка входа MCP (`~/.config/opencode/opencode.json`): `bash -lc … exec .venv/bin/camoufox-research`, `CAMOUFOX_CAPS` по умолчанию `research,browser`.
- Обновление: правка → точечные тесты (`python -m unittest tests.<файл>`, не `discover` — suite ходит в живой ресёрч) → **обязательная переустановка** `uv pip install --python .venv/bin/python --reinstall-package camoufox-research .` → перезапуск MCP. Пакет ставится копией в site-packages (не editable), entry point импортит оттуда — без реинсталла сервер поднимает старый код.
- Ручки: `CAMOUFOX_CACHE_DIR` (`~/.cache/camoufox-research` — живые данные владельца, не трогать), `HEALTH_PULSE_NOTIFY=1` (уведомления opt-in), вентили `CAMOUFOX_ALLOW_FILE` / `ALLOW_PRIVATE` / `ALLOW_ANY_PATH`, `CAMOUFOX_CAMPAIGN_STALE_MIN` (30 мин).

## 7 классов багов (21.09)

1. **fresh-cache** — старт кампании открывал лог до спавна воркера: на чистом кэше FileNotFoundError, кампания висла в `running` (`camoufox_campaign_ext.py`, `tests/test_campaign_recovery.py`).
2. **зомби-кампания** — `running` без процесса запирал очередь по «закону одного инстанса»; теперь `_reclaim_stale()` по молчанию лога плюс тул `research_cancel()`.
3. **мусорные волны** — `extract_terms` отдавал голые слова, волна улетала в музыкальные сайты; академический канал звал `paper_rows` без гейта релевантности; DDG отдавал клиенту `duckduckgo.com/l/?uddg=…` вместо источника (`camoufox_academic.py`, `tests/test_query_quality.py`, `tests/test_ddg_links.py`).
4. **кэш как обход стража** — проверка URL стояла ПОСЛЕ кэша: `file:///etc/passwd` возвращался из записи прошлого прогона; теперь стражи первой строкой плюс `CacheBypassTest` (`camoufox_urlguard.py`, `tests/test_security_guards.py`).
5. **error-contract** — ошибка воркера ехала строкой «ошибка: …», и SDK отдавал её как успешный результат (`isError=false`); мост бросает SDK-класс `ToolError` (`tests/test_tool_error_contract.py`).
6. **стражи путей** — `export(path=…)` писал любой файл управляемым со страницы текстом, вплоть до `config.env`, который cron-скрипты подключают через `.` (текст → исполнение кода от владельца); теперь `safe_export_path()` только внутрь каталога экспорта, плюс починены стражи самой репы (`tests/test_guard_scripts.py`).
7. **opt-in уведомления** — notify-send спамил на каждом запуске пульса (дедуп сравнивал готовую строку со штампом времени); гейт `HEALTH_PULSE_NOTIFY=1` и дедуп по смыслу вердикта (`tests/test_health_pulse_notify.py`).

## Как проверять живьём

- Драйвер stdio-MCP `/run/media/admin1/DATA/AGGG/mcpdrive.py`: `<venv>/bin/python mcpdrive.py <репа> '<json-план>'` — initialize с перебором версий протокола → tools/list → tools/call с замером времени.
- Soak-харнесс `/run/media/admin1/DATA/AGGG/soak_camoufox.py` — N итераций «новый сервер + браузер»: зомби по `/proc`, сироты после остановки, зависания (таймаут вызова 90 с), рост RSS дерева >250 МБ на итерацию; rc=1 при находке.
- Доказательство — `isError=true` с текстом причины на ЖИВОМ вызове и rc харнесса, а не зелёный юнит: ошибка `research_start(terms_wave=…)` дожила до пробы, потому что юниты звали `start()` напрямую; дедуп уведомлений «проходил» тест дважды подряд, пока спамил в живую.
- Тесты ресёрча не параллелить: два браузера одновременно = «write EPIPE» у Playwright-драйвера. Один прогон — один инстанс.

## Контекст / ссылки

- Грабли прошлых заходов: `docs/landmines.md`; правила правок: `CONTRIBUTING.md`; политика размера модулей: `FILE-SIZE.md` (~262 строки).
- Родственные посты: [Lightpanda](lightpanda.md) (лёгкий браузер для агентов — та же ниша), [md-this-page](md-this-page.md) и [scraperai](scraperai.md) — паттерн «страница → анализ»; [PROJECT_STATUS.md](../coding/project-status-habit.md) — привычка сводить состояние работы в документ.

## Вывод

Станция работает, но её классы отказов системные, а не косметические: ловушка на старте, залипшая очередь, мусор в цитатах, страж после кэша, ошибка под видом ответа, текст со страницы как код, спам в рабочий стол. Общее правило, которое их закрыло: стражи — первой строкой, ошибка — исключением SDK, а доказательство — только живой прогон через настоящее stdio.
