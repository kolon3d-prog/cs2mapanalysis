#!/usr/bin/env node
// spec-station — ставит спек-режим (скилл spec-mode + слэш-команды) в клиентов.
//
// Скилл и команды живут в самой станции (skill/, commands/) и ставятся ссылками или копиями —
// второй копии текста нигде не заводится. Пути считаются от $HOME и текущего каталога:
// абсолютных путей диска в станции нет.
//
// Слои скилла делятся на два вида. Канонический (`global`, `~/.agents/skills`) и проектный (`project`)
// держат сам скилл. Клиентские (`opencode`, `claude`, `omp`, `pi`) — это зеркала канонического слоя:
// ссылка идёт не на станцию, а на `~/.agents/skills/<имя>`, как разложено на машине. Так у скилла один
// источник, а слой клиента остаётся ярлыком.
import {
  readFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, cpSync, symlinkSync,
  lstatSync, readlinkSync, renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = process.env.SPEC_STATION_SOURCE || join(ROOT, "skill");
const COMMANDS = process.env.SPEC_STATION_COMMANDS || join(ROOT, "commands");
const HOME = process.env.SPEC_STATION_HOME || homedir();
const CWD = process.env.SPEC_STATION_CWD || process.cwd();

const SKILL_NAME = "spec-mode";

/** Слои скилла: те же имена, что у skills-station — скилл кладётся туда же, где живут остальные. */
const SKILL_LAYERS = {
  global: () => join(HOME, ".agents/skills"),
  project: () => join(CWD, ".agents/skills"),
  opencode: () => join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "opencode/skills"),
  claude: () => join(HOME, ".claude/skills"),
  omp: () => join(process.env.OMP_AGENT_DIR || join(HOME, ".omp/agent"), "skills"),
  pi: () => join(process.env.PI_CODING_AGENT_DIR || join(HOME, ".pi/agent"), "skills"),
};

/** Клиентские слои — зеркала канонического, а не самостоятельные места. */
const CLIENT_LAYERS = ["opencode", "claude", "omp", "pi"];

/** Что считается «живым»: у скилла — свой каталог слоя, у команд — agent-каталог клиента.
 *  Разные проверки не случайно: установка команд создаёт каталог клиента, и общая проверка ломала бы
 *  вывод `status` — клиент без слоя скиллов выглядел бы как слой с пропавшим скиллом. */
const LAYER_HOST = {
  opencode: () => join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "opencode/skills"),
  claude: () => join(HOME, ".claude/skills"),
  omp: () => join(process.env.OMP_AGENT_DIR || join(HOME, ".omp/agent"), "skills"),
  pi: () => join(process.env.PI_CODING_AGENT_DIR || join(HOME, ".pi/agent"), "skills"),
};

const CLIENT_HOST = {
  opencode: () => process.env.XDG_CONFIG_HOME || join(HOME, ".config/opencode"),
  claude: () => join(HOME, ".claude"),
  omp: () => process.env.OMP_AGENT_DIR || join(HOME, ".omp/agent"),
  pi: () => process.env.PI_CODING_AGENT_DIR || join(HOME, ".pi/agent"),
};

/** Каталоги команд по клиентам. omp/opencode/claude читают `commands/*.md`; у pi тот же механизм
 *  называется шаблонами промптов и живёт в `prompts/` — сам pi переносит туда старый `commands/`
 *  миграцией при старте (`dist/migrations.js`: renameSync(commandsDir, promptsDir)). Писать сразу
 *  в `prompts/` — иначе станция считает команды поставленными там, где их уже нет. */
const COMMAND_CLIENTS = {
  omp: () => join(process.env.OMP_AGENT_DIR || join(HOME, ".omp/agent"), "commands"),
  pi: () => join(process.env.PI_CODING_AGENT_DIR || join(HOME, ".pi/agent"), "prompts"),
  opencode: () => join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "opencode/commands"),
  claude: () => join(HOME, ".claude/commands"),
};

const REQUIRED = {
  references: [
    "spec-protocol.md", "ears.md", "feature-spec.md", "bugfix-spec.md", "quick-spec.md",
    "analyze-requirements.md", "tasks-and-waves.md", "correctness.md", "steering.md", "spec-kit.md",
  ],
  templates: ["requirements.md", "design.md", "tasks.md", "bugfix.md"],
};

function usage() {
  process.stdout.write(`spec-station — спек-режим (Kiro spec mode + spec-kit) как скилл и слэш-команды

    spec-station list                          что в станции: режимы, шаблоны, команды
    spec-station install [флаги]               поставить скилл в слои и команды в клиентов
    spec-station remove  [флаги]               снять
    spec-station status  [флаги]               что стоит
    spec-station verify  [--json]              целостность станции (скилл, справочники, шаблоны, команды)

флаги:
    --layer ${Object.keys(SKILL_LAYERS).join("|")}|all       куда скилл (по умолчанию all)
                                               all = канонический слой плюс клиентские слои, у которых
                                               есть каталог клиента; клиентские ложатся зеркалом
                                               на канонический, а не на станцию
    --dir <путь>                               свой путь для скилла (вместо --layer)
    --client ${Object.keys(COMMAND_CLIENTS).join(",")}|all|none
                                               куда команды (по умолчанию all — только по живым клиентам)
    --mode link|copy                           ссылками (по умолчанию) или независимой копией
    --dry-run, --json
    --force                                  заменить существующий target с backup

примеры:
    spec-station install                        скилл во все слои, команды во все живые клиенты
    spec-station install --layer global --client none
    spec-station install --layer project --client none
    spec-station install --client omp,opencode --mode copy
    spec-station status --json
`);
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function linkTarget(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) return readlinkSync(path);
  } catch {
    return undefined;
  }
  return undefined;
}

function frontmatter(path) {
  const text = readFileSync(path, "utf8");
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const field = (key) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return { name: field("name"), description: field("description") };
}

/** Файлы станции: скилл рекурсивно, команды плоско. */
function sourceFiles(source = SOURCE) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (isDir(path)) walk(path, join(prefix, entry));
      else files.push({ from: path, rel: join(prefix, entry) });
    }
  };
  walk(source, "");
  return files;
}

function commandFiles() {
  if (!isDir(COMMANDS)) return [];
  return readdirSync(COMMANDS)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => ({ file, path: join(COMMANDS, file), description: frontmatter(join(COMMANDS, file)).description }));
}

/** Куда ставить скилл: явный слой, свой путь или все живые слои. */
function targetLayers(flags) {
  if (flags.dir) return [{ name: "dir", dir: resolve(flags.dir) }];
  if (flags.layer === "all") {
    const live = CLIENT_LAYERS.filter((name) => existsSync(LAYER_HOST[name]()));
    return ["global", ...live].map((name) => ({ name, dir: SKILL_LAYERS[name]() }));
  }
  if (!SKILL_LAYERS[flags.layer]) throw new Error(`--layer принимает ${Object.keys(SKILL_LAYERS).join(", ")}, all или задай --dir`);
  return [{ name: flags.layer, dir: SKILL_LAYERS[flags.layer]() }];
}

/** Источник ссылки для слоя: клиентский слой смотрит на канонический, остальные — на станцию. */
function layerSource(name) {
  if (!CLIENT_LAYERS.includes(name)) return SOURCE;
  const canonical = join(SKILL_LAYERS.global(), SKILL_NAME);
  return existsSync(canonical) ? canonical : SOURCE;
}

/** Клиенты для команд: явный список или все, у кого есть свой agent-каталог. */
function clients(flags) {
  if (flags.client === "none") return [];
  const all = Object.keys(COMMAND_CLIENTS);
  if (!flags.client || flags.client === "all") {
    const live = all.filter((name) => existsSync(CLIENT_HOST[name]()));
    const dead = all.filter((name) => !existsSync(CLIENT_HOST[name]()));
    return live.map((name) => ({ name, dir: COMMAND_CLIENTS[name](), skipped: false }))
      .concat(dead.map((name) => ({ name, dir: COMMAND_CLIENTS[name](), skipped: true })));
  }
  // явный список — приказ: ставим и тому клиенту, которого ещё нет (каталог создаётся)
  return flags.client.split(",").map((name) => {
    name = name.trim();
    if (!COMMAND_CLIENTS[name]) throw new Error(`--client принимает ${all.join(", ")}, all или none (дано ${name})`);
    return { name, dir: COMMAND_CLIENTS[name](), skipped: false };
  });
}

function sameContent(a, b) {
  const left = readdirSync(a, { recursive: true }).sort();
  const right = readdirSync(b, { recursive: true }).sort();
  if (left.length !== right.length || left.some((file, index) => file !== right[index])) return false;
  for (const file of left) {
    if (isDir(join(a, file))) continue;
    if (!readFileSync(join(a, file)).equals(readFileSync(join(b, file)))) return false;
  }
  return true;
}

function sameFile(a, b) {
  try {
    return statSync(a).isFile() && statSync(b).isFile() && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function cmdList(asJson) {
  const refs = isDir(join(SOURCE, "references")) ? readdirSync(join(SOURCE, "references")).sort() : [];
  const tpls = isDir(join(SOURCE, "templates")) ? readdirSync(join(SOURCE, "templates")).sort() : [];
  const commands = commandFiles();
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ skill: SKILL_NAME, source: SOURCE, layers: Object.keys(SKILL_LAYERS), references: refs, templates: tpls, commands: commands.map(({ file, description }) => ({ file, description })) }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`спек-режим: скилл ${SKILL_NAME}\nисточник: ${SOURCE}\n\nсправочники (${refs.length}):\n`);
  for (const name of refs) process.stdout.write(`  ${name}\n`);
  process.stdout.write(`\nшаблоны артефактов (${tpls.length}):\n`);
  for (const name of tpls) process.stdout.write(`  ${name}\n`);
  process.stdout.write(`\nкоманды (${commands.length}):\n`);
  for (const command of commands) process.stdout.write(`  /${basename(command.file, ".md").padEnd(14)} ${command.description}\n`);
  return 0;
}

/** Поставить скилл в один слой. Возвращает строку отчёта. */
function nextBackupPath(target) {
  let backup = `${target}.bak`;
  let index = 1;
  while (existsSync(backup)) {
    backup = `${target}.bak.${index}`;
    index += 1;
  }
  return backup;
}

function backupExisting(target) {
  const backup = nextBackupPath(target);
  renameSync(target, backup);
  return backup;
}

function installTarget(source, target, mode) {
  const temporary = `${target}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    if (mode === "copy") {
      for (const file of sourceFiles(source)) {
        const to = join(temporary, file.rel);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(file.from, to);
      }
    } else {
      try {
        symlinkSync(source, temporary, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
        cpSync(source, temporary, { recursive: true, force: true });
      }
    }
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function installIntoLayer(layer, flags) {
  const target = join(layer.dir, SKILL_NAME);
  const from = layerSource(layer.name);
  const label = `${SKILL_NAME} [${layer.name}]`.padEnd(24);

  const existing = linkTarget(target);
  if (existing && resolve(dirname(target), existing) === from) return `${label} уже стоит`;

  if (!existsSync(target) && !existing) {
    if (!flags.dryRun) place(from, target, flags);
    return `${label} → ${target}`;
  }
  if (!existing && sameContent(from, target)) return `${label} уже стоит (копия совпадает)`;
  if ((existsSync(target) || existing) && !flags.force) {
    throw new Error(`${label}: target уже существует; для замены нужен --force (backup будет создан рядом)`);
  }
  if (existsSync(target) || existing) backupExisting(target);
  if (!flags.dryRun) place(from, target, flags);
  return `${label} заменяю чужое → ${target}`;
}

function place(from, target, flags) {
  mkdirSync(dirname(target), { recursive: true });
  installTarget(from, target, flags.mode);
}

function cmdInstall(flags) {
  for (const layer of targetLayers(flags)) process.stdout.write(`${installIntoLayer(layer, flags)}\n`);

  for (const client of clients(flags)) {
    if (client.skipped) {
      process.stdout.write(`  ${client.name.padEnd(14)} клиента нет — пропускаю (${client.dir})\n`);
      continue;
    }
    for (const command of commandFiles()) {
      const to = join(client.dir, command.file);
      const existing = linkTarget(to);
      const name = basename(command.file, ".md").padEnd(14);
      if (existing && resolve(dirname(to), existing) === command.path) {
        process.stdout.write(`  /${name} ${client.name}: уже стоит\n`);
        continue;
      }
      if (!existing && sameFile(to, command.path)) {
        process.stdout.write(`  /${name} ${client.name}: уже стоит (копия совпадает)\n`);
        continue;
      }
      const replacingCopy = !existing && existsSync(to);
      process.stdout.write(`  /${name} ${client.name}: ${replacingCopy ? "обновляю копию" : existsSync(to) ? "заменяю чужое" : "ставлю"} → ${to}\n`);
      if (flags.dryRun) continue;
      if ((existsSync(to) || existing) && !flags.force) {
        throw new Error(`команда /${name} для ${client.name}: target уже существует; для замены нужен --force (backup будет создан рядом)`);
      }
      if (existsSync(to) || existing) {
        const backup = backupExisting(to);
        process.stdout.write(`  /${name} ${client.name}: backup → ${backup}\n`);
      }
      mkdirSync(client.dir, { recursive: true });
      const temporary = `${to}.tmp-${process.pid}`;
      rmSync(temporary, { force: true });
      try {
        if (flags.mode === "copy") copyFileSync(command.path, temporary);
        else {
          try {
            symlinkSync(command.path, temporary);
          } catch (error) {
            if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
            copyFileSync(command.path, temporary);
            process.stdout.write(`  /${name} ${client.name}: копия (symlink недоступен; правки в станции не дойдут) → ${to}\n`);
          }
        }
        renameSync(temporary, to);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
  }

  process.stdout.write(flags.dryRun ? "\n(dry-run: ничего не записано)\n" : "\nготово\n");
  return 0;
}

function cmdRemove(flags) {
  for (const layer of targetLayers(flags)) {
    const target = join(layer.dir, SKILL_NAME);
    const label = `${SKILL_NAME} [${layer.name}]`.padEnd(24);
    if (existsSync(target) || linkTarget(target)) {
      process.stdout.write(`${label} снимаю\n`);
      if (!flags.dryRun) rmSync(target, { recursive: true, force: true });
    } else {
      process.stdout.write(`${label} и так нет\n`);
    }
  }
  for (const client of clients(flags)) {
    if (client.skipped) continue;
    for (const command of commandFiles()) {
      const to = join(client.dir, command.file);
      if (!existsSync(to) && !linkTarget(to)) continue;
      process.stdout.write(`  /${basename(command.file, ".md").padEnd(14)} ${client.name}: снимаю\n`);
      if (!flags.dryRun) rmSync(to, { force: true });
    }
  }
  process.stdout.write(flags.dryRun ? "\n(dry-run: ничего не удалено)\n" : "\nснято\n");
  return 0;
}

function cmdStatus(flags) {
  let problems = 0;
  for (const layer of targetLayers(flags)) {
    const target = join(layer.dir, SKILL_NAME);
    const link = linkTarget(target);
    let state;
    if (link && !existsSync(target)) {
      state = `битая ссылка (${link})`;
      problems += 1;
    } else if (link) {
      const resolved = resolve(dirname(target), link);
      const hollow = !existsSync(join(target, "SKILL.md"));
      state = `ссылка → ${resolved}${hollow ? " (нет SKILL.md)" : ""}`;
      if (hollow) problems += 1;
      if (resolved !== layerSource(layer.name)) state += " (не туда)";
    } else if (isDir(target)) {
      state = `копия (${readdirSync(target, { recursive: true }).length} файлов)`;
    } else {
      state = "нет";
      problems += 1;
    }
    process.stdout.write(`скилл ${SKILL_NAME} [${layer.name}]: ${state}\n  слой: ${layer.dir}\n`);
  }

  process.stdout.write("\nкоманды:\n");
  for (const client of clients(flags)) {
    if (client.skipped) {
      process.stdout.write(`  ${client.name.padEnd(14)} клиента нет\n`);
      continue;
    }
    const commands = commandFiles();
    const states = commands.map((command) => {
      const path = join(client.dir, command.file);
      const link = linkTarget(path);
      if (link) return resolve(dirname(path), link) === command.path ? "link" : "wrong";
      if (!existsSync(path)) return "missing";
      return sameFile(path, command.path) ? "copy" : "stale";
    });
    const good = states.filter((state) => state === "link" || state === "copy").length;
    const bad = states.filter((state) => state !== "link" && state !== "copy");
    problems += bad.length;
    const labels = [];
    if (states.includes("copy")) labels.push(`копий: ${states.filter((state) => state === "copy").length}`);
    if (states.includes("stale")) labels.push(`устарели: ${commands.filter((_, index) => states[index] === "stale").map((command) => command.file).join(", ")}`);
    if (states.includes("wrong")) labels.push(`не туда: ${commands.filter((_, index) => states[index] === "wrong").map((command) => command.file).join(", ")}`);
    if (states.includes("missing")) labels.push(`нет: ${commands.filter((_, index) => states[index] === "missing").map((command) => command.file).join(", ")}`);
    process.stdout.write(`  ${client.name.padEnd(14)} ${good}/${commands.length}${labels.length ? ` (${labels.join("; ")})` : ""}\n`);
  }
  return problems === 0 ? 0 : 1;
}

function cmdVerify(asJson) {
  const problems = [];
  const skillFile = join(SOURCE, "SKILL.md");
  if (!existsSync(skillFile)) problems.push(`нет ${skillFile}`);
  else {
    const { name, description } = frontmatter(skillFile);
    if (!name) problems.push("SKILL.md: нет name в frontmatter");
    if (!description) problems.push("SKILL.md: нет description в frontmatter");
    if (name && name !== SKILL_NAME) problems.push(`SKILL.md: name=${name}, ожидалось ${SKILL_NAME}`);
  }
  for (const [kind, names] of Object.entries(REQUIRED)) {
    for (const name of names) if (!existsSync(join(SOURCE, kind, name))) problems.push(`нет ${kind}/${name}`);
  }
  const commands = commandFiles();
  if (commands.length === 0) problems.push(`нет команд в ${COMMANDS}`);
  for (const command of commands) if (!command.description) problems.push(`commands/${command.file}: нет description`);
  if (asJson) process.stdout.write(`${JSON.stringify({ problems }, null, 2)}\n`);
  else if (problems.length === 0) process.stdout.write(`станция в порядке: скилл, ${Object.values(REQUIRED).flat().length} файлов справочников и шаблонов, ${commands.length} команд\n`);
  else process.stdout.write(problems.join("\n") + "\n");
  return problems.length === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
const commands = new Set(["list", "install", "remove", "status", "verify"]);
const flags = { layer: "all", dir: null, client: "all", mode: "link", dryRun: false, force: false, json: false };
let command = "list";
let explicit = false;
const positional = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (commands.has(arg) && !explicit) {
    command = arg;
    explicit = true;
  } else if (arg === "--layer") flags.layer = argv[++i];
  else if (arg === "--dir") flags.dir = argv[++i];
  else if (arg === "--client") flags.client = argv[++i];
  else if (arg === "--mode") flags.mode = argv[++i];
  else if (arg === "--dry-run") flags.dryRun = true;
  else if (arg === "--force") flags.force = true;
  else if (arg === "--json") flags.json = true;
  else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    process.stderr.write(`spec-station: неизвестный флаг ${arg}\n`);
    process.exit(2);
  } else positional.push(arg);
}

try {
  if (!["link", "copy"].includes(flags.mode)) throw new Error("--mode принимает link или copy");
  if (positional.length) throw new Error(`лишний аргумент: ${positional[0]} (см. spec-station --help)`);
  let code = 0;
  if (command === "list") code = cmdList(flags.json);
  else if (command === "install") code = cmdInstall(flags);
  else if (command === "remove") code = cmdRemove(flags);
  else if (command === "status") code = cmdStatus(flags);
  else if (command === "verify") code = cmdVerify(flags.json);
  process.exit(code);
} catch (error) {
  process.stderr.write(`spec-station: ${error.message}\n`);
  process.exit(1);
}
