---
type: Post
title: CyberStrikeAI — AI-native платформа авторизованного пентеста (100+ тулов)
description: 'Платформа для санкционированного пентеста: 100+ курированных инструментов
  (nmap, sqlmap, nuclei, metasploit, ghidra...), agentic-исполнение с human-in-the-loop
  согласованием, Go, MCP-native, RAG, Chrome-расширение; ⚠️ только с разрешения владельца;
  Apache-2.0, 5K звёзд.'
date: 2026-08-11
tags:
- ai
- agents
- security
- pentest
- automation
source: https://github.com/Ed1s0nZ/CyberStrikeAI
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:54:39+00:00
permalink: wiki-vibecoding/ai/cyberstrikeai
---

# CyberStrikeAI — AI-native платформа авторизованного пентеста (100+ тулов)

Оригинальный пост:

CyberStrikeAI — AI-native платформа для санкционированного pentest'а, агрегирующая 100+ security-тулов 🛡🤖

⚠️ Только для авторизованного тестирования: сам репозиторий прямо требует явное разрешение владельца целевой системы и позиционируется как образовательный/профессиональный инструмент для security-исследователей и пентестеров.

🧰 100+ курированных инструментов по всей kill chain: сетевые сканеры (nmap, masscan, rustscan), веб-сканеры (sqlmap, nikto, ffuf, httpx), сканеры уязвимостей (nuclei, wpscan, dalfox), сабдомен-энумерация (subfinder, amass), API/Container/Cloud security (trivy, kube-hunter, prowler, checkov), бинарный анализ (ghidra, radare2, binwalk), эксплуатация (metasploit, msfvenom, pwntools).

🤖 Agentic-исполнение: естественноязычный запрос превращается в управляемое, аудируемое действие — планирование, выполнение, human-in-the-loop согласование, сбор evidence и replay в одном воркспейсе.

🔌 Построено на Go, MCP-native тулы, RAG на базе своей базы знаний, визуальные workflow и attack-chain моделирование; есть расширение для Chrome/Edge — захватывает сетевой трафик из DevTools и шлёт запросы прямо в CyberStrikeAI для AI-ассистированного анализа.

🔓 Apache-2.0, open source

🚀 Установка:

git clone https://github.com/Ed1s0nZ/CyberStrikeAI.git
cd CyberStrikeAI && chmod +x run.sh && ./run.sh

⭐️ 5k звёзд, 815 форков на GitHub

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: AI-native платформа авторизованного пентеста: 100+ тулов по kill chain (nmap, sqlmap, nuclei, metasploit, ghidra, trivy и др.).
- Agentic-исполнение: NL-запрос → планирование → выполнение → human-in-the-loop → evidence → replay.
- Технологии: Go, MCP-native, RAG по своей базе знаний, визуальные workflow, attack-chain моделирование; Chrome/Edge-расширение (перехват DevTools-трафика).
- ⚠️ Позиционирование: только авторизованное тестирование с явного разрешения владельца; Apache-2.0, 5K звёзд.

## Вывод

Пентест-платформы с агентами оформляются в отдельный жанр (ср. Z3r0, Agentic SOC): 100+ инструментов + оркестрация + аудит. Human-in-the-loop согласование перед действиями — обязательный паттерн в security. Этическая рамка (только авторизованно) — стандарт, который мы поддерживаем.