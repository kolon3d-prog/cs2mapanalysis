---
type: Post
title: ComfyUI Video Tiler — снижение памяти при обработке видео тайлами
description: 'Тайлер для видео и изображений в ComfyUI: разбиение на плитки (тайлы)
  снижает потребление памяти при обработке; протестирован в апскейле LTX 2.3 и MiniMax
  H3.'
date: 2026-08-11
tags:
- tools
- video
- upscale
- comfyui
- memory
source: https://github.com/maDcaDDie2000/comfyui-video-tiler
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:41:03+00:00
permalink: wiki-vibecoding/tools/comfyui-video-tiler
---

# ComfyUI Video Tiler — снижение памяти при обработке видео тайлами

Оригинальный пост:

ComfyUI Video Tiler (https://github.com/maDcaDDie2000/comfyui-video-tiler)

Тайлер для видео и изображений в #ComfyUI, снижает потребление памяти при обработке за счёт разбиения на тайлы (плитки)

протестирован в апскейле LTX 2.3 и MiniMax H3

Спасибо @m_franz

#upscale #lowvram

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: нода/расширение для ComfyUI: разбиение видео/изображений на тайлы → меньше памяти при обработке.
- Тесты из поста: апскейл LTX 2.3, MiniMax H3.
- Зачем: апскейл больших видео на GPU с ограниченной памятью (low-VRAM).

## Вывод

Классический паттерн «тайлинг» для видео-апскейла: обрабатываем куски, склеиваем — можно тянуть большие разрешения на слабом GPU. Для локальной генерации видео (ср. FreeCut, KrillinAI) — практичное дополнение к ComfyUI-пайплайнам.