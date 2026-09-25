---
type: Post
title: BrowserOS — браузер с ИИ-агентом на уровне Chromium
description: 'Форк Chromium: агент вшит в сам браузер (не расширение); 53+ инструмента
  автоматизации, 40+ интеграций (Gmail, Slack, GitHub, Linear, Notion); BYO AI — 11+
  провайдеров или локально Ollama/LM Studio; MCP-сервер для Claude Code/Cursor; адблок
  uBlock MV2; 10K+ звёзд, AGPL-3.0.'
date: 2026-08-11
tags:
- tools
- browser
- agents
- automation
- privacy
source: https://github.com/browseros-ai/BrowserOS
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:03:57+00:00
permalink: wiki-vibecoding/tools/browseros
---

# BrowserOS — браузер с ИИ-агентом на уровне Chromium

Оригинальный пост:

BrowserOS — браузер, в который AI-агент встроен на уровне Chromium, а не как расширение 🌐🤖

Устал, что "AI-браузеры" вроде Comet или Atlas гоняют твои запросы через чужое облако и чужую модель? BrowserOS это чинит.

🏠 Форк Chromium с привычным интерфейсом Chrome: работают все расширения, импорт данных из Chrome в один клик.

🛠 53+ встроенных инструмента браузерной автоматизации плюс 40+ интеграций с приложениями (Gmail, Slack, GitHub, Linear, Notion) — агент вшит в сам браузер, а не ограничен API расширений, поэтому может фоново запускать задачи по расписанию.

🔑 Bring your own AI: 11+ провайдеров — Claude, OpenAI, Gemini, ChatGPT Pro через OAuth, или полностью локально через Ollama/LM Studio. Данные и история остаются на вашей машине.

🔌 BrowserOS как MCP-сервер: можно управлять браузером прямо из Claude Code, Cursor или любого MCP-клиента — и наоборот, чатиться с текущей страницей из бокового меню.

🚫 Встроенный адблок на базе uBlock Origin с полной поддержкой Manifest V2.

⭐️ 10k+ звёзд, 1k форков на GitHub
🔓 AGPL-3.0, open source

🔗 GitHub: github.com/browseros-ai/BrowserOS
🌐 Сайт: browseros.com

## Контекст

- Пост готовый, ссылки не проверялись (по указанию автора).
- Что: Chromium-форк с агентом на уровне ядра: 53+ инструментов автоматизации, 40+ интеграций (Gmail, Slack, GitHub, Linear, Notion), фоновые задачи по расписанию.
- BYO AI: 11+ провайдеров или локально (Ollama/LM Studio); данные и история на машине.
- MCP: браузер управляется из Claude Code/Cursor и наоборот; адблок uBlock MV2; 10K+★, AGPL-3.0.

## Вывод

«Агент вшит в браузер, а не приклеен расширением» (ср. ego-lite, Argos): глубже интеграция = больше возможностей (фоновые задачи, расписания). MCP-двусторонность — браузер как инструмент агентов и наоборот. BYO AI с локальным режимом — приватность. Сильный кандидат для агентной веб-автоматизации.