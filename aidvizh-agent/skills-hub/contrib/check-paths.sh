#!/usr/bin/env bash
# Ищет пользовательские абсолютные пути в текстовых файлах дерева.
#
# Зачем: путь вида /home/<user>/..., /run/media/<диск>/..., C:\Users\<user>\... на другой машине
# мёртв, а на этой — ломается при переезде диска (у хаба так уже было: DATA/11 → DATA/AGGG).
# Параметризованный путь (/home/$USER/..., /run/media/${USER}/...) ловится так же: он так же
# привязан к чужому дому. Такие места считаем от $BASH_SOURCE/$PSScriptRoot/$HOME или держим в конфиге.
#
# Использование: contrib/check-paths.sh [каталог ...]   (без аргументов — корень хаба)
# Строку, где путь законен (например, systemd сам требует абсолютный путь), помечаем
# маркером: path-guard: ok — и она не считается нарушением.
# Каталоги `collection/` и `vendor/` пропускаем: там лежат чужие копии (скиллы, библиотеки),
# их содержимое мы не правим — свои файлы держим чистыми, чужие не трогаем.
set -uo pipefail

# Что после префикса считается пользовательским путём: буква или цифра (admin1, Bob) либо параметр
# ($HOME, $USER, ${USER}, %USERNAME%) — на чужой машине мёртво и то, и другое. Плейсхолдер в угловых
# скобках (/home/<user>) — это пример, а не путь: после префикса там не буква и не параметр, и он
# намеренно не ловится.
user_part='[A-Za-z0-9$%{]'
PATTERN="(/home/$user_part|/Users/$user_part|/run/media/$user_part|/mnt/$user_part|C:\\\\Users\\\\$user_part)"

roots=("$@")
if (( ${#roots[@]} == 0 )); then
  roots=("$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")
fi

hits="$(
  grep -rInE "$PATTERN" "${roots[@]}" \
    --exclude-dir=.git \
    --exclude-dir=__pycache__ \
    --exclude-dir=node_modules \
    --exclude-dir=collection \
    --exclude-dir=vendor \
    --exclude-dir=sessions \
    --exclude='*.min.js' \
    --exclude='*.pyc' \
    --exclude='check-paths.sh' \
    --exclude='check-paths.ps1' 2>/dev/null |
    grep -v 'path-guard: ok' || true
)"

if [[ -z "$hits" ]]; then
  printf 'check-paths: чисто (%s)\n' "${roots[*]}"
  exit 0
fi

printf '%s\n' "$hits"
printf '\ncheck-paths: %d строк с пользовательскими абсолютными путями — считай путь от скрипта/$HOME или помечай строку маркером "path-guard: ok"\n' "$(printf '%s\n' "$hits" | wc -l)" >&2
exit 1
