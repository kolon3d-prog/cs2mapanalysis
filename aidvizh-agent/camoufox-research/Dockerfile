# syntax=docker/dockerfile:1
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

# camoufox-research в контейнере: «работает на любой ОС без вопросов».
#
#   сборка:  docker build -t camoufox-research:dev .
#   запуск:  bash scripts/run_in_docker.sh          (печатает готовую секцию клиента)
#            bash scripts/run_in_docker.sh --self-test   (рукопожатие MCP внутри образа)
#
# РАЗМЕР — ЧЕСТНО (предупреждаем до скачивания): скачать ≈908 МБ (сжатые
# слои), на диске после сборки 2,9 ГБ. Это НЕ раздутый код: внутри браузер
# Camoufox (Firefox-форк: дистрибутив 663,5 МБ, распакованно 1,3 ГБ в
# ~/.cache/camoufox) плюс библиотеки Firefox-стека.
# Причина существования файла ровно эта: у 4 из 6 аналогов MCP-серверов
# Dockerfile есть — клиенту дешевле скачать образ один раз, чем ставить
# Firefox-стек и качать браузер на каждой машине (docs/install-crossplatform.md).
# Меньше не получится: без браузера research не работает.
#
# ТРАНСПОРТ (главная тонкость): MCP по умолчанию — stdio, а stdin/stdout ЭТО
# И ЕСТЬ протокол. Отсюда три следствия, которые видно в файле:
#   1) ENTRYPOINT (docker/entrypoint.sh) не пишет в stdout ни строчки —
#      баннер или прогресс в stdout = «клиент давится» на разборе JSON-RPC;
#   2) клиенту ОБЯЗАТЕЛЕН `-i` (stdin открыт) и ЗАПРЕЩЁН `-t` (tty
#      подмешивает CR/LF и эхо — протокол ломается);
#   3) ENTRYPOINT — именно exec, чтобы SIGTERM от `docker stop` шёл серверу,
#      а код возврата контейнера был кодом возврата сервера.
#
# HEALTHCHECK — НЕ ОБЪЯВЛЕН, И ЭТО РЕШЕНИЕ, А НЕ ПРОПУСК:
#   * у stdio-сервера нет порта и нет HTTP-ручки — проверять нечего снаружи;
#   * единственный живой канал проверки — stdin/stdout, то есть поток,
#     которым владеет клиент: наш пинг украл бы у него строку ответа
#     (лечение хуже болезни);
#   * `pgrep camoufox` бессмыслен: сервер и есть PID 1 контейнера, «жив
#     процесс» ≡ «жив контейнер». Смерть сервера Docker и так покажет как
#     `Exited` — это и есть healthcheck клиента (docker events / restart-политика);
#   * healthcheck, который всегда зелёный (или падает по чужой причине),
#     вреден: он приучает не верить индикатору.
#   Для http-транспорта честная проверка ВОЗМОЖНА и проверена 21.09:
#   `curl -X POST .../mcp` → 200 (`GET /` → 404: роут только POST /mcp) —
#   команда целиком в docs/install-crossplatform.md, раздел Docker.

# --- стадия 1: venv с зависимостями -----------------------------------------
# Сборка отдельно от рантайма: компиляторов и кэшей сборки в финальном образе
# быть не должно (вес + лишняя поверхность).
FROM python:3.13-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26 AS builder

# uv — только менеджер окружения и замороженного lock-файла.
# UV_PROJECT_ENVIRONMENT=/opt/venv — не создавать второй .venv в слое.
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /src

# uv и lock-файл — единственный источник зависимостей для сборки.
# Версия uv зафиксирована в uv.lock/ci-контракте; базовый образ прибит digest выше.
RUN pip install --no-cache-dir "uv==0.12.3"

# Копируем ровно то, что нужно `uv sync`: lock, pyproject, пакет и README.
# Остальное отсекает .dockerignore.
COPY pyproject.toml README.md uv.lock ./
COPY camoufox_research/ ./camoufox_research/

# Проверка на месте (сборка падает здесь, а не у клиента): сервер обязан
# регистрировать реестр тулов.
RUN uv sync --frozen --no-dev \
 && /opt/venv/bin/python -c "import camoufox_research.camoufox_research as s; print('tools:', len(s.mcp._tool_manager._tools))"

# --- стадия 2: рантайм -------------------------------------------------------
FROM python:3.13-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26 AS runtime

# Системные библиотеки Firefox-стека. Основа — ТОТ ЖЕ список, что ставит
# scripts/install.sh для apt (закон 28: одна правда о зависимостях; второй
# список рядом заводить нельзя — разойдутся). Одно отличие, и оно измерено:
# libasound2 у install.sh помечен ОПЦИОНАЛЬНЫМ, а в образе он обязателен —
# проверка 21.09 (`camoufox-bin --version` в контейнере) дала
# «XPCOMGlueLoad error ... libasound.so.2: cannot open shared object file»:
# libxul.so линкуется с libasound жёстко, и без него движок НЕ стартует.
# На хосте пользователь доставит пакет сам, в закрытом образе — нечем: экономить
# ~1 МБ ценой неработающего движка — плохая сделка.
# fontconfig + шрифты: без шрифтов Firefox рисует пустые страницы, а camouflage
# подменяет метрики шрифтов по системным — без них anti-detect теряет смысл.
# rm -rf /var/lib/apt/lists/*: apt-индексы (~50 МБ) в слое не нужны.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libgtk-3-0 \
        libdbus-glib-1-2 \
        libxt6 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libnss3 \
        libnspr4 \
        libpango-1.0-0 \
        libcairo2 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libasound2 \
        fontconfig \
        fonts-liberation \
        fonts-dejavu-core \
        ca-certificates; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Не root: браузер — сетевая поверхность (чужие страницы, чужие скрипты),
# поэтому uid 1000 без sudo. 1000 — первый обычный uid на хосте, так что
# named volume и bind-mount работают без chown (см. --data в run_in_docker.sh).
# Хост-uid другой (редкий случай) → `docker build --build-arg CAMOUFOX_UID=$(id -u)`.
ARG CAMOUFOX_UID=1000
RUN groupadd --gid "${CAMOUFOX_UID}" camoufox \
 && useradd --uid "${CAMOUFOX_UID}" --gid "${CAMOUFOX_UID}" \
        --create-home --home-dir /home/camoufox --shell /usr/sbin/nologin camoufox

COPY --from=builder --chown=root:root /opt/venv /opt/venv
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/camoufox-entrypoint
RUN chmod 0755 /usr/local/bin/camoufox-entrypoint

# CAMOUFOX_CACHE_DIR=/data — путь для модулей, которые читают переменную
# (critic/usage-cut/health_pulse). CAMOUFOX_CAPS=research,browser — ДЕФОЛТ
# агента из camoufox_caps.py (34 тула): профиль ставим явно, чтобы у клиента
# и в доке было одно число; полный реестр — `-e CAMOUFOX_CAPS=all`.
# PYTHONUNBUFFERED: stdout — это протокол, буферизовать его нельзя
# (ответ должен уйти клиенту строкой сразу, а не «когда-нибудь»).
ENV PATH=/opt/venv/bin:${PATH} \
    HOME=/home/camoufox \
    CAMOUFOX_CACHE_DIR=/data \
    CAMOUFOX_CAPS=research,browser \
    PYTHONUNBUFFERED=1

# /data — единственное, что обязано пережить контейнер: sqlite-кэш страниц и
# поиска, БД кампаний, critic-кэш, memory.md. VOLUME объявлен нарочно: если
# клиент запустит `docker run` без -v, Docker создаст анонимный том и данные
# не потеряются молча при --rm (а `--self-test` покажет это же).
RUN mkdir -p /data && chown camoufox:camoufox /data
VOLUME ["/data"]

# ПОЧЕМУ СИМЛИНК: имена путей кэша в ядре по историческим причинам ЖЁСТКИЕ —
# camoufox_cache._CACHE_DIR = ~/.cache/camoufox-research (там же cache.db и БД
# кампаний), а CAMOUFOX_CACHE_DIR читают лишь часть модулей. Чтобы том
# гарантированно забирал ВСЁ (а не «часть, которая успела обновиться»),
# ~/.cache/camoufox-research указывает на /data: оба пути ведут в том, ни один
# модуль не забыт. Симлинк ставим ПОСЛЕ объявления VOLUME.
RUN mkdir -p /home/camoufox/.cache \
 && ln -s /data /home/camoufox/.cache/camoufox-research \
 && chown -R camoufox:camoufox /home/camoufox/.cache

USER camoufox

# Браузер скачиваем ПРИ СБОРКЕ (внутрь образа), а не при первом запуске:
# клиент получает готовый контейнер, а не «скачай 663 МБ при первом туле».
# HOME=camoufox ⇒ браузер ложится в /home/camoufox/.cache/camoufox — это НЕ
# том: браузер часть образа, том хранит только данные пользователя.
# (Сети на первом запуске, кроме самих страниц, больше не нужно.)
RUN python -m camoufox fetch

# exec-форма: argv уходит серверу без промежуточного шелла (нет лишнего
# процесса-обёртки и лишнего парсинга кавычек). Разбор аргументов — в
# docker/entrypoint.sh; CMD намеренно пуст: по умолчанию поднимается stdio-сервер.
ENTRYPOINT ["/usr/local/bin/camoufox-entrypoint"]
