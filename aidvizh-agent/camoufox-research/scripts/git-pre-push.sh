#!/usr/bin/env bash
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

# Строгий режим — ПЕРВОЙ исполняемой строкой (единый гейт набора считает
# строгость по первым 25 строкам; выше — только комментарии).
set -euo pipefail

# PRE-PUSH СТРАЖ (28.08): перед git push проверяет, ЧТО публикуется.
# Разрешено (только это): research/public/** и metrics/** (метрики).
# Если пуш несёт что-то другое — стоп с вопросом (не безмолвный отказ):
#   git push  → ask (спросить: push -f/--force чтобы продолжить)
#               или отредактировать и запушшить только нужное.
#
# Установка: cp scripts/git-pre-push .git/hooks/pre-push && chmod +x
# Переносимость: relative от .git (сам находит репо).
# Режим --classify <файл> (28.08): ALLOW/BLOCK без git — для self-теста.
#
# Почему -e/-u/pipefail тут ничего не ломают (проверено bats-набором
# tests/bats/git_pre_push.bats: новый бранч с приватным — СТОП, витрина —
# пропуск, границы --classify):
#   · `[ -z "$f" ] && continue` — тест слева от && под -e освобождён (важен rc
#     списка, а не левого условия);
#   · вердикт берём ПО СЛОВУ (`[ "$(classify_file "$f" || true)" = BLOCK ]`), а не
#     по rc пайплайна: classify_file возвращает 3 на BLOCK (контракт режима
#     --classify), и с pipefail прежний `classify_file | grep -q` дал бы rc 3 →
#     условие ложно → страж молча пропустил бы приватное (поймано bats 22.09);
#   · `classify_file` в режиме --classify возвращает 3 НАМЕРЕННО: с -e шелл
#     выходит с тем же rc 3 и уже напечатанным вердиктом (то же наблюдаемое);
#   · `read` в while — условие цикла, EOF не ошибка.

REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")"
# cd в корень ОБЯЗАТЕЛЕН (аудит переносимости 21.09): REPO вычислялся, но НЕ
# использовался — без перехода все git-команды ниже выполнялись в ТЕКУЩЕМ
# каталоге. Хук, запущенный вручную из другого места, работал не с тем
# репо (или падал на «git diff не отработал» вне репозитория), хотя корень
# уже был найден. Git-хуки стартуют из корня, но скрипт — публичная точка
# входа (его зовут и руками, и по абсолютному пути).
cd "$REPO" || exit 1
ALLOWED_PREFIXES=("research/public/" "metrics/")

classify_file() {
  local f="$1"
  case "$f" in
    metrics/budget-alert.txt) echo BLOCK; return 3 ;;  # runtime-алерт — не в git
  esac
  for pfx in "${ALLOWED_PREFIXES[@]}"; do
    case "$f" in
      "$pfx"*) echo ALLOW; return 0 ;;
    esac
  done
  case "$f" in
    # код/тесты/конфиги проекта; *.md НЕ разрешаем вслепую —
    # приватный research/*.md не должен пройти (28.08: дыра поймана аудитом)
    # pyproject.toml/uv.lock отдельными альтернативами НЕ нужны: их уже
    # покрывают *.toml/*.lock стоящие раньше — до них case не доходит
    # (SC2221/SC2222: мёртвые ветки, вердикт тот же — ALLOW).
    # Контейнер (21.09): Dockerfile/.dockerignore/docker/* — это код доставки,
    # без них публичная установка через Docker не собирается, а приватного
    # там нет. Ловилось как BLOCK и стопорило пуш всей обновы.
    scripts/*|camoufox_research/*|tests/*|.github/*|configs/*|docs/*.md|README*.md|*.yaml|*.yml|*.toml|*.lock|*.ini|.gitignore|Dockerfile|*.dockerignore|docker/*)
      echo ALLOW; return 0 ;;
  esac
  echo BLOCK; return 3
}

if [ "${1:-}" = "--classify" ]; then
  [ -n "${2:-}" ] || { echo "используй: $(basename "$0") --classify <путь>" >&2; exit 2; }
  classify_file "$2"
  exit $?
fi

# Стандартный git-инпут: local_ref local_sha remote_ref remote_sha
while read -r _lref _lsha _rref _rsha; do
  # смотрим diff между старым remote и новым local (что уходит публично)
  # Новый бранч: сравнивать не с чем — берём ПУСТОЕ дерево (весь history).
  # Было `$REPO_HASH_EMPTY` — переменной нет, `set -u` нет → пустая строка,
  # `git diff ""...HEAD` молча давал пустой список, и пуш нового бранча
  # проходил БЕЗ ЕДИНОЙ проверки (аудит 21.09).
  if [ "$_rsha" = "0000000000000000000000000000000000000000" ]; then
    diff_args=("$(git hash-object -t tree /dev/null)" HEAD)
  else
    diff_args=("$_rsha...HEAD")
  fi
  if ! files=$(git diff --name-only "${diff_args[@]}" 2>&1); then
    echo "⛔ pre-push: git diff не отработал — не могу проверить, что уходит:" >&2
    echo "   $files" >&2
    exit 1
  fi
  files=$(printf '%s\n' "$files" | grep -v "^\.git" || true)
  bad=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Вердикт берём ПО СЛОВУ, а не через rc пайплайна: classify_file возвращает 3
    # на BLOCK (контракт режима --classify, его проверяет bats), а с pipefail это
    # стало бы rc всего `classify_file | grep -q` — условие оказалось бы ложным
    # и страж молча пропустил бы приватное (поймано прогоном bats 22.09).
    if [ "$(classify_file "$f" || true)" = "BLOCK" ]; then
      bad="$bad $f"
    fi
  done <<< "$files"
  if [ -n "$bad" ]; then
    echo "⛔ PRE-PUSH СТРАЖ: пушишь НЕ витрину/метрики:" >&2
    echo "   $bad" >&2
    echo "   Разрешено: research/public/**, metrics/** (публикуемое)." >&2
    echo "   Другое — только код/тесты (camoufox_research/scripts/tests)." >&2
    echo "   Продолжить (может быть намеренно)? git push -f (force)." >&2
    exit 1  # стоп по умолчанию — юзер решает
  fi
done
exit 0
