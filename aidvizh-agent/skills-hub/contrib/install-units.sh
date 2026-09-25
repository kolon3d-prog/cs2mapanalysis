#!/usr/bin/env bash
# Ставит systemd-юниты хаба в пользовательский systemd, подставляя путь хаба.
# Юниты лежат рядом шаблонами (@HUB@) — так в репозитории нет абсолютных путей,
# которые ломаются при переезде диска.
set -euo pipefail

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$DEST"
for unit in skills-hub-check.service skills-hub-check.timer; do
  sed "s|@HUB@|$HUB|g" "$HUB/contrib/$unit.in" >"$DEST/$unit"
  printf 'ok: %s\n' "$DEST/$unit"
done

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  printf '\nактивирую и проверяю таймер:\n'
  systemctl --user enable --now skills-hub-check.timer
  systemctl --user is-enabled --quiet skills-hub-check.timer
  systemctl --user is-active --quiet skills-hub-check.timer
  printf 'ok: skills-hub-check.timer.enabled + active\n'
  printf 'проверить: systemctl --user start skills-hub-check.service && journalctl --user -u skills-hub-check -n 20\n'
else
  printf '\nsystemctl не найден — юниты положены, но не активированы\n'
fi
