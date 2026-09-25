# vibe-station

Версия плагина: `0.4.0`.

Режим «директор» для **opencode2**: `/vibe` — ты ведёшь воркер-сессии, сам править и запускать не можешь.
Порт vibe mode из omp (`@oh-my-pi/pi-coding-agent/src/vibe/*`, `src/tools/vibe.ts`,
`src/prompts/system/vibe-mode-active.md`).

- `/vibe [промпт]` — включить режим; повторный `/vibe` выключает его.
- `/vibe status` — расширение станции: роспись воркеров · `/vibe wall` — текстовый progress snapshot · `/vibe off` — выключить.
- Тулы директора: `vibe_spawn` (в т. ч. `readOnly: true` для аудита), `vibe_promote`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`, `vibe_todo`.
- Скилл `vibe-mode` — кладётся в канонический слой `~/.agents/skills` и в зеркала клиентов
  (`~/.config/opencode/skills`, `~/.claude/skills`, `~/.omp/agent/skills`, `~/.pi/agent/skills`): без зеркала
  opencode2 скилл не видит вовсе (проверено: `@vibe` в палитре показывает `@vibe-mode …`).

Зачем: два постоянных исполнителя работают параллельно, а директор только ставит задачи, читает результат и проверяет файлы.
Директор читает файлы и проверяет работу сам — словам воркера не верит.

    vibe_spawn(cli=fast, prompt="Переименуй поле X в Y в файлах A,B; критерий: тесты bun test зелёные")
      → id воркера, результат придёт сам, когда ход закончится
     vibe_spawn(cli=fast, readOnly=true, prompt="Проведи read-only аудит /path; не менять файлы")
       → id аудит-воркера с техническим read-only профилем
    vibe_send(session=<id>, message="теперь то же для модуля Z; прогони тесты")
    vibe_kill(session=<id>)

## Паритет с omp

| что | omp | vibe-station |
|---|---|---|
| команда | `/vibe [prompt]`, повторный `/vibe` выключает | тот же toggle; станция добавляет `status/list/show` и `off/stop/clear/disable` |
| вход при plan/goal | блокирует plan, active и paused goal | plan, active goal и paused goal блокируются через agent/session + modes-state; active loop не блокируется |
| тулсет директора | эфемерный набор `read` + `todo` + `vibe_*` (`activateVibeTools`) | нативный агент `vibe-director` (файл `agent/vibe-director.md`): V2 hard allowlist `read`, `question`, `skill`, `vibe_*`; `*/* deny` закрывает остальные native tools. `subagent` запрещён явно; `task` не является отдельным V2 action |
| промпт режима | `<vibe-mode>` в системный канал (`vibe-mode-active.md`) | **тело файла агента** `agent/vibe-director.md` — системный промпт читает сам клиент; плагин добавляет только живую роспись `<vibe-roster>` |
| воркеры | постоянные сессии-агенты (`sonic` для fast, `task` для good), живут между ходами | сессии opencode2 (`session.create({agent, model, location: {directory}})`), живут между ходами |
| результат хода | приезжает сам; `vibe_wait` забирает job и подтверждает доставку | job хранит свой `messageID`; конец подтверждает public `session.wait`, затем `vibe_wait` атомарно забирает полный result |
| `vibe_send` | `turn`, `steered` или `queued` | steer с durable outbox/id; подтверждённый rejection попадает в очередь и стартует одним следующим ходом |
| `vibe_kill` | отменяет job, teardown, tombstone | abort observer, interrupt, public wait/idle, затем dead-state; сессию переименовывает (`… (снят)`), потому что API не удаляет сессии. Внешние prompt/steer/synthetic сериализованы с teardown через lifecycle gate и поколения worker |
| выход | аборт текущего хода директора, убийство воркеров, возврат тулсета | так же: прерываем ход директора и воркеров, возвращаем агента |
| модели | роли `@smol` (fast) и `@task` (good) | requested: `model:` агента → `VIBE_FAST_MODEL`/`VIBE_GOOD_MODEL` → `small_model`; для явных worker-агентов без модели spawn блокируется; actual читается из `assistant.model`; если его нет — `unknown` |
| чего нет | TV-wall и мини-композер в рендере тулов, статусная строка `Vibe: on` | server plugin не имеет UI renderer; отдельный TUI entrypoint даёт footer-status, полный panel/TV-wall и streaming renderer пока нет |

### Live-аудит 24.09.2026

Проверка сохранённого transcript показала: серверный `switchAgent` переключает директора, но TUI может в следующем prompt снова отправить `build`. Поэтому станция не считает state-файл достаточной гарантией. Добавлен fail-closed `tool.execute.before`: при включённом vibe любой tool вне `read`, `question`, `skill`, `vibe_*` блокируется, даже если TUI прислал имя `build`. Это plugin-level защита, а не исправление TUI local store; полный native-safe TUI lifecycle остаётся platform limit.
В станции обычные `fast/good` используют явную модель агента и не переходят на модель директора при
ошибке agent lookup. Для разделения ролей используй `model:` в агентах или
`VIBE_FAST_MODEL`/`VIBE_GOOD_MODEL`. Фактическая модель результата читается только из assistant
message и не подменяется requested-значением.

Director prompt требует сначала короткий план, выбирает `fast` для механики и `good` для проектирования,
предупреждает о пересечении file scopes и проверяет каждый результат ручным чтением файлов.

### Native OMP parity

- Версия 2 state восстанавливает idle worker-ы после restart через native `session.get`; interrupted job только наблюдается, prompt не переотправляется.
- `lifecycleScope` привязывает roster к director session/agent/location; active worker sessions атрибутируются своему director, а неопределённый active-signal блокирует coordinator calls без kill.
- RPC wall отдаёт structured worker rows и обновляется по native events/revisions; старый text fallback сохранён.
- `/skill:<id>` в начале `/vibe` prompt передаётся как native `skills: [{ id }]`; неизвестный или пустой skill prompt отклоняется.
- `VIBE_MODEL_FALLBACK=default` — явный opt-in для `ctx.model.default()`; по умолчанию `none` сохраняет blocking при unresolved model.
- Native assistant `tokens` и timestamps дают tok/s; без валидных полей метрика не показывается.
- Controlled service restart probe не запускается автоматически при активных sessions; используйте disposable opt-in smoke.


`vibe_spawn(cli=fast|good, readOnly=true, prompt=...)` создаёт отдельного worker-аудитора с hard-deny
профилем. В текущем exact OpenCode2 подтверждены только `read` и `question`; shell, edit, write и
установка остаются запрещены. Обычные `fast/good` сохраняют полный доступ инструментов как в OMP.

После завершения read-only аудита idle worker можно явно перевести в coding-профиль без новой сессии:

```text
vibe_promote(session=<worker-id>, profile="coding")
vibe_send(session=<worker-id>, message="Теперь исправь найденную проблему...")
```

Promotion использует native `session.switchModel` и `session.switchAgent`, затем проверяет
`session.get`. Это не автоматическое расширение прав: при `promotion-failed` station оставляет состояние
неподтверждённым и блокирует новую координацию до reconciliation.

### Что пока адаптация, а не полный клон

- `vibe_todo` — список станции с optional `phase` и `blockedBy` ID; старый плоский state читается совместимо, а `legacy-N` ID проецируются без записи до следующей mutation.
- Директор — V2 hard allowlist через permissions (`*/* deny`, затем `read/question/skill/vibe_* allow`), а не старый denylist. Это проверено по installed V2 source: `core/src/permission.ts:87-97` (`evaluate`, last match) и `core/src/tool.ts:225-263` (snapshot фильтрует по action).
- Воркеры не порождают subagents: `subagent` запрещён. `task` не дублируется как permission: в installed V2 это не отдельный tool action, только compatibility/CLI alias.
- Restart: versioned native state rehydrates idle worker-ы; interrupted job остаётся retryable и не переотправляется. Legacy state без scope сохраняет прежний безопасный teardown; незакрытый result сохраняется как `needs-reaccept`, а не удаляется молча.
- Synthetic-доставка использует один сохранённый `syntheticID`: initial и retry отправляют exact ID, поэтому принятый-but-lost response не создаёт дубль. При неподтверждённом ack job может быть прочитан через `vibe_wait` как `delivery-unknown`; для этого состояния следующий turn разрешён только после явного consume.
- Exact `opencode 0.0.0-dev-19846` не предоставляет `ToolContext.signal`/`abort`: `vibe_wait` использует station-side timeout, а статус прямо говорит, что отмена ожидания не поддерживается.
- Длинный preview помечен `truncated="true"` и прямо говорит, что полный result доступен через `vibe_wait`.
- `model.variant` не теряется при создании worker или чтении модели сессии.
- `requested` и `actual` модели показываются отдельно; `actual` берётся только из свежего assistant message, без fallback на requested.
- Модели omp `@smol/@task` не читаются напрямую; используется явная V2-конфигурация станции (об этом ниже).

### Почему так нативно (и что плагином быть обязано)

Нативное в opencode2 — и этим пользуется режим:

- **агенты файлами**: `~/.config/opencode/agent/vibe-*.md` и `vibe-audit-*.md` — `description`, `mode`, `hidden`, `model`, `steps`, `permissions`
  из фронтматтера, тело файла = системный промпт (проверено зондом с «магической фразой»);
- **модель fast/good** — `model:` в файле агента главнее переменных окружения;
- **запреты** — `permissions` фронтматтера, а не глобальный реестр тулов (реестр бьёт по всем сессиям сразу);
- **команда** `/vibe` — обычная команда плагина с подписью формата в палитре.

Плагином обязано быть (конфиг этого не умеет):

- **воркер-сессии**: `session.create`, `prompt`, `synthetic`, `interrupt` — только API плагина;
- **доставка результатов** директору (аналог self-delivery асинхронных джобов в omp);
- **тулы** `vibe_*` — в opencode2 инструменты живут в реестре, файлового/конфиг-способа нет;
- **проверка агентов и выход** (возврат прежнего агента, снятие воркеров).

Чего нет в принципе — и почему результат всё равно тот же:

- **нативный TV-wall и мини-композер**: exact OpenCode2 `19846` не даёт server plugin UI renderer; отдельный TUI entrypoint
  добавляет `prompt.footer.status` через public RPC exact `19846`: TUI делает initial pull и обновляется по `rpc.vibe-wall.changed`; полный `session.panel` и per-tool renderer пока нет;
- **удаление сессий**: API их не удаляет; `vibe_kill` прерывает ход и переименовывает («снят») — продолжать разговор
  нельзя, как и в omp после kill;
- ~~**`todo` у директора**~~ — закрыто: свой `vibe_todo` (op: list/add/done/clear) хранит прогресс в состоянии станции,
  он виден в `/vibe wall`, `/vibe status` и уезжает директору в `<vibe-roster>`;
- **`execute`**: у omp такого тула нет, у нас он есть (код-режим) и обязан быть запрещён — иначе модель обходит
  запреты скриптом (в опыте — 96 сообщений футильных попыток).

## Как это работает

- **Состояние** — файл на сессию: `~/.local/state/vibe-station/<session>.json` (режим, прежний агент, роспись воркеров, jobs, очереди).
  Все read/modify/write транзакции закрыты межпроцессовым `.lock`; spawn держит lock через cap-check, `session.create` и commit,
  поэтому внешний writer не может потерять worker или провести cap. Воркер создаётся в `parent_session.get().location.directory`.
  В installed V2 public contract `session.create` принимает `location: Location.PublicRef`, а `schema/src/location.ts:14-17`
  у `PublicRef` оставляет только `directory`; `workspaceID` не передаётся и не изобретается.
- **Orphan и recovery** — после create пишется durable cleanup-journal. Если commit проиграл, а interrupt/rename не удались,
  следующий `setup` повторяет teardown по journal. Recovery сканирует только state/journals с `cwd === ctx.location.directory`;
  чужие каталоги не трогаются. Для orphan используется тот же bounded interrupt+public-idle boundary: без подтверждённого idle
  journal остаётся, а следующий `setup` повторяет cleanup. Непрочитанный результат после restart сохраняется как `needs-reaccept`;
  наблюдатели в памяти после restart не восстанавливаются.
- **Очередь steer** — durable outbox с exact `messageID`. Неясный transport-error оставляет тот же ID pending и не допускает повторную
  отправку; подтверждённый API-rejection переносит сообщение в очередь. Очередь соединяется через `\n\n` и запускается одним
  следующим turn (как `src/vibe/runtime.ts:1492-1495` в OMP). Ошибки записи state возвращаются тулом и не маскируются под `queued`.
- **Job identity и completion** — каждый job хранит exact OpenCode `messageID`, baseline и terminal result. Старый delayed
  `session.execution.*` не может завершить новый turn: сначала подтверждается `session.inbox.delivered` с тем же ID, затем
  public `session.wait({sessionID})`. Ошибка/обрыв wait оставляет job `retryable`; ложный terminal timeout не создаётся.
- **Wait claim** — `vibe_wait` снимает durable snapshot только своих workers, атомарно ставит claim через тот же lock и
  возвращает job одному consumer. Queued turn не подменяет старый job; synthetic и wait не могут оба забрать один результат.
- **Kill/timeout** завершают job только после подтверждённого API teardown/interrupt и public `session.wait`/idle. `kill`/disable ставят stopping/dead только
  после успешных interrupt+wait+rename; при ошибке state сохраняется для retry.
- **Агенты режима — нативные файлы конфига** (`~/.config/opencode/agent/vibe-{director,fast,good,audit-fast,audit-good}.md`, ставит установщик):
  `description`, `mode`, `hidden`, `model`, `steps`, `permissions` читает сам клиент, а **тело файла становится системным
  промптом** директора. Проверено опытом на зонде: агент из файла появился в `/api/agent` с правами из фронтматтера,
  `model: provider/id` и `steps: N` доехали, а модель в ответе процитировала «магическую фразу» из тела файла.
  Каталоги сканируются по `BP=["agent","agents","mode","modes"]` (в бинаре), набор ключей фронтматтера —
  `new Set(["variant", ...Object.keys(Config.Agent.fields)])`.
- **Запреты директора** — права нативного агента, а не глобальный реестр тулов (`tool.transform` бьёт по всем сессиям).
  В `agent/vibe-director.md` сначала стоит `*/* deny`, затем явные allow-правила; `core/src/permission.ts:87-97`
  и `core/src/tool.ts:225-263` подтверждают last-match и фильтрацию snapshot. Дополнительно plugin-level
  `tool.execute.before` закрывает write/exec tools, если TUI ошибочно прислал `build`. Плагин проверяет, что агенты стоят:
  нет — `/vibe` отвечает, что нужно `bin/vibe-station.sh install`.
- **Job identity и completion** — каждый job хранит exact OpenCode `messageID`, baseline и terminal result. Старый delayed
  `session.execution.*` не может завершить новый turn: сначала подтверждается `session.inbox.delivered` с тем же ID, затем
  public `session.wait({sessionID})`. Свежий assistant определяется относительно baseline; undocumented `parentID` и stale
  fallback не используются. Ошибка/обрыв wait оставляет job `retryable`; ложный terminal timeout не создаётся.
- **Доставка** — `<vibe-turn session=… cli=… turn=… status=… duration=… model=…>` с последними 40 tool calls, явным
  overflow и ответом воркера. Ошибка synthetic не теряется: station повторяет тот же сохранённый `syntheticID` с backoff;
  если state write или ack не подтверждены, результат остаётся в job и показывается как `delivery-unknown`/`needs-reaccept`.
  `VIBE_DELIVER=queue` кладёт результат в очередь вместо пробуждения хода директора. Preview длиннее 4000 знаков получает
  `truncated="true"` и указание на полный `vibe_wait`.
- **Потолок и timeout** — station показывает источник effective values: `VIBE_MAX_WORKERS` (station default `4`) и
  `VIBE_TURN_TIMEOUT_MS` (station default `30m`); invalid values показываются как fallback, а native OpenCode2 cap/timeout
  остаются `unverified`, не `unlimited`. Timeout вызывает interrupt и затем ждёт public idle; полный result остаётся доступен через `vibe_wait`.
- **Выключение** — `/vibe` повторно или `/vibe off`: воркеры прерываются и переименовываются, известный прежний агент
  возвращается. Если прежний агент не был записан, станция не врёт: state остаётся retryable, пока пользователь не переключит
  агент вручную и не повторит `/vibe off`. Любая API/state ошибка также оставляет retryable state.
- **Цели и циклы** — `/vibe` блокирует active/paused goal, но совместим с active loop, как в OMP.

## Откуда дефолты (сверено с omp и OpenCode)

Проверены установленные пакеты: `@oh-my-pi/pi-coding-agent@18.1.21` и `@opencode/cli@0.0.0-dev-19846`.
Во втором публичный plugin contract подтверждает `session.prompt({id,...})`, `session.wait({sessionID})`,
`event.subscribe()` и `Location.PublicRef`; станция не использует внутренние серверные методы.

| поведение | место в источниках |
|---|---|
| набор воркеров `fast`/`good` и их смысл | `src/prompts/system/vibe-mode-active.md`, `src/tools/vibe.ts:50` (`VIBE_TOOL_NAMES`) |
| fast = быстрая модель, good = сильная | `src/vibe/runtime.ts:51-57` (`VIBE_CLI_AGENT`: `sonic` c `@smol`, `task` c `@task`) |
| `vibe_spawn(cli, name?, prompt, readOnly?)`, `vibe_promote(session, profile="coding")`, `vibe_send(session, message)`, `vibe_wait(sessions?, timeout?)`, `vibe_kill(session)`, `vibe_list()` | `src/tools/vibe.ts:59-92` (OMP base) + native OpenCode2 `session.switchAgent` extension |
| окно `vibe_wait` 30 с | `src/vibe/runtime.ts:75-80` (`DEFAULT_WAIT_TIMEOUT_MS`) |
| snapshot job + single-consumer acknowledge | `src/vibe/runtime.ts:975-1057` |
| полная очередь steer и следующий turn | `src/vibe/runtime.ts:935-966`, `1492-1503` |
| максимум 40 activity entries | `src/vibe/runtime.ts:64-80`, `282-292` |
| результаты приезжают сами, `vibe_wait` — только при блокировке | `src/prompts/tools/vibe-wait.md`, `vibe-turn-result.md` |
| повторный `/vibe` выключает, план/цель блокируют вход | `src/modes/interactive-mode.ts` (`handleVibeModeCommand`, `#enterVibeMode`) |
| выход убивает воркеров и возвращает тулсет | `src/modes/interactive-mode.ts` (`#exitVibeMode`) |
| форма доставленного результата | `src/prompts/tools/vibe-turn-result.md` |

## Установка

    bin/vibe-station.sh install     # симлинки: server plugin, TUI footer, пять агентов, скилл
    bin/vibe-station.sh status
    bin/vibe-station.sh remove

Windows: `pwsh -File bin/vibe-station.ps1 install`. OpenCode2 config: `$XDG_CONFIG_HOME/opencode`, иначе `~/.config/opencode`; `VIBE_CONFIG_DIR` — только для изолированных тестов с `VIBE_ALLOW_UNSCANNED_CONFIG=1`.

Установщик ставит ссылками server plugin (`plugins/vibe-station.ts`), TUI-плагин (`plugins/vibe-station-tui/`),
агентов режима (`agent/vibe-{director,fast,good,audit-fast,audit-good}.md`) и скилл (`~/.agents/skills/vibe-mode` + зеркала клиентов → `skill/`) —
правь их прямо в конфиге или в станции.

**На новой машине** станция ставится центром набора: `center bootstrap` (шаг 7 — `vibe-station install`)
или `center fresh`. Связи проверяет `center doctor`; в реестре теперь есть server plugin, TUI plugin, пять агентов,
скилл в каноническом слое и его зеркала для клиентов, поэтому пропажа любой из них видна как расхождение, а не как «вроде работало».

**После правки server-файла — `opencode2 service restart`**: сервис держит plugin в памяти. TUI companion подхватывается новым TUI-клиентом или reload; main service в этой задаче не перезапускался.
Переменные: `VIBE_FAST_MODEL` / `VIBE_GOOD_MODEL` (`provider/model`), `VIBE_MAX_WORKERS`, `VIBE_DELIVER=queue|wake`, `VIBE_TURN_TIMEOUT_MS` (по умолчанию `1800000`), `VIBE_TEARDOWN_TIMEOUT_MS` (grace period OMP, по умолчанию `5000`), `VIBE_LOCK_TIMEOUT_MS` (по умолчанию `5000`), `VIBE_STATE_DIR`, `VIBE_LOG` (по умолчанию `/tmp/opencode/vibe.log`), `VIBE_DEBUG=0`.

## Проверка

Логика без модели (92 проверки): вход/выход, optional-agent restore, plan/active/paused goal, exact public location,
inter-process lock/cap, durable orphan cleanup, location-scoped recovery, ownership wait, public `session.wait` retryable
state, reconnect без нового setup, exact job identity против delayed terminal, atomic single-consumer claim, steer
idempotency/outbox, write-error truthfulness, stable synthetic ID, delivery-unknown/restart recovery, actual/requested model,
effective-limit status, text-wall projection, TUI/RPC snapshot projection и event invalidation, activity tail до 40,
installer safety/config override, kill/disable wait boundary, timeout, prompt rejection, permissions и `vibe_todo`.
Тесты event-driven: без polling и time-based sleep; failure guard — только у event/call waiters и коротких окон поведения.

    bun vibe-station/tests/logic.test.mjs
    node vibe-station/tests/logic.test.mjs      # node ≥ 22.18: типы снимает сам
    bun build vibe-station/plugin/opencode/vibe.ts --target=bun --outdir=/tmp/opencode/vibe-build

Установщик (10 тестов, bats):

    bats vibe-station/tests/station.bats

Живой прогон 23.09.2026 (opencode2, opencode-go/deepseek-v4.1-flash): сессия `build` → `/vibe «создай файл /tmp/vibe-live.txt
через воркера fast, проверь чтением и отчитайся»`. Транскрипт директора по шагам: `agent-switched` на `vibe-director` →

`vibe_spawn(cli=fast, name=make-file, prompt=<бриф>)` → `vibe_wait` → пришёл `<vibe-turn … status="succeeded" duration="6с">`

с трассой `shell` → директор сам прочитал `/tmp/vibe-live.txt` (`1: ok`) → `vibe_kill` → отчёт человеку.
Файл на диске: `ok`. Стоимость прогона: $0.0045. Затем `/vibe off` — агент вернулся в `build`, файл состояния снят.

Повторный прогон 23.09.2026 после перевода агентов в нативные файлы (там же): `/vibe «создай файл /tmp/vibe-live2.txt
через воркера fast, проверь чтением, покажи роспись и сними воркера»` — `vibe_spawn(cli=fast, name=tmpfile)` →
`vibe_wait` → `read /tmp/vibe-live2.txt` → `1: native` → `vibe_list` (в росписи видна модель) → `vibe_kill` → отчёт.
Файл на диске: `native`. Стоимость: $0.0048. Директор в обоих прогонах вёл себя ровно по тексту файла агента.

Третий прогон (23.09.2026, книжка прогресса и аборт хода на выходе): `/vibe «файл /tmp/vibe-live3.txt; веди через
vibe_todo, воркер fast, проверь чтением, закрой пункт, сними воркера»` — `vibe_todo(add)` → `vibe_spawn(fast)`
→ `vibe_wait` → доставка → `read` (`1: todo`) → `vibe_todo(done, index=1)` → `vibe_kill` → отчёт.
Файл на диске: `todo`; в состоянии сессии прогресс `[x] 1. Создать /tmp/vibe-live3.txt…` и один воркер `fast` с моделью.

## Грабли

- **Нельзя ждать ход модели внутри `setup`** — сервер ждёт возврата setup, ход не стартует: `session.prompt`
  висит, второй prompt в ту же сессию падает с внутренней ошибкой (проверено зондом). Вся работа — после возврата
  setup; первый промпт директора подаётся без `await` и по той же причине.
- **`session.prompt` — это admission receipt, не completion**: V2 dev-19846 принимает exact `messageID` и может завершить
  promise до конца turn. Станция сначала ждёт `session.inbox.delivered` для этого ID, затем использует public
  `session.wait({sessionID})`. Ошибка wait/event и timeout без interrupt-подтверждения оставляют job retryable.
- **Агенты — файлами, не трансформом**: `agent.transform` не умеет `add` (редактор: `list`, `get`, `default`, `update`,
  `remove`), а рантайм-агент не несёт системного промпта — файл `agent/*.md` несёт и права, и промпт, и модель.
- **`execute` и hard allowlist**: `agent/vibe-director.md` начинает с `*/* deny`; installed V2
  `core/src/tool.ts:225-263` не отдаёт запрещённый direct tool и не создаёт code-mode `execute`.
  Поэтому директор не может обойти права через codemode.
- **Сессии воркеров видны в списке клиента**: помечаются `vibe:<cli>#N <метка>`, при снятии получают «(снят)»;
  удалять сессии API opencode2 не умеет. Versioned state rehydrates existing sessions; если public API не подтверждает
  session, worker остаётся retryable и не заменяется автоматически.
- **`/vibe` и modes-station**: active/paused goal блокируют вход, active loop — нет (как в OMP). Обратной
  проверки `/goal` при активном vibe нет; не заводите оба режима в одной сессии.
