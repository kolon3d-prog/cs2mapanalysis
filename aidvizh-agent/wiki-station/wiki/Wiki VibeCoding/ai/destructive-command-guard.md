---
type: Post
title: Destructive Command Guard — защита от деструктивных команд агента
description: 'Инструмент защиты от деструктивных действий агента: guard против опасных
  команд в актуальных репозиториях.'
date: 2026-08-11
tags:
- ai
- agents
- security
- safety
- tools
source: https://github.com/Dicklesworthstone/destructive_command_guard
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:12:35+00:00
permalink: wiki-vibecoding/ai/destructive-command-guard
---

# Destructive Command Guard — защита от деструктивных команд агента

Оригинальный пост (краткий):

https://github.com/Dicklesworthstone/destructive_command_guard наткнулся недавно не помню где, тоже для защиты от деструктивных действий агента актуальных репозиториев GitHub для продуктивной разработки

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: guard против деструктивных команд агента (например, rm -rf, git push --force и т.п.) — защита репозиториев от опасных действий (подробности в репозитории).

## Вывод

Safety-слой для агентов (ср. наш «необратимые решения — только со спроса»): защита от деструктивных команд — обязательный элемент для автономных агентов. Для наших CLI-агентов — стоит рассмотреть как дополнение к уровням допуска (Ask/Full Access у CodeWhale).