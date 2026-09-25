---
type: Post
title: 'Social Media Skills — 17 навыков для Claude: единый авторский стиль на всех
  площадках'
description: 'Набор из 17 навыков для Claude по созданию контента для LinkedIn, Instagram,
  YouTube, Substack и X: voice-builder (профиль стиля), post-writer, hook-generator,
  post-scorer, content-matrix, reels-scripting, youtube-thumbnail, analytics-dashboard
  и др.'
date: 2026-08-11
tags:
- tools
- skill
- social-media
- content
- marketing
source: https://github.com/charlie947/social-media-skills
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:37:44+00:00
permalink: wiki-vibecoding/tools/social-media-skills
---

# Social Media Skills — 17 навыков для Claude: единый авторский стиль на всех площадках

Оригинальный пост:

Social Media Skills это набор из 17 навыков для Claude, объединённых в систему создания контента для LinkedIn, Instagram, YouTube, Substack и X.

Основой служит профиль автора, который используется всеми остальными навыками, чтобы сохранять единый стиль на разных площадках.

Основа авторского стиля
• voice-builder: проводит интервью, анализирует от 3 до 5 примеров текстов и создаёт файлы about-me.md и voice.md
• newsletter-voice: добавляет отдельные правила для написания рассылок и создаёт newsletter-voice.md

LinkedIn и создание контента
• profile-optimizer: полностью перерабатывает профиль LinkedIn, включая заголовок, About, опыт, Featured и четыре промпта для изображений
• post-writer: пишет публикации LinkedIn в стиле пользователя
• graphic-designer: выбирает между HTML и CSS графикой и инфографикой, созданной с помощью ИИ
• post-formatter: превращает тему в готовую публикацию по формулам PAS, AIDA, BAB, STAR или SLAY
• hook-generator: создаёт шесть вариантов цепляющего вступления для каждой темы
• post-scorer: получает историю публикаций через Apify и оценивает черновик по реально работающим форматам автора
• content-matrix: объединяет тематические направления с восемью форматами и формирует более 32 идей для публикаций
• niche-research: исследует Reddit, X и Google через Claude for Chrome и находит 20 актуальных материалов за последние семь дней
• gemini-infographic: создаёт промпты для инфографики в стиле нарисованной от руки доски
• gemini-carousel: собирает карусель по слайдам с подтверждением структуры перед финальной генерацией
• quote-post: Claude пишет цитату, а Gemini создаёт изображение с уже встроенным текстом

Instagram Reels
• reels-scripting: анализирует успешный Reel через Apify и Gemini 2.5 Flash, а затем создаёт новый сценарий в стиле пользователя на основе его рассылки

YouTube
• youtube-thumbnail: превращает название видео в брендированный промпт для создания обложки в Gemini

Работа с аудиторией
• pinned-comment: создаёт закреплённый комментарий в стиле мема и подходящий промпт для изображения

Аналитика
• analytics-dashboard: превращает экспорт LinkedIn Analytics в интерактивную панель на React и формирует пять рекомендаций на основе данных

https://github.com/charlie947/social-media-skills

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: система из 17 навыков для Claude — контент для LinkedIn, Instagram, YouTube, Substack, X.
- Архитектура (из поста): профиль автора (about-me.md, voice.md) как основа — все навыки используют его для единого стиля.
- Состав: voice-builder, newsletter-voice, profile-optimizer, post-writer, graphic-designer, post-formatter (PAS/AIDA/BAB/STAR/SLAY), hook-generator, post-scorer (Apify), content-matrix (32+ идеи), niche-research, gemini-infographic, gemini-carousel, quote-post, reels-scripting, youtube-thumbnail, pinned-comment, analytics-dashboard (React).
- Связки: Claude + Gemini + Apify (внешние сервисы для анализа и генерации).

## Вывод

Пример зрелой «системы навыков» вокруг одного профиля: общая память стиля + специализированные навыки под каждую площадку/формат. Для нас показательна идея «voice как общий источник правды» — тот же принцип, что AGENTS.md/персона для агента. Плюс связка разных моделей (Claude пишет, Gemini генерит картинки) — мультимодельный пайплайн.