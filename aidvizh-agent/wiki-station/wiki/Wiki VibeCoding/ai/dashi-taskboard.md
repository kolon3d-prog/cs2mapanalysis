---
type: Post
title: Dashi Taskboard — канбан-доска для Codex с API, CLI и скиллом
description: 'Канбан-доска для Codex: создание задач, отслеживание статусов, передача
  агенту на выполнение; HTTP API, CLI taskctl и Codex Skill (in_progress → работа
  → in_review → done после подтверждения пользователя).'
date: 2026-08-11
tags:
- ai
- agents
- task-management
- kanban
- codex
source: https://github.com/chuspeeism/dashi-taskboard
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:34:51+00:00
permalink: wiki-vibecoding/ai/dashi-taskboard
---

# Dashi Taskboard — канбан-доска для Codex с API, CLI и скиллом

Оригинальный пост:

Dashi Taskboard - это канбан доска для Codex, через которую можно создавать задачи, отслеживать их статус и передавать их агенту Codex на выполнение.

В комплекте есть HTTP API, CLI taskctl и Codex Skill. Skill может взять задачу с доски, перевести её в in_progress, выполнить работу, отправить в in_review, а в done задача переводится после подтверждения пользователя.

https://github.com/chuspeeism/dashi-taskboard

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора). (В пачке ссылка пришлась дважды — создан один файл.)
- Что: канбан-доска задач для Codex: создание, статусы, передача агенту.
- Компоненты из поста: HTTP API, CLI taskctl, Codex Skill.
- Жизненный цикл задачи через Skill: взял (todo) → in_progress → выполнил → in_review → done (только после подтверждения пользователя — человек в цикле).

## Вывод

Пример «процессного» управления агентами: задачи как канбан с явными статусами и подтверждением человека перед done. Тот же принцип, что наш task-цикл: агент работает, но финальный гейт — за человеком. Полезный паттерн для команд, где агенты делают заметную часть работы.