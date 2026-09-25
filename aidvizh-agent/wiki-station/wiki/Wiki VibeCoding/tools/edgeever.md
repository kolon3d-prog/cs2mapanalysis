---
type: Post
title: EdgeEver — self-hosted замена Evernote на бесплатных тирах Cloudflare
description: 'Serverless и AI-native: разворачивается на бесплатных тирах Cloudflare
  (Workers + D1 + R2, до 150k заметок и 50k картинок) без Docker/Nginx/SSL; REST API,
  OpenAPI, MCP-эндпоинт для агентов; авто-тегирование, коннекторы Notion/Feishu; данные
  в своём Cloudflare-аккаунте.'
date: 2026-08-11
tags:
- tools
- notes
- selfhosted
- cloudflare
- mcp
source: https://edgeever.org/en/
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:12:35+00:00
permalink: wiki-vibecoding/tools/edgeever
---

# EdgeEver — self-hosted замена Evernote на бесплатных тирах Cloudflare

Оригинальный пост:

📓 EdgeEver (https://edgeever.org/en/) — self-hosted замена Evernote, serverless и AI-native

Опенсорс-проект, который разворачивается целиком на бесплатных тирах Cloudflare — без своего сервера и с нативной поддержкой AI-агентов.

☁️ Serverless и бесплатно навсегда
🚫 Никакого Docker, Nginx, SSL — деплой в один клик на Cloudflare
💰 100% на бесплатных тирах: Workers + D1 + R2 (до 150k заметок и 50k картинок)
🔐 Данные полностью твои — всё живёт в собственном Cloudflare-аккаунте, а не у третьей стороны

🤖 AI Agent native
🔌 Встроенный REST API, OpenAPI-схема и удалённый MCP-эндпоинт
🔗 Токен MCP подключается к Codex, Claude Code, Antigravity и подобным инструментам
🏷 Годится для авто-тегирования, чистки knowledge graph, кросс-заметочного поиска
🔄 Умеет коннектиться и к Notion/Feishu Bitable, превращая разрозненные заметки в структурированные данные

📝 Классика для миграции с Evernote
🌲 Безлимитные вложенные блокноты, TipTap-редактор с историей версий

📦 Открытые данные
Всё хранится как Markdown/JSON/plain text в SQLite

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: self-hosted заметки на бесплатных тирах Cloudflare (Workers + D1 + R2): без своего сервера/Docker/SSL; до 150k заметок и 50k картинок; данные в своём аккаунте.
- AI-native: REST API + OpenAPI + удалённый MCP-эндпоинт (Codex, Claude Code, Antigravity); авто-тегирование, knowledge graph, кросс-заметочный поиск; коннекторы Notion/Feishu.
- Данные: Markdown/JSON/plain text в SQLite; TipTap-редактор; классика миграции с Evernote.

## Вывод

Показательный пример «бесплатного serverless» (ср. Cloudflare Skills, cloudflare-imgbed): заметки на чужих бесплатных тирах, но в своём аккаунте = контроль данных. MCP-эндпоинт для агентов — наш жанр. Для личной базы знаний — реальная альтернатива Evernote/Notion без своего сервера.