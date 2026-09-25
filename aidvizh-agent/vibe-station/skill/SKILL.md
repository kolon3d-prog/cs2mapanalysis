---
name: vibe-mode
description: >-
  Режим директора /vibe в opencode2 (порт vibe mode из omp): главная сессия только читает и проверяет, работу
  делают постоянные воркер-сессии fast/good. Использовать, когда просят «включи vibe», «поработай директором»,
  «запусти воркеров», «распараллель задачи между агентами», «vibe mode», «worker sessions», а также когда нужно
  объяснить, поставить или починить станцию vibe-station.
---

# vibe-режим (opencode2)

`vibe-director` оставляет только `read`, `question`, `skill` и `vibe_*`; hard deny
закрывает остальные V2 tools. Работу делают **воркер-сессии**: отдельные сессии opencode2
с полным набором инструментов, каждая помнит свой разговор между ходами.

В omp этот режим встроен; в opencode2 его даёт станция `vibe-station` (`~/.config/opencode/plugins/vibe-station.ts`,
TUI footer `~/.config/opencode/plugins/vibe-station-tui/` и агенты `~/.config/opencode/agent/vibe-{director,fast,good,audit-fast,audit-good}.md`). Директор использует V2
permissions как hard allowlist: `read`, `question`, `skill` и `vibe_*`; `subagent` и
остальные native tools запрещены правилом `*/* deny`. Обычные `fast/good` сохраняют полный доступ;
`readOnly=true` выбирает отдельный технически закрытый профиль. `task` — лишь имя режима/CLI,
не отдельный V2 action.

## Когда брать

`/vibe` не запускается при active или paused goal. Active loop совместим с режимом — это совпадает с OMP.

- задачи распадаются на 2+ независимых воркстрима (можно вести параллельно);
- есть механическая часть (переименования, массовые правки, сбор данных, прогоны тестов) — её отдаём `fast`;
- есть часть на суждение (проектирование, хитрый дебаг, многофайловые изменения) — её отдаём `good`;
- нужен контроль: результат каждого воркера проверяется чтением файлов, а не словами.

Не брать, если работа одна нитка и зависима по шагам: тогда обычный режим дешевле. В omp для разовых
параллельных задач есть `task`-подагенты; в этой станции те же задачи ведут постоянные `vibe_*` воркеры.

## Тулы директора

| тул | параметры | что делает |
|---|---|---|
| `vibe_spawn` | `cli: fast\|good`, `prompt`, `name?`, `readOnly?` | создаёт постоянную воркер-сессию и подаёт первый ход; `readOnly=true` выбирает технически закрытый audit-профиль |
| `vibe_promote` | `session`, `profile="coding"` | переводит уже idle audit-worker в coding-профиль через native `switchAgent`; session ID и история сохраняются |
| `vibe_send` | `session`, `message` | steer с durable outbox/id; подтверждённый rejection сохраняется в очереди, неясный receipt не отправляется повторно; idle-воркер получает новый turn |
| `vibe_wait` | `sessions?`, `timeout?` | ждёт **конкретный** job/turn (окно 30 с, перевызывается); completion подтверждён public `session.wait`; durable single-consumer claim возвращает полный result и не допускает duplicate synthetic |
| `vibe_kill` | `session` | прерывает ход и снимает воркер (разговор продолжить уже нельзя) |
| `vibe_list` | — | роспись: id, тип, состояние, модель, ходы, очередь steer, последний результат |
| `vibe_todo` | `op: list\|add\|done\|clear`, `text?`, `index?`, `phase?`, `blockedBy?` | книжка прогресса директора; `blockedBy` принимает stable todo IDs (воркеры её не ведут) |

`/vibe wall` и `vibe_list` — pull-based snapshot станции: активные jobs, unread results, delivery и todos. TUI footer использует public RPC: initial pull + `rpc.vibe-wall.changed`, поэтому обновляется live; полный panel/TV-wall — отдельный следующий шаг.

Native recovery: versioned state rehydrates idle worker-ы через `session.get`; interrupted prompt не переотправляется. При смене director scope старые worker-ы suspend-ятся, но не убиваются.

Результаты ходов приходят сами — скрытой синтетикой `<vibe-turn …>` с последними 40 tool calls, model и ответом воркера.
Если `vibe_wait` уже получил job, synthetic для этого job не отправляется повторно. Ответ `retryable` означает «конец не подтверждён»:
повтори `vibe_wait`; не перезапускай prompt вручную.

## Этикет

1. Бриф в `vibe_spawn` — самодостаточный: файлы, ограничения, критерии приёмки. Воркер не видит ваш разговор.
2. Один воркстрим — одна сессия. Продолжение и правки — `vibe_send` в ту же сессию, не новый `vibe_spawn`.
3. На каждый результат: прочитать тронутые файлы, сверить с критериями, только потом строить дальше.
4. `good` проектирует, `fast` исполняет механику; застрял `fast` — эскалируй в `good`.
5. Воркстрим закрыт — `vibe_kill`. Завис — тоже `vibe_kill` (ход прервётся).
6. Выход из режима: `/vibe` (или `/vibe off`) — ход директора прервётся, воркеры снимутся, известный прежний агент вернётся.
   Если API teardown, state или прежний агент не подтверждены, режим не объявляется выключенным: исправь и повтори `/vibe off`.
7. После аудита не выдавай права текстом. Дождись idle и вызови `vibe_promote`; при `promotion-failed` остановись и сообщи причину.

## Модели

Порядок: `model:` в файле агента (`agent/vibe-fast.md`) → `VIBE_FAST_MODEL`/`VIBE_GOOD_MODEL` →
`small_model` из конфига (для fast). Для явного worker-агента без модели spawn блокируется:
модель директора не используется как fallback. Если явно задан `VIBE_MODEL_FALLBACK=default`,
разрешён только native `ctx.model.default()`; по умолчанию fallback выключен. Фактическая модель берётся только из assistant
message и показывается отдельно от `requested`. После правки файла агента — `opencode2 service restart`.

## Станция: установка и проверка

    vibe-station/bin/vibe-station.sh install    # server plugin + TUI footer + пять агентов + этот скилл
    vibe-station/bin/vibe-station.sh status
    vibe-station/bin/vibe-station.sh remove

    bun vibe-station/tests/logic.test.mjs       # 92 проверки без модели (стенд подменяет session/agent/tool API)
    bats vibe-station/tests/station.bats        # 10 тестов установщика

Признаки здоровья: `/vibe status` отвечает росписью, `opencode2 api GET /api/agent` показывает
`vibe-director/vibe-fast/vibe-good/vibe-audit-fast/vibe-audit-good`, после `/vibe` сессия работает под `vibe-director` и её правки запрещены.
Переживание restart: versioned native state восстанавливает idle worker-ы; interrupted job наблюдается без replay prompt.
Если public API не подтверждает session, worker остаётся retryable и не заменяется автоматически.
