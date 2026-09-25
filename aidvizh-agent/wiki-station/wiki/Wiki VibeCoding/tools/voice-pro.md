---
type: Post
title: 'Voice-Pro — мультимедийный конвейер голоса: Whisper + клонирование + TTS'
description: 'Веб-приложение: загрузка YouTube (yt-dlp), разделение голоса/шума, распознавание
  (Whisper, Faster-Whisper, Whisper-Timestamped), клонирование голоса zero-shot (F5-TTS,
  E2-TTS, CosyVoice/Fun-CosyVoice3), TTS (Edge-TTS, kokoro, Azure), перевод 100+ языков;
  альтернатива ElevenLabs.'
date: 2026-08-11
tags:
- tools
- voice
- video
- transcription
- tts
source: https://github.com/abus-aikorea/voice-pro
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:54:39+00:00
permalink: wiki-vibecoding/tools/voice-pro
---

# Voice-Pro — мультимедийный конвейер голоса: Whisper + клонирование + TTS

Оригинальный пост:

Voice-Pro - это передовое веб-приложение, которое полностью меняет процесс создания мультимедийного контента. Оно объединяет в себе загрузку видео с YouTube, разделение голоса и фонового шума, распознавание речи, перевод и генерацию голоса (TTS). Это единый, мощный инструмент для креаторов, исследователей и специалистов, работающих с мультиязычным контентом.

🔊 Топовое распознавание речи: Whisper, Faster-Whisper, Whisper-Timestamped
🎤 Клонирование голоса с одного дубля (Zero-shot): F5-TTS, E2-TTS, CosyVoice (включая Fun-CosyVoice3 - с поддержкой корейского и еще 8 языков)
📢 Мультиязычный синтез речи (TTS): Edge-TTS, kokoro (опционально Azure TTS через ваши собственные API-ключи)
🎥 Загрузка с YouTube и извлечение аудио: yt-dlp
🌍 Мгновенный перевод на 100+ языков: Deep-Translator (опционально Azure Translator через ваши собственные API-ключи)

Являясь мощной альтернативой ElevenLabs, Voice-Pro предоставляет подкастерам, разработчикам и авторам контента продвинутые решения для работы с голосом.

https://github.com/abus-aikorea/voice-pro

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: единый веб-конвейер голоса: YouTube-загрузка (yt-dlp), разделение голоса/шума, распознавание (Whisper/Faster-Whisper/Whisper-Timestamped), клонирование zero-shot (F5-TTS, E2-TTS, CosyVoice/Fun-CosyVoice3 — корейский +8 языков), TTS (Edge-TTS, kokoro, Azure опционально), перевод 100+ языков (Deep-Translator/Azure).
- Позиционирование: альтернатива ElevenLabs для подкастов/контента/исследований.

## Вывод

Мощный self-hosted конвейер голоса — всё в одном (ср. KrillinAI — дубляж, OmniVoice — TTS): распознавание → перевод → клонирование → синтез. Для подкастов/локализации — бесплатная локальная альтернатива платным сервисам. Кандидат для наших voice-пайплайнов.