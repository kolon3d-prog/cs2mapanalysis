#!/usr/bin/env bash
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

# Прогон bats-тестов стражей (tests/bats) — из любого места одной командой.
# ПОЧЕМУ отдельный скрипт: тесты зовут НАСТОЯЩИЕ scripts/*.sh (фейковые в
# PATH только внешние утилиты), и запускать их нужно из корня репо; заодно
# отсутствие bats кричит и кодом 127, а не «тихо зелено».

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bats >/dev/null 2>&1; then
  echo "bats не установлен — тесты стражей НЕ прогонялись." >&2
  echo "  dnf install bats   |   apt install bats   |   npm i -g bats" >&2
  exit 127
fi

cd "$REPO"
exec bats --print-output-on-failure tests/bats
