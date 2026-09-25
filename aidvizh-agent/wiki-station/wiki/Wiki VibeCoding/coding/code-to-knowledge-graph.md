---
type: Post
title: Code-to-Knowledge-Graph — кодовая база как запрашиваемый граф знаний
description: 'Преобразует кодовую базу в запрашиваемый граф знаний: извлечение сущностей,
  отношений и архитектурных выводов.'
date: 2026-08-11
tags:
- coding
- graph
- knowledge-base
- agents
- analysis
source: https://github.com/Bevel-Software/code-to-knowledge-graph
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:12:35+00:00
permalink: wiki-vibecoding/coding/code-to-knowledge-graph
---

# Code-to-Knowledge-Graph — кодовая база как запрашиваемый граф знаний

Оригинальный пост (краткий):

https://github.com/Bevel-Software/code-to-knowledge-graph

Code-to-Knowledge-Graph преобразует кодовую базу в запрашиваемый граф знаний для извлечения сущностей, отношений и архитектурных выводов.

## Контекст

- Пост готовый, ссылка не проверялась (по указанию автора).
- Что: код → граф знаний: сущности, отношения, архитектурные выводы (ср. CodeGraph, repowise, codebase-memory-mcp — класс «индекс кода для агентов»).

## Вывод

Ещё один представитель класса «код как граф» (CodeGraph, repowise, codebase-memory-mcp, наш CRG): запрашиваемый граф для агентов. Паттерн подтверждён: структура кода как данные для LLM. Для больших баз — кандидат на замер против нашего стека.