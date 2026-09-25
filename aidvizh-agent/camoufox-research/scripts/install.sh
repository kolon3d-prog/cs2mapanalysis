#!/usr/bin/env bash
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

# Строгий режим — ПЕРВОЙ исполняемой строкой: выше только комментарии, так что
# ни одна команда не успевает выполниться «тихо». (Единый гейт набора считает
# строгость по первым 25 строкам — держим эту строку здесь, чтобы файл не попадал
# в список исключений команд-центра: исключение — это «строгого режима нет», а он есть.)
set -euo pipefail

# Кроссплатформенный установщик кауфми-MCP: Linux / macOS / Windows (MSYS).
#
# ДВА ВХОДА, один и тот же результат: системные библиотеки браузера → venv в
# РАНТАЙМЕ (~/.venvs/camoufox-research) → uv sync --frozen (или pip install .)
# → python -m camoufox fetch → регистрация MCP в клиенте + config.env →
# рукопожатие MCP (tools/list).
#
#   1) ИЗ КЛОНА — ОСНОВНОЙ путь: репо уже на диске, ставим то, что лежит
#      рядом со скриптом (--repo ПУТЬ / env CAMOUFOX_REPO — если клон в
#      другом месте):
#        bash <каталог-репо>/scripts/install.sh [флаги]
#      Сеть не нужна вовсе, шага «клонировать» нет: ни GitHub, ни ветка
#      `main` не при чём — ставится ваша копия (в т.ч. своя ветка с правками).
#
#   2) ОДНОЙ СТРОКОЙ — ФОЛБЭК для ДРУГОЙ машины, где клона ещё нет:
#        curl -fsSL <raw>/scripts/install.sh | bash -s -- [флаги]
#      Отличие ровно одно: шаг 0 — git clone из GitHub в --dir
#      (по умолчанию ~/camoufox-research); дальше шаги те же.
#
# ЧЕГО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ (и почему):
#   * не переписывает логику scripts/install_mcp.py: config.env и секцию MCP
#     в opencode.json пишет ТОЛЬКО он (закон 28: пути в одном месте, не
#     хардкод). Поэтому вызываются ЕГО ФУНКЦИИ как модуля, а не скрипт целиком:
#     у install_mcp.py свой `pip install git+…@main`, который затёр бы
#     установку из локального клона (у владельца ветка local-fixes), и был бы
#     нарушен порядок «pip → обёртка caps» (урок dsh 31.08).
#   * не ставит cron/systemd-таймеры без --with-cron: расписания владельца
#     трогаем только по явной просьбе.
#   * не держит окружение в клоне: venv и кэши живут в $HOME (код — в клоне,
#     состояние — в рантайме; так один venv обслуживает и клон, и git-версию).
#     Каталог клона по умолчанию — $HOME/camoufox-research, venv —
#     $HOME/.venvs/camoufox-research (канон scripts/install_mcp.py).
#
# Платформы (честно):
#   linux   — полный путь: apt/dnf/yum/pacman/zypper/apk (+ sudo или root).
#   macos   — полный путь; системные библиотеки не нужны (браузер
#             самодостаточен), systemd-таймеров НЕТ — только cron.
#   windows — MSYS/Git-Bash: venv/pip/fetch работают, но обвязка репо
#             Unix-only (install_mcp.py с путями venv/bin, bash-обёртка caps,
#             cron, systemd-таймеры, стражи) → MCP прописывается вручную,
#             для полного пути рекомендован WSL2.
#
# Идемпотентность: повторный запуск не ломает — клон есть (не переклонирую),
# venv есть (не пересоздаю), пакет импортируется (установку пропускаю), браузер
# скачан (fetch сам пропустит), секция MCP не дублируется (чипсет проверяет
# перед записью). В пайпе (нет tty) вопросов нет — работаем как с --yes.
#
# Запуск:  bash scripts/install.sh --help    (справка)
#          bash scripts/install.sh --dry-run (план для этой машины, без правок)
#          bash scripts/install.sh --version (версия + целевые пути)
#          bash scripts/install.sh           (установка)
#          bash scripts/install.sh --uninstall (снять venv + запись MCP)

TOOL="camoufox-research"
REPO_URL="${CAMOUFOX_REPO_URL:-https://github.com/aidvizhhub/camoufox-research.git}"
UV_PY_SPEC="${CAMOUFOX_PYTHON_SPEC:-3.13}"   # что просить у uv, если системного ≥3.10 нет

# Рантайм-каталоги (канон проекта): код — в клоне, окружение/кэш — в $HOME.
# venv ВНУТРИ клона = клон нельзя ни снести, ни перенести, а вторая копия
# репо тянет второе окружение (гонки за cache.db, урок dsh 31.08). Поэтому
# дефолт venv — тот же, что в scripts/install_mcp.py и README.
DEFAULT_REPO_DIR="$HOME/$TOOL"                     # куда клонировать при 1-клике
DEFAULT_VENV_DIR="$HOME/.venvs/$TOOL"              # рантайм-окружение
OPENCODE_CFG="$HOME/.config/opencode/opencode.json"
CACHE_DIR="${CAMOUFOX_CACHE_DIR:-$HOME/.cache/camoufox-research}"

DRY_RUN=0
SKIP_DEPS=0
SKIP_BROWSER=0
WITH_CRON=0
BOOTSTRAP_UV=0
REINSTALL=0
UNINSTALL=0
SHOW_VERSION=0
ASSUME_YES=0
BOOTSTRAP=0                                        # запуск без клона (пайп)
OS_FORCE=""
REPO_ARG=""
VENV_ARG=""
DIR_ARG=""

# Кэши инструментов и БАЙТКОДА — в рантайм, а не в клон (как в scripts/gates.sh):
# установка импортирует пакет и зовёт сборку, и без этого в клоне на диске
# данных остаются `__pycache__`/сборка (урок 21.09: прод-диск — не свалка).
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-${CAMOUFOX_GATES_CACHE:-$HOME/.cache/camoufox-research/gates}/pycache}"

# --- цвет и лог ------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_INFO=$'\033[0;34m'
  C_OK=$'\033[0;32m'
  C_WARN=$'\033[1;33m'
  C_ERR=$'\033[0;31m'
  C_OFF=$'\033[0m'
else
  C_INFO=""
  C_OK=""
  C_WARN=""
  C_ERR=""
  C_OFF=""
fi

info() { printf '%s[INFO]%s  %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok()   { printf '%s[ OK ]%s  %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s[WARN]%s  %s\n' "$C_WARN" "$C_OFF" "$*"; }
err()  { printf '%s[ERR ]%s  %s\n' "$C_ERR" "$C_OFF" "$*" >&2; }
die()  { err "$@"; exit 1; }
run()  { printf '  $ %s\n' "$*"; "$@"; }

# --- шаги с временем -------------------------------------------------------
# Логируем КАЖДЫЙ шаг: время старта (стенные часы) + длительность в секундах.
# Без этого «установка висит?» и «что так долго?» — гадание (663 МБ браузера
# и сборка колёс идут минутами, и видеть это надо).
STEPS=7
STEP_NO=0
STEP_T0=0

step_start() {   # $1=что делаем на этом шаге
  STEP_NO=$((STEP_NO + 1))
  STEP_T0=$SECONDS
  info "шаг $STEP_NO/$STEPS ($(date '+%H:%M:%S')): $*"
}

step_end() {     # $1=итог шага
  printf '  %s[ OK ]%s шаг %d/%d: %s — %d с\n' \
    "$C_OK" "$C_OFF" "$STEP_NO" "$STEPS" "$*" "$((SECONDS - STEP_T0))"
}

ask() {          # $1=вопрос, $2=дефолт (y|n). 0=да.
  # Внутри `curl … | bash` stdin ЗАНЯТ САМИМ СКРИПТОМ: любой read() съел бы
  # следующие его строки (классический самоубийственный баг установщиков).
  # Поэтому при отсутствии tty отвечаем дефолтом молча — то же, что --yes.
  local q="$1" d="${2:-y}" hint ans
  if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
    [ "$d" = y ]
    return
  fi
  if [ "$d" = y ]; then hint="Y/n"; else hint="y/N"; fi
  printf '%s [%s] ' "$q" "$hint"
  read -r ans || ans=""
  ans="${ans:-$d}"
  case "$ans" in
    [yYдД]*) return 0 ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<'USAGE'
Кроссплатформенный установщик camoufox-research (Linux / macOS / Windows-MSYS).

Откуда ставим (таблица — docs/install-crossplatform.md):

  ИЗ КЛОНА — основной путь: репо уже на диске, сеть не нужна, шага «клон»
  нет (ставится код из клона, в т.ч. своя ветка):
    bash scripts/install.sh [флаги]          # из корня клона
    bash /путь/к/репо/scripts/install.sh     # откуда угодно: каталог репо
                                             # ищется рядом со скриптом, иначе
                                             # --repo ПУТЬ (env CAMOUFOX_REPO)
    Windows:  pwsh -File <репо>\scripts\install.ps1 [-WhatIf]

  ОДНОЙ СТРОКОЙ — фолбэк для ДРУГОЙ машины, где клона нет (шаг 0 склонирует
  сам в --dir, по умолчанию ~/camoufox-research):
    curl -fsSL https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.sh | bash
    Windows: irm https://raw.githubusercontent.com/aidvizhhub/camoufox-research/main/scripts/install.ps1 | iex

Флаги:
  --dir ПУТЬ       куда клонировать репо при запуске без клона
                   (по умолчанию ~/camoufox-research, либо env CAMOUFOX_REPO_DIR)
  --repo ПУТЬ      каталог УЖЕ существующего клона (по умолчанию — где лежит
                   этот скрипт, либо env CAMOUFOX_REPO)
  --venv ПУТЬ      каталог venv (по умолчанию ~/.venvs/camoufox-research —
                   рантайм, НЕ клон; env CAMOUFOX_VENV)
  --yes, -y        не задавать вопросов (в пайпе — автоматически)
  --skip-deps      не ставить системные пакеты (уже стоят / нет прав)
  --skip-browser   не качать браузер (663 МБ) и не проверять его — для CI/тестов
  --reinstall      переустановить пакет принудительно
  --bootstrap-uv   поставить uv (astral.sh), если нет ни python ≥ 3.10, ни uv
  --with-cron      поставить cron-строки (Linux/macOS; вызывает install_cron.sh)
  --uninstall      снять venv + запись MCP в opencode.json (кэш, браузер и
                   config.env НЕ трогаются)
  --version        печатать версию репо и целевые пути, затем выйти
  --dry-run        показать план для ЭТОЙ машины и выйти (ничего не меняет)
  --os ИМЯ         форсировать ОС для плана/тестов: linux | macos | windows
  -h, --help       эта справка

Что ставится (идемпотентно, 7 шагов с логом и временем):
  0) клон в --dir — ТОЛЬКО если запущено без клона (curl|bash)
  1) системные библиотеки Firefox-стека (Linux — через пакетный менеджер)
  2) python ≥ 3.10 (uv, если есть, иначе python3 -m venv)
  3) venv в рантайме (~/.venvs/camoufox-research, uv: --seed — внутри pip)
  4) пакет: uv sync --frozen по uv.lock (или pip install . из клона)
  5) python -m camoufox fetch — браузер (уже скачанный не трогает)
  6) MCP в opencode.json + ~/.cache/camoufox-research/config.env — функции
     scripts/install_mcp.py (единый источник путей и секции MCP)
  7) проверка: импорт пакета, консольный скрипт, версия браузера и РУКОПОЖАТИЕ
     MCP (initialize + tools/list через scripts/mcp_drive.py — без npx)

Код возврата: 0 — ок, 1 — ошибка установки, 2 — неверный флаг.

Unix-only часть репо (честно): scripts/install_cron.sh (cron) и
scripts/install_timers.sh (systemd-user — только Linux). На Windows их нет;
на macOS systemd нет, cron есть.
USAGE
}

# --- разбор аргументов -----------------------------------------------------
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --dir)
        [ "$#" -ge 2 ] || { err "--dir без значения"; exit 2; }
        DIR_ARG="$2"; shift ;;
      --repo)
        [ "$#" -ge 2 ] || { err "--repo без значения"; exit 2; }
        REPO_ARG="$2"; shift ;;
      --venv)
        [ "$#" -ge 2 ] || { err "--venv без значения"; exit 2; }
        VENV_ARG="$2"; shift ;;
      --os)
        [ "$#" -ge 2 ] || { err "--os без значения"; exit 2; }
        case "$2" in
          linux|macos|windows) OS_FORCE="$2" ;;
          *) err "--os принимает linux|macos|windows (получено: $2)"; exit 2 ;;
        esac
        shift ;;
      --yes|-y) ASSUME_YES=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --version) SHOW_VERSION=1 ;;
      --skip-deps) SKIP_DEPS=1 ;;
      --skip-browser) SKIP_BROWSER=1 ;;
      --reinstall) REINSTALL=1 ;;
      --bootstrap-uv) BOOTSTRAP_UV=1 ;;
      --with-cron) WITH_CRON=1 ;;
      -h|--help) usage; exit 0 ;;
      *) err "неизвестный флаг '$1' (см. --help)"; exit 2 ;;
    esac
    shift
  done
}

# --- пути ------------------------------------------------------------------
abs_path() {   # $1=путь → абсолютный; разворачивает ~ (каталог может не существовать)
  local p="$1" tilde="~"
  if [ "$p" = "$tilde" ]; then
    p="$HOME"
  elif [ "${p#"$tilde"/}" != "$p" ]; then
    p="$HOME/${p#"$tilde"/}"
  fi
  case "$p" in
    /*) printf '%s\n' "$p" ;;
    *) printf '%s\n' "$PWD/$p" ;;
  esac
}

is_repo() {    # $1=путь — полноценный клон (pyproject + чипсет install_mcp.py)?
  [ -n "$1" ] && [ -f "$1/pyproject.toml" ] && [ -f "$1/scripts/install_mcp.py" ]
}

local_repo_guess() {   # репо РЯДОМ со скриптом — обычный `bash scripts/install.sh`
  # Внутри `curl … | bash` BASH_SOURCE ПУСТ (кода на диске нет) — это и есть
  # признак установки «в один клик»: локального клона нет, нужен --dir.
  local src="${BASH_SOURCE[0]:-}" dir
  [ -n "$src" ] && [ -f "$src" ] || return 1
  dir="$(cd "$(dirname "$src")/.." 2>/dev/null && pwd)" || return 1
  is_repo "$dir" || return 1
  printf '%s\n' "$dir"
}

resolve_repo() {
  if [ "$UNINSTALL" -eq 1 ]; then
    # Снятие кода не требует (venv — в рантайме, MCP — в JSON), но клон, если он
    # известен, показываем в итоге: пользователю важно знать, что код остался.
    if [ -n "$REPO_ARG" ]; then
      REPO="$REPO_ARG"
    elif [ -n "${CAMOUFOX_REPO:-}" ]; then
      REPO="$CAMOUFOX_REPO"
    else
      REPO="$(local_repo_guess || true)"
    fi
    if [ -n "$REPO" ]; then
      REPO="$(abs_path "$REPO")"
    fi
    return 0
  fi

  if [ -n "$REPO_ARG" ]; then
    is_repo "$REPO_ARG" ||
      die "--repo '$REPO_ARG' — не клон $TOOL (нет pyproject.toml/scripts/install_mcp.py)"
    REPO="$REPO_ARG"
  elif [ -n "${CAMOUFOX_REPO:-}" ]; then
    is_repo "$CAMOUFOX_REPO" ||
      die "CAMOUFOX_REPO='$CAMOUFOX_REPO' — не клон $TOOL (нет pyproject.toml/scripts/install_mcp.py)"
    REPO="$CAMOUFOX_REPO"
  else
    local guess
    if guess="$(local_repo_guess)"; then
      REPO="$guess"
    else
      # Клона рядом нет → ставим «в один клик»: клонируем в --dir (шаг 0).
      REPO="${DIR_ARG:-${CAMOUFOX_REPO_DIR:-$DEFAULT_REPO_DIR}}"
      BOOTSTRAP=1
    fi
  fi
  REPO="$(abs_path "$REPO")"
}

bootstrap_clone() {   # клон для установки «в один клик» (curl|bash)
  command -v git >/dev/null 2>&1 ||
    die "нужен git, чтобы склонировать репо в один клик —
       поставь git или запусти из готового клона: git clone $REPO_URL"
  if [ -e "$REPO" ]; then
    if is_repo "$REPO"; then
      ok "клон уже есть — использую его (не переклонирую): $REPO"
      return 0
    fi
    die "$REPO существует и это не клон $TOOL — укажи другой --dir"
  fi
  mkdir -p "$(dirname "$REPO")"
  info "клон $REPO_URL → $REPO (полный: чтобы работал git pull из update_mcp.sh)"
  git clone "$REPO_URL" "$REPO" ||
    die "git clone не удался: $REPO_URL → $REPO (проверь сеть/доступ к GitHub)"
}

resolve_venv() {
  local v
  if [ -n "$VENV_ARG" ]; then
    v="$VENV_ARG"
  elif [ -n "${CAMOUFOX_VENV:-}" ]; then
    v="$CAMOUFOX_VENV"
  else
    v="$DEFAULT_VENV_DIR"       # рантайм, а НЕ клон: код отдельно, окружение отдельно
  fi
  VENV="$(abs_path "$v")"

  if [ "$OS" = windows ]; then
    VENV_BIN="$VENV/Scripts"
    VENV_PY="$VENV_BIN/python.exe"
    ENTRY="$VENV_BIN/camoufox-research.exe"
  else
    VENV_BIN="$VENV/bin"
    VENV_PY="$VENV_BIN/python"
    ENTRY="$VENV_BIN/camoufox-research"
  fi
}

# --- версия и целевые пути (--version) --------------------------------------
repo_version() {   # из pyproject, БЕЗ импорта и venv (работает до установки)
  if [ -n "$REPO" ] && [ -f "$REPO/pyproject.toml" ]; then
    sed -n 's/^version = "\(.*\)"/\1/p' "$REPO/pyproject.toml" | head -n 1
  else
    printf 'неизвестна (клон ещё не создан)\n'
  fi
}

print_version() {
  printf '%s %s\n' "$TOOL" "$(repo_version)"
  printf '  ОС / арх        : %s / %s\n' "$OS" "$ARCH"
  printf '  репозиторий     : %s\n' "${REPO:-—}"
  if [ "$BOOTSTRAP" -eq 1 ]; then
    printf '                    (будет склонирован из %s при установке)\n' "$REPO_URL"
  fi
  printf '  venv (рантайм)  : %s\n' "$VENV"
  printf '  кэш / состояние : %s\n' "$CACHE_DIR"
  printf '  браузер Camoufox: %s\n' "$(browser_cache_dir)"
  printf '  MCP в клиенте   : %s\n' "$OPENCODE_CFG"
  printf '  байткод-кэш     : %s\n' "$PYTHONPYCACHEPREFIX"
}

# --- детект окружения ------------------------------------------------------
detect_os() {
  local u
  u="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  case "$u" in
    linux*) echo linux ;;
    darwin*) echo macos ;;
    mingw*|msys*|cygwin*) echo windows ;;
    *) echo "unknown:$u" ;;
  esac
}

detect_arch() {
  local a
  a="$(uname -m 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  case "$a" in
    x86_64|amd64) echo x86_64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "$a" ;;
  esac
}

detect_pm() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  elif command -v pacman >/dev/null 2>&1; then echo pacman
  elif command -v zypper >/dev/null 2>&1; then echo zypper
  elif command -v apk >/dev/null 2>&1; then echo apk
  elif command -v brew >/dev/null 2>&1; then echo brew
  else echo unknown
  fi
}

find_python() {   # python из ПРОВЕРЕННОГО диапазона (3.10–3.13), иначе любой >= 3.10
  local c p
  local in_range='import sys; raise SystemExit(0 if sys.version_info[:2] in ((3,10),(3,11),(3,12),(3,13)) else 1)'
  for c in python3.13 python3.12 python3.11 python3.10 python3 python; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [ -n "$p" ] || continue
    if "$p" -c "$in_range" >/dev/null 2>&1; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  # Запасной путь: свежий python (3.14+) — pyproject разрешает >=3.10, но
  # колёса запиненных зависимостей могут быть ещё не собраны (честно предупредим).
  for c in python3 python; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [ -n "$p" ] || continue
    if "$p" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' \
        >/dev/null 2>&1; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 0
}

find_uv() {       # uv может лежать вне PATH (установка astral.sh ставит в ~/.local/bin)
  local c p
  for c in uv "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv; do
    p="$(command -v "$c" 2>/dev/null || true)"
    if [ -n "$p" ] && [ -x "$p" ]; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 0
}

detect_env() {
  OS="$(detect_os)"
  [ -n "$OS_FORCE" ] && OS="$OS_FORCE"
  ARCH="$(detect_arch)"
  PM="$(detect_pm)"
  SUDO=()
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
  fi
  PY="$(find_python)"
  UV="$(find_uv)"
  IS_WSL=0
  if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
    IS_WSL=1
  fi
  if [ -n "$PY" ]; then
    PY_VER="$("$PY" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true)"
  else
    PY_VER=""
  fi
  PY_IN_RANGE=0
  if [ -n "$PY" ] && "$PY" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] in ((3,10),(3,11),(3,12),(3,13)) else 1)' \
      >/dev/null 2>&1; then
    PY_IN_RANGE=1
  fi
}

# --- системные зависимости браузера (Firefox-стек) -------------------------
set_dep_list() {   # $1=пакетный менеджер → REQ_DEPS (обязательные), OPT_DEPS
  REQ_DEPS=()
  OPT_DEPS=()
  case "$1" in
    apt)
      REQ_DEPS=(libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 libxcomposite1
                libxdamage1 libxfixes3 libxrandr2 libgbm1 libnss3 libnspr4
                libpango-1.0-0 libcairo2 libatk1.0-0 libatk-bridge2.0-0
                fonts-liberation libasound2)   # libasound2 ОБЯЗАТЕЛЕН: libxul.so
                # линкуется с alsa, без него camoufox не стартует (находка 21.09)
      OPT_DEPS=() ;;
    dnf|yum)
      REQ_DEPS=(gtk3 dbus-glib libXt libXcomposite libXdamage libXfixes libXrandr
                mesa-libgbm nss nspr pango cairo atk at-spi2-atk dejavu-sans-fonts
                alsa-lib)   # alsa обязателен: libxul.so линкуется с ним жёстко
      OPT_DEPS=() ;;
    pacman)
      REQ_DEPS=(gtk3 dbus-glib libxt libxcomposite libxdamage libxfixes libxrandr
                mesa nss nspr pango cairo atk at-spi2-atk ttf-dejavu
                alsa-lib)   # alsa обязателен: libxul.so линкуется с ним жёстко
      OPT_DEPS=() ;;
    zypper)
      REQ_DEPS=(gtk3 dbus-1-glib libXt6 libXcomposite1 libXdamage1 libXfixes3
                libXrandr2 libgbm1 mozilla-nss pango cairo atk at-spi2-atk
                dejavu-fonts alsa-lib)   # alsa обязателен (libxul.so линкуется жёстко)
      OPT_DEPS=() ;;
    apk)
      REQ_DEPS=(gtk+3.0 dbus-glib libxt libxcomposite libxdamage libxfixes libxrandr
                mesa nss nspr pango cairo atk at-spi2-atk ttf-dejavu gcompat
                alsa-lib)   # alsa обязателен (libxul.so линкуется жёстко)
      OPT_DEPS=() ;;
  esac
}

pkg_installed() {  # $1=pm $2=пакет — уже стоит?
  case "$1" in
    apt) dpkg-query -W -f='${Status}' "$2" 2>/dev/null | grep -q "install ok installed" ;;
    dnf|yum|zypper) rpm -q "$2" >/dev/null 2>&1 ;;
    pacman) pacman -Q "$2" >/dev/null 2>&1 ;;
    apk) apk info -e "$2" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

install_pkgs() {   # $1=pm, далее пакеты
  local pm="$1"
  shift
  [ "$#" -eq 0 ] && return 0
  case "$pm" in
    apt)
      run "${SUDO[@]+"${SUDO[@]}"}" apt-get update -qq &&
        run "${SUDO[@]+"${SUDO[@]}"}" apt-get install -y -qq "$@" ;;
    dnf|yum) run "${SUDO[@]+"${SUDO[@]}"}" "$pm" install -y -q "$@" ;;
    zypper) run "${SUDO[@]+"${SUDO[@]}"}" zypper --non-interactive install -y "$@" ;;
    pacman) run "${SUDO[@]+"${SUDO[@]}"}" pacman -Sy --noconfirm --needed "$@" ;;
    apk) run "${SUDO[@]+"${SUDO[@]}"}" apk add --no-cache "$@" ;;
    brew) run brew install "$@" ;;
    *) return 1 ;;
  esac
}

deps_plan() {      # что из зависимостей не хватает (read-only — для плана)
  DEPS_MISSING=()
  DEPS_OPTIONAL=()
  case "$OS" in
    macos) DEPS_NOTE="не требуются (браузер самодостаточен)"; return 0 ;;
    windows) DEPS_NOTE="вне bash (MSYS) — см. docs/install-crossplatform.md"; return 0 ;;
  esac
  if [ "$PM" = unknown ]; then
    DEPS_NOTE="пакетный менеджер не распознан"
    return 0
  fi
  if [ "$PM" = brew ]; then
    DEPS_NOTE="brew на Linux — библиотеки ставит пользователь"
    return 0
  fi
  set_dep_list "$PM"
  local p
  for p in "${REQ_DEPS[@]+"${REQ_DEPS[@]}"}"; do
    pkg_installed "$PM" "$p" || DEPS_MISSING+=("$p")
  done
  for p in "${OPT_DEPS[@]+"${OPT_DEPS[@]}"}"; do
    pkg_installed "$PM" "$p" || DEPS_OPTIONAL+=("$p")
  done
  if [ "${#DEPS_MISSING[@]}" -eq 0 ]; then
    DEPS_NOTE="все обязательные уже стоят (${#REQ_DEPS[@]} шт., $PM)"
  else
    DEPS_NOTE="нет ${#DEPS_MISSING[@]} из ${#REQ_DEPS[@]} — доставлю через $PM"
  fi
}

install_deps() {
  if [ "$SKIP_DEPS" -eq 1 ]; then
    ok "--skip-deps: системные пакеты не трогаю"
    DEPS_NOTE="--skip-deps: системные пакеты не трогаю"
    return 0
  fi
  case "$OS" in
    macos)
      ok "macOS: системные библиотеки не нужны"
      DEPS_NOTE="macOS: не требуются"
      return 0 ;;
    windows)
      warn "Windows: системные пакеты — вне bash (см. docs/install-crossplatform.md)"
      DEPS_NOTE="Windows: вне bash"
      return 0 ;;
  esac
  if [ "$PM" = unknown ]; then
    die "пакетный менеджер не распознан: нужны библиотеки Firefox-стека (GTK3, NSS, X11, шрифты) —
       поставь их сам и повтори с --skip-deps"
  fi
  if [ "$PM" = brew ]; then
    warn "brew на Linux: библиотеки браузера ставит пользователь — пропускаю"
    DEPS_NOTE="brew: библиотеки ставит пользователь"
    return 0
  fi
  if [ "${#DEPS_MISSING[@]}" -gt 0 ]; then
    if [ "$(id -u)" -ne 0 ] && [ "${#SUDO[@]}" -eq 0 ]; then
      die "нужны системные пакеты (${DEPS_MISSING[*]}), но нет root/sudo —
       запусти с sudo или с --skip-deps (зависимости уже стоят?)"
    fi
    info "ставлю ($PM): ${DEPS_MISSING[*]}"
    install_pkgs "$PM" "${DEPS_MISSING[@]}" ||
      die "пакетный менеджер $PM не поставил зависимости — смотри его вывод выше"
    DEPS_NOTE="поставил через $PM: ${DEPS_MISSING[*]}"
  else
    ok "системные зависимости уже стоят"
    DEPS_NOTE="обязательные уже стояли (${#REQ_DEPS[@]} шт., $PM)"
  fi
  if [ "${#DEPS_OPTIONAL[@]}" -gt 0 ]; then
    info "необязательные (звук, для headless-research не критичны): ${DEPS_OPTIONAL[*]}"
    if ! install_pkgs "$PM" "${DEPS_OPTIONAL[@]}"; then
      warn "необязательные пакеты не встали — продолжаю"
    fi
  fi
}

# --- python / uv / venv ----------------------------------------------------
ensure_python() {
  if [ -z "$UV" ] && [ -z "$PY" ]; then
    if [ "$BOOTSTRAP_UV" -eq 1 ]; then
      command -v curl >/dev/null 2>&1 || die "--bootstrap-uv: нужен curl"
      info "ставлю uv (astral.sh) — системного python ≥ 3.10 нет"
      run sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
      UV="$(find_uv)"
      [ -n "$UV" ] || die "uv не появился после установки — поставь вручную (docs/install-crossplatform.md)"
    else
      die "нет python ≥ 3.10 и нет uv: поставь python3.12+ или запусти с --bootstrap-uv"
    fi
  fi
}

create_venv() {
  if [ -x "$VENV_PY" ]; then
    ok "venv уже есть — не пересоздаю: $VENV"
    return 0
  fi
  info "создаю venv в рантайме: $VENV"
  if [ -n "$UV" ]; then
    # Всегда проверенная версия ($UV_PY_SPEC, 3.13 — как в живом venv владельца):
    # у uv свежий системный python (3.14) может не иметь колёс у запиненных
    # зависимостей (mcp==2.1.1, camoufox==0.5.5). Своя версия — CAMOUFOX_PYTHON_SPEC.
    # --seed: кладёт pip внутрь venv — иначе канонический
    # `python scripts/install_mcp.py` (он зовёт venv/bin/pip) не заработает.
    run "$UV" venv --seed --python "$UV_PY_SPEC" "$VENV"
  else
    run "$PY" -m venv "$VENV"
  fi
}

install_package() {
  if [ "$PKG_OK" -eq 1 ] && [ "$REINSTALL" -eq 0 ]; then
    ok "пакет уже установлен ($PKG_VER) — установку пропускаю (--reinstall чтобы переставить)"
    clean_repo_junk
    return 0
  fi
  # Приоритет — `uv sync --frozen` по uv.lock: та же сборка, что в CI (файл
  # лока — источник истины, без резолва и дрейфа версий). `pip install .` из
  # pyproject остаётся фолбэком: uv нет / лока нет / лок разошёлся / sync упал.
  if [ -n "$UV" ] && [ -f "$REPO/uv.lock" ] && [ "$REINSTALL" -eq 0 ] && uv_lock_fresh; then
    info "uv sync --frozen — установка строго по uv.lock (окружение: $VENV)"
    # --inexact: не вычищать из venv то, чего нет в локе (pip внутри venv нужен
    # каноническому `python scripts/install_mcp.py`).
    # --no-editable: код кладём в venv, а не ссылкой на клон — тогда окружение
    # рантайма самодостаточно (клон можно снести/перенести), а рабочий процесс
    # MCP не пишет __pycache__ в клон на диске данных.
    if UV_PROJECT_ENVIRONMENT="$VENV" "$UV" sync --frozen --inexact --no-editable \
        --no-progress --project "$REPO"; then
      pkg_import_check
      clean_repo_junk
      return 0
    fi
    warn "uv sync --frozen не прошёл — фолбэк на pip install . (причина выше)"
  fi
  info "pip install . — ЛОКАЛЬНЫЙ клон $REPO (источник — код на диске, не git-main)"
  if [ -n "$UV" ]; then
    if [ "$REINSTALL" -eq 1 ]; then
      run "$UV" pip install --python "$VENV_PY" --reinstall "$REPO"
    else
      run "$UV" pip install --python "$VENV_PY" "$REPO"
    fi
  else
    if [ "$REINSTALL" -eq 1 ]; then
      run "$VENV_PY" -m pip install --force-reinstall "$REPO"
    else
      run "$VENV_PY" -m pip install "$REPO"
    fi
  fi
  pkg_import_check
  clean_repo_junk
}

uv_lock_fresh() {   # uv.lock сходится с pyproject? (read-only проверка, без правок)
  "$UV" lock --check --project "$REPO" >/dev/null 2>&1
}

pkg_import_check() {
  "$VENV_PY" -c 'import camoufox_research' >/dev/null 2>&1 ||
    die "установка не дала импортируемый пакет в $VENV — смотри вывод выше"
}

clean_repo_junk() {   # byproduct'ы сборки в САМОМ клоне
  # setuptools собирает колесо на месте → `build/` в клоне; импорт из клона
  # дописывает `__pycache__`. Клон — код, не свалка (урок 21.09). Убираем РОВНО
  # эти два вида, больше в клоне ничего не трогаем.
  local n=0 d
  if [ -d "$REPO/build" ]; then
    run rm -rf "$REPO/build"
    n=$((n + 1))
  fi
  if [ -d "$REPO/camoufox_research" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      run rm -rf "$d"
      n=$((n + 1))
    done < <(find "$REPO/camoufox_research" -type d -name __pycache__ -prune 2>/dev/null)
  fi
  if [ "$n" -eq 0 ]; then
    ok "клон чистый: build/ и __pycache__ не появились"
  else
    ok "убрал в клоне byproduct'ы сборки: $n шт. (build/, __pycache__)"
  fi
}

fetch_browser() {
  if [ "$SKIP_BROWSER" -eq 1 ]; then
    ok "--skip-browser: браузер (663 МБ) не качаю и не проверяю"
    return 0
  fi
  info "браузер Camoufox: python -m camoufox fetch (уже скачанный не трогает)"
  # Ненулевой rc здесь не смертелен: браузер мог быть скачан раньше, а сеть —
  # отвалиться сейчас. Жёсткая проверка — ниже (installed_verstr).
  if ! run "$VENV_PY" -m camoufox fetch; then
    warn "fetch вернул ненулевой код — проверю, установлен ли браузер"
  fi
}

# --- MCP + config.env: только через чипсет install_mcp.py -------------------
delegate_chipset() {
  local py="$1"
  "$py" - "$REPO" "$VENV" <<'PY'
# Единый источник секции MCP (opencode.json) и config.env — install_mcp.py.
# Зовём ФУНКЦИИ, а не скрипт целиком: его собственный шаг
# `pip install git+…@main` подменил бы установку из локального клона.
import pathlib
import sys

repo = pathlib.Path(sys.argv[1])
venv = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(repo / "scripts"))
hint = f"{sys.executable} {repo / 'scripts' / 'install_mcp.py'} --venv {venv}"

try:
    import install_mcp as chip
except Exception as exc:  # noqa: BLE001 — человеку нужен совет, не трейсбек
    print(f"[ERR ] чипсет не импортировался: {type(exc).__name__}: {exc}", file=sys.stderr)
    print(f"       запусти вручную: {hint}", file=sys.stderr)
    raise SystemExit(1) from exc

need = ("wrap_console", "write_mcp_config", "write_env_config", "verify")
missing = [name for name in need if not hasattr(chip, name)]
if missing:
    print(f"[ERR ] install_mcp.py изменился — нет: {', '.join(missing)}", file=sys.stderr)
    print(f"       запусти вручную: {hint}", file=sys.stderr)
    raise SystemExit(1)

# Порядок ВАЖЕН (урок dsh 31.08): обёртка caps — поверх ТОЛЬКО ЧТО
# установленного консольного скрипта, поэтому строго после pip.
chip.wrap_console(venv)
chip.write_mcp_config(venv)
chip.write_env_config(venv)
# Секцию MCP чипсет НЕ перезаписывает (чужое не трогаем) — поэтому печатаем
# РЕАЛЬНЫЙ путь, который в итоге оказался в конфиге: если он ведёт в ДРУГОЙ
# venv (например, в старый <клон>/.venv), это видно здесь, а не потом в виде
# «MCP не поднимается».
import json as _json

want = str(venv / "bin" / "camoufox-research")
try:
    conf = _json.loads(chip.OPENCODE_CFG.read_text(encoding="utf-8"))
    cmd = conf.get("mcp", {}).get(chip.MCP_NAME, {}).get("command", [])
    got = cmd[0] if cmd else "(нет)"
except Exception as exc:  # noqa: BLE001 — конфига нет/битый: это диагностика, не падение
    got = f"(не прочитать: {type(exc).__name__})"
if got == want:
    print(f"[5+] MCP → {want} (этот venv)")
else:
    print(f"[WARN] MCP в конфиге → {got}")
    print(f"       а этот venv ставит → {want}")
    print("       путь в ~/.config/opencode/opencode.json поправь вручную или укажи --venv тот же")
raise SystemExit(0 if chip.verify(venv) else 1)
PY
}

register_mcp() {
  if [ "$OS" = windows ]; then
    warn "Windows: install_mcp.py и bash-обёртка caps — Unix-only, MCP не прописываю"
    printf '  впиши в opencode.json руками (путь Windows):\n'
    printf '    "camoufox": {"type": "local", "command": ["%s"], "enabled": true}\n' \
      "$VENV_BIN/camoufox-research.exe"
    printf '  примеры для клиентов: %s\n' "$REPO/mcp/config/"
    printf '  полный путь (обёртка caps, cron, таймеры) — WSL2 / Linux / macOS\n'
    return 0
  fi
  info "MCP + config.env: функции scripts/install_mcp.py (единый источник путей)"
  delegate_chipset "$VENV_PY" || die "чипсет не подтвердил установку — смотри его вывод выше"
}

install_cron_now() {
  [ "$WITH_CRON" -eq 1 ] || return 0
  if [ "$OS" = windows ]; then
    warn "--with-cron: на Windows cron репо нет (Unix-only) — пропускаю"
    return 0
  fi
  if [ ! -f "$REPO/scripts/install_cron.sh" ]; then
    warn "нет $REPO/scripts/install_cron.sh — cron пропускаю"
    return 0
  fi
  info "cron-строки (расписание читается из config.env)"
  run bash "$REPO/scripts/install_cron.sh"
}

verify_all() {
  [ -x "$VENV_PY" ] || die "нет интерпретатора venv: $VENV_PY"
  "$VENV_PY" -c 'import camoufox_research' >/dev/null 2>&1 ||
    die "пакет не импортируется в $VENV"
  ok "пакет $TOOL импортируется в $VENV"
  if [ -x "$ENTRY" ]; then
    ok "консольный скрипт: $ENTRY"
  else
    warn "консольный скрипт не найден: $ENTRY (клиент запускай через $VENV_PY)"
  fi
  if [ "$SKIP_BROWSER" -eq 1 ]; then
    warn "--skip-browser: версию браузера не проверяю (research без него не поедет)"
    return 0
  fi
  local ver
  ver="$("$VENV_PY" -c 'from camoufox.pkgman import installed_verstr
try:
    print(installed_verstr())
except Exception:
    pass' 2>/dev/null || true)"
  [ -n "$ver" ] || die "браузер Camoufox не установлен (fetch не удался) —
       проверь сеть/прокси и повтори; без браузера research не работает"
  ok "браузер Camoufox: $ver"
}

verify_handshake() {
  # Финальная проверка — ЖИВОЕ рукопожатие MCP (initialize + tools/list), а не
  # «файл на месте»: сервер, который не отвечает, уже был (аудит 21.09).
  # Драйвер свой, scripts/mcp_drive.py: npx/Node в цепочке установки не нужен.
  local driver="$REPO/scripts/mcp_drive.py" out n rc
  local to=()
  if [ ! -f "$driver" ]; then
    # Так бывает на СТАРОМ клоне (main без scripts/mcp_drive.py): не падаем —
    # профиль тулов уже проверил чипсет на шаге 6 (verify: дефолт vs CAPS=all).
    warn "нет $driver — рукопожатие не проверяю (профиль тулов проверил чипсет)"
    HANDSHAKE_NOTE="драйвера нет — рукопожатие пропущено (профиль проверил чипсет)"
    return 0
  fi
  command -v timeout >/dev/null 2>&1 && to=(timeout 180)   # macOS: timeout нет — едем без него
  info "рукопожатие MCP: initialize + tools/list (scripts/mcp_drive.py)"
  rc=0
  out="$("${to[@]+"${to[@]}"}" "$VENV_PY" "$driver" "$REPO" '[{"op":"tools"}]' 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    err "сервер не ответил на рукопожатие (rc=$rc) — хвост вывода драйвера:"
    printf '%s\n' "$out" | tail -n 15 >&2
    die "установка неполная: MCP не поднимается (см. вывод выше)"
  fi
  printf '%s\n' "$out" | sed -n 's/^BOOT /  /p'
  n="$(printf '%s\n' "$out" | sed -n 's/^TOOLS n=\([0-9][0-9]*\):.*/\1/p')"
  case "$n" in
    ""|0) die "сервер ответил, но профиль тулов пустой — смотри вывод драйвера выше" ;;
  esac
  HANDSHAKE_NOTE="initialize + tools/list ок, тулов $n"
  ok "MCP-сервер отвечает: initialize ок, тулов $n"
}

next_steps() {
  printf '\n'
  info "что дальше:"
  printf '  · opencode: переподключить MCP после смены кода:\n'
  printf '      opencode2 api post /api/mcp/camoufox/disconnect\n'
  printf '      opencode2 api post /api/mcp/camoufox/connect\n'
  printf '  · Claude Desktop / Cursor: авто-регистрация только у opencode,\n'
  printf '      готовые примеры — %s\n' "$REPO/mcp/config/"
  case "$OS" in
    linux|macos)
      printf '  · расписание (Unix-only): bash %s/scripts/install_cron.sh\n' "$REPO" ;;
    windows)
      printf '  · cron/таймеры репо на Windows НЕТ — Task Scheduler вручную,\n'
      printf '      полный путь (обёртка caps, cron) — только WSL2\n' ;;
  esac
  if [ "$OS" = linux ]; then
    printf '  · догон ночных джобов (systemd-user, ТОЛЬКО Linux):\n'
    printf '      bash %s/scripts/install_timers.sh\n' "$REPO"
    if [ "$IS_WSL" -eq 1 ]; then
      printf '      (WSL: нужен systemd — systemd=true в /etc/wsl.conf)\n'
    fi
  elif [ "$OS" = macos ]; then
    printf '  · systemd-таймеров на macOS НЕТ: install_timers.sh неприменим\n'
  fi
  printf '  · config.env (пути репо/venv — читают крон-скрипты): %s\n' \
    "$CACHE_DIR/config.env"
}

# --- снятие установки (--uninstall) ----------------------------------------
pick_python() {   # интерпретатор для правки JSON: venv (если жив) → системный
  if [ -x "$VENV_PY" ]; then
    printf '%s\n' "$VENV_PY"
    return 0
  fi
  find_python
}

remove_mcp_entry() {
  if [ ! -f "$OPENCODE_CFG" ]; then
    warn "$OPENCODE_CFG нет — MCP-запись снимать нечего"
    return 0
  fi
  local py
  py="$(pick_python)"
  [ -n "$py" ] || die "нет python, чтобы поправить $OPENCODE_CFG — удали секцию 'camoufox' руками"
  "$py" - "$OPENCODE_CFG" "$VENV" "$REPO" <<'PY'
# Снятие ровно одной секции: остальной конфиг клиента (other MCP, настройки)
# не трогаем — чужой файл, чужие ключи.
#
# И снимаем ТОЛЬКО СВОЮ запись (аудит 22.09): ключ 'camoufox' в конфиге может
# стоять не нами — каталог mcp-station пишет тот же сервер своей записью
# (обёртка `bash -lc …`, см. mcp-station/catalog/camoufox.json). Снести чужую
# установку = оставить станцию с «потерянной» записью, которую она при
# следующем update вернёт на место, а человек не поймёт, почему она воскресла.
# Признаки своей записи: метка владельца (её пишет scripts/install_mcp.py) ЛИБО
# команда, буквально указывающая внутрь нашего venv/клона. Чужую обёртку
# (`bash -lc "$HOME/…"`) внутрь не раскрываем намеренно: это не наша строка.
import json
import sys
from pathlib import Path

OWNER_MARK = "CAMOUFOX_MCP_OWNER"      # та же метка, что в scripts/install_mcp.py
OWNER_VALUE = "camoufox-research"

path = Path(sys.argv[1])
roots = [r for r in (sys.argv[2], sys.argv[3]) if r]   # venv, клон


def owner_reason(entry):
    """Почему запись считаем своей; None — чужая."""
    for key in ("environment", "env"):
        env = entry.get(key)
        if isinstance(env, dict) and str(env.get(OWNER_MARK, "")) == OWNER_VALUE:
            return f"метка {OWNER_MARK}={OWNER_VALUE}"
    tokens = entry.get("command")
    tokens = [tokens] if isinstance(tokens, str) else list(tokens or [])
    args = entry.get("args")
    if isinstance(args, list):
        tokens += args
    for tok in tokens:
        if not isinstance(tok, str):
            continue
        for root in roots:
            root = root.rstrip("/")
            if root and (tok == root or tok.startswith(root + "/")):
                return f"путь внутри {root}"
    return None


cfg = json.loads(path.read_text(encoding="utf-8"))
mcp = cfg.get("mcp", {})
if "camoufox" not in mcp:
    print(f"[WARN] секции 'camoufox' в {path} нет — нечего снимать")
    raise SystemExit(0)

entry = mcp["camoufox"]
why = owner_reason(entry)
if why is None:
    print(f"[WARN] оставляю запись 'camoufox' в {path}: поставлена не нами")
    print(f"       запись: {json.dumps(entry, ensure_ascii=False)}")
    print("       снять её должен тот, кто ставил (каталог mcp-station: mcp-station remove camoufox)")
    raise SystemExit(0)

mcp.pop("camoufox")
path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"[ OK ] MCP 'camoufox' снят из {path} — наша запись ({why}; был: {entry.get('command')})")
PY
}

venv_guard() {   # предохранитель ДО правок: rm -rf только по настоящему venv
  if [ ! -e "$VENV" ]; then
    return 0                      # снимать нечего — это не ошибка (идемпотентно)
  fi
  case "$VENV" in
    ""|/|"$HOME") die "отказ: подозрительный путь venv '$VENV' — уточни --venv" ;;
  esac
  [ -f "$VENV/pyvenv.cfg" ] ||
    die "отказ: $VENV не похож на venv (нет pyvenv.cfg) — уточни --venv"
}

remove_venv() {
  if [ ! -e "$VENV" ]; then
    warn "venv нет ($VENV) — пропускаю"
    return 0
  fi
  run rm -rf "$VENV"
  ok "venv удалён: $VENV"
}

uninstall_all() {
  # Снимаем РОВНО установку: venv + запись MCP в клиенте.
  # НЕ трогаем кэш/состояние ($CACHE_DIR: cache.db, отчёты, tool_usage) и
  # браузер (~/.cache/camoufox, 663 МБ) — это данные и скачанный дистрибутив,
  # а не установка: сносить их «в подарок» значит заставлять качать заново.
  info "снятие установки: venv + запись MCP в клиенте"
  printf '  venv            : %s\n' "$VENV"
  printf '  MCP-конфиг      : %s\n' "$OPENCODE_CFG"
  printf '  НЕ трогаю       : %s (кэш, config.env) и %s (браузер)\n' \
    "$CACHE_DIR" "$(browser_cache_dir)"
  # Проверка пути — ДО первой правки: иначе кривой --venv снял бы MCP-запись,
  # оставив venv (полуснятая установка вместо честного отказа).
  venv_guard
  if ! ask "снять venv и MCP-запись?" y; then
    info "отменено — ничего не меняю"
    return 0
  fi
  if [ "$OS" = windows ]; then
    warn "Windows: MCP прописан руками — сотри секцию 'camoufox' в opencode.json сам"
  else
    remove_mcp_entry
  fi
  remove_venv
  printf '\n'
  ok "установка снята. Осталось нетронутым:"
  printf '  · кэш/состояние : %s (внутри config.env — пути снятого venv;\n' "$CACHE_DIR"
  printf '                    переустановка перезапишет его)\n'
  printf '  · браузер       : %s (качать заново не нужно)\n' "$(browser_cache_dir)"
  printf '  · код           : %s\n' "${REPO:-— (клона не было)}"
}

# --- состояние и план ------------------------------------------------------
browser_cache_dir() {   # зеркало camoufox.pkgman.INSTALL_DIR (platformdirs user_cache_dir)
  case "$OS" in
    macos) printf '%s\n' "$HOME/Library/Caches/camoufox" ;;
    windows) printf '%s\n' "${LOCALAPPDATA:-$HOME/AppData/Local}/camoufox/Cache" ;;
    *) printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/camoufox" ;;
  esac
}

compute_state() {
  deps_plan
  if [ -n "$UV" ]; then
    PY_NOTE="uv: $UV → venv на python $UV_PY_SPEC (проверенный; скачает, если нет)"
    [ -n "$PY" ] && PY_NOTE="$PY_NOTE; системный: $PY ($PY_VER)"
  elif [ -n "$PY" ]; then
    if [ "$PY_IN_RANGE" -eq 1 ]; then
      PY_NOTE="$PY ($PY_VER), uv нет — venv через python3 -m venv"
    else
      PY_NOTE="$PY ($PY_VER — ВНЕ проверенного 3.10–3.13), uv нет:
                     колёс запиненных зависимостей может не быть"
    fi
  else
    PY_NOTE="python ≥ 3.10 нет"
    [ "$BOOTSTRAP_UV" -eq 1 ] && PY_NOTE="$PY_NOTE — поставлю uv (--bootstrap-uv)"
  fi

  if [ -x "$VENV_PY" ]; then
    VENV_NOTE="уже есть — не пересоздаю"
  else
    VENV_NOTE="создам"
  fi

  PKG_OK=0
  PKG_VER="?"
  if [ -x "$VENV_PY" ]; then
    # Идемпотентность решает ИМПОРТ (работоспособность), а не метаданные:
    # dist-info может отсутствовать (editable/uv), а пакет при этом живой.
    if "$VENV_PY" -c 'import camoufox_research' >/dev/null 2>&1; then
      PKG_OK=1
      PKG_VER="$("$VENV_PY" -c 'import importlib.metadata as m
print(m.version("camoufox-research"))' 2>/dev/null || echo 'версия неизвестна')"
      PKG_NOTE="уже установлен ($PKG_VER) — установку пропущу"
    else
      PKG_NOTE="$(package_method_note)"
    fi
    [ "$REINSTALL" -eq 1 ] && PKG_NOTE="переустановлю (--reinstall)"
  else
    PKG_NOTE="$(package_method_note) (после создания venv)"
  fi

  local bdir
  bdir="$(browser_cache_dir)"
  if [ "$SKIP_BROWSER" -eq 1 ]; then
    BROWSER_NOTE="пропущу (--skip-browser) — 663 МБ не качаю"
  elif [ -d "$bdir/browsers" ]; then
    BROWSER_NOTE="кэш уже есть ($bdir) — fetch пропустит загрузку"
  else
    BROWSER_NOTE="скачаю в $bdir (нужна сеть)"
  fi

  if [ "$OS" = windows ]; then
    MCP_NOTE="вручную (обвязка репо Unix-only)"
  else
    MCP_NOTE="функции scripts/install_mcp.py (единый источник) + config.env"
  fi

  if [ "$BOOTSTRAP" -eq 1 ]; then
    CLONE_NOTE="клона рядом нет → git clone $REPO_URL → $REPO"
  else
    CLONE_NOTE="клон есть: $REPO (не клонирую)"
  fi

  HANDSHAKE_NOTE="initialize + tools/list через scripts/mcp_drive.py"
}

package_method_note() {   # чем ставим пакет: лок-файл приоритетнее pyproject
  if [ -z "$UV" ]; then
    printf 'pip install .'
    return 0
  fi
  if [ "$BOOTSTRAP" -eq 1 ]; then
    printf 'uv sync --frozen (uv.lock — свежесть проверю после клона)'
    return 0
  fi
  if [ -f "$REPO/uv.lock" ] && uv_lock_fresh; then
    printf 'uv sync --frozen (uv.lock)'
  else
    printf 'pip install .'
  fi
}

print_plan() {
  info "план (идемпотентный: повторный запуск ничего не ломает)"
  printf '  клон                     : %s\n' "$CLONE_NOTE"
  printf '  1/7 системные зависимости : %s\n' "$DEPS_NOTE"
  if [ "${#DEPS_MISSING[@]}" -gt 0 ]; then
    printf '      не хватает           : %s\n' "${DEPS_MISSING[*]}"
  fi
  printf '  2/7 python / uv          : %s\n' "$PY_NOTE"
  printf '  3/7 venv (рантайм)       : %s — %s\n' "$VENV" "$VENV_NOTE"
  printf '  4/7 пакет                : %s — %s\n' "$PKG_NOTE" "$REPO"
  printf '  5/7 браузер Camoufox      : python -m camoufox fetch — %s\n' "$BROWSER_NOTE"
  printf '  6/7 MCP + config.env     : %s\n' "$MCP_NOTE"
  printf '  7/7 проверка             : импорт, консольный скрипт, браузер; %s\n' \
    "$HANDSHAKE_NOTE"
  printf '      пути                 : venv %s | кэш %s | браузер %s\n' \
    "$VENV" "$CACHE_DIR" "$(browser_cache_dir)"
  if [ "${#DEPS_OPTIONAL[@]}" -gt 0 ]; then
    printf '  (+) необязательные        : %s\n' "${DEPS_OPTIONAL[*]}"
  fi
}

print_header() {
  local mode priv
  mode="установка"
  [ "$DRY_RUN" -eq 1 ] && mode="план (dry-run — ничего не меняю)"
  if [ "$(id -u)" -eq 0 ]; then priv="root"
  elif [ "${#SUDO[@]}" -gt 0 ]; then priv="sudo"
  else priv="нет (системные пакеты — только с --skip-deps или root)"; fi
  printf '\n'
  info "$TOOL: $mode"
  printf '  ОС: %s | арх: %s | пакетный менеджер: %s | права: %s\n' \
    "$OS" "$ARCH" "$PM" "$priv"
  if [ -n "$OS_FORCE" ]; then
    warn "--os $OS_FORCE форсирована (uname: $(uname -s 2>/dev/null || echo '?')) — для плана/тестов"
  fi
  case "$OS" in
    unknown:*)
      die "неподдерживаемая ОС: ${OS#unknown:} (есть linux, macOS, Windows-MSYS)" ;;
    linux)
      if [ "$ARCH" != x86_64 ] && [ "$ARCH" != arm64 ]; then
        die "архитектура $ARCH не поддержана Camoufox (нужны x86_64 или arm64)"
      fi ;;
  esac
  if [ "$IS_WSL" -eq 1 ]; then
    info "WSL обнаружен: ставим как Linux; systemd-таймеры — только при systemd=true"
  fi
}

# --- main ------------------------------------------------------------------
main() {
  local t_all=$SECONDS
  parse_args "$@"
  detect_env      # ОС/арх/PM/python — от них зависят пути venv (bin/ против Scripts/)
  # Пайп = stdin занят самим скриптом (curl|bash): интерактивных вопросов быть
  # не может — read() съел бы следующие строки установщика. Работаем как --yes.
  if [ ! -t 0 ]; then
    ASSUME_YES=1
  fi
  resolve_repo
  resolve_venv

  if [ "$SHOW_VERSION" -eq 1 ]; then
    print_version
    return 0
  fi

  print_header

  if [ "$UNINSTALL" -eq 1 ]; then
    uninstall_all
    return 0
  fi

  compute_state
  print_plan

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n'
    ok "dry-run: план показан, ни один шаг не выполнен (система не изменена)"
    return 0
  fi

  printf '\n'
  if [ "$BOOTSTRAP" -eq 1 ]; then
    # Шаг 0 (в нумерацию 1..7 не входит): установка «в один клик» без клона.
    info "клон репозитория ($(date '+%H:%M:%S')): клона рядом нет — беру из сети"
    local t_clone=$SECONDS
    bootstrap_clone
    ok "клон готов — $((SECONDS - t_clone)) с: $REPO"
    printf '\n'
  fi

  step_start "системные библиотеки Firefox-стека"
  install_deps
  step_end "зависимости: ${DEPS_NOTE}"

  step_start "python / uv"
  ensure_python
  step_end "python: ${PY_NOTE}"

  step_start "venv в рантайме: $VENV"
  create_venv
  step_end "venv: ${VENV_NOTE}"

  step_start "пакет $TOOL → $VENV"
  install_package
  step_end "пакет: $PKG_NOTE"

  step_start "браузер Camoufox"
  fetch_browser
  step_end "браузер: ${BROWSER_NOTE}"

  step_start "MCP в клиенте + config.env"
  register_mcp
  step_end "MCP: ${MCP_NOTE}"

  step_start "проверка: пакет, браузер, рукопожатие MCP"
  verify_all
  verify_handshake
  step_end "проверка: ${HANDSHAKE_NOTE}"

  install_cron_now     # только с --with-cron: вне семи шагов, по явной просьбе
  next_steps
  printf '\n'
  ok "Установка $TOOL завершена за $((SECONDS - t_all)) с"
}

main "$@"
