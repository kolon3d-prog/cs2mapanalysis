#!/usr/bin/env bash
# Установка stealth-browser-mcp (nodriver) — единственный сервер каталога, которому нужна
# локальная сборка: он ставится из git в ~/.agents/mcp, а не запускается через npx.
# Идемпотентно: повторный запуск только обновляет зависимости.
set -euo pipefail

DEST="${STEALTH_DIR:-$HOME/.agents/mcp/stealth-browser-mcp}"
REPO="https://github.com/vibheksoni/stealth-browser-mcp.git"

command -v git >/dev/null 2>&1 || { printf 'stealth-setup: нужен git\n' >&2; exit 1; }
command -v uv  >/dev/null 2>&1 || {
  printf 'stealth-setup: нужен uv (curl -fsSL https://astral.sh/uv/install.sh | sh).\n' >&2
  printf 'python3 3.14 не собирает зависимости nodriver — uv сам скачает 3.13.\n' >&2
  exit 1
}

mkdir -p "$(dirname "$DEST")"
if [[ ! -d "$DEST/.git" ]]; then
  printf '== клонирую %s\n' "$REPO"
  git clone --depth 1 "$REPO" "$DEST"
else
  printf '== репозиторий уже есть, обновляю\n'
  git -C "$DEST" pull --ff-only --depth 1 >/dev/null
fi

printf '== ставлю зависимости (python 3.13)\n'
[[ -x "$DEST/venv/bin/python" ]] || uv venv --python 3.13 "$DEST/venv" >/dev/null
uv pip install -q -r "$DEST/requirements.txt" --python "$DEST/venv/bin/python"

printf '== проверка\n'
"$DEST/venv/bin/python" - <<'PY'
import nodriver, fastmcp  # noqa: F401
print('nodriver и fastmcp на месте')
PY
printf 'готово: %s\n' "$DEST/venv/bin/python $DEST/src/server.py"
