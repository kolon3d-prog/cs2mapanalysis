---
type: Post
title: Design Craft — готовые design skills для AI-агентов
description: 'Open-source репозиторий от HEADLINE Design с правилами дизайна для AI-кодинг
  агентов: 3–5 цветов, до 2 шрифтов, mobile-first, semantic tokens, обязательные states,
  accessibility, анти-паттерны «AI UI» (фиолетовые градиенты, blobs).'
date: 2026-08-11
tags:
- tools
- design
- ui
- agents
- skill
source: https://github.com/headline-design/design-craft
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:25:44+00:00
permalink: wiki-vibecoding/tools/design-craft
---

# Design Craft — готовые design skills для AI-агентов

Оригинальный пост:

🎨 Design Craft — готовые design skills для AI-агентов
Open-source репозиторий от HEADLINE Design, который добавляет AI-кодинг агентам «вкус» к UI без постоянных длинных инструкций.
Идея: подключаешь SKILL.md с правилами дизайна и получаешь более адекватный интерфейс из коробки.
Поддержка: Claude, Gemini, v0, Lovable.
Внутри правила вроде:
• 3–5 цветов максимум
• до 2 шрифтов
• mobile-first
• semantic design tokens
• обязательные states (hover/focus/active/disabled)
• accessibility
• нормальная компонентная архитектура
• performance best practices
• анти-паттерны AI-дизайна
Фокус — убрать типичный «AI UI»: фиолетовые градиенты, декоративные blobs, отсутствующие focus states и монолитные компоненты.
По сути — это слой дизайн-экспертизы для coding agents, который можно просто подключить в контекст и сразу улучшить качество интерфейсов.
Репозиторий:
https://github.com/headline-design/design-craft
MIT, можно свободно использовать.

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: набор design-правил в формате SKILL.md для AI-кодинг агентов (Claude, Gemini, v0, Lovable); MIT.
- Правила из поста: лимиты (3–5 цветов, до 2 шрифтов), mobile-first, semantic design tokens, обязательные states (hover/focus/active/disabled), accessibility, компонентная архитектура, performance, анти-паттерны AI-дизайна (фиолетовые градиенты, blobs, отсутствие focus states, монолитные компоненты).

## Вывод

Design Craft — пример «экспертиза как скилл»: вместо длинных инструкций каждый раз — подключённый SKILL.md, который меняет поведение агента. Прямо в нашей логике (скиллы = документированный опыт). Анти-паттерны «AI UI» — ценный список сам по себе: по нему можно ревьюить и свои генерации.