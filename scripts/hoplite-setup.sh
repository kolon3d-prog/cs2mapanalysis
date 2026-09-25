#!/usr/bin/env bash
# Light, non-destructive aidvizh-agent setup for each new sandbox.
# Deliberately skips `center fresh`: its cleanup step deletes tracked kit files from the checkout.
# Heavy/optional stations (camoufox, stealth-browser, debug MCPs, systemd units) are skipped too.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT="$ROOT/aidvizh-agent"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
fail=0

# git may drop the executable bit on checkout
find "$KIT" -type f \( -name '*.sh' -o -path '*/bin/*' \) -exec chmod +x {} + 2>/dev/null

# omp needs bun >= 1.4 (fails to parse on 1.3.x)
if command -v bun >/dev/null && [ "$(bun --version | cut -d. -f1-2 | tr -d .)" -lt 14 ]; then
  bun upgrade >/dev/null 2>&1 || echo "warn: bun upgrade failed"
fi

step() {
  local label="$1"; shift
  echo "== $label"
  "$@"; local rc=$?
  if [ "$rc" -ne 0 ]; then echo "!! $label failed (exit $rc)"; fail=1; fi
}

step "center command" bash "$KIT/command-center/contrib/install-links.sh"
step "agents"         bash "$KIT/cli-station/bin/cli-station.sh" install
# npm may not create the omp bin link
if ! command -v omp >/dev/null; then
  cli="$(npm root -g 2>/dev/null)/@oh-my-pi/pi-coding-agent/dist/cli.js"
  [ -f "$cli" ] && chmod +x "$cli" && mkdir -p "$HOME/.local/bin" && ln -sf "$cli" "$HOME/.local/bin/omp"
fi
step "skills hub links" bash "$KIT/skills-hub/contrib/install-links.sh"
step "skills (incl. spec-mode)" bash "$KIT/skills-station/bin/skills-station.sh" install all
step "memory"           bash "$KIT/memory-station/bin/memory-station.sh" install --bootstrap-uv
step "wiki"             bash "$KIT/wiki-station/bin/wiki-station.sh" install
step "MCP"              bash "$KIT/mcp-station/bin/mcp-station.sh" install

# Integrity guard: setup must never modify tracked kit files.
if git -C "$ROOT" status --porcelain -- aidvizh-agent | grep -q '^ D'; then
  echo "!! tracked kit files were deleted — restoring"; git -C "$ROOT" checkout -- aidvizh-agent; fail=1
fi
echo "aidvizh setup done (failures: $fail)"
exit 0
