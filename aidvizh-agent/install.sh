#!/usr/bin/env bash
# Установка агента: одна команда. Сама добирает инструменты, ставит всё через центр,
# затем тяжёлые станции, которых нет в шагах центра (stealth-browser, camoufox), и живой проверкой
# доводит до «дом жив». Режимы: первая установка (fresh), --update (без сноса), --reset (снять наше).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CENTER="$HERE/command-center/bin/center.sh"
T0=$SECONDS

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

pkg() {
  # sudo без пароля не прошёл — пробуем интерактивный sudo (терминал есть), и только потом напрямую:
  # иначе на обычной Fedora «одна команда» превращается в «поставь node руками».
  if have dnf; then sudo -n dnf install -y "$@" 2>/dev/null || sudo dnf install -y "$@" 2>/dev/null || dnf install -y "$@"
  elif have apt-get; then sudo -n apt-get install -y "$@" 2>/dev/null || sudo apt-get install -y "$@" 2>/dev/null || apt-get install -y "$@"
  elif have brew; then
    # у brew формула node, а не nodejs; остальные имена совпадают
    local names=() p
    for p in "$@"; do case "$p" in nodejs) names+=(node) ;; *) names+=("$p") ;; esac; done
    brew install "${names[@]}"
  else return 1
  fi
}

MODE=install
for arg in "$@"; do
  case "$arg" in
    --update) if [ "$MODE" = reset ]; then printf 'выбери один режим: --update или --reset\n' >&2; exit 2; fi; MODE=update ;;
    --reset) if [ "$MODE" = update ]; then printf 'выбери один режим: --update или --reset\n' >&2; exit 2; fi; MODE=reset ;;
    -h|--help)
      printf 'установка агента: %s [режим]\n' "$0"
      printf '  без флага   первая установка; если агентская среда уже есть — ставит рядом, ничего не снося\n'
      printf '              если набор уже стоит — объяснит --update / --reset и выйдет\n'
      printf '  --update    обновить установленное, ничего не снося\n'
      printf '  --reset     снять наше и поставить заново; чужое (личные скиллы, серверы, конфиги) не трогается\n'
      exit 0 ;;
    *)
      printf 'неизвестный флаг: %s (см. --help)\n' "$arg" >&2
      exit 2 ;;
  esac
done

say '== предпосылки'
if ! have node; then
  say 'node не найден — ставлю (движок станций)'
  pkg nodejs || { say 'не смог поставить node — поставь 20+ вручную и запусти снова'; exit 1; }
fi
say "node $(node --version)"

if ! have bun; then
  say 'bun не найден — ставлю (альтернатива npm, способ поставить omp)'
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
  export PATH="$HOME/.bun/bin:$PATH"
fi
if have bun; then say "bun $(bun --version)"; fi

if ! have uv; then
  say 'uv не найден — ставлю (окружения stealth и camoufox)'
  curl -fsSL https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
  export PATH="$HOME/.local/bin:$PATH"
fi
if have uv; then say "uv $(uv --version)"; fi

missing=()
for t in git gh jq; do have "$t" || missing+=("$t"); done
if [ "${#missing[@]}" -gt 0 ]; then
  say "нет: ${missing[*]} — ставлю"
  pkg "${missing[@]}" || say "не смог поставить: ${missing[*]} — поставь вручную"
fi

"$CENTER" prereqs || {
  say ''
  say 'осталось поставить перечисленное выше и запустить снова.'
  exit 1
}

case "$MODE" in
  update)
    say ''
    say '== обновление (без сноса)'
    "$CENTER" update all || true
    ;;
  reset)
    say ''
    say '== reset: снос нашего и установка заново (чужое не трогается)'
    "$CENTER" fresh --yes || true
    ;;
  install)
    if [ -e "$HOME/.omp/agent" ] || [ -e "$HOME/.pi/agent" ] || [ -e "$HOME/.config/opencode" ] || [ -e "$HOME/.agents/skills" ]; then
      # след набора — команда center из прошлой установки: это обновление/переустановка, а не заселение
      if [ -e "$HOME/.local/bin/center" ] || [ -e "$HOME/.local/bin/center.cmd" ]; then
        say ''
        say 'набор уже стоит на этой машине — снос не делаю.'
        say "  обновить, ничего не снося:       $0 --update"
        say "  поставить начисто (снять наше):  $0 --reset"
        exit 1
      fi
      say ''
      say 'агентская среда уже есть — ставлю набор рядом, ничего не снося (шаг сноса пропускаю).'
      say '  чужое остаётся чужим: свои MCP-серверы и скиллы станции не трогают; прошивка персоны кладёт .bak'
      "$CENTER" fresh --yes --no-cleanup || true
    else
      say ''
      say '== установка'
      "$CENTER" fresh --yes || true
    fi
    ;;
esac

say ''
say '== тяжёлые станции, которых нет в шагах центра: stealth-browser и camoufox (браузер ~663 МБ)'
"$HERE/mcp-station/bin/stealth-setup.sh" || say 'stealth-browser не встал — не блокирую: набор работает и без него, итог проверки ниже'
"$HERE/camoufox-research/scripts/install.sh" || say 'camoufox не встал — не блокирую: набор работает и без него, итог проверки ниже'

say ''
say '== живая проверка'
check() {
  local out
  out="$("$CENTER" verify 2>&1 || true)"
  printf '%s\n' "$out"
  printf '%s' "$out" | grep -q 'провалов 0'
}
if ! check; then
  say ''
  say 'первый прогон нашёл провалы — повтор через 20 с (занятая машина даёт ложную красноту)'
  sleep 20
  if ! check; then
    say ''
    say 'дом поставлен, но проверка дважды нашла провалы — список выше.'
    exit 1
  fi
fi
say ''
say "дом жив · $((SECONDS-T0)) c · дальше: логины провайдеров и ключи сервисов (см. README.md)"
