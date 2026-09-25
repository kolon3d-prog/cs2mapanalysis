#!/usr/bin/env bash
# vibe-station: ставит server plugin и TUI footer для /vibe в opencode2 — симлинками.
#
#   bin/vibe-station.sh install   поставить (или переставить) ссылки
#   bin/vibe-station.sh status    что стоит сейчас
#   bin/vibe-station.sh remove    снять ссылку (чужой файл не трогаем)
#
# Конфиг OpenCode2: $XDG_CONFIG_HOME/opencode, иначе ~/.config/opencode.
# VIBE_CONFIG_DIR допускается только для изолированных тестов с VIBE_ALLOW_UNSCANNED_CONFIG=1.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$HERE/plugin/opencode/vibe.ts"
TUI_SOURCE="$HERE/plugin/opencode-tui"
if [ -n "${VIBE_CONFIG_DIR:-}" ]; then
  if [ "${VIBE_ALLOW_UNSCANNED_CONFIG:-0}" != "1" ]; then
    printf 'vibe-station: VIBE_CONFIG_DIR не читается OpenCode2; используй XDG_CONFIG_HOME/opencode (для изолированных тестов: VIBE_ALLOW_UNSCANNED_CONFIG=1)\n' >&2
    exit 1
  fi
  CONFIG_DIR=$VIBE_CONFIG_DIR
else
  CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
fi
PLUGINS_DIR="$CONFIG_DIR/plugins"
LINK="$PLUGINS_DIR/vibe-station.ts"
TUI_LINK="$PLUGINS_DIR/vibe-station-tui"
# Агенты режима — нативные файлы конфига opencode2 (каталог agent/ сканируется клиентом):
# в них mode, hidden, permissions и системный промпт. Плагин только проверяет, что они стоят.
AGENT_DIR="$CONFIG_DIR/agent"
AGENTS="vibe-director vibe-fast vibe-good vibe-audit-fast vibe-audit-good"
# Скилл режима — как spec-mode у spec-station: канонический слой ~/.agents/skills плюс зеркала клиентов,
# иначе opencode2 (и остальные клиенты) скилл просто не видят: его слой сканируется отдельно.
SKILL_SOURCE="$HERE/skill"
SKILL_NAME="vibe-mode"
skill_layers() {
  printf '%s\n' \
    "${VIBE_SKILLS_DIR:-$HOME/.agents/skills}" \
    "$CONFIG_DIR/skills" \
    "$HOME/.claude/skills" \
    "$HOME/.omp/agent/skills" \
    "$HOME/.pi/agent/skills"
}

say() { printf '%s\n' "$*"; }
die() {
  printf 'vibe-station: %s\n' "$*" >&2
  exit 1
}

prepare_destination() {
  # prepare_destination <источник> <ссылка> <вид>: сохраняем чужое, включая symlink.
  src=$1
  dst=$2
  kind=$3
  if [ -L "$dst" ]; then
    target=$(readlink -- "$dst")
    if [ "$target" != "$src" ]; then
      stamp=$(date +%s)
      mv -- "$dst" "$dst.bak-$stamp" || die "не смог отложить чужой $kind $dst"
      say "чужой $kind отложен: $dst.bak-$stamp"
    fi
  elif [ -e "$dst" ]; then
    stamp=$(date +%s)
    mv -- "$dst" "$dst.bak-$stamp" || die "не смог отложить чужой $kind $dst"
    say "чужой $kind отложен: $dst.bak-$stamp"
  fi
}

link_into() {
  # link_into <источник> <ссылка>: чужой файл откладываем, не затираем
  src=$1
  dst=$2
  [ -f "$src" ] || die "нет файла: $src"
  prepare_destination "$src" "$dst" "файл"
  ln -sfn -- "$src" "$dst" || die "не смог поставить ссылку $dst"
  [ "$(readlink -- "$dst")" = "$src" ] || die "ссылка указывает не туда: $(readlink -- "$dst")"
}

link_dir_into() {
  # link_dir_into <каталог в станции> <ссылка>: каталог линкуем целиком, чтобы references/ ехали вместе
  src=$1
  dst=$2
  [ -d "$src" ] || die "нет каталога: $src"
  prepare_destination "$src" "$dst" "каталог"
  ln -sfn -- "$src" "$dst" || die "не смог поставить ссылку $dst"
  [ "$(readlink -- "$dst")" = "$src" ] || die "ссылка указывает не туда: $(readlink -- "$dst")"
}

cmd_install() {
  [ -f "$SOURCE" ] || die "нет плагина: $SOURCE"
  [ -d "$TUI_SOURCE" ] || die "нет TUI-плагина: $TUI_SOURCE"
  mkdir -p "$PLUGINS_DIR" "$AGENT_DIR" || die "не смог создать каталоги конфига"
  link_into "$SOURCE" "$LINK"
  say "плагин: $LINK -> $SOURCE"
  link_dir_into "$TUI_SOURCE" "$TUI_LINK"
  say "TUI:    $TUI_LINK -> $TUI_SOURCE"
  for name in $AGENTS; do
    link_into "$HERE/agent/$name.md" "$AGENT_DIR/$name.md"
    say "агент:  $AGENT_DIR/$name.md -> $HERE/agent/$name.md"
  done
  mkdir -p "$HOME/.agents" || die "не смог создать $HOME/.agents"
  skill_layers | while IFS= read -r layer; do
    parent=$(dirname -- "$layer")
    if [ ! -d "$parent" ]; then
      say "скилл:  слой $layer пропущен (клиента нет)"
      continue
    fi
    mkdir -p "$layer" || die "не смог создать $layer"
    link_dir_into "$SKILL_SOURCE" "$layer/$SKILL_NAME"
    say "скилл:  $layer/$SKILL_NAME -> $SKILL_SOURCE"
  done
  say "сервис держит плагин в памяти — после правок: opencode2 service restart"
  say "проверка: /vibe в новой сессии, дальше vibe_spawn (cli=fast|good)"
}

status_one() {
  # status_one <источник> <ссылка> <подпись>
  src=$1
  dst=$2
  label=$3
  say "$label: $dst"
  if [ -f "$src" ]; then
    say "  в станции: $(wc -c <"$src") байт"
  elif [ -d "$src" ]; then
    say "  в станции: каталог"
  else
    say "  в станции: НЕТ"
  fi
  if [ -L "$dst" ]; then
    target=$(readlink -- "$dst")
    if [ "$target" = "$src" ]; then
      say "  состояние: стоит, указывает в станцию"
    else
      say "  состояние: ссылка на другое место — $target"
    fi
  elif [ -e "$dst" ]; then
    say "  состояние: файл (не ссылка) — станция его не ставила"
  else
    say "  состояние: не стоит (install)"
  fi
}

cmd_status() {
  status_one "$SOURCE" "$LINK" "плагин"
  status_one "$TUI_SOURCE" "$TUI_LINK" "TUI"
  for name in $AGENTS; do
    status_one "$HERE/agent/$name.md" "$AGENT_DIR/$name.md" "агент $name"
  done
  skill_layers | while IFS= read -r layer; do
    status_one "$SKILL_SOURCE" "$layer/$SKILL_NAME" "скилл $SKILL_NAME"
  done
}

remove_one() {
  # remove_one <ссылка>: снимаем только свою ссылку, чужое не трогаем
  dst=$1
  if [ -L "$dst" ]; then
    target=$(readlink -- "$dst")
    case "$target" in
      "$HERE"/*)
        rm -f -- "$dst" || die "не смог снять $dst"
        say "снято: $dst"
        ;;
      *) die "ссылка ведёт не в станцию ($target) — не трогаю" ;;
    esac
  elif [ -e "$dst" ]; then
    die "$dst — файл, не ссылка станции; снеси вручную, если это точно он"
  else
    say "нечего снимать: $dst нет"
  fi
}

cmd_remove() {
  remove_one "$LINK"
  remove_one "$TUI_LINK"
  for name in $AGENTS; do
    remove_one "$AGENT_DIR/$name.md"
  done
  skill_layers | while IFS= read -r layer; do
    remove_one "$layer/$SKILL_NAME"
  done
}

usage() {
  say "vibe-station: режим директора /vibe для opencode2"
  say ""
  say "  vibe-station install   поставить server + TUI ссылки в $PLUGINS_DIR"
  say "  vibe-station status    что стоит сейчас"
  say "  vibe-station remove    снять ссылку"
  say ""
  say "конфиг: $CONFIG_DIR (OpenCode2; VIBE_CONFIG_DIR только для тестов)"
}

case "${1:-status}" in
  install) cmd_install ;;
  status) cmd_status ;;
  remove) cmd_remove ;;
  help) usage ;;
  -h | --help) usage ;;
  *) die "неизвестная команда «$1»: install | status | remove" ;;
esac
