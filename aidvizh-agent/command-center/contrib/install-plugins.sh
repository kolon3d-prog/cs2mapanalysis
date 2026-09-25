#!/usr/bin/env bash
# Плагины центра: ссылки слэш-команды /center в каталоги трёх клиентов (opencode2, omp, pi).
#
# Тонкая обёртка: движок один на все ОС — contrib/install-plugins.mjs (его же зовёт .ps1),
# поэтому на Windows и на Unix ставится одно и то же, а формат строк не разъезжается.
#
#   contrib/install-plugins.sh [install|uninstall|status] [--dry-run]
#
# Пути считаются от самого скрипта и от $HOME — абсолютных путей диска здесь нет.
# Идемпотентно: если ссылка уже ведёт сюда, ничего не делает.
# Живой файл клиента на месте ссылки не затирается: он уезжает в <файл>.bak.
# Тип связи: симлинк → junction для каталогов → копия (о копии движок говорит прямо: она не следит
# за правками). Чем связывать, можно задать хуком CENTER_LINK_MODE (нужен тестам).
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
CENTER="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'install-plugins: нужен node (им работает движок установки)\n' >&2
  exit 2
}

exec node "$CENTER/contrib/install-plugins.mjs" "$@"
