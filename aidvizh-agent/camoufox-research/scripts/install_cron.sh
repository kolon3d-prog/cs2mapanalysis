#!/usr/bin/env bash
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub
  # noqa: E501

# Крон-установщик: генерирует ВСЕ крон-строки из config.env одной
# командой (БЕЗ ручной правки и без хардкода путей — закон 28).
# Строки читают ~/.cache/camoufox-research/config.env (sed) — переезд
# на другую машину = перезапустить этот скрипт.
#
# Запуск:
#   scripts/install_cron.sh           — поставить/обновить строки
#   scripts/install_cron.sh --dry     — показать без применения
#   scripts/install_cron.sh --remove  — снять ВСЕ наши строки (переезд)
#   scripts/install_cron.sh --keep-timings — обновить, сохранив СВОИ
#     времена расписаний (если менял руками — не перезапишутся)
#
# Что ставит (имена логов — конвенция кэша):
#   7 9,21  watchdog_search  (DDG жив?)           — 2р/день
#   3 11 * 1 topic_watch     (дозор тем)          — пн
#   0 0 1   precommit   autoupdate (линтеры)      — 1р/мес
# НОЧНЫЕ (backup_cache 04:20, map_metric 04:40) — в systemd-таймеры с
# догоном (install_timers.sh): crond пропускает при спящей машине.

set -euo pipefail

REPO="${CAMOUFOX_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CACHE="${CAMOUFOX_CACHE_DIR:-$HOME/.cache/camoufox-research}"
CFG="$CACHE/config.env"
MODE="install"
DRY=0
KEEP=0
# Флаги РАЗВЕДЕНЫ (аудит 21.09): раньше всё писалось в одну MODE, поэтому
# `--dry --keep-timings` терял --dry (побеждал последний матч) и ПИСАЛ
# crontab, а опечатка вида `--dryy` молча считалась обычной установкой.
for a in "$@"; do
  case "$a" in
    --dry) DRY=1 ;;
    --remove) MODE="remove" ;;
    --keep-timings) KEEP=1 ;;
    *) echo "install_cron: неизвестный флаг '$a' (есть: --dry, --remove, --keep-timings)" >&2; exit 2 ;;
  esac
done

# crontab — Unix-only (Linux/macOS/BSD; на macOS он есть, но демон требует
# Full Disk Access юзеру, иначе строки молча не выполняются). В Git-Bash/
# Windows и в минимальных контейнерах бинарника НЕТ: раньше скрипт писал
# временные файлы и падал «crontab: command not found» посреди работы,
# оставив мусор. Планировщик для Windows НЕ выдумываем — только честный
# отказ с подсказкой (там же нет и systemd — см. install_timers.sh).
# Превью строк (--dry) на машине без cron сознательно НЕ поддерживаем:
# ставить строки всё равно нечем, а исключение ослабляло страж — --dry
# доходил до temp-файлов и падал «mktemp: command not found» уже ПОСРЕДИ
# работы (ровно то, от чего страж и стоит). Отказ — ДО создания любых
# файлов, поэтому мусора не остаётся.
command -v crontab >/dev/null 2>&1 || {
  echo "install_cron: нет crontab — планировщик cron недоступен в этой ОС (Git-Bash/Windows)." >&2
  echo "  Строки не ставить и не превьюшить нечем. Linux/macOS/BSD: поставь cron." >&2
  echo "  Догон ночных джобов без cron — install_timers.sh (systemd)." >&2
  exit 1
}

gen_line() { # $1=расписание $2=имя-лога $3=скрипт (можно с хвостовыми аргументами)
  # Три ловушки кавычек/путей, поймано прогоном готовой строки через `sh -c`
  # (аудит переносимости 21.09):
  # 1) sed-программа для python стояла в ОДИНАРНЫХ кавычках внутри
  #    single-quoted payload `bash -c '...'` — /bin/sh закрывал кавычку
  #    раньше времени, снимал `\(`→`(`, `\1`→`1`; sed не матчил, подстановка
  #    давала ПУСТУЮ команду и джоб падал с `bash: : command not found`
  #    (то есть крон-хвосты не выполнялись вообще). Внутри single-quoted
  #    payload безопасны ДВОЙНЫЕ кавычки — их и используем.
  # 2) $CFG/$CACHE подставлялись голыми словами: пробел в пути (обычное дело
  #    на macOS — `/Users/First Last/...`) рвал и sed, и redirect лога.
  # 3) fallback репо был захардкожен (`$HOME/media-projects/camoufox-research`
  #    — путь другой машины); берём реальный корень репо, вычисленный выше.
  local payload
  payload="cd \"\$CAMOUFOX_REPO\" && \"\$(sed -n \"s/^CAMOUFOX_PYTHON=\\\"\\(.*\\)\\\"/\\1/p\" \"$CFG\" 2>/dev/null || echo python3)\" scripts/$3"
  echo "$1 CAMOUFOX_REPO=\"\$(sed -n 's/^CAMOUFOX_REPO=\"\\(.*\\)\"/\\1/p' \"$CFG\" 2>/dev/null || echo \"$REPO\")\" bash -c '$payload' >> \"$CACHE/$2.log\" 2>&1"
}

# имена <-> дефолтные расписания <-> скрипты (для keep-timings)
ITEMS=(
  "watchdog_search|7 9,21 * * *|watchdog_search.py"
  "topic_watch|3 11 * * 1|topic_watch.py"
  "precommit|0 0 1 * *|pre-commit_autoupdate.sh"
  "budget_review|20 10 * * 1|budget_review.py"
  "tool_usage|15 10 * * 1|tool_usage_stats.py --out \"\$CAMOUFOX_REPO/metrics/usage-weekly.txt\" --candidates \"\$CAMOUFOX_REPO/metrics/usage-candidates.json\""
  "health_pulse|0 8 * * *|health_pulse.py"
)

# Временные файлы — ТОЛЬКО через mktemp, не фиксированный /tmp/cron_new:
# предсказуемое имя в общем /tmp затиралось параллельным прогоном (крон
# ставится и хуком, и руками), а чужой симлинк по этому пути подменял
# содержимое будущего crontab. mktemp без шаблона одинаково работает
# в GNU, macOS и BSD.
TMP_LINES="$(mktemp)"
TMP_NEW="$(mktemp)"
trap 'rm -f "$TMP_LINES" "$TMP_NEW"' EXIT

# --- remove: снять наши строки, оставить чужие ---
if [ "$MODE" = "remove" ]; then
  crontab -l 2>/dev/null | grep -vE 'watchdog_search|topic_watch|backup_cache|map_metric_cron|precommit|budget_review|tool_usage_stats|health_pulse' > "$TMP_NEW" 2>/dev/null || true
  crontab "$TMP_NEW"
  echo "✅ Сняты все строки кауфми (чужой крон не тронут)."
  echo "   Осталось строк в crontab: $(crontab -l 2>/dev/null | grep -c .)"
  exit 0
fi

# --- собрать строки: своё расписание или из старого crontab (keep) ---
read_old_sched() { # $1=имя — найти расписание в текущем crontab
  # || true: set -euo pipefail — grep без совпадений падал бы на новых именах
  crontab -l 2>/dev/null | grep "$1" | head -1 | awk '{print $1, $2, $3, $4, $5}' || true
}

for item in "${ITEMS[@]}"; do
  IFS='|' read -r name def_sched script <<< "$item"
  sched="$def_sched"
  if [ "$KEEP" = 1 ]; then
    old="$(read_old_sched "$name")"
    [ -n "$old" ] && sched="$old"   # своё расписание сильнее дефолта
  fi
  gen_line "$sched" "$name" "$script" >> "$TMP_LINES"
done

if [ "$DRY" = 1 ]; then
  echo "Крон-строки (dry, НЕ применены):"
  sed 's/^/  /' "$TMP_LINES"
  exit 0
fi

# --- install/keep: убрать старые наши, добавить новые (идемпотентно) ---
crontab -l 2>/dev/null | grep -vE 'watchdog_search|topic_watch|backup_cache|map_metric_cron|precommit|budget_review|tool_usage_stats|health_pulse' > "$TMP_NEW" 2>/dev/null || true
cat "$TMP_LINES" >> "$TMP_NEW"
crontab "$TMP_NEW"
echo "✅ Крон обновлён (строк наших: $(grep -cE 'watchdog_search|backup_cache|map_metric_cron' "$TMP_NEW"))"
echo "   проверь: crontab -l"
