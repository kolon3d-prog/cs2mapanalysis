---
type: Post
title: 'FreeLLMAPI — локальный прокси: 82+ моделей бесплатно'
description: 'Локальный прокси с UI: 82+ модели, 0₽; ключи от 12+ провайдеров (Mistral,
  Groq, Cerebras, SambaNova, NVIDIA, OpenRouter, GitHub tokens, Cohere, Cloudflare,
  Google AI Studio, BigModel, Pollinations); роутинг, fallback при 429, слежение за
  квотами; OpenAI-совместимый; для Pi CLI, Claude Code, Cursor и др.'
date: 2026-08-11
tags:
- tools
- llm
- proxy
- api
- free
source: https://github.com/tashfeenahmed/freellmapi
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:12:35+00:00
permalink: wiki-vibecoding/tools/freellmapi
---

# FreeLLMAPI — локальный прокси: 82+ моделей бесплатно

Оригинальный пост:

🔥 1 ЭНДПОИНТ · 82 МОДЕЛИ + · 0₽ БЕСПЛАТНО

FreeLLMAPI (https://github.com/tashfeenahmed/freellmapi) — локальный прокси с UI. В 1 клик добавляешь халявные ключи от 12+ провайдеров. Сам рутит, сам fallback при 429, сам следит за квотами. Ты в ИИ: промт → POST localhost:3001/v1/chat/completions → он решает через кого.

Куда воткнуть: всё что умеет OpenAI API — Pi CLI, Opencode, Claude Code, Aider, Cline, Cursor, любой скрипт. Меняешь base_url и готово.
Где ключи (все бесплатно, без карты):
🔑 console.mistral.ai/api-keys
🔑 console.groq.com/keys
🔑 cloud.cerebras.ai
🔑 cloud.sambanova.ai
🔑 build.nvidia.com
🔑 openrouter.ai/keys
🔑 github.com/settings/tokens (пустые scopes)
🔑 dashboard.cohere.com/api-keys
🔑 dash.cloudflare.com → Workers AI → REST API
🔑 aistudio.google.com/apikey
🔑 open.bigmodel.cn
- Pollinations / Kilo / LLM7

UI: localhost:3001 → Add Key → выбрал → вставил → клик. 12 ключей за 3 минуты. Без JSON-а.
Скорость: Groq/Cerebras/SambaNova — мгновенно. Qwen3 480B через Groq быстрее платного GPT. Не Claude Opus конечно, но для прототипов и тестов — имба.

Итог: 10 минут покликать → 82+ халявные модели навсегда. Вставляй куда угодно.

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: локальный OpenAI-совместимый прокси: 82+ моделей, ключи 12+ бесплатных провайдеров (Mistral, Groq, Cerebras, SambaNova, NVIDIA, OpenRouter, GitHub tokens, Cohere, Cloudflare, Google AI Studio, BigModel, Pollinations/Kilo/LLM7); роутинг + fallback при 429 + квоты; UI для добавления ключей.
- Интеграции: Pi CLI, Opencode, Claude Code, Aider, Cline, Cursor — смена base_url.

## Вывод

Практичный «халявный роутер» (ср. OmniRoute, FreeLLM — каталог): один эндпоинт для всех бесплатных тарифов. ⚠️ Для продакшена ненадёжно (бесплатные тарифы меняются, GitHub-token с пустыми scopes — на грани ToS). Для прототипов/тестов — удобно. Паттерн «роутер + fallback + квоты» — правильная архитектура.