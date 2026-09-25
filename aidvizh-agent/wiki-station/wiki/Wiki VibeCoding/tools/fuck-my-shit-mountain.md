---
type: Post
title: Fuck My Shit Mountain — скилл беспощадного аудита кода агентами
description: 'Скилл для Codex, Claude Code, Copilot, Gemini: честная проверка проекта
  вместо похвалы; профиль репо, отчёт с уликами (severity/confidence/evidence/impact/fix),
  25 режимов (security, ai-safety, testing-authenticity — «зелёные, но фейковые тесты»,
  cost, accessibility...); Markdown/HTML с баллами 0-10.'
date: 2026-08-11
tags:
- tools
- skill
- code-review
- audit
- testing
source: https://github.com/XiNian-dada/Fuck_My_Shit_Mountain
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:12:35+00:00
permalink: wiki-vibecoding/tools/fuck-my-shit-mountain
---

# Fuck My Shit Mountain — скилл беспощадного аудита кода агентами

Оригинальный пост:

🏔 Fuck My Shit Mountain (https://github.com/XiNian-dada/Fuck_My_Shit_Mountain) — скилл для беспощадного аудита кода AI-агентами

Название с юмором, но подход максимально серьёзный: скилл для Codex, Claude Code, Copilot, Gemini, который заставляет агента честно проверить проект вместо того, чтобы хвалить его.

📋 Как работает:

🗺 Сначала строит профиль репозитория: язык, фреймворк, точки входа, тесты, зависимости, CI, конфиги

📊 Выдаёт отчёт с уликами: severity, confidence, evidence, impact, fix guidance, идеи для регресс-тестов — не "плохо", а "вот почему и что делать"

🎯 Разделяет подтверждённые проблемы и риски, требующие проверки

📈 Для каждого измерения — уровень уверенности покрытия: High/Medium/Low/Not assessed

🧩 25 режимов аудита на выбор:

🔐 security, privacy, supply-chain
⚙️ stability, performance, architecture
🧪 testing, testing-authenticity (лечит "зелёные, но фейковые" тесты)
🤖 ai-safety (prompt injection, авторизация тулов, RAG-утечки)
💸 cost, dependency-weight
♿️ accessibility, frontend-state, backend-api
📝 documentation, code-consistency, comment-coverage
...и ещё десяток

🖥 Отчёт можно получить в Markdown или HTML — со шкалами баллов (0-10), coverage-матрицей, топ-рисками и планом устранения по приоритету (fix now / before release / schedule)

⚙️ Установка простая — клонируешь репо и кидаешь папку fuck-my-shit-mountain/ в ~/.claude/skills/ (или аналог для Codex/Copilot/Gemini)

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: скилл жёсткого аудита: профиль репо → отчёт с уликами (severity/confidence/evidence/impact/fix), разделение подтверждённого и рисков, покрытие High/Medium/Low.
- 25 режимов: security, privacy, supply-chain, stability, performance, architecture, testing, testing-authenticity («фейковые» тесты), ai-safety (prompt injection, авторизация тулов, RAG-утечки), cost, dependency-weight, accessibility, frontend-state, backend-api, documentation и др.
- Отчёт: Markdown/HTML, баллы 0-10, coverage-матрица, топ-риски, план (fix now / before release / schedule).

## Вывод

Сильный пример «скилла-ревьюера» (ср. Prelint, Open Code Review, наш fable-judge): «не плохо, а вот почему и что делать» + evidence. Режим testing-authenticity (лечит «зелёные, но фейковые» тесты) — прямо наш тезис о честных тестах. ai-safety режим — prompt injection/RAG-утечки. Кандидат для аудита наших проектов.