---
type: Post
title: Obelisk — локальный индекс сессий кодинг-агентов с поиском
description: Индексирует транскрипты Claude Code, Codex и Kimi Code в SQLite (теги
  источников, ID без пересечений); скилл учит агента писать JS-запросы к базе; память
  через obelisk --attune; Electron-десктоп с поиском, heatmap и рекапами; CLI и app
  синхронны.
date: 2026-08-11
tags:
- ai
- agents
- memory
- sqlite
- indexing
source: https://github.com/tommy0103/obelisk
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:49:01+00:00
permalink: wiki-vibecoding/ai/obelisk
---

# Obelisk — локальный индекс сессий кодинг-агентов с поиском

Оригинальный пост:

Obelisk — локальный индекс всех сессий кодинг-агентов, по которому агент может сам искать 🗂️🤖

📚 Индексирует транскрипты Claude Code, Codex и Kimi Code в единую SQLite-базу — источник помечается тегом, ID разных провайдеров не пересекаются.

🔍 Отдельный скилл учит агента писать JS-запросы к локальной базе и искать по истории сессий, включая под-агентов и workflow, а не только текущий чат.

🧠 Memory — агент регистрирует markdown-файл памяти командой obelisk --attune <script>; в новых сессиях память подтягивается как синтез-кэш, а не замена сырым логам.

🖥️ Десктоп-app на Electron: браузер сессий с поиском и фильтром по проекту, читаемые тул-коллы (диффы, вывод терминала), activity heatmap, недельный/месячный рекап.

🔌 CLI и app читают одну SQLite-базу — обе стороны всегда синхронны.

🚀 Установка (готовые сборки пока только под macOS):

git clone https://github.com/tommy0103/obelisk.git
cd obelisk/app && npm ci && npm run dev

🔗 Сайт: obelisk-website-henna.vercel.app
🔗 GitHub: github.com/tommy0103/obelisk

## Контекст

- Пост готовый, ссылки не проверялись (по указанию автора).
- Что: локальный индекс транскриптов агентов (Claude Code, Codex, Kimi Code) в SQLite: тег источника, непересекающиеся ID.
- Возможности из поста: скилл для агента — JS-запросы к базе (поиск по сессиям, под-агентам, workflow); memory (obelisk --attune <script>) — markdown-память как синтез-кэш поверх сырых логов; Electron-десктоп (браузер сессий, читаемые тул-коллы, heatmap, рекапы); CLI и app на одной базе.
- Установка: macOS-сборки (git clone + npm).

## Вывод

Obelisk — «наш research.db, но для сессий агентов»: индексация + поиск + память. Паттерн «агент ищет по своей истории» (ср. Memora, Continuum, PROJECT_STATUS.md) — состояние сессий становится данными, а не мусором. Electron+CLI на одной SQLite — правильная архитектура (единый источник правды).