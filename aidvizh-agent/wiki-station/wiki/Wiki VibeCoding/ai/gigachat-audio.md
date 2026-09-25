---
type: Post
title: GigaChat3.1-Audio — аудио-LLM для записей до 2 часов (русский)
description: 'Аудио LLM: ASR, перевод (русский/английский), QA по аудио, распознавание
  эмоций, temporal grounding (48.3 mIoU, события в записях до 2 часов); 10B MoE (1.8B
  активных), энкодер GigaAM; русскоязычная модель.'
date: 2026-08-11
tags:
- ai
- audio
- asr
- russian
- llm
source: https://huggingface.co/ai-sage/GigaChat3.1-Audio-10B-A1.8B
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:12:35+00:00
permalink: wiki-vibecoding/ai/gigachat-audio
---

# GigaChat3.1-Audio — аудио-LLM для записей до 2 часов (русский)

Оригинальный пост:

GigaChat3.1-Audio-10B-A1.8B (https://huggingface.co/ai-sage/GigaChat3.1-Audio-10B-A1.8B)

Аудио LLM для работы с длинными записями (2 часа)

* Распознавание речи (ASR) - переводит аудио в текст
* Перевод - упомянуты русский и английский
* Ответы на вопросы по аудио (QA)
* Распознавание эмоций
* Временная привязка (temporal grounding) - находит в какой части аудио происходит то или иное событие, заявлено 48.3 mIoU на задачах для записей до 2 часов

• 10B #MoE декодер, активно 1.8B параметров
• энкодер GigaAM

Демо (https://huggingface.co/spaces/hugging-apps/gigachat-audio-10b-a1-8b-demo)

#alm #qa #asr #stt #translation #russian

## Контекст

- Пост готовый, ссылки не проверялись (по указанию автора).
- Что: аудио-LLM (10B MoE, 1.8B активных; энкодер GigaAM): ASR, перевод (рус/англ), QA по аудио, эмоции, temporal grounding (48.3 mIoU, до 2 часов).
- Русский язык — ключевая особенность для нас.

## Вывод

Редкий случай: аудио-LLM с русским акцентом (ср. VibeVoice-ASR, Vibe): длинные записи (2 часа) с диаризацией-подобными возможностями и QA. Для расшифровки совещаний/лекций на русском — сильный кандидат. 48.3 mIoU — заявление.