---
type: Post
title: Modern Web Guidance — не даём агенту тащить лишние зависимости
description: 'Инструмент учит агентов использовать актуальные API веб-платформы: CSS
  Anchor Positioning вместо Floating UI, <dialog> вместо самодельного модала, scheduler.yield()
  вместо useMemo; Baseline в AGENTS.md/CLAUDE.md; npx modern-web-guidance@latest install;
  ранняя версия.'
date: 2026-08-11
tags:
- coding
- agents
- web
- standards
- optimization
source: https://blog.logrocket.com/chromes-modern-web-guidance-prevent-ai-coding-agents/
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:49:01+00:00
permalink: wiki-vibecoding/coding/modern-web-guidance
---

# Modern Web Guidance — не даём агенту тащить лишние зависимости

Оригинальный пост:

Modern Web Guidance: не даём ИИ-агенту тащить лишние зависимости

Просишь агента сделать модалку — получаешь портал, setTimeout и лишнюю библиотеку. Modern Web Guidance учит агента использовать актуальные API веб-платформы.

Устанавливается через npx modern-web-guidance@latest install или плагин для редактора. Укажите целевой Baseline в AGENTS.md/CLAUDE.md — и агент спросит, можно ли обойтись браузером.

В демо это сработало: CSS Anchor Positioning вместо Floating UI для тултипа, нативный <dialog> вместо самодельного модала, scheduler.yield() вместо useMemo при поиске по 2000 задач.

Сразу говорю, версия ранняя. Но идея здравая: ИИ-код должен ориентироваться на актуальную платформу. Подробности (https://blog.logrocket.com/chromes-modern-web-guidance-prevent-ai-coding-agents/).

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: инструкция/плагин для агентов — использовать актуальные веб-платформенные API вместо лишних библиотек.
- Механика из поста: указание целевого Baseline в AGENTS.md/CLAUDE.md; агент спрашивает, можно ли обойтись браузером; установка npx modern-web-guidance@latest install или плагин редактора.
- Демо: CSS Anchor Positioning вместо Floating UI (тултип); нативный <dialog> вместо модала; scheduler.yield() вместо useMemo (поиск по 2000 задач).
- Статус: ранняя версия.

## Вывод

Паттерн «платформа прежде библиотеки» — наш KISS/architecture-simplicity в действии: меньше зависимостей = меньше веса и уязвимостей. Для нас ценно: добавить такой принцип в наши правила для агентов («сначала браузер/стандарт, потом библиотека»). Связано: наш YAGNI-фильтр.