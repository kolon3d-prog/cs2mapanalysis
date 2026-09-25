---
type: Howto
title: Codemap — интерактивная карта репозитория для Codex (docs/codemap/)
description: 'Совет по вайбкодингу: попросить Codex создать интерактивную карту репозитория
  (docs/codemap/codemap.html + .json + .lock) и отмечать изменения; полный промпт
  внутри поста; правило для AGENTS.md о синхронизации карты.'
date: 2026-08-11
tags:
- coding
- agents
- prompts
- visualization
- workflow
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:41:03+00:00
permalink: wiki-vibecoding/coding/codemap
---

# Codemap — интерактивная карта репозитория для Codex (docs/codemap/)

Оригинальный пост:

Совет по вайбкодингу: попросите Codex создать интерактивную карту вашего репозитория, а затем отмечать, какие модули изменились с момента её генерации.

Нажав на любой модуль, можно увидеть его вызывающие компоненты, зависимости, основные потоки выполнения, связанные тесты и подтверждающие данные из исходного кода.

Он создаёт:
→ docs/codemap/codemap.html
→ docs/codemap/codemap.json
→ docs/codemap/codemap.lock

Полный промпт ↓

Analyze the current codebase. Do not modify product code. Only create or update files under docs/codemap/.

Ignore vendor, build, dist, cache, and other generated directories.

If docs/codemap/ already exists, first compare the existing codemap.lock with the current repo and list the modules that changed. Then regenerate these three files together:

1. docs/codemap/codemap.html

Build a fully self-contained interactive code map that opens directly in a browser. Include:

- major modules, services, databases, queues, and external dependencies
- no more than 20 primary nodes; group low-level files under their parent module
- calls and data flows between modules
- the 3-5 most important end-to-end flows
- a clear dark theme by default
- system boundaries and the most important data flows visible on the first screen
- color-coded module types with a simple legend
- automatic layout that minimizes crossing edges
- clicking any module highlights its upstream callers, downstream dependencies, related tests, and the flows it belongs to
- selecting a flow highlights its complete path
- search, filtering, zoom, and drag controls

At the top, show the repo name, generation time, and the commit it was generated from.

2. docs/codemap/codemap.json

Use this structure:

{
  "generated_at": "",
  "generated_from_commit": "",
  "scope": [],
  "nodes": [],
  "edges": [],
  "flows": []
}

Each node must include:

- id
- path
- role
- entrypoints
- tests
- constraints
- evidence

Each edge must include:

- from
- to
- type
- evidence

type may only be:

- imports
- calls
- reads
- writes
- publishes
- subscribes

Each flow must include:

- trigger
- steps
- outcome

Every step must reference an existing node id.

Attach the matching source path and symbol to every node and edge. Mark any relationship without source evidence as unknown. Do not guess.

3. docs/codemap/codemap.lock

Use parseable JSON to record:

- the current commit
- whether the working tree has uncommitted changes
- generation time
- scanned scope
- excluded directories
- the fingerprint algorithm
- a deterministic fingerprint for each top-level module, calculated from its tracked file paths and current file contents

If no existing codemap.lock is found, treat every module as new and generate the full map.

When finished, verify that:

- codemap.json parses successfully
- every node path exists and every evidence symbol can be found in the source
- every edge and flow step references an existing node
- codemap.html and codemap.json use the same nodes, edges, and flows
- codemap.lock matches the current commit, working tree state, and module fingerprints
- every relationship without source evidence is marked unknown

These three files must always be generated together from the current repo. Never edit only one of them manually.

Finally, show:

- files created or modified
- stale modules
- remaining unknowns
- validation results
- the complete diff

Ещё один момент. Добавьте правило в AGENTS.md, чтобы карта кода всегда оставалась синхронизированной с репозиторием:

At the start of every code-changing task, compare the current repo with docs/codemap/codemap.lock.

## Контекст

- Пост готовый, ссылок нет (по указанию автора).
- Что: совет + полный промпт: агент генерирует интерактивную карту репозитория (3 файла в docs/codemap/).
- Состав: codemap.html (self-contained интерактивная карта: ≤20 узлов, потоки, тёмная тема, клики с подсветкой зависимостей/тестов, поиск/зум); codemap.json (структура: nodes с evidence, edges только 6 типов, flows со ссылками на node id, «не угадывай — помечай unknown»); codemap.lock (commit, рабочее дерево, отпечатки модулей для детекции изменений).
- Правило для AGENTS.md: в начале каждой кодовой задачи сравнивать репо с codemap.lock.
- Принципы промпта: не менять продуктовый код, только docs/codemap/; evidence для каждой связи; валидация после генерации; «Do not guess».

## Вывод

Отличный пример «карта кода как артефакт проекта»: граф, который живёт в репо и обновляется агентом (ср. наш code-review-graph и db-tools — но здесь карта в виде файлов в репозитории). Принципы промпта — прямо наши: evidence, no guess, валидация, lock для синхронизации. Сильный кандидат в наш инструментарий для проектов.