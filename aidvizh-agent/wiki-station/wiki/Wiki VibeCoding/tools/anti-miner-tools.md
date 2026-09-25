---
type: Reference
title: 'Утилиты против майнеров и вредоносов: Anti-Miner, MinerSearch, KVRT и др.'
description: 'Набор инструментов проверки ПК на майнеры/вредоносы: Anti-Miner (поиск
  и удаление майнеров), MinerSearch (эвристика + карантин), KVRT (портативный сканер
  Kaspersky), witr (контроль процессов), MatrixDefender-4.2 (RAT/майнеры), maltrail
  (черные списки и эвристики).'
date: 2026-08-11
tags:
- tools
- security
- windows
- malware
- list
status: stable
generated:
  by: build-agent/aggg2.0
  at: 2026-08-11 13:12:35+00:00
permalink: wiki-vibecoding/tools/anti-miner-tools
---

# Утилиты против майнеров и вредоносов: Anti-Miner, MinerSearch, KVRT и др.

Оригинальный пост:

Удаляем все майнеры, вредоносы и прочий мусор со своего компа — в связи с новостями о взломе игры MECCHA CHAMELEON всем будет полезно проверить свои ПК на предмет угроз.

Освежим в памяти полезные сервисы:

• Anti-Miner (https://github.com/Daiwv/Anti-Miner) — сервис для Windows. Ищет скрытые майнеры и удаляет их безвозвратно.
• MinerSearch (https://github.com/BlendLog/MinerSearch) — новая тулза для поиска майнеров. С эвристикой, карантином и обновляемой базой угроз.
• KVRT (https://www.kaspersky.ru/downloads/free-virus-removal-tool) — бесплатный портативный сканер для Windows и Linux. Убивает вирусы, трояны, руткиты и шпионское ПО.
• witr (https://github.com/pranshuparmar/witr) — утилита для контроля за всеми процессами на компе.
• MatrixDefender-4.2 (https://github.com/belrinn/MatrixDefender-4.2) — прога для Windows, чтобы удалять RAT‑трояны, майнеры и уязвимости, включая LimeRAT.
• maltrail (https://github.com/stamparm/maltrail) — находит вредоносы по черным спискам и эвристикам. Давно зарекомендовавший себя проект.
• witr (https://github.com/pranshuparmar/witr) — сервис, который находит и детально показывает угрозы. Сразу поймете, что перед вами: полезный процесс или шлак/майнер/вирус.

## Контекст

- Пост готовый, ссылки не проверялись (по указанию автора).
- Что: набор утилит против майнеров/вредоносов (повод — взлом игры MECCHA CHAMELEON): Anti-Miner (Windows), MinerSearch (эвристика + карантин), KVRT (Kaspersky, портативный, Win/Linux), witr (контроль процессов), MatrixDefender-4.2 (RAT/майнеры/LimeRAT), maltrail (чёрные списки/эвристики, известный проект).

## Вывод

Стандартный «набор первой помощи» при подозрении на майнер: KVRT (проверенный вендор) + witr (контроль процессов вручную) + maltrail (сетевой мониторинг). Для нас актуально: после любых сомнительных установок (репаки, активаторы) — прогон KVRT. Помнить: серые активаторы сами могут быть майнерами.