#!/usr/bin/env bash
# Ставит systemd-юниты центра в пользовательский systemd, подставляя путь центра и путь
# локальной обёртки. Шаблоны лежат рядом (@CENTER@/@LOCAL@) — так в репозитории нет абсолютных
# путей, которые ломаются при переезде диска (тот же приём, что у skills-hub/contrib/install-units.sh).
#
# Что ставится:
#   center-sentinel.service/.timer — сторож каждые 15 минут: диск DATA на месте и ссылки в $HOME живы;
#   center-backup.service/.timer   — ночной бэкап, только если есть файл целей
#                                    $HOME/.config/center/backup.target (по строке на цель;
#                                    второй столбец — свой --keep);
#   $HOME/.local/state/center/center-local.sh — ЛОКАЛЬНАЯ обёртка (копия, не ссылка на диск): она
#                                    переживает пропажу диска и говорит об этом строкой, иначе
#                                    юнит молчал бы ровно тогда, когда должен кричать.
#
# Юниты зовут обёртку, а не скрипт с диска: сторож, живущий на том же диске, что и сторожимое,
# не сторож.
#
# Использование: contrib/install-units.sh
#   XDG_CONFIG_HOME, XDG_STATE_HOME — куда ставить (по умолчанию $HOME/.config и $HOME/.local/state)
set -euo pipefail

CONTRIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CENTER="$(cd "$CONTRIB/.." && pwd)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
LOCAL="${XDG_STATE_HOME:-$HOME/.local/state}/center"
TARGET_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/center/backup.target"

mkdir -p "$DEST" "$LOCAL"

# Подстановка путей: @CENTER@ — центр на диске, @LOCAL@ — локальная обёртка в $HOME.
install_template() {
  sed -e "s|@CENTER@|$CENTER|g" -e "s|@LOCAL@|$LOCAL|g" "$CONTRIB/$1.in" >"$DEST/$1"
  printf 'ok: %s\n' "$DEST/$1"
}

install_local_wrapper() {
  sed -e "s|@CENTER@|$CENTER|g" "$CONTRIB/center-local.sh.in" >"$LOCAL/center-local.sh"
  chmod +x "$LOCAL/center-local.sh"
  printf 'ok: %s (копия, а не ссылка на диск — переживает пропажу диска)\n' "$LOCAL/center-local.sh"
}

install_local_wrapper
install_template center-sentinel.service
install_template center-sentinel.timer

backup=0
if [[ -f "$TARGET_FILE" ]]; then
  install_template center-backup.service
  install_template center-backup.timer
  backup=1
else
  printf '— центр-бэкап не ставлю: нет файла целей %s\n' "$TARGET_FILE"
  printf '  (положи в него путь на другом диске — по строке на цель — и запусти этот скрипт снова)\n'
fi

activate_timer() {
  local unit="$1"
  systemctl --user enable --now "$unit"
  systemctl --user is-enabled --quiet "$unit"
  systemctl --user is-active --quiet "$unit"
  printf 'ok: %s.enabled + active\n' "$unit"
}

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  printf '\nактивирую и проверяю таймеры:\n'
  activate_timer center-sentinel.timer
  if (( backup == 1 )); then
    activate_timer center-backup.timer
  fi
  printf 'проверить: systemctl --user start center-sentinel.service && journalctl --user -u center-sentinel -n 20\n'
else
  printf '\nsystemctl не найден — юниты положены, но не активированы\n'
fi
