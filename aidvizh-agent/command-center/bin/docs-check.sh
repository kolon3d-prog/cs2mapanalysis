#!/usr/bin/env bash
# docs-check: гейт доков — ЧИСЛА, СПИСКИ и КОМАНДЫ в README/docs против факта.
#
# Тонкая обёртка: движок один на все ОС — bin/docs-check.mjs (его же зовёт bin/docs-check.ps1),
# поэтому вердикт на bash и на PowerShell один и тот же, а формат строк не разъезжается.
#
# Факт берётся из кода, реестра и файлов на диске (не из самих доков): проекты и список проектов —
# из command-center/registry.json, скиллы — из skills-station/collection, тесты — из '^@test' по
# наборам bats, шаги плана — из center.mjs, версия — из VERSION, упомянутые команды — из usage
# станций, индекс доков — из docs/README.md. Отдельно проверяется платформенная полнота:
# у каждого .sh должен быть сосед .ps1, иначе путь лежит в command-center/platform-exceptions.txt.
#
# Использование: bin/docs-check.sh [--json] [--quiet]
#   --json   машинный вывод (ok, факты, расхождения)
#   --quiet  только расхождения (без строки фактов)
#   DOCS_CHECK_ROOT — проверить другое дерево (наборы тестов подкладывают мини-диск)
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" == /* ]]; then SELF="$TARGET"; else SELF="$(dirname "$SELF")/$TARGET"; fi
done
CENTER="$(cd "$(dirname "$SELF")/.." && pwd)"

command -v node >/dev/null 2>&1 || {
  printf 'docs-check: нужен node (им считается факт — как и всем движкам станций)\n' >&2
  exit 2
}

exec node "$CENTER/bin/docs-check.mjs" "$@"
