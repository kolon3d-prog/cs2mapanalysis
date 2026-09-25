#!/usr/bin/env bash
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

# Строгий режим — ПЕРВОЙ исполняемой строкой (выше только комментарии): единый
# гейт набора считает строгость по первым 25 строкам, и без этого файл попал бы
# в список исключений с неверной причиной «строгого режима нет».
set -euo pipefail

# run_in_docker.sh — запуск MCP-сервера camoufox-research в контейнере для КЛИЕНТА.
#
# Зачем: «работает на любой ОС без вопросов» — клиенту не нужен Firefox-стек,
# python, venv и скачивание браузера. Всё это уже в образе (≈908 МБ скачать,
# 2,9 ГБ на диске — см. Dockerfile), а хост должен уметь одно: запустить контейнер.
#
# Что делает по умолчанию (без флагов): печатает ГОТОВУЮ конфигурацию клиента
# (opencode.json и generic mcpServers), команду `docker run` и объясняет, почему
# в ней есть `-i` и почему НЕЛЬЗЯ `-t`/`-d`. Ничего не меняет в системе.
#
# Флаги:
#   --runtime docker|podman   чем запускать (по умолчанию: docker, иначе podman)
#   --image TAG               имя образа (по умолчанию camoufox-research:dev)
#   --data NAME|PATH          том для данных (по умолчанию camoufox-research-data)
#   --caps LIST               профиль тулов: -e CAMOUFOX_CAPS=LIST (напр. all)
#   --build                   собрать/пересобрать образ из этого репо
#   --run [АРГУМЕНТЫ…]        запустить контейнер здесь и сейчас (остальное — серверу)
#   --http [PORT]             вариант для http-транспорта (по умолчанию 8833)
#   --self-test               живое рукопожатие MCP в контейнере (initialize+tools/list)
#   --json                    только JSON конфигурации клиента (для скриптов)
#   --help                    справка
#
# Коды возврата: 0 — ок, 1 — ошибка (нет рантайма/образа, рукопожатие не прошло),
# 2 — неверный флаг.
#
# POSIX-мышление в bash-обёртке: bash-специфика только там, где она реально
# нужна (массивы аргументов), остальное — переносимо (см. скилл shell-portability:
# has_command, кавычки, отсутствие `sed -i` и прочих GNU-привычек).

IMAGE_DEFAULT="camoufox-research:dev"
DATA_DEFAULT="camoufox-research-data"
# Порог «сервер отдал реестр» для --self-test. 30 — нижняя граница с запасом:
# дефолтный профиль агента (CAMOUFOX_CAPS=research,browser) = 34 тула
# (camoufox_caps.py), полный реестр (all) — 62. Порог ловит «поднялся, но пустой»,
# а не фиксирует точное число: число тулов профиля — предмет отдельного гейта.
MIN_TOOLS_DEFAULT=30

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

RUNTIME=""
IMAGE="$IMAGE_DEFAULT"
DATA="$DATA_DEFAULT"
CAPS=""
DO_BUILD=0
DO_RUN=0
DO_SELF_TEST=0
JSON_ONLY=0
HTTP_PORT=""
HTTP_HOST="127.0.0.1"
RUN_EXTRA=()

die() { printf 'ОШИБКА: %s\n' "$1" >&2; exit "${2:-1}"; }
info() { printf '%s\n' "$1"; }

usage() {
    cat <<'EOF'
run_in_docker.sh — MCP-сервер camoufox-research в контейнере (stdio по умолчанию).

  bash scripts/run_in_docker.sh                 # готовая конфигурация клиента
  bash scripts/run_in_docker.sh --build         # собрать образ из этого репо
  bash scripts/run_in_docker.sh --self-test     # проверить рукопожатие MCP в образе
  bash scripts/run_in_docker.sh --run --caps all   # запустить сервер (stdio) здесь

Флаги:
  --runtime docker|podman   рантайм контейнеров (по умолчанию docker, иначе podman)
  --image TAG               имя образа (по умолчанию camoufox-research:dev)
  --data NAME|PATH          том данных (по умолчанию camoufox-research-data)
  --caps LIST               профиль тулов: research,browser | all | session,vision
  --build                   собрать образ: docker build -t TAG <корень репо>
  --run [АРГ…]              запустить контейнер (остальные АРГ — серверу)
  --http [PORT]             http-транспорт вместо stdio (по умолчанию 8833);
                            по умолчанию доступен только с 127.0.0.1 хоста
  --http-bind HOST          интерфейс публикации HTTP (по умолчанию 127.0.0.1;
                            0.0.0.0 открывает наружу и печатает предупреждение)
  --self-test               initialize + tools/list внутри контейнера, гейт по числу тулов
  --json                    только JSON конфигурации клиента (для скриптов)
  --help                    эта справка

Всё, что делает скрипт, читаемо: он НИЧЕГО не пишет в файлы хоста (кроме сборки
образа) — конфигурацию клиента вы вставляете сами.
EOF
}

has_command() { command -v "$1" >/dev/null 2>&1; }

pick_runtime() {
    if [ -n "${CAMOUFOX_CONTAINER_RUNTIME:-}" ]; then
        RUNTIME="$CAMOUFOX_CONTAINER_RUNTIME"
    elif has_command docker; then
        RUNTIME="docker"
    elif has_command podman; then
        RUNTIME="podman"
    else
        die "нет ни docker, ни podman: поставьте один из них (или CAMOUFOX_CONTAINER_RUNTIME=/путь/к/рантайму)"
    fi
    has_command "$RUNTIME" || die "рантайм '$RUNTIME' не найден в PATH"
}

# --- разбор флагов ----------------------------------------------------------
need_value() {  # $1=флаг, $2=значение: пусто → ошибка с подсказкой (rc=2)
    [ -n "${2:-}" ] || die "флаг $1 без значения (--help)" 2
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --runtime) need_value "--runtime" "${2:-}"; RUNTIME="$2"; shift 2 ;;
        --image) need_value "--image" "${2:-}"; IMAGE="$2"; shift 2 ;;
        --data) need_value "--data" "${2:-}"; DATA="$2"; shift 2 ;;
        --caps) need_value "--caps" "${2:-}"; CAPS="$2"; shift 2 ;;
        --build) DO_BUILD=1; shift ;;
        --run) DO_RUN=1; shift; RUN_EXTRA=("$@"); break ;;
        --http)
            DO_RUN=1
            # Значение опционально; отличаем «--http PORT» от «--http» по тому,
            # начинается ли следующий аргумент с дефиса (порта-флага не бывает).
            if [ "$#" -ge 2 ] && [ "${2#--}" = "$2" ] && [ -n "$2" ]; then
                HTTP_PORT="$2"
                shift
            else
                HTTP_PORT=8833
            fi
            shift ;;
        --http-bind)
            need_value "--http-bind" "${2:-}"; HTTP_HOST="$2"; shift 2 ;;
        --self-test) DO_SELF_TEST=1; shift ;;
        --json) JSON_ONLY=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "неизвестный флаг: $1 (--help)" 2 ;;
    esac
done
# --runtime мог быть задан флагом, а мог не задаваться вовсе.
[ -n "$RUNTIME" ] || pick_runtime
has_command "$RUNTIME" || die "рантайм '$RUNTIME' не найден в PATH"

image_present() { "$RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1; }

build_image() {
    info "== сборка $IMAGE из $REPO_ROOT (первый раз ~5-10 мин: качается браузер ≈663 МБ) =="
    "$RUNTIME" build -t "$IMAGE" "$REPO_ROOT"
    info "== образ собран: $("$RUNTIME" image inspect --format '{{.Size}}' "$IMAGE" 2>/dev/null || echo '?') байт =="
}

# Аргументы запуска контейнера. -i обязателен (stdio); -t НЕ добавляем никогда.
# -v "$DATA:/data" — кэш/кампании переживают --rm, иначе каждый старт с нуля.
run_args() {
    RUN_ARGS=("$RUNTIME" run -i --rm)
    if [ -n "$HTTP_PORT" ]; then
        # Внутри контейнера сервер слушает 0.0.0.0, но наружу по умолчанию
        # публикуем только loopback хоста. Открытый интерфейс — явный флаг.
        RUN_ARGS+=(-p "${HTTP_HOST}:${HTTP_PORT}:${HTTP_PORT}")
        if [ "$HTTP_HOST" != "127.0.0.1" ] && [ "$HTTP_HOST" != "localhost" ]; then
            printf 'ВНИМАНИЕ: HTTP публикуется на %s:%s; это доступ из других сетей.\n' "$HTTP_HOST" "$HTTP_PORT" >&2
        fi
    fi
    RUN_ARGS+=(-v "${DATA}:/data")
    if [ -n "$CAPS" ]; then
        RUN_ARGS+=(-e "CAMOUFOX_CAPS=${CAPS}")
    fi
    RUN_ARGS+=("$IMAGE")
    if [ -n "$HTTP_PORT" ]; then
        RUN_ARGS+=(--transport http --host 0.0.0.0 --port "$HTTP_PORT")
    fi
    if [ "${#RUN_EXTRA[@]}" -gt 0 ]; then
        RUN_ARGS+=("${RUN_EXTRA[@]}")
    fi
}

# --- JSON для клиента -------------------------------------------------------
# Два формата, потому что клиенты разные: opencode (type: local + command)
# и универсальный mcpServers (Claude Desktop и родня). Печатаем ровно то, что
# можно вставить как есть (кавычки для JSON, не для шелла).
#
# ВАЖНО: command/args собираются ИЗ ТЕХ ЖЕ RUN_ARGS, что уходят в контейнер
# (двойник конфигурации, расходящийся с реальным запуском, — худший вид лжи:
# человек вставляет JSON, а сервер поднимается иначе).
json_command() {  # $1=with-runtime | no-runtime (для поля args у mcpServers)
    local parts=() arg
    if [ "$1" = "with-runtime" ]; then
        parts+=("\"$RUNTIME\"")
    fi
    for arg in "${RUN_ARGS[@]:1}"; do
        parts+=("\"$arg\"")
    done
    local IFS=','
    printf '%s' "${parts[*]}"
}
json_env() {  # env-объект: профиль тулов, если он задан флагом
    if [ -n "$CAPS" ]; then
        printf '{"CAMOUFOX_CAPS":"%s"}' "$CAPS"
    else
        printf '{}'
    fi
}
json_opencode() {
    printf '%s\n' "{\"mcp\":{\"camoufox\":{\"type\":\"local\",\"command\":[$(json_command with-runtime)],\"environment\":$(json_env),\"enabled\":true}}}"
}
json_mcpservers() {
    printf '%s\n' "{\"mcpServers\":{\"camoufox\":{\"command\":\"$RUNTIME\",\"args\":[$(json_command no-runtime)],\"env\":$(json_env)}}}"
}
# http-режим в конфигурации клиента выглядит иначе: не дочерний процесс, а URL.
# Формат записи у клиентов разный — поэтому это ДОПОЛНИТЕЛЬНАЯ строка, а не
# замена stdio-конфигурации (url проверен curl'ом, см. --run --http).
json_url() {
    printf '%s\n' "{\"mcpServers\":{\"camoufox\":{\"type\":\"http\",\"url\":\"http://${HTTP_HOST}:${HTTP_PORT}/mcp\"}}}"
}

# --- рукопожатие внутри контейнера -----------------------------------------
# out/err — ГЛОБАЛЬНЫЕ (не local): trap на EXIT срабатывает уже после возврата
# функции, и с local в этот момент переменные не видны («out: не заданы границы
# переменной» при set -u). Урок: trap на EXIT и локальные переменные функции
# несовместимы.
SELF_TEST_OUT=""
SELF_TEST_ERR=""
cleanup_self_test_tmp() {
    if [ -n "$SELF_TEST_OUT" ]; then
        rm -f "$SELF_TEST_OUT" "$SELF_TEST_ERR"
    fi
}

self_test() {
    local n boot_start boot_end rc=0 nonjson proto
    SELF_TEST_OUT="$(mktemp "${TMPDIR:-/tmp}/camoufox-mcp-out.XXXXXX")"
    SELF_TEST_ERR="$(mktemp "${TMPDIR:-/tmp}/camoufox-mcp-err.XXXXXX")"
    trap cleanup_self_test_tmp EXIT

    run_args
    printf '%s\n' "== рукопожатие MCP в контейнере: $RUNTIME run -i --rm -v $DATA:/data $IMAGE =="
    boot_start="$(date +%s)"
    # sleep в конце пайпа держит stdin ОТКРЫТЫМ: закрой его сразу — сервер
    # увидит EOF раньше, чем ответит на tools/list (гонка, а не «сервер сломан»).
    {
        printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"run_in_docker","version":"1"}}}'
        printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
        sleep 3
    } | "${RUN_ARGS[@]}" >"$SELF_TEST_OUT" 2>"$SELF_TEST_ERR" || rc=$?
    boot_end="$(date +%s)"

    n="$(grep -o '"inputSchema"' "$SELF_TEST_OUT" 2>/dev/null | wc -l | tr -d ' ')"
    proto="$(grep -o '"protocolVersion":"[^"]*"' "$SELF_TEST_OUT" 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
    # stdout — это протокол: посторонняя строка = сломанный клиент. Считаем её.
    nonjson="$(grep -vc '^{' "$SELF_TEST_OUT" 2>/dev/null | tr -d ' ' || true)"

    # Время честно названо полным: сюда входит запуск контейнера и те самые 3 с
    # удержания stdin — это не «boot сервера», и выдавать одно за другое нельзя.
    printf '  сервер ответил: %s строк JSON, protocolVersion=%s, тулов=%s\n' \
        "$(grep -c . "$SELF_TEST_OUT" 2>/dev/null | tr -d ' ' || echo 0)" "${proto:-нет}" "$n"
    printf '  полное время прогона (docker run + 3 с удержания stdin): %s с (rc=%s)\n' \
        "$((boot_end - boot_start))" "$rc"
    printf '  строк НЕ-JSON в stdout (должно быть 0): %s\n' "${nonjson:-0}"
    if [ -s "$SELF_TEST_ERR" ]; then
        printf '  stderr (tail 5):\n%s\n' "$(tail -5 "$SELF_TEST_ERR" | sed 's/^/    /')"
    fi

    if [ -z "$proto" ]; then
        printf 'РЕЗУЛЬТАТ: FAIL — рукопожатие не состоялось (initialize без protocolVersion)\n'
        return 1
    fi
    if [ "${nonjson:-0}" -ne 0 ]; then
        printf 'РЕЗУЛЬТАТ: FAIL — в stdout попал мусор (stdio-протокол сломан)\n'
        return 1
    fi
    if [ "$n" -lt "$MIN_TOOLS_DEFAULT" ]; then
        printf 'РЕЗУЛЬТАТ: FAIL — тулов %s < %s (профиль не применился?)\n' "$n" "$MIN_TOOLS_DEFAULT"
        return 1
    fi
    printf 'РЕЗУЛЬТАТ: PASS — образ поднимает MCP и отдаёт %s тулов (порог %s)\n' "$n" "$MIN_TOOLS_DEFAULT"
}

# --- выполнение -------------------------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
    build_image
fi

if [ "$JSON_ONLY" -eq 1 ]; then
    run_args
    if [ -n "$HTTP_PORT" ]; then
        # http-режим: клиенту нужен URL, а не дочерний процесс — форма
        # «command: docker run …» здесь была бы неверной (сервер не читает stdin).
        json_url
    else
        json_opencode
        json_mcpservers
    fi
    exit 0
fi

if [ "$DO_SELF_TEST" -eq 1 ]; then
    image_present || build_image
    self_test
    exit $?
fi

if [ "$DO_RUN" -eq 1 ]; then
    image_present || build_image
    run_args
    if [ -n "$HTTP_PORT" ]; then
        printf 'http-транспорт: %s\n' "${RUN_ARGS[*]}"
        printf 'слушает http://%s:%s/mcp (внутри контейнера 0.0.0.0)\n' "$HTTP_HOST" "$HTTP_PORT"
        printf 'проверка (проверено 21.09): POST на /mcp → 200 + event-stream.\n'
        printf 'GET / → 404 — это НЕ ошибка (роут только POST /mcp), а не «сервер не встал»:\n'
        printf '  curl -sS -o /dev/null -w "%%{http_code}\\n" -X POST http://%s:%s/mcp \\\n' "$HTTP_HOST" "$HTTP_PORT"
        printf "    -H 'Content-Type: application/json' \\\\\n    -H 'Accept: application/json, text/event-stream' \\\\\n"
        printf "    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"1\"}}}'\n"
    fi
    exec "${RUN_ARGS[@]}"
fi

# По умолчанию — конфигурация для клиента (систему не трогаем).
run_args
info "=== camoufox-research в контейнере: готовая конфигурация клиента ==="
info ""
info "образ:  $IMAGE   (≈908 МБ скачать, 2,9 ГБ на диске; внутри браузер Camoufox)"
info "данные: $DATA:/data (кэш страниц/поиска, кампании, память — переживают --rm)"
info "профиль тулов: ${CAPS:-дефолт образа (CAMOUFOX_CAPS=research,browser, 34 тула)}"
info ""
info "команда руками (то же, что в конфигурации ниже):"
info "  ${RUN_ARGS[*]}"
info ""
info "ПОЧЕМУ \`-i\` И ПОЧЕМУ НЕ \`-t\`/\`-d\`:"
info "  MCP по stdio — это stdin/stdout, то есть сам протокол. \`-i\` держит stdin"
info "  открытым: без него сервер получит EOF и завершится (клиент увидит"
info "  'server disconnected'). \`-t\` нельзя — tty подмешивает CR и эхо,"
info "  JSON-RPC рассыпается. \`-d\`/\`--restart\` тоже нельзя: сервер — дочерний"
info "  процесс клиента, он живёт ровно столько, сколько сессия агента."
info ""
info "opencode.json:"
json_opencode
info ""
info "универсальный формат (Claude Desktop и подобные):"
json_mcpservers
info ""
info "Дальше:"
info "  bash scripts/run_in_docker.sh --self-test    # рукопожатие внутри образа (гейт)"
info "  bash scripts/run_in_docker.sh --build        # пересобрать образ из этого репо"
info "  bash scripts/run_in_docker.sh --http 8833    # http-транспорт вместо stdio"
info "  внешний HTTP: добавь --http-bind 0.0.0.0 (по умолчанию только 127.0.0.1)"
info "  --caps all  → полный реестр (62 тула); session,vision — opt-in группы"
info ""
info "Bind-mount вместо тома: \`--data /путь/на/хосте\` — каталог должен быть"
info "записываем uid 1000 (\`sudo chown 1000:1000 /путь\`): контейнер работает НЕ от root."
