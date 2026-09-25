---
type: Post
title: Pane — терминальный менеджер AI-агентов, агностик к агенту и ОС
description: 'Менеджер агентов: настоящий терминал любому CLI-агенту (Claude Code,
  Codex, Aider, Goose) без плагинов; git worktree с автобезопасной работой; кросс-контекст
  через @; честный Pane Chat (не придумывает); Remote Pane (self-hosted, управление
  с десктопа/браузера); десктоп-апп; AGPL-3.0.'
date: 2026-08-11
tags:
- tools
- terminal
- agents
- workflow
- tui
source: https://github.com/dcouple/Pane
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 12:54:39+00:00
permalink: wiki-vibecoding/tools/pane
---

# Pane — терминальный менеджер AI-агентов, агностик к агенту и ОС

Оригинальный пост:

Pane — терминальный менеджер AI-агентов, агностик к агенту и ОС 🖥🤖
⌨️ Приносите своего агента: Claude Code, Codex, Aider, Goose или что угодно, работающее в терминале — без плагинов и SDK, Pane даёт настоящий терминал любому CLI-агенту.
🌿 Git worktree без боли: создаёте пейн — Pane сам создаёт worktree и ветку; удаляете пейн — сам чистит; хоткей — сам ребейзит с main. git worktree вручную больше не нужен.
🖇 Кросс-контекст между терминалами: @ в любом терминале подтягивает последние 500 строк из другого пейна прямо в контекст, без копипаста.
💬 Pane Chat смотрит на активные и недавно заархивированные пейны, ветки, PR и логи агентов и отвечает, что реально произошло — если источника нет, честно скажет, а не придумает.
📱 Remote Pane: self-hosted — код и агенты живут на VM, WSL-боксе, домашнем сервере или Mac mini, а управляете вы с десктопа или браузера runpane.com/app по коду подключения pane-remote://....
🖥 Полноценный десктоп-апп: встроенный diff-viewer, файловый эксплорер, git-workflow, командная палитра, браузерная вкладка — работает на Windows, WSL, macOS, Linux, VM.
🔓 AGPL-3.0, open source, local-first — открытие пейна не заливает код никуда, агенты используют собственных провайдеров.
🚀 Установка:
curl -fsSL https://runpane.com/install.sh | sh
или
npm i -g runpane && runpane setup
🔗 GitHub: github.com/dcouple/Pane
🌐 Сайт: runpane.com

## Контекст

- Пост готовый, ссылки не проверялись (по указанию автора).
- Что: менеджер агентов для любого CLI-агента (без плагинов): настоящие терминалы.
- Фичи из поста: git worktree автоматически (создание/очистка/ребейз); кросс-контекст (@ → последние 500 строк другого пейна); Pane Chat — отвечает по фактам (если источника нет — честно скажет, не придумает); Remote Pane (self-hosted, подключение по pane-remote://); десктоп-апп (diff-viewer, эксплорер, командная палитра); AGPL-3.0, local-first.

## Дополнительный пост (повторный, тот же инструмент, кратко)

https://github.com/dcouple/Pane

Terminal-first, open-source AI agent manager for any CLI agent (agent agnostic), any OS (mac, windows, linux). The Open-Source Agentic Development Environment for running multiple coding agents in parallel. Run locally or self-host Remote Pane to manage agents from desktop or phone. Simplify multi-agent orchestration with the runpane CLI.

runpane.com

## Контекст (дополнение из повторного поста)

- Позиционирование (из второго поста): terminal-first open-source agent manager (agent agnostic, any OS); «Open-Source Agentic Development Environment» для параллельных агентов; локально или Remote Pane (десктоп/телефон); оркестрация через runpane CLI.

## Вывод

Pane — зрелый «менеджер агентных сессий» (ср. Herdr, ccmux, OpenChamber): работа с worktree автоматизирована, контекст между пейнами — как между вкладками. «Честно скажет, а не придумает» — тот же принцип, что наш «не отвечать с головы». Remote-режим — агенты на сервере, управление откуда угодно.