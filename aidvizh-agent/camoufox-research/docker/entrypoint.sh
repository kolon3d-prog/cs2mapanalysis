#!/bin/sh
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub
#
# Точка входа контейнера camoufox-research (см. Dockerfile).
#
# ПОЧЕМУ ТАК — из-за stdio. MCP по умолчанию общается по stdin/stdout, то есть
# stdout — ЭТО ПРОТОКОЛ. Любая наша строка в stdout (баннер, «сервер запущен»,
# прогресс pip, предупреждение python) попадает в поток JSON-RPC, и клиент
# ломается на разборе. Поэтому здесь: в stdout не пишем НИКОГДА, а диагностика —
# только в stderr и только по явному запросу (CAMOUFOX_ENTRYPOINT_DEBUG=1).
#
# ПОЧЕМУ exec: сервер должен стать процессом №1 контейнера — тогда SIGTERM от
# `docker stop` приходит прямо ему (чистое завершение: закрыть браузер и кэш),
# а код возврата контейнера равен коду возврата сервера. Обёртка через
# подпроцесс съела бы и сигналы, и rc.
#
# Формы запуска:
#   docker run -i --rm -v camoufox-data:/data IMAGE             # stdio-MCP (норма)
#   docker run -i --rm IMAGE --caps all                         # флаги → серверу
#   docker run -i --rm IMAGE --transport http --port 8833       # http (нужен -p)
#   docker run --rm IMAGE python -c 'import camoufox_research'  # любая команда образа
#
# POSIX sh (не bash): в slim-образе /bin/sh — dash; ничего bash-специфичного
# тут не нужно, и не нужно, чтобы скрипт ломался при смене базового образа.
set -eu

if [ "${CAMOUFOX_ENTRYPOINT_DEBUG:-}" = "1" ]; then
    echo "entrypoint: argv=[$*] caps=${CAMOUFOX_CAPS:-default} cache=${CAMOUFOX_CACHE_DIR:-default}" >&2
fi

if [ "$#" -eq 0 ]; then
    # Пусто → сервер с настройками из ENV образа (транспорт stdio по умолчанию).
    set -- camoufox-research
elif [ "${1#-}" != "$1" ]; then
    # Начинается с дефиса → это флаг СЕРВЕРА (--caps, --transport, --port).
    set -- camoufox-research "$@"
elif ! command -v "$1" >/dev/null 2>&1; then
    # Не команда образа (нет такого исполняемого) → считаем аргументами сервера.
    set -- camoufox-research "$@"
fi
# Иначе ($1 — существующая команда: python, sh, pip, camoufox-research) —
# запускаем как есть: отладка и разовые проверки внутри образа.

exec "$@"
