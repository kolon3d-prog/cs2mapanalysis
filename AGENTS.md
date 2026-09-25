# AGENTS.md

This repo follows the aidvizh-agent rules. Read `aidvizh-agent/AGENTS.md` before any work; its rules apply
to the whole repository, not only to `aidvizh-agent/`.

Key rules (full versions in `aidvizh-agent/command-center/docs/11-zero-assumption.md`):

- Ask the system first, then act: verify the contract by behavior, not exit codes; wait on events, not time;
  mark unproven claims `[verify]`; an honest blocker beats a hack.
- Search with `rg` / `fd`, excluding `.git`, `node_modules`, `.cache`, `.venvs`, `dist`, `build`; cap output.
- Tests: domain + e2e only. Test ladder 1 → N (one target test, then module, then the full gate once before the
  final commit), fail-fast batches.
- Don't invent commands: use `center` (`aidvizh-agent/command-center/bin/center.sh`) and its registry.
- Reversible changes autonomously; destructive or external side effects never silently.

Skills: installed under `~/.agents/skills` (`memory`, `skills-ops`, `spec-mode`, `sysprompt`, `vibe-mode`,
`wiki`). Read the matching `SKILL.md` when a task fits its description. If the kit is missing on a fresh
machine, reinstall with `bash aidvizh-agent/install.sh` (then `center verify`).
