---
type: Post
title: Fable-Fusion 27B — мультимодальный fine-tune Qwen3.6 для локальных агентов
description: 'Qwen3.6-27B Fable-Fusion-711: мультимодальный fine-tune с упором на
  reasoning и tool calling; GGUF-кванты 12–17 ГБ; ARC-C 0.711 (8-bit) / 0.701 (4-bit);
  контекст до 262K; vision + tool calling; доработка против отказов (Heretic/abliteration);
  для локальных агентных сценариев.'
date: 2026-08-11
tags:
- ai
- llm
- local
- reasoning
- qwen
source: https://huggingface.co/DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:03:57+00:00
permalink: wiki-vibecoding/ai/fable-fusion
---

# Fable-Fusion 27B — мультимодальный fine-tune Qwen3.6 для локальных агентов

Оригинальный пост:

🔥 27B-модель Fable-Fusion метит в новый топ локальных AI-агентов

На Hugging Face набирает популярность Qwen3.6-27B Fable-Fusion-711 — мультимодальный fine-tune Qwen3.6 с упором на reasoning, tool calling и работу в агентных сценариях. Модель распространяется в GGUF и имеет кванты, которые помещаются на потребительское железо.

По заявленным тестам:

• ARC-C: 0.711 в 8-bit и 0.701 в 4-bit
• контекст базовой Qwen3.6 — до 262K токенов нативно
• поддерживаются vision и tool calling
• multi-stage fine-tune с улучшенной структурой reasoning
• есть GGUF-кванты примерно от 12–17 ГБ
• модель специально дорабатывали для снижения количества отказов через Heretic/abliteration.

27B dense-модель пытаются приблизить по качеству reasoning к гораздо более тяжёлым системам, сохраняя возможность локального запуска.

https://huggingface.co/DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: Qwen3.6-27B fine-tune: reasoning/tool calling/vision, GGUF 12–17 ГБ, ARC-C 0.711/0.701, контекст до 262K, multi-stage fine-tune, снижение отказов через Heretic/abliteration.
- Позиционирование: 27B dense против более тяжёлых систем — локальный запуск.

## Вывод

Тренд «локальные агентные модели» (ср. Muse Glimmer 30B, Kimi K3): 27B с vision+tool calling на потребительском железе. Цифры ARC-C — заявления автора, проверять независимо (benchmark-дисциплина). «Uncensored/Heretic» в имени — маркетинг; для рабочих задач важна фактическая точность.