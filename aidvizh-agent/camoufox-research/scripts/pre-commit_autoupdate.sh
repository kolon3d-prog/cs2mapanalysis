#!/usr/bin/env bash
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub
  # noqa: E501

# pre-commit autoupdate — раз в месяц (пины линтеров). Переносимо:
# repo из config.env/env/авто, python из config.env/env. Ошибки не
# роняют крон (autoupdate — украшательство, не добыча).
# Вызывается крон-установщиком install_cron.sh.

set -uo pipefail

REPO="${CAMOUFOX_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# Кэш — из контракта окружения, не хардкод $HOME/.cache/...: свой
# CAMOUFOX_CACHE_DIR иначе не находил config.env и писал лог мимо кэша.
CACHE="${CAMOUFOX_CACHE_DIR:-$HOME/.cache/camoufox-research}"
if [ -f "$CACHE/config.env" ]; then
  . "$CACHE/config.env" 2>/dev/null || true
fi
PY="${CAMOUFOX_PYTHON:-python3}"

cd "$REPO" || exit 0
"$PY" -m pre_commit autoupdate >> "$CACHE/precommit.log" 2>&1 || true
