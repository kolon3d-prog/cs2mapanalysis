---
type: Post
title: nodumbmode — скиллы, мешающие ИИ-агентам делать глупости и сжигать токены
description: 'Набор из 4 скиллов от hronicasync: nodumb (манифест здравого смысла),
  changelog-discipline (журнал решений), system-feedback (понятно ли юзеру), ask-nodumb
  (дизайнер-консультант); собраны из реальных ошибок в проектах; установка одной командой.'
date: 2026-08-11
tags:
- tools
- skill
- agents
- prompts
- productivity
source: https://github.com/hronicasync/nodumbmode
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:32:50+00:00
permalink: wiki-vibecoding/tools/nodumbmode
---

# nodumbmode — скиллы, мешающие ИИ-агентам делать глупости и сжигать токены

Оригинальный пост:

🧨 Появился набор скиллов, которые мешают ИИ-агентам делать глупости и сжигать токены — ру дизайнер выкатил nodumbmode для фикса типичных ошибок.

Внутри лежат 4 скилла:

→ nodumb (https://github.com/hronicasync/nodumbmode/blob/main/nodumb/SKILL.md) — манифест здравого смысла для агента и набор главных рекомендаций.
→ changelog-discipline (https://github.com/hronicasync/nodumbmode/blob/main/changelog-discipline/SKILL.md) — ведёт журнал решений и записывает, что поменялось, почему и что отвергли.
→ system-feedback (https://github.com/hronicasync/nodumbmode/blob/main/system-feedback/SKILL.md) — проверяет, понятно ли юзеру, что произошло после действия и что делать при ошибке.
→ ask-nodumb (https://github.com/hronicasync/nodumbmode/blob/main/ask-nodumb/SKILL.md) — дизайнер-консультант, который разбирает продуктовую или UX-задачу до проектирования решения.

Самое крутое — все скиллы собраны из реальных ошибок в проектах и новый скилл появляется только после конкретного фейла.

Ставится за одну команду:

npx skills@latest add hronicasync/nodumbmode

Сохраняем — тут (https://github.com/hronicasync/nodumbmode).

@notboring_tech

## Контекст

- Пост готовый, ссылки не проверялись (по указанию автора).
- Что: репозиторий с 4 скиллами против типичных ошибок агентов: nodumb (здравый смысл), changelog-discipline (журнал решений), system-feedback (понятность юзеру), ask-nodumb (продуктовый консультант).
- Философия (из поста): скиллы собраны из реальных ошибок; новый скилл — только после конкретного фейла.
- Установка: `npx skills@latest add hronicasync/nodumbmode`.

## Вывод

⚠️ Важно: эти 4 скилла УЖЕ установлены и используются в нашем воркспейсе (AGENTS.md: «СКИЛЛЫ НА КАЖДУЮ ЗАДАЧУ: nodumb, ask-nodumb, system-feedback, changelog-discipline»). Пост — подтверждение, что мы на верном пути: философия «скилл после фейла» совпадает с нашей («грабля = правило в канон»).