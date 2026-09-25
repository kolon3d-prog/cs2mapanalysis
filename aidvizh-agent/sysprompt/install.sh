#!/bin/sh
set -eu

# На Windows (Git Bash/MSYS) `ln -s` по умолчанию делает копии, а не ссылки: правки в проекте
# перестают доходить до клиента. Поэтому здесь отказываемся и отправляем в PowerShell-установщик.
windows=0
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW* | MSYS* | CYGWIN*) windows=1 ;;
esac
if [ "$windows" -eq 0 ] && [ -n "${MSYSTEM:-}" ]; then
  windows=1
fi

if [ "$windows" -eq 1 ] && [ "${SYSPROMPT_ALLOW_MSYS:-}" != "1" ]; then
  printf 'windows: симлинки из Git Bash превращаются в копии.\n' >&2
  printf 'поставь через PowerShell: pwsh -File install.ps1\n' >&2
  printf '(если копии устраивают — SYSPROMPT_ALLOW_MSYS=1 install.sh ...)\n' >&2
  exit 1
fi

root=$(cd "$(dirname "$0")" && pwd)
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
agents="$HOME/.agents/skills"

link() {
  src=$1
  dst=$2
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    printf 'занято: %s — это не симлинк, не трогаю\n' "$dst" >&2
    exit 1
  fi
  ln -sfn "$src" "$dst"
  printf '%s -> %s\n' "$dst" "$src"
}

install_opencode_dev() {
  mkdir -p "$cfg/plugins" "$cfg/commands" "$cfg/skills" "$agents"
  link "$root/opencode/dev/plugin/sysprompt.ts" "$cfg/plugins/sysprompt.ts"
  link "$root/opencode/dev/command/prompt.md" "$cfg/commands/prompt.md"
  link "$root/opencode/skill" "$agents/sysprompt"
  link "../../../.agents/skills/sysprompt" "$cfg/skills/sysprompt"
  printf '\nготово. перезапусти сервер: opencode2 service restart\n'
}

install_omp() {
  agent="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
  mkdir -p "$agent/extensions"
  link "$root/omp/dev/extension/sysprompt.ts" "$agent/extensions/sysprompt.ts"
  printf '\nготово. перезапусти omp (расширения читаются на старте сессии)\n'
}

install_pi() {
  agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  mkdir -p "$agent/extensions"
  link "$root/pi/dev/extension/sysprompt.ts" "$agent/extensions/sysprompt.ts"
  printf '\nготово. перезапусти pi (расширения читаются на старте, /reload подхватывает на лету)\n'
}

target="${1:-auto}"

case "$target" in
  auto)
    version=$(opencode2 --version 2>/dev/null || true)
    case "$version" in
      *-dev-*) target=opencode-dev ;;
      *)
        printf 'не понял сборку opencode: %s\nукажи таргет явно: install.sh opencode-dev | omp | pi | all\n' "${version:-бинарь не найден}" >&2
        exit 1
        ;;
    esac
    ;;
esac

case "$target" in
  opencode-dev) install_opencode_dev ;;
  omp) install_omp ;;
  pi) install_pi ;;
  all)
    install_opencode_dev
    install_omp
    install_pi
    ;;
  *)
    printf 'неизвестный таргет: %s (доступно: opencode-dev, omp, pi, all)\n' "$target" >&2
    exit 1
    ;;
esac
