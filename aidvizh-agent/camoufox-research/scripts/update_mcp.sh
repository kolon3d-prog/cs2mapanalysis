#!/usr/bin/env bash
# Авто-ритуал обновления кауфми в opencode ИЗ ГИТА (одна команда):
#   git pull → pip install (git+github) → reconnect MCP → проверка ping
# Запуск:  bash scripts/update_mcp.sh            # выполнить
#         bash scripts/update_mcp.sh --dry-run   # ПЛАН без изменений
# Идемпотентно: нет изменений — ничего не переустанавливает, только
# переподключает (MCP после апгрейда всегда требует reconnect).
# --dry-run: показать план (что будет сделано, какие шаги), НЕ выполнять
# git pull/pip install (проверка отличается от подмены — план честный).

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ] || [ "${1:-}" = "--check" ]; then
  DRY_RUN=1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${CAMOUFOX_VENV:-$HOME/.venvs/camoufox-research}"
GIT_URL="https://github.com/aidvizhhub/camoufox-research.git"
PY="$VENV/bin/python"
PIP="$VENV/bin/pip"
# Раскладка venv различается: POSIX — bin/python, Windows/Git-Bash —
# Scripts/python.exe (тот же раскол, что в _compat.venv_python). С
# хардкодом bin/python на Git-Bash скрипт падал «No such file or directory».
if [ -x "$VENV/Scripts/python.exe" ]; then
  PY="$VENV/Scripts/python.exe"
  PIP="$VENV/Scripts/pip.exe"
fi

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] $*"
    return 0
  fi
  "$@"
}

# Ждём событие, а не время (No Blind Waiting): событие — статус в `opencode2 mcp list`.
# Возврат: 0 — событие случилось, 1 — не дождались за срок (решает вызывающий, что печатать).
wait_mcp() { # wait_mcp connected|gone [секунды]
  local want="$1" deadline=$((SECONDS + ${2:-30})) line
  while (( SECONDS < deadline )); do
    line="$(opencode2 mcp list 2>/dev/null | grep -F 'camoufox' | head -1 || true)"
    if [ "$want" = "connected" ]; then
      [[ "$line" =~ (^|[^a-z])connected ]] && return 0
    else
      [[ -z "$line" || ! "$line" =~ (^|[^a-z])connected ]] && return 0
    fi
    sleep 0.5 # темп опроса, решает условие
  done
  return 1
}

echo "=== 1/5: git pull ($REPO) ==="
cd "$REPO"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  [dry-run] git pull --ff-only origin main"
  echo "  (актуально? $(git fetch -q origin main 2>/dev/null && git rev-list --count HEAD..origin/main 2>/dev/null || echo '?') коммита впереди)"
else
  git pull --ff-only origin main
fi

echo "=== 2/5: pip install из git (без editable: схема «с гита» 28.08) ==="
run "$PIP" install --upgrade "git+$GIT_URL@main"

echo "=== 3/5: проверка установки ==="
run "$PY" -c "import camoufox_research.camoufox_research as s; print('тулов:', len(s.mcp._tool_manager._tools))"
run "$PIP" show camoufox-research 2>/dev/null | grep -E "^Version" || true

echo "=== 4/5: reconnect MCP (перезапуск сервера) ==="
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  [dry-run] opencode2 api post /api/mcp/camoufox/disconnect + connect"
else
  if command -v opencode2 >/dev/null 2>&1; then
    opencode2 api post /api/mcp/camoufox/disconnect >/dev/null 2>&1 || true
    wait_mcp gone 15 || echo "⚠ camoufox всё ещё connected после disconnect — переподключаю как есть"
    opencode2 api post /api/mcp/camoufox/connect >/dev/null 2>&1 || true
    if wait_mcp connected 60; then
      echo "  camoufox: connected (по событию, не по таймеру)"
    else
      echo "⚠ camoufox не поднялся за 60 с — проверь: opencode2 mcp list"
    fi
    opencode2 mcp list | head -3
  else
    echo "⚠ opencode2 не найден — переподключи MCP вручную (Settings → MCP)."
  fi
fi

echo "=== 5/5: проверка сервера (pong) ==="
# pgrep -a (показать командную строку) — расширение procps: в BSD/macOS `-a`
# означает «включить процессы-родители» и печатает ТОЛЬКО pid (cmdline терялся),
# в BusyBox такой опции нет вовсе. ps -Ao pid=,command= одинаков в GNU и BSD.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  [dry-run] ps -Ao pid=,command= | grep -F 'bin/camoufox-research'"
else
  ps -Ao pid=,command= 2>/dev/null | grep -F "bin/camoufox-research" | grep -v grep | head -2 \
    || echo "сервер не запущен — вызови любой тул, поднимется автоматически"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "🔍 DRY-RUN: план показан, НИЧЕГО не изменено."
  echo "   Выполнить по-настоящему: bash $0 (без флага)"
else
  echo "✅ $REPO обновлён из git (тулы выше), MCP переподключён."
  echo "   Новые тулы доступны в текущей сессии после вызова."
fi
