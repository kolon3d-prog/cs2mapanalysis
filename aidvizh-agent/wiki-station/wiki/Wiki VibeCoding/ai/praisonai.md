---
type: Post
title: PraisonAI — Python/JS-фреймворк для сборки AI-агентов и команд
description: 'Открытый фреймворк для разработчика: агент за 5 строк кода, команды
  (AgentTeam), workflow (AgentFlow), веб-API (AgentOS); память, RAG, self-reflection,
  140+ тулов, MCP, 100+ LLM-провайдеров; 4 уровня входа от SDK до no-code.'
date: 2026-08-11
tags:
- ai
- agents
- framework
- python
- multi-agent
source: https://github.com/MervinPraison/PraisonAI
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:32:50+00:00
permalink: wiki-vibecoding/ai/praisonai
---

# PraisonAI — Python/JS-фреймворк для сборки AI-агентов и команд

Оригинальный пост:

PraisonAI — открытый Python/JS-фреймворк для сборки своих AI-агентов и команд агентов 🦞🤖

⚡️ Агент за 5 строк кода: Agent(instructions=...).start(...) — от одного агента до команды (AgentTeam), workflow-пайплайна (AgentFlow) или полноценного веб-API (AgentOS).

🧠 Из коробки: память (кратко/долгосрочная), RAG, self-reflection (агент сам проверяет и улучшает свой ответ), 140+ встроенных тулов, MCP-интеграция, песочница для выполнения кода.

🔌 100+ LLM-провайдеров: OpenAI, Anthropic, Gemini, DeepSeek, Ollama, Groq, Bedrock и другие — переключаются без переписывания кода.

🖥️ AgentClaw — опциональный дашборд с чатом, ботами и подключением Telegram/Discord/Slack/WhatsApp — но это один из пяти способов деплоя, а не главный продукт.

⚙️ 4 уровня входа: чистый Python/JS SDK, no-code CLI (praisonai "задача"), low-code YAML-конфиг, визуальный drag-and-drop билдер.

🆚 Чем отличается от OpenClaw и Hermes: те — готовые персональные агенты, с которыми вы просто переписываетесь в Telegram/Discord (self-hosted, но «из коробки»). PraisonAI — это фреймворк для разработчика: вы сами код собираете агентов и мультиагентные системы под свою задачу, а не получаете готового ассистента. Чат-бот — просто одна из фич, а не суть продукта.

🚀 Установка:

curl -fsSL https://praison.ai/install.sh | bash
# или
pip install praisonaiagents

🔗 Документация: praison.ai/docs
🔗 GitHub: github.com/MervinPraison/PraisonAI

## Контекст

- Пост готовый, ссылки не проверялись (по указанию автора).
- Что: фреймворк для разработчиков (Python/JS) — сборка агентов и мультиагентных систем кодом: Agent(instructions=...).start(...), AgentTeam, AgentFlow, AgentOS.
- Возможности из поста: память (кратко/долгосрочная), RAG, self-reflection, 140+ тулов, MCP, песочница кода; 100+ LLM-провайдеров без переписывания кода.
- Деплой: 5 способов, включая дашборд AgentClaw (чат, Telegram/Discord/Slack/WhatsApp).
- Вход: SDK, no-code CLI, YAML-конфиг, drag-and-drop билдер.
- Позиционирование из поста: не готовый ассистент (как OpenClaw/Hermes), а фреймворк — «вы сами собираете под свою задачу».

## Вывод

PraisonAI — показательный представитель класса «agent-фреймворки для разработчиков» (ср. LangGraph, CrewAI): код, а не чат. Полезен как платформа для экспериментов (много провайдеров, MCP, песочница). Для нас интересно как эталон паттернов: self-reflection (агент проверяет себя — ср. fable-judge), MCP-интеграция, многоуровневый вход.