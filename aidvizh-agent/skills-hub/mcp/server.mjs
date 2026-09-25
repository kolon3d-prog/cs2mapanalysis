#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // mcp/server.mjs -> каталог хаба
const MANAGER = join(ROOT, "skills-manager.sh");

/**
 * Поиск по УСТАНОВЛЕННЫМ скиллам живёт в станции скиллов: движок там же, где CLI, чтобы
 * агент в сессии видел то же, что оператор в терминале. Путь ищется рядом с хабом
 * (в репозитории станции лежат соседями) или задаётся SKILLS_STATION_ROOT.
 */
const STATION_CANDIDATES = [
  process.env.SKILLS_STATION_ROOT,
  join(ROOT, "..", "skills-station"),
  // хаб часто запускают через симлинк (~/.agents/skills/skills-ops): со снятыми ссылками
  // каталог станции ищем и от настоящего пути mcp/server.mjs
  join(realRoot(ROOT), "..", "skills-station"),
].filter(Boolean);

function realRoot(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

let enginePromise;
async function loadStation() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const tried = [];
      for (const dir of STATION_CANDIDATES) {
        const lib = join(dir, "bin", "lib", "skill-index.mjs");
        tried.push(lib);
        if (existsSync(lib)) return { engine: await import(pathToFileURL(lib).href), root: dir };
      }
      throw new Error(`движок поиска по установленным скиллам не найден; искал ${tried.join(", ")} — задай SKILLS_STATION_ROOT`);
    })();
  }
  return enginePromise;
}

/** Слои для движка: дом и проект клиента те же, что у CLI станции (SKILLS_STATION_HOME/CWD). */
function stationLayers(root) {
  return {
    home: process.env.SKILLS_STATION_HOME || homedir(),
    cwd: process.env.SKILLS_STATION_CWD || process.cwd(),
    collection: process.env.SKILLS_STATION_COLLECTION || join(root, "collection"),
    configHome: process.env.XDG_CONFIG_HOME,
  };
}

/** Каталог-склад заглушек WindowsApps (алиасы Store и заглушка WSL): рабочей командой он не считается. */
function isStubDir(dir) {
  return dir.split(/[\\/]/).some((part) => part.toLowerCase() === "windowsapps");
}

/** Каталоги PATH: разделитель — по виду строки (в Git Bash та же переменная приходит через «:»). */
function pathDirs() {
  const path = String(process.env.PATH ?? "");
  const sep = path.includes(";") || /^[A-Za-z]:[\\/]/.test(path) ? ";" : ":";
  return path.split(sep).filter(Boolean);
}

/** bash из PATH, но не заглушка: на Windows имя файла bash.exe, расширения — из PATHEXT. */
function bashFromPath() {
  const exts = String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of pathDirs()) {
    if (isStubDir(dir)) continue;
    for (const ext of ["", ...exts]) {
      const candidate = join(dir, `bash${ext}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* нет файла — следующий кандидат */
      }
    }
  }
  return undefined;
}

/**
 * bash ищем по абсолютному пути и проверяем делом. На Windows это Git for Windows (имя файла bash.exe),
 * а в PATH часто стоит заглушка WSL: она печатает «поставь дистрибутив» и выходит с нулём, поэтому на
 * `-c true` выглядела рабочей. Требуем ответ версией GNU bash — заглушка её не отдаёт. WSL не годится и
 * когда дистрибутив поставлен: у него другой $HOME и другой корень диска, конфиги разъезжаются.
 */
const SHELL_CANDIDATES =
  process.platform === "win32"
    ? [
        process.env.AGGG_BASH,
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe` : undefined,
        bashFromPath(),
      ].filter(Boolean)
    : ["bash"];

function resolveShell() {
  for (const candidate of SHELL_CANDIDATES) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.error || probe.status !== 0) continue;
    if (!/GNU bash/i.test(String(probe.stdout ?? ""))) continue; // заглушка WSL: инструкция вместо версии
    return candidate;
  }
  return undefined;
}

const SHELL = resolveShell();
// bash на Windows не разбирает обратные слэши — путь до роутера отдаём в прямых
const MANAGER_ARG = MANAGER.replaceAll("\\", "/");

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
const SERVER_INFO = { name: "skills-hub", version: "1.0.0" };

const TIMEOUT_MS = {
  search: 180_000,
  inspect: 180_000,
  list: 120_000,
  install: 600_000,
};

const SEARCH_SOURCES = ["skills-sh", "github", "clawhub", "skillsmp", "all"];
const PKG_SOURCES = ["skills-sh", "github", "clawhub"];

const TOOLS = [
  {
    name: "skills_find",
    description:
      "Search skills ALREADY INSTALLED on this machine — client layers (./.agents/skills, ~/.agents/skills, opencode, claude) plus the skills-station collection — by name, description and body. No network, no database, no index to build. Use it mid-session: the skill list in the session context is fixed at start, so a skill added or edited later is invisible there, while this tool sees it immediately. Multi-word queries match all words first, then any word; an empty result returns the nearest skill names. Returns name, layer, path, description, score and a matching snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need, e.g. 'браузер', 'debug a hung process', 'camo'. Empty string lists every installed skill." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results; default 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "skills_show",
    description:
      "Read an installed skill: description, first lines of its body and the SKILL.md path, by exact or unambiguous partial name. Pair with skills_find to go from 'do we have a skill about X' to reading it without restarting the client.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name or its unambiguous part, e.g. 'camoufox-research-ops' or 'camo'" },
      },
      required: ["name"],
    },
  },
  {
    name: "skills_search",
    description:
      "Search agent-skill marketplaces. skills-sh (skills.sh, default) and github take packages as owner/repo@skill; clawhub takes slugs like puppeteer or @owner/slug; skillsmp is a search-only index; all queries every marketplace. Returns candidates with popularity and their package refs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, e.g. 'pdf parsing' or 'puppeteer'" },
        source: { type: "string", enum: SEARCH_SOURCES, description: "Marketplace to query; default skills-sh" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results; default 10" },
        owner: { type: "string", description: "Restrict results to one owner (skills-sh and github only)" },
      },
      required: ["query"],
    },
  },
  {
    name: "skills_inspect",
    description:
      "Read a skill's SKILL.md without installing it. Default returns a summary (name, description, permissions, install/dependency sections); full=true returns the entire file. Inspect any third-party skill before installing.",
    inputSchema: {
      type: "object",
      properties: {
        pkg: { type: "string", description: "Package ref: owner/repo@skill for skills-sh/github, slug for clawhub" },
        source: { type: "string", enum: PKG_SOURCES, description: "Marketplace; default skills-sh" },
        full: { type: "boolean", description: "Return the whole SKILL.md instead of the summary" },
      },
      required: ["pkg"],
    },
  },
  {
    name: "skills_list",
    description: "List installed agent skills as seen by the marketplace CLI (~/.agents/skills and locks).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: PKG_SOURCES, description: "Marketplace view; default skills-sh" },
      },
    },
  },
  {
    name: "skills_install",
    description:
      "Install a skill into ~/.agents/skills (project=true installs into ./.agents/skills). Installed skills run with the agent's full privileges: require explicit human approval before calling this tool, and inspect the skill first.",
    inputSchema: {
      type: "object",
      properties: {
        pkg: { type: "string", description: "Package ref: owner/repo@skill for skills-sh/github, slug for clawhub" },
        source: { type: "string", enum: PKG_SOURCES, description: "Marketplace; default skills-sh" },
        project: { type: "boolean", description: "Install into ./.agents/skills instead of ~/.agents/skills" },
      },
      required: ["pkg"],
    },
  },
];

function requireString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' must be a non-empty string`);
  return value.trim();
}

function pickEnum(args, key, allowed, fallback) {
  const value = args[key] ?? fallback;
  if (!allowed.includes(value)) throw new Error(`'${key}' must be one of: ${allowed.join(", ")}`);
  return value;
}

function pickLimit(args, fallback) {
  const value = args.limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("'limit' must be an integer between 1 and 100");
  }
  return value;
}

function spawnManager(args, timeoutMs) {
  const configured = Number(process.env.MCP_SKILLS_HUB_TIMEOUT_MS);
  const effectiveTimeoutMs = Number.isInteger(configured) && configured > 0 ? configured : timeoutMs;
  return new Promise((resolve) => {
    if (!SHELL) {
      resolve({
        code: -1,
        out: "",
        err:
          "skills-manager: не найден настоящий bash, а MCP-сервер запускает bash-роутер. " +
          "На Windows поставь Git for Windows (winget install Git.Git) — заглушка WSL не годится " +
          `(у неё другой $HOME и другой корень диска): ${MANAGER}`,
      });
      return;
    }
    const child = spawn(SHELL, [MANAGER_ARG, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let out = "";
    let err = "";
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };

    const timer = setTimeout(() => {
      err += `\nskills-manager: timeout after ${effectiveTimeoutMs}ms`;
      child.kill("SIGKILL");
      finish(124);
    }, effectiveTimeoutMs);

    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      err += `\nskills-manager: ${error.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

async function runManager(args, timeoutMs) {
  const result = await spawnManager(args, timeoutMs);
  const chunks = [];
  if (result.out.trim()) chunks.push(result.out.trimEnd());
  if (result.err.trim()) chunks.push(result.err.trimEnd());
  if (chunks.length === 0) chunks.push(`exit code ${result.code}, no output`);
  return { text: chunks.join("\n"), failed: result.code !== 0 };
}

async function dispatchTool(name, args) {
  switch (name) {
    case "skills_find": {
      const query = typeof args.query === "string" ? args.query : "";
      const limit = pickLimit(args, 10);
      const { engine, root } = await loadStation();
      const skills = engine.collectSkills(stationLayers(root));
      const found = engine.searchSkills(skills, query, limit);
      const payload = { ok: true, query: found.query, count: found.results.length, results: found.results };
      if (found.suggestions.length) payload.suggestions = found.suggestions;
      return { text: JSON.stringify(payload, null, 2), failed: false };
    }
    case "skills_show": {
      const wanted = requireString(args, "name");
      const { engine, root } = await loadStation();
      const skills = engine.collectSkills(stationLayers(root));
      const found = engine.findSkill(skills, wanted);
      if (!found.skill) {
        const similar = (found.suggestions ?? []).map((row) => `${row.name} [${row.layer}]`).join(", ");
        return {
          text: `skills_find: скилла «${wanted}» нет. Похожие: ${similar || "—"}`,
          failed: true,
        };
      }
      const skill = found.skill;
      return {
        text: `${skill.name} [${skill.layer}]\npath: ${skill.path}\n\n${skill.description}\n\n${engine.bodyHead(skill, 40)}\n`,
        failed: false,
      };
    }
    case "skills_search": {
      const command = ["search", requireString(args, "query")];
      command.push("--source", pickEnum(args, "source", SEARCH_SOURCES, "skills-sh"));
      command.push("--limit", String(pickLimit(args, 10)));
      if (args.owner !== undefined) command.push("--owner", requireString(args, "owner"));
      return runManager(command, TIMEOUT_MS.search);
    }
    case "skills_inspect": {
      const command = ["inspect", requireString(args, "pkg")];
      command.push("--source", pickEnum(args, "source", PKG_SOURCES, "skills-sh"));
      if (args.full === true) command.push("--full");
      return runManager(command, TIMEOUT_MS.inspect);
    }
    case "skills_list": {
      const source = pickEnum(args, "source", PKG_SOURCES, "skills-sh");
      return runManager(["list", "--source", source], TIMEOUT_MS.list);
    }
    case "skills_install": {
      const command = ["install", requireString(args, "pkg")];
      command.push("--source", pickEnum(args, "source", PKG_SOURCES, "skills-sh"));
      if (args.project === true) command.push("--project");
      return runManager(command, TIMEOUT_MS.install);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handleMessage(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL;
    respond(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }

  if (id === undefined || id === null) return;

  if (method === "ping") {
    respond(id, {});
    return;
  }

  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const args = params?.arguments ?? {};
    try {
      const outcome = await dispatchTool(params?.name, args);
      respond(id, { content: [{ type: "text", text: outcome.text }], isError: outcome.failed || undefined });
    } catch (error) {
      respond(id, { content: [{ type: "text", text: `skills-hub-mcp: ${error.message}` }], isError: true });
    }
    return;
  }

  respondError(id, -32601, `method not found: ${method}`);
}

let inputBuffer = "";
let messageQueue = Promise.resolve();

function enqueueMessage(message) {
  messageQueue = messageQueue.then(() => handleMessage(message));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newline;
  while ((newline = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("skills-hub-mcp: ignoring malformed JSON line\n");
      continue;
    }
    enqueueMessage(message);
  }
});
