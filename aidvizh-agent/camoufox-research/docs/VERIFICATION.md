# Verification — что и чем проверено

> Правило этого файла: **каждая строка — команда и её вывод**. «Проверено» без
> команды здесь не бывает; где остались границы — отдельный раздел
> «Что НЕ проверено». Дата срезов: 21.09.2026, пакет `0.19.0`.

## Оглавление

1. [Сводка](#1-сводка)
2. [Юнит-тесты: 311 python (канон — 258)](#2-юнит-тесты-311-python-канон--258)
3. [Стражи репозитория: 18 bats](#3-стражи-репозитория-18-bats)
4. [Semgrep: 5 своих правил](#4-semgrep-5-своих-правил)
5. [Живые прогоны](#5-живые-прогоны)
6. [Контракты и стражи по темам](#6-контракты-и-стражи-по-темам)
7. [Docker и PowerShell](#7-docker-и-powershell)
8. [Что НЕ проверено](#8-что-не-проверено)
9. [Как воспроизвести](#9-как-воспроизвести)

## 1. Сводка

| Что | Чем измерено | Результат |
|---|---|---|
| Юнит-тесты | `grep -rhoE "^\s*def test_" tests/test_*.py \| wc -l` | **311** тестов в 39 файлах (снимок 22.09; 258/33 — канон прошлого среза) |
| Точечные прогоны (срез) | `~/.venvs/camoufox-research/bin/python -m unittest tests.test_fetch_limit tests.test_security_guards` | 26 тестов, `OK` за 1.62 с |
| Стражи репозитория (шелл) | `bash scripts/run_bats.sh` | **18 ok / 0 not ok** |
| Свои правила безопасности | `semgrep --config .semgrep.yml camoufox_research/ scripts/ --error` | **0 находок**, 5 правил, 64 файла |
| Нагрузка (зомби/сироты/RSS) | `scripts/soak_probe.py` (3 итерации) | 0 зомби, 0 сирот, 0 зависаний, дрейф RSS ≈ 0 |
| Контент страницы | `fetch_page` Wikipedia (замер контента) | 26 301 симв. за 8.25 с |
| Контент документа | `read_document` PDF по URL | 40 000 симв. за 2.91 с |
| Кампания | `research_start` → `research_status` | 63 домена / 72 источника (цель 60) |
| Рукопожатие MCP | `python scripts/mcp_probe.py --json` | `ok=true`, protocol `2025-11-25`, tools=34 |

Числа тулов отвечают на разные вопросы: **34** — дефолт (пусто →
`DEFAULT_CAPS=research,browser`, закреплён `tests/test_caps_default.py`), **60** —
с `session`, **36** — с `vision`, **62** — полный реестр, только явно
(`CAMOUFOX_CAPS=all`). Гейт CI (`probe`) требует ≥50 и потому идёт с
`CAMOUFOX_CAPS: all` — как и остальные счётные гейты `ci.yml` (починено 21.09);
с пустым `CAMOUFOX_CAPS` probe честно покажет 34 (замер этого захода). Замеры
контента/кампании и сравнение с tavily/exa — с провенансом каждой цифры — в
`docs/RESEARCH-PLAYBOOK.md` (§3–4); здесь они сведены без повторения команд.

## 2. Юнит-тесты: 311 python (канон — 258)

`tests/test_*.py` — 39 файлов, 311 тестов на снимке 22.09. Канонические
**258 в 33 файлах** — состояние до захода 21.09; в нём добавились
`test_content_defaults.py` (сейчас 16), `test_session_network.py` (12),
`test_caps_default.py` (10), `test_live_flows.py` (3), плюс правки в
существующих. Число растёт вместе с кодом: считать его нужно командой из
таблицы выше, а не помнить.

Прогон точечный (`python -m unittest tests.<файл>`), НЕ `discover`: часть suite
ходит в живой ресёрч/браузер, и «прогнать всё» = запустить живую кампанию.
`test_live_flows.py` — отдельный opt-in слой: без `CAMOUFOX_LIVE_TESTS=1` все
сценарии пропускаются (см. `docs/testing-live-flows.md`).

| Файл | Тестов | Что закрывает |
|---|---|---|
| `test_p0_fixes.py` | 29 | партия P0-фиксов (кэш, воркер, ретраи) |
| `test_security_guards.py` | 17 | страж URL (анти-SSRF/LFI) + страж пути записи (анти-RCE) |
| `test_campaign_api.py` | 14 | API кампаний (старт/статус/отчёт/резюм) |
| `test_budget_and_cache.py` | 12 | бюджет в вызовах, TTL-кэш |
| `test_bridge_timeouts.py` | 10 | таймаут не убивает воркер, лок не сериализует вызовы |
| `test_health_pulse_notify.py` | 10 | уведомления пульса: opt-in, дедуп, best-effort |
| `test_health_portable.py` | 10 | переносимость путей (Linux/macOS/Windows-ветки) |
| `test_fetch_limit.py` | 9 | потолок контента 100k вместо жёстких 12k |
| `test_guard_scripts.py` | 9 | шелл-стражи: pre-push, gitleaks, cron, обёртка venv |
| `test_notify_platform.py` | 9 | свой механизм уведомлений на macOS/Windows |
| `test_install_chipset.py`, `test_housekeep_cleanup.py`, `test_query_quality.py`, `test_worker_api.py` | по 9 | чипсет установки; метла с TTL; волна термов и качество выдачи; API воркера |
| `test_campaign_recovery.py` | 8 | кампания-зомби → `research_cancel` снимает блокировку |
| `test_caps.py` | 8 | каждый тул в группе; профиль режет реестр |
| `test_structured_content.py` | 8 | JSON-режимы отдают `structuredContent` |
| `test_extract_llm.py` | 8 | извлечение полей схемой (в т.ч. из текста) |
| `test_tool_error_contract.py` | 7 | ошибка тула = `isError=true`, не текст |
| `test_document_sniff.py` | 6 | формат документа по содержимому, не по URL |
| `test_fact.py` | 6 | FACT-счётчик живых цитат |
| `test_guards_smoke.py` | 6 | метла + сторож поиска (смоук) |
| `test_health_pulse.py` | 6 | вердикт пульса |
| `test_content_defaults.py` | 16 | дефолты полноты: сколько символов отдают тулы без аргументов, воркеры |
| `test_session_network.py` | 12 | перехват сети/консоли сессии (добавлен 21.09) |
| `test_caps_default.py` | 10 | дефолтный профиль caps (добавлен 21.09) |
| `test_live_flows.py` | 3 | живые сценарии: логин, ленивый скролл, отказ `file://` — opt-in `CAMOUFOX_LIVE_TESTS=1` |
| остальные 12 файлов | 42 | RPC-контракт, ретраи, скилл-линт, порядок тулов, карта сайта, дедуп ссылок |

## 3. Стражи репозитория: 18 bats

`tests/bats/` — 4 файла, 18 тестов (`bats --count tests/bats/` → `18`). Ранера
зовут `bash scripts/run_bats.sh` (из корня репо; нет `bats` — код 127, а не
«тихо зелено»). Прогон 21.09: **18 ok, 0 not ok**.

- `install_cron.bats` (6) — `--dry` не пишет crontab; опечатка в флаге ≠ запись; `--keep-timings`.
- `git_pre_push.bats` (5) — страж pre-push на новом бранче (пустой `$REPO_HASH_EMPTY`).
- `gitleaks_precommit.bats` (4) — rc сканера не затирается `exit 0`.
- `health_pulse_notify.bats` (3) — уведомление пульса не роняет прогон.

## 4. Semgrep: 5 своих правил

`.semgrep.yml` — свои правила (реестр `p/…` не тянем: он меняется под нами и
требует сети), гейт в CI — `--error`. Пять правил: `fetch-url-without-check-url`
(fetch мимо стража URL), `fetch-url-checked-after-fetch` (проверка ПОСЛЕ
запроса), `write-file-without-safe-export-path` (запись мимо безопасного пути),
`subprocess-shell-true`, `swallow-hides-guard-fetch-or-write` (`except: pass`,
прячущий страж).

Проверено: `semgrep --validate` → «5 rule(s), 0 configuration errors»; скан
`camoufox_research/ scripts/` → **0 findings**, 64 цели; сам semgrep отчитался
«Parsed lines: ~100.0%».

## 5. Живые прогоны

**Soak (зомби / сироты / зависания / RSS).** Harness: `scripts/soak_probe.py`
(рядом с репо, `/run/media/admin1/DATA/AGGG/`), отчёт — `soak_report.json`.
Каждая итерация = новый сервер + браузер, 21 вызов (ping, поиск, `fetch_page`,
сессия, `session_eval`). Три итерации: **21/21 ok** каждая, boot 0.84 / 0.81 /
0.85 с, пик RSS 1341 / 1336 / 1337 МБ, зомби 0, сирот 0, зависаний 0. Порог
harness: рост >250 МБ/итерацию = утечка; фактический дрейф ≈ 0 (3 МБ). После
остановки сервера своих процессов не осталось (`after_proc=0`), `tools=60`.

**Полнота контента (замеры 21.09).** Файлы замеров — `content_limit_after.json`,
`content_pdf2.json`, `content_levers.json` (каталог прогонов).

| Замер | Символов | Секунд |
|---|---|---|
| `fetch_page` Wikipedia после потолка 100k | 26 301 | 8.25 |
| `read_document` PDF по URL | 40 000 (ровно `max_chars`) | 2.91 |
| `research` без `fetch_all` | 10 760 | 1.73 |

Полный набор замеров (включая 30 540 / 31 504 / 54 598) — в
`docs/RESEARCH-PLAYBOOK.md` §3. До правки потолка тот же вызов возвращал ровно
12 000 симв. — регрессия закреплена `test_fetch_limit.py`.

**Кампания.** `cmp_1789994740_950a` → `research_status`: статус `done`,
источников 72, разных сайтов **63/60**, 2 волны, бюджет поиска 3/40 вызовов.

**Матрица антибота** (`docs/anti-bot-matrix.md`): тест-страница детекта — 12/13
строк passed; `nowsecure.nl` — JS-рендер прошёл; демо Cloudflare Turnstile через
`session_navigate` — интерстишл (не прошло).

## 6. Контракты и стражи по темам

| Контракт | Как проверено | Что гарантирует |
|---|---|---|
| Ошибка = `isError=true`, и она не переигрывается | `test_tool_error_contract.py`: строка-ошибка → `ToolError`; `session_*`/`research_*` мост не повторяет | клиент отличит сбой от ответа (retry/ветвление), вторая вкладка/кампания не появится |
| `structuredContent` в JSON-режимах | `test_structured_content.py` (схема — только на JSON-ответах) | агент получает объект, а не строку с JSON |
| Страж URL и пути записи | `test_security_guards.py`: `file://`, `127.0.0.1`, `169.254.169.254` и `export(path=…)` вне разрешённого каталога отвергнуты | нет LFI/SSRF и RCE через `~/.cache/camoufox-research/config.env` |
| Потолок контента | `test_fetch_limit.py`: дефолт ≥100k, `CAMOUFOX_FETCH_LIMIT` перекрывает | «дай больше» работает и на первом, и на повторном вызове |
| Определение документа | `test_document_sniff.py`: `%PDF`/`PK\x03\x04` решают, а не расширение в URL | arXiv `/pdf/<id>` и DOI-ссылки читаются |
| Таймаут/лок моста | `test_bridge_timeouts.py`: воркер не убивается, `stats` не ждёт `research` | долгий вызов не ломает остальные тулы |
| Профили тулов | `test_caps.py`, `test_tool_order.py`: у каждого тула группа, порядок стабилен | тул не исчезает молча, префикс промпта и prompt-кэш стабильны |
| Уведомления пульса | `test_health_pulse_notify.py` + `test_notify_platform.py` | по умолчанию молчим (`HEALTH_PULSE_NOTIFY=1` — явное согласие), дедуп по смыслу вердикта, окно повтора 1440 мин |
| Восстановление кампании | `test_campaign_recovery.py`: кампания-зомби → `research_cancel` → `failed` | очередь не заперта «законом одного инстанса» |
| Шелл-стражи | `test_guard_scripts.py` + 18 bats | pre-push/gitleaks/cron реально останавливают, а не «зелено» |
| Гейты CI | `.github/workflows/ci.yml` | lock проверяется отдельной read-only job; в тестах `uv sync --frozen`, затем `py_compile`, ruff+mypy (блок), bandit (medium+), semgrep `--error`, bats, `unittest discover`, MCP smoke, probe `tools/list ≥ 50` (полный реестр — только явным `CAMOUFOX_CAPS=all`) |

## 7. Docker и PowerShell

**Docker** (поставка 21.09: `Dockerfile`, `docker/entrypoint.sh`,
`.dockerignore`, `scripts/run_in_docker.sh` — печатает готовую секцию клиента и
умеет `--self-test`: живое рукопожатие MCP внутри образа). Проверено на этой
машине:

```bash
sh -n docker/entrypoint.sh && bash -n scripts/run_in_docker.sh   # OK
shellcheck -S warning docker/entrypoint.sh scripts/run_in_docker.sh  # rc=0, пусто
docker build --check -t camoufox-research:check .   # «Check complete, no warnings found»
```

Ключевые решения (из самого файла): двухстадийная сборка, браузер скачивается на
сборке, `/data` — единственный том (`~/.cache/camoufox-research` — симлинк),
`USER camoufox`, `ENTRYPOINT` — exec и ни строки в stdout (stdout = протокол
stdio), `HEALTHCHECK` не объявлен осознанно (у stdio-сервера нет порта; для
`--transport http` — `curl -f`). Размер ≈1.3 ГБ — по комментарию Dockerfile
(своего `docker images` не делали): это браузер, а не код.

**PowerShell** (поставка 21.09: `scripts/install.ps1` — установка, и
`scripts/health_pulse.ps1` — пульс здоровья). `pwsh` на этой машине НЕ установлен,
поэтому проверка — парсингом в контейнере `mcr.microsoft.com/powershell:lts`:

```bash
docker run --rm -v "$PWD:/w:ro" mcr.microsoft.com/powershell:lts pwsh -NoProfile \
  -Command '$bad=0; foreach($f in @("/w/scripts/install.ps1","/w/scripts/health_pulse.ps1")){
    $e=$null; [System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$e)|Out-Null;
    if($e){$e|%{$_.ToString()};$bad=1}else{"parse OK: $f"}}; exit $bad'
# → parse OK: /w/scripts/install.ps1 ; parse OK: /w/scripts/health_pulse.ps1
```

Честная граница: это **парсинг**, а не исполнение; Windows-специфичные командлеты
(реестр, службы, ветки `Get-Command`) на Linux не выполняются — см. ниже.

## 8. Что НЕ проверено

- **Windows и macOS живьём.** Есть мок-ветки (`test_health_portable.py`,
  `test_notify_platform.py` — osascript/PowerShell-toast) и `--dry-run`
  установщика; реальные ОС не запускались.
- **PowerShell-исполнение.** На хосте нет `pwsh`; проверен только парсинг в
  контейнере. Windows-командлеты не исполнялись ни разу.
- **Docker-образ не собирался на этой машине в этом заходе** (проверены
  `--check`-линт Dockerfile и синтаксис entrypoint); сборка тянет ≈1.3 ГБ
  (браузер на стадии build).
- **CF-интерстишл.** Демо Cloudflare Turnstile отдало интерстишл через
  `session_navigate`; «проходим Cloudflare» — НЕ заявляем. Часть сайтов честно
  не читается (см. `docs/anti-bot-matrix.md`, раздел «Пределы»).
- **Долгие кампании под нагрузкой.** Soak — 3 итерации по 21 вызову; часовых
  кампаний в замере нет. В окне замеров матрицы антибота на машине параллельно
  шёл чужой тяжёлый прогон — времена там ЗАВЫШЕНЫ (вердикты — нет, они по
  содержимому).
- **Полный `unittest discover`.** Гоняется в CI, но НЕ в этом заходе локально:
  suite ходит в живой ресёрч; локально гонялись точечные файлы.
- **`zillow.com`** (другой вендор WAF: PerimeterX/DataDome) — не измерен.
- **Живые сценарии (`test_live_flows.py`).** В заходе не прогонялись (нужен
  браузер и сеть, включаются явно `CAMOUFOX_LIVE_TESTS=1`) — см.
  `docs/testing-live-flows.md`.
- **Полнота на «сложных» сайтах.** Замеры контента — на Wikipedia/arXiv;
  медиа-тяжёлые и бесконечные ленты отдельно не мерились (рецепт есть в
  `docs/RESEARCH-PLAYBOOK.md`, раздел 7).

## 9. Как воспроизвести

```bash
cd /run/media/admin1/DATA/AGGG/camoufox-research   # репо + .venv (python 3.13)

# 1) юнит-тесты — точечно (discover запускает живой ресёрч!)
~/.venvs/camoufox-research/bin/python -m unittest tests.test_fetch_limit tests.test_security_guards
~/.venvs/camoufox-research/bin/python -m unittest tests.test_tool_error_contract tests.test_caps

# 2) шелл-стражи
bash scripts/run_bats.sh            # 18 ok / 0 not ok
bats --count tests/bats/            # 18

# 3) страж безопасности кода
semgrep --validate --config .semgrep.yml
semgrep --config .semgrep.yml camoufox_research/ scripts/ \
  --metrics=off --disable-version-check --error     # 0 findings

# 4) рукопожатие MCP (сколько тулов реально отдаётся)
~/.venvs/camoufox-research/bin/python scripts/mcp_probe.py --json
# срез профилей: пусто → дефолт 34; CAMOUFOX_CAPS=all → 62; ...=research,browser,session → 60

# 5) нагрузка (зомби/сироты/RSS) — 3 итерации
~/.venvs/camoufox-research/bin/python scripts/soak_probe.py 3

# 6) Docker (файлы поставки)
sh -n docker/entrypoint.sh && bash -n scripts/run_in_docker.sh
docker build --check -t camoufox-research:check .
```

## См. также

- `docs/RESEARCH-PLAYBOOK.md` — как выжимать полноту (рецепты и замеры).
- `docs/testing-live-flows.md` — живые сценарии (`CAMOUFOX_LIVE_TESTS=1`).
- `CONTRIBUTING.md` (ритуал правки), `docs/landmines.md` (грабли с прод-фиксами),
  `EXPERIENCE.md` (журнал опыта).
