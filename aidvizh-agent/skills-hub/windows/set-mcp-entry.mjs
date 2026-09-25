#!/usr/bin/env node
// Дописывает регистрацию skills-hub в конфиг клиента. Идемпотентно: если значения уже такие,
// файл не перезаписывается. Формат сохраняется (2 пробела, порядок ключей), бэкап рядом — .bak.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Регистрация для Windows — нативная: `node` плюс путь к серверу. Шелла в конфиге Windows нет, а `bash`
 * в PATH там часто заглушка WSL (печатает «поставь дистрибутив» и выходит с нулём) — запись через
 * `bash -lc` давала бы мёртвый сервер. Путь абсолютный по той же причине: раскрывать `$HOME` в конфиге
 * некому; так же поступает `mcp-station install` со своими записями (`argvWindows`).
 */
const MCP_COMMAND = ["node", join(homedir(), ".agents/skills/skills-ops/mcp/server.mjs")];

const PROFILES = {
  opencode: {
    config: (home) => `${home}/.config/opencode/opencode.json`,
    apply: (config) => {
      config.mcp = config.mcp ?? {};
      config.mcp["skills-hub"] = { type: "local", command: MCP_COMMAND };
      config.permission = config.permission ?? {};
      config.permission["skills-hub_skills_install"] = "ask";
      return ["mcp.skills-hub", "permission.skills-hub_skills_install"];
    },
  },
  omp: {
    config: (home) => `${home}/.omp/agent/mcp.json`,
    apply: (config) => {
      config.mcpServers = config.mcpServers ?? {};
      config.mcpServers["skills-hub"] = { command: MCP_COMMAND[0], args: MCP_COMMAND.slice(1) };
      config.tools = config.tools ?? {};
      config.tools.approval = config.tools.approval ?? {};
      config.tools.approval["mcp__skills_hub_skills_install"] = "prompt";
      return ["mcpServers.skills-hub", "tools.approval.mcp__skills_hub_skills_install"];
    },
  },
};

function parseArgs(argv) {
  const args = { client: "opencode", file: "", offline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--client") {
      args.client = argv[i + 1];
      i += 1;
    } else if (arg === "--file") {
      args.file = argv[i + 1];
      i += 1;
    } else if (arg === "--offline") {
      args.offline = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`неизвестный флаг: ${arg}`);
    } else {
      args.file = arg;
    }
  }
  if (!PROFILES[args.client]) throw new Error(`--client принимает opencode или omp, получено: ${args.client}`);
  if (!args.file) throw new Error("нужен путь к конфигу: --file <путь>");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const profile = PROFILES[args.client];

if (args.offline) {
  const home = args.file;
  process.stdout.write(`${profile.config(home)}\n`);
  process.exit(0);
}

const before = existsSync(args.file) ? readFileSync(args.file, "utf8") : "";
const config = before.trim() ? JSON.parse(before) : {};
const keys = profile.apply(config);
const after = `${JSON.stringify(config, null, 2)}\n`;

if (before === after) {
  process.stdout.write(`already configured (${args.client}): ${keys.join(", ")} - ${args.file}\n`);
  process.exit(0);
}

if (before.trim()) copyFileSync(args.file, `${args.file}.bak`);
writeFileSync(args.file, after);
process.stdout.write(`updated ${args.file}: ${keys.join(", ")} (backup: ${args.file}.bak)\n`);
