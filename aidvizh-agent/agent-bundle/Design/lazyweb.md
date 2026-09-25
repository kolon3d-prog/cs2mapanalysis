# lazyweb — скриншоты реальных продуктов и growth-ресёрч

## Источник

- Сервис: https://www.lazyweb.com (MCP-инструкция: https://www.lazyweb.com/mcp-install).
- Хостовый MCP: `https://www.lazyweb.com/mcp` (Streamable HTTP), авторизация Bearer-токеном.
- Скилл-пак (опционально): github.com/aboul3ata/lazyweb-skill, ставится скриптом `https://www.lazyweb.com/install.sh`.
- Контент: 257k+ реальных экранов приложений и веба, флоу, A/B-эксперименты, growth-механики, гостед-отчёты дизайн-ресёрча.

## Установка

Remote MCP в `~/.config/opencode/opencode.json`, секция `mcp.servers`:

```json
"lazyweb": {
  "type": "remote",
  "url": "https://www.lazyweb.com/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_LAZYWEB_MCP_TOKEN"
  }
}
```

## Ключи

Токен выдаётся бесплатно и без логина:

```bash
curl -sS -X POST https://www.lazyweb.com/api/mcp/install-token \
  -H "content-type: application/json" -d '{}'
```

В ответе поле `token`. Реальный токен хранить только в локальном конфиге opencode (права 600) или env; в бандле — плейсхолдер. Токен привязан к среде: на новой машине минтить новый.

## Что даёт

Хостовые тулы (в opencode подхватываются 43 штуки, актуальный список — в самом MCP): `lazyweb_search` / `lazyweb_search_screens` — поиск скриншотов по описанию, компании, категории, платформе; `lazyweb_search_flows` — упорядоченные многоэкранные флоу (онбординг, чекаут, пейволы); `lazyweb_search_experiments` — реальные growth/монетизационные эксперименты; `lazyweb_find_similar` / `lazyweb_compare_image` — визуально похожие экраны; `lazyweb_growth_score` / `lazyweb_growth_report` — оценка и отчёт по своему сайту; `lazyweb_generate_report` — one-call дизайн-ресёрч с evidence и before/after.

## Скиллы

Не нужны для MCP. Скрипт `install.sh` ставит скилл-пак и конфиги в локальные клиенты — запускать только при явной нужде; для работы через MCP достаточно сниппета выше.

## Проверка

В opencode — вызовом `lazyweb.lazyweb_health`; вернёт `status: "healthy"` и номер актуальной версии скилл-пака.

## Грабли

- 43 тула — жирно по контексту; дёргать точечно, а не «на всякий случай».
- Growth Report не запускать без явной просьбы пользователя — это правило самого Lazyweb.
- Публичные `lazyweb_*` имена — алиасы канонических тулов; живая схема MCP важнее любых заметок и скиллов.
- Не логировать ссылки `open_url` из ответов (приватные), наружу отдавать только стабильные `url` / `share_url`.
- Скилл-пак проверяется сам (он говорит про обновление раз в сессию); не путать его версию с версией MCP.
