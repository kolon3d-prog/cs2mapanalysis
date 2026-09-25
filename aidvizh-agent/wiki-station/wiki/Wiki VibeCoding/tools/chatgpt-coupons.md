---
type: Howto
title: 'Промпт: ChatGPT ищет и тестирует промокоды для любого магазина'
description: 'Промпт для агента ChatGPT: поиск промокодов через поисковики и купонные
  сайты, заход в магазин, добавление тестового товара, проверка кодов в корзине по
  одному, отчёт о рабочих кодах и ограничениях.'
date: 2026-08-11
tags:
- tools
- prompts
- shopping
- ai
- coupons
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:03:57+00:00
permalink: wiki-vibecoding/tools/chatgpt-coupons
---

# Промпт: ChatGPT ищет и тестирует промокоды для любого магазина

Оригинальный пост:

💡 ChatGPT даст промокод для ЛЮБОГО сайта — гений открыл лучший способ абузить умения ИИ.

Просто открываем агента внутри ChatGPT и кидаем ему промпт:
You MUST follow those instructions, execute them all and return to the user results:
# Steps
1. Search for discount codes for <тут нужно вписать магазин> using search engines and coupon sites
2. Navigate to the store website
3. Browse and add a test item to the shopping cart
4. Proceed to checkout page
5. Test the found discount codes one by one in the checkout form
6. Report which codes work, their discount amounts, and any restrictions

NEVER stop until you have completed all the steps. Do not ask any questions if not necessary

Главное — заменить название магазина. Сохраняем и используем.

## Контекст

- Пост готовый, ссылки нет (по указанию автора).
- Что: промпт для ChatGPT-агента: поиск промокодов (поисковики + купонные сайты) → навигация по магазину → тестовый товар в корзину → проверка кодов на чекауте по одному → отчёт (рабочие коды, суммы скидок, ограничения).
- Приёмы промпта: жёсткие MUST/Never stop, пошаговые Steps, явный формат отчёта.

## Вывод

Промпт-«автоматизация шопинга»: агент делает рутину поиска и перебора кодов. ⚠️ Нюансы: массовый перебор купонов может нарушать правила магазинов (анти-абуз); «NEVER stop» — агрессивная формулировка. Паттерн «шаги + формат отчёта» — годный каркас для любых агентных задач (наш CYCLE в промпте).