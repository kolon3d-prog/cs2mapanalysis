---
type: Reference
title: 'Экосистема вперёд: выбор библиотек и фреймворков вместо самопала'
description: 'Запрет наколенных структур: брать production-ready стандарт под задачу
  и язык, фильтровать по AOT/оверхеду/зависимостям и проверять актуальность версии
  перед объявлением.'
date: 2026-09-21
tags:
- tools
- coding
- ecosystem
- libraries
- architecture
generated:
  by: wiki-station/mcp
  at: 2026-09-21 18:34:54+00:00
permalink: wiki-vibecoding/tools/ecosystem-first
---

# Экосистема вперёд: выбор библиотек и фреймворков вместо самопала

# Экосистема вперёд

## Запрет наколенных структур

Перед реализацией сетевых протоколов, pty, сериализации, UI или конкурентности агент обязан выбрать проверенную production-ready библиотеку экосистемы, а не изобретать цикл событий и диспетчеры руками.

**Каркас вместо самопала — де-факто стандарт под задачу:**

- **C#**: Avalonia/Uno для нативного кроссплатформенного UI, Orleans/ProtoActor для акторов, MediatR/MassTransit для шины, Refit для API;
- **Rust**: Axum/Actix для сети, Slint/Tauri v2/Iced для десктопа, Bevy/wgpu для GPU-рендера, Tokio/tracing для ядра;
- **Go**: Gin/Echo/Fiber для API, Bubbletea для TUI, Temporal/Asynq для очередей;
- **C++ / Zig**: Qt6/Dear ImGui/Raylib для интерфейсов, EnTT/Flecs для ECS, Seastar/Boost.Asio для асинхронщины;
- **Node / Python**: Fastify/NestJS для Node, FastAPI/Litestar для Python, Textual для TUI.

## Примитивы вместо велосипедов

- **C#**: чистый net standard/AOT, memory/spans, channels, ASP.NET Minimal API, CommunityToolkit;
- **Rust**: tokio/crossbeam для рантайма, tracing, serde, portable-pty, iced/egui/slint для нативного UI;
- **Go**: stdlib first, `golang.org/x/sys`, charmbracelet для TUI;
- **C++ / Zig**: mimalloc, libuv/io_uring, std.heap и аллокаторы без скрытых аллокаций;
- **Node / Python**: pydantic, FastMCP, node-pty, uv/bun вместо тяжёлых комбайнов.

## Критерий отбора

- low overhead;
- поддержка AOT / статической сборки;
- zero-copy буферы при работе с I/O;
- отсутствие заброшенных зависимостей.

**Фильтр на вшивость:** фреймворк обязан поддерживать Native AOT / статический билд, не жрать гигабайты памяти на старте и не тянуть миллион транзитивных зависимостей. Electron, раздутые ORM и тяжёлые рантаймы идут нахуй.

## Проверка актуальности

Перед объявлением пакета в коде — веб-поиск по последней мажорной версии и актуальному API, а не синтаксис пятилетней давности из памяти. Сомневаешься в выборе фреймворка — ищи свежие бенчмарки и состояние репозитория (звёзды, свежие коммиты, поддержка), а не первое попавшееся.

## Связи

- Почему модель тянет устаревшее из весов — `ai/llm-why-dumb`.
- Куда роутить проверку версии — `tools/search-routing-matrix`.