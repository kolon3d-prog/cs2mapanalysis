#!/usr/bin/env bash
# modes-station: ставит плагин /goal и /loop в opencode2 — симлинком в каталог плагинов клиента.
#
#   bin/modes-station.sh install   поставить (или переставить) ссылку
#   bin/modes-station.sh status    что стоит сейчас
#   bin/modes-station.sh remove    снять ссылку (чужой файл не трогаем)
#
# Конфиг: $MODES_CONFIG_DIR, иначе $XDG_CONFIG_HOME/opencode, иначе ~/.config/opencode.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$HERE/plugin/opencode/modes.ts"
CONFIG_DIR=${MODES_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}
PLUGINS_DIR="$CONFIG_DIR/plugins"
LINK="$PLUGINS_DIR/modes-station.ts"

say() { printf '%s\n' "$*"; }
die() {
  printf 'modes-station: %s\n' "$*" >&2
  exit 1
}

cmd_install() {
  [ -f "$SOURCE" ] || die "нет плагина: $SOURCE"
  mkdir -p "$PLUGINS_DIR" || die "не смог создать $PLUGINS_DIR"
  if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    stamp=$(date +%s)
    mv -- "$LINK" "$LINK.bak-$stamp" || die "не смог отложить чужой файл $LINK"
    say "чужой файл отложен: $LINK.bak-$stamp"
  fi
  ln -sfn -- "$SOURCE" "$LINK" || die "не смог поставить ссылку $LINK"
  target=$(readlink -- "$LINK" 2>/dev/null || true)
  [ "$target" = "$SOURCE" ] || die "ссылка указывает не туда: $target"
  say "готово: $LINK -> $SOURCE"
  say "новые сессии opencode2 подхватят плагин сразу; если нет — opencode2 service restart"
  say "проверка: opencode2 api POST /api/session -d '{\"title\":\"modes-check\"}' и /loop 2 в новой сессии"
}

cmd_status() {
  say "плагин: $SOURCE"
  [ -f "$SOURCE" ] && say "  на диске: $(wc -c <"$SOURCE") байт" || say "  на диске: НЕТ"
  say "ссылка: $LINK"
  if [ -L "$LINK" ]; then
    target=$(readlink -- "$LINK")
    if [ "$target" = "$SOURCE" ]; then
      say "  состояние: стоит, указывает на плагин"
    else
      say "  состояние: ссылка на другое место — $target"
    fi
  elif [ -e "$LINK" ]; then
    say "  состояние: файл (не ссылка) — станция его не ставила"
  else
    say "  состояние: не стоит (install)"
  fi
}

cmd_remove() {
  if [ -L "$LINK" ]; then
    target=$(readlink -- "$LINK")
    if [ "$target" = "$SOURCE" ]; then
      rm -f -- "$LINK" || die "не смог снять $LINK"
      say "снято: $LINK"
    else
      die "ссылка ведёт не в станцию ($target) — не трогаю"
    fi
  elif [ -e "$LINK" ]; then
    die "$LINK — файл, не ссылка станции; снеси вручную, если это точно он"
  else
    say "нечего снимать: ссылки нет"
  fi
}

usage() {
  say "modes-station: плагин /goal и /loop для opencode2"
  say ""
  say "  modes-station install   поставить ссылку в $PLUGINS_DIR"
  say "  modes-station status    что стоит сейчас"
  say "  modes-station remove    снять ссылку"
  say ""
  say "конфиг: $CONFIG_DIR (переопределяется MODES_CONFIG_DIR)"
}

case "${1:-status}" in
  install) cmd_install ;;
  status) cmd_status ;;
  remove) cmd_remove ;;
  help) usage ;;
  -h | --help) usage ;;
  *) die "неизвестная команда «$1»: install | status | remove" ;;
esac
