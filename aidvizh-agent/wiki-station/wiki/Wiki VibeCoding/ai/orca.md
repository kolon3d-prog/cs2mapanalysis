---
type: Post
title: Orca — ADE для параллельной работы с флотом кодинг-агентов
description: 'Десктоп+мобильный: любые CLI-агенты; Parallel Worktrees (промпт → несколько
  агентов в изолированных worktree, сравнение результатов); Design Mode (клик по UI
  → HTML/CSS/скриншот в промпт); удалённый компьют (SSH/self-hosted/VM); GitHub/Linear/Jira;
  Computer Use; MIT, 27.3k★.'
date: 2026-08-11
tags:
- ai
- agents
- orchestration
- worktree
- desktop
source: https://github.com/stablyai/orca
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:12:35+00:00
permalink: wiki-vibecoding/ai/orca
---

# Orca — ADE для параллельной работы с флотом кодинг-агентов

Оригинальный пост (ключевые части):

Orca — ADE для параллельной работы с AI-агентами

🖥 Десктопное приложение (macOS/Windows/Linux) + мобильный компаньон для управления флотом кодинг-агентов.

✅ Работает с любым CLI-агентом. Из коробки — Claude Code, Codex, Cursor CLI, GitHub Copilot, OpenCode, Grok CLI, Amp, Devin, Goose и ещё пара десятков, плюс кастомный агент подключается вручную.

🌳 Parallel Worktrees. Один промпт разлетается на несколько агентов, каждый в изолированном git-worktree — сравниваешь результаты и выбираешь лучший без ручного мерджа. Каждая задача получает отдельный worktree, отдельный терминал агента и отдельную вкладку браузера.

📱 Мобильный компаньон. iOS/Android — следишь за агентами и шлёшь им задачи с телефона.

🎨 Design Mode. Клик по элементу UI в реальном Chromium-окне — HTML, CSS и обрезанный скриншот сразу летят в промпт агента.

🌐 Гибкий удалённый компьют — три варианта на выбор:
SSH на свою мощную машину;
self-hosted Orca-сервер;
эфемерные VM по требованию (per-workspace environments) — если не хочешь держать сервер постоянно.
Важно: это не хостинговый VPS-продукт от Orca — весь удалённый компьют работает на твоих собственных машинах/облачных аккаунтах.

🔗 GitHub & Linear/Jira нативно. PR, issues, доски задач прямо в приложении.
⌨️ Терминалы уровня Ghostty. WebGL-рендеринг, бесконечные сплиты, живучий scrollback.

🤖 Orca CLI + оркестрация. Скриптуешь workflow'ы (orca worktree create, snapshot, click, fill), есть Scheduled automations и Computer Use — агент может управлять десктопными приложениями напрямую, не только терминалом.

📌 Позиционирование от самих разработчиков: Orca — не модель (свой Claude/Codex/OpenCode-подписка нужна своя), не замена git (каждый worktree — обычный git-worktree, можно зайти и работать голым git). Инструмент для тех, кто пишет код и хочет ревьюить AI-диффы серьёзно, а не для no-code сценариев.

‼️ И многое другое!

🖥 Открытый исходный код, MIT-лицензия, 27.3k★ на GitHub.
🔗 github.com/stablyai/orca

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: ADE (Agentic Development Environment): флот CLI-агентов, Parallel Worktrees (промпт → несколько агентов в изолированных worktree → выбор лучшего), Design Mode (клик по UI → HTML/CSS/скриншот в промпт).
- Удалённый компьют: SSH / self-hosted / эфемерные VM (на своих машинах); GitHub/Linear/Jira; Computer Use; Orca CLI (worktree create, snapshot, click, fill); мобильный компаньон.
- Позиционирование: не модель, не замена git; для серьёзного ревью AI-диффов; MIT, 27.3k★.

## Вывод

Orca — зрелый «агентный IDE» (ср. OpenChamber, Cindy, Pane): параллельные worktree с выбором лучшего результата (как Multi-run & Fusion у OpenChamber) — сильный паттерн качества. Design Mode (клик → контекст) — прямой мост UI→агент. «Ревьюить AI-диффы серьёзно» — наша философия.