#!/usr/bin/env node
// cleanup-station — центр сноса: снимает агентов, скиллы, прошивки, расширения и MCP-регистрации.
// Нужен, чтобы поставить всё заново начисто (или освободить машину).
//
// Правила безопасности, зашитые в код:
//   1) работаем только внутри домашнего каталога (или явно указанного --home);
//   2) удаляем ровно то, что перечислено: известные имена файлов, ссылки на диск, записи в конфигах;
//   3) `clean-all` без --yes только показывает план;
//   4) данные на диске (персоны, коллекция скиллов, репозитории) не трогаются вообще.
import { existsSync, readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, rmSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DISK = resolve(ROOT, "..");
let HOME = resolve(process.env.CLEANUP_HOME || homedir());
const PLATFORM = process.env.CLEANUP_PLATFORM || process.platform;

function computePaths() {
  return {
    ompAgent: process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(HOME, ".omp/agent"),
    piAgent: process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(HOME, ".pi/agent"),
    opencodeConfig: process.env.XDG_CONFIG_HOME ? join(resolve(process.env.XDG_CONFIG_HOME), "opencode") : join(HOME, ".config/opencode"),
    skillsGlobal: join(HOME, ".agents/skills"),
    skillsProject: join(process.cwd(), ".agents/skills"),
    skillsOpencode: process.env.XDG_CONFIG_HOME
    ? join(resolve(process.env.XDG_CONFIG_HOME), "opencode/skills")
    : join(HOME, ".config/opencode/skills"),
    skillsClaude: join(HOME, ".claude/skills"),
    bin: join(HOME, ".local/bin"),
    units: join(HOME, ".config/systemd/user"),
    // рантайм центра: локальная обёртка таймеров лежит там же, где архивы бэкапа (install-units.sh)
    centerState: process.env.XDG_STATE_HOME ? join(resolve(process.env.XDG_STATE_HOME), "center") : join(HOME, ".local/state/center"),
    agentsLock: join(HOME, ".agents/.skill-lock.json"),
  };
}

let paths = computePaths();

const CLIS = {
  omp: { label: "omp (oh-my-pi)", package: "@oh-my-pi/pi-coding-agent", manager: "bun" },
  pi: { label: "pi", package: "@earendil-works/pi-coding-agent", manager: "npm", extraArgs: ["--ignore-scripts"] },
  opencode: { label: "opencode / opencode2", package: "@opencode/cli", manager: "npm" },
};

/** Наши прошивки: файл считается нашим, если его содержимое совпадает с одной из персон на диске. */
function personaTexts() {
  const dir = join(DISK, "personas");
  if (!existsSync(dir)) return new Map();
  const map = new Map();
  for (const file of readdirSync(dir)) {
    if (!/\.(txt|md)$/.test(file)) continue;
    map.set(readFileSync(join(dir, file), "utf8"), file.replace(/\.(txt|md)$/, ""));
  }
  return map;
}

/** Каталог MCP-серверов: имена оттуда — признак «наш сервер». */
const MCP_CATALOG = process.env.CLEANUP_MCP_CATALOG || join(DISK, "mcp-station/catalog");

/** Имена серверов из каталога mcp-station; null — каталога нет (тогда «наши» неизвестны). */
function catalogServers() {
  if (!existsSync(MCP_CATALOG)) return null;
  const names = new Set();
  for (const file of readdirSync(MCP_CATALOG)) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(MCP_CATALOG, file), "utf8"));
      if (entry.name) names.add(entry.name);
    } catch {
      // битая запись каталога — не повод счесть сервер нашей: пропускаем
    }
  }
  return names;
}

function usage() {
  process.stdout.write(`cleanup-station — снос и подготовка к чистой установке

  cleanup-station plan [--json]        что будет снято (ничего не трогает)
  cleanup-station clean-cli [--only omp|pi|opencode]
  cleanup-station clean-skills [--layer global|project|opencode|claude|all]
  cleanup-station clean-prompts
  cleanup-station clean-extensions
  cleanup-station clean-mcp
  cleanup-station clean-all [--yes]

Флаги:
  --dry-run     показать, что будет сделано, и ничего не менять
  --yes         подтвердить реальное выполнение clean-all
  --state       добавить состояние агентов: базы, сессии, кэши (в clean-all тоже)
  --configs     снести конфиги клиентов целиком (провайдеры, модели, MCP, прошивки) — спросит «уверены?»
  --purge       снести логины и файл ключей (потом вводить заново)
  --deep        то же, что --state + --purge
  --home <путь> работать в другом домашнем каталоге (для тестов и чужих профилей)

Домашний каталог: ${HOME}
Диск с репозиториями (не трогаем): ${DISK}

Чужое не трогается: скиллы — только ссылки на диск, MCP — только серверы из каталога mcp-station.
`);
}

function guard(target) {
  if (!target.startsWith(`${HOME}${sep}`) && target !== HOME) {
    throw new Error(`отказ: ${target} вне домашнего каталога ${HOME}`);
  }
  return target;
}

function say(dryRun, action, target) {
  process.stdout.write(`${dryRun ? "снял бы  " : "снимаю   "}${action.padEnd(22)} ${target}\n`);
}

/** Необратимые шаги (конфиги, логины) требуют --yes; в терминале спросим, иначе откажемся. */
function confirmOrRefuse(flags, what) {
  if (flags.yes) return true;
  if (process.stdin.isTTY) {
    const answer = run(["sh", "-c", `printf '%s [y/N] ' '${what}'; read ans; printf %s "$ans"`], 120_000);
    if (answer.out.trim().toLowerCase().startsWith("y")) return true;
  }
  process.stderr.write(`отказ: ${what} — это необратимо, запусти с --yes\n`);
  return false;
}

function run(argv, timeout = 600_000) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function managerCommand(manager, args) {
  const found = run(["sh", "-c", `command -v ${manager}`], 15_000);
  if (found.code !== 0) return undefined;
  return [found.out.split("\n")[0], ...args];
}

// ------------------------------------------------------------------ шаги сноса

function stepCli(only, dryRun) {
  const targets = only && only.length ? only : Object.keys(CLIS);
  let done = 0;
  for (const name of targets) {
    const spec = CLIS[name];
    if (!spec) throw new Error(`нет CLI ${name} (есть: ${Object.keys(CLIS).join(", ")})`);
    const argv = managerCommand(spec.manager, ["uninstall", "-g", spec.package, ...(spec.extraArgs ?? [])]);
    if (!argv) {
      process.stdout.write(`пропуск   ${spec.label}: нет ${spec.manager} — снимай так: ${spec.manager} uninstall -g ${spec.package}\n`);
      continue;
    }
    say(dryRun, `CLI ${name}`, `${spec.manager} uninstall -g ${spec.package}`);
    if (dryRun) continue;
    const result = run(argv);
    if (result.code === 0) done += 1;
    else process.stdout.write(`ошибка    ${spec.label}: ${result.out.split("\n").slice(-2).join(" / ")}\n`);
  }
  return done;
}

function stepSkills(layer, dryRun) {
  // проектный слой трогаем только по явной просьбе: это скиллы того проекта, где стоит человек
  const layers = layer === "all" ? ["global", "opencode", "claude"] : [layer];
  for (const name of layers) {
    const dir = name === "global" ? paths.skillsGlobal : name === "project" ? paths.skillsProject : name === "opencode" ? paths.skillsOpencode : paths.skillsClaude;
    try {
      guard(dir);
    } catch (error) {
      process.stdout.write(`отказ     ${error.message}\n`);
      continue;
    }
    if (!existsSync(dir)) {
      process.stdout.write(`пропуск   слой ${name}: каталога нет (${dir})\n`);
      continue;
    }
    const foreign = [];
    for (const entry of readdirSync(dir)) {
      const target = join(dir, entry);
      // снимаем только наше: запись, ссылкой ведущую на диск. Копию или ссылку мимо диска
      // не трогаем — по имени своё от чужого не отличить, а чужой скилл это чужая работа;
      // наши копии на место вернёт установка (skills-station install all).
      let resolved;
      try {
        const stat = lstatSync(target);
        if (!stat.isSymbolicLink()) {
          foreign.push(entry);
          continue;
        }
        const link = readlinkSync(target);
        resolved = link.startsWith("/") ? link : resolve(dir, link);
      } catch {
        continue;
      }
      if (!resolved.startsWith(DISK)) {
        foreign.push(entry);
        continue;
      }
      say(dryRun, `скилл (${name})`, target);
      if (!dryRun) rmSync(target, { recursive: true, force: true });
    }
    if (foreign.length) {
      process.stdout.write(`оставляю ${dir}: ${foreign.length} чужих (не ссылки на диск): ${foreign.join(", ")}\n`);
    }
  }
}

function stepPrompts(dryRun) {
  const ours = personaTexts();
  const files = [
    join(paths.ompAgent, "APPEND_SYSTEM.md"),
    join(paths.ompAgent, "SYSTEM.md"),
    join(paths.piAgent, "APPEND_SYSTEM.md"),
    join(paths.piAgent, "SYSTEM.md"),
    join(paths.opencodeConfig, "AGENTS.md"),
  ];
  for (const file of files) {
    guard(file);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const persona = ours.get(text);
    if (!persona) {
      process.stdout.write(`оставляю ${file}: содержимое не наша прошивка (правь сам, чтобы не потерять)\n`);
      continue;
    }
    // Рядом уже лежит .bak — значит, файл кому-то ещё нужен: чистить его вслепую нельзя.
    // Не удаляем и не затираем (и в dry-run тоже не обещаем снятие): говорим о ручном решении
    // и не считаем это ошибкой.
    if (existsSync(`${file}.bak`)) {
      process.stdout.write(`оставляю ${file}: рядом уже есть .bak, реши руками\n`);
      continue;
    }
    say(dryRun, `прошивка «${persona}»`, file);
    if (dryRun) continue;
    writeFileSync(file, "");
  }
}

function stepExtensions(dryRun) {
  const dirs = [
    join(paths.ompAgent, "extensions"),
    join(paths.piAgent, "extensions"),
    join(paths.opencodeConfig, "plugins"),
    // агенты режимов (vibe-station ставит сюда vibe-*.md ссылками): снимаем только ссылки внутрь набора
    join(paths.opencodeConfig, "agent"),
    paths.bin,
  ];
  for (const dir of dirs) {
    guard(dir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const target = join(dir, entry);
      let link;
      try {
        const stat = lstatSync(target);
        if (!stat.isSymbolicLink()) continue;
        link = readlinkSync(target);
      } catch {
        continue;
      }
      const resolved = link.startsWith("/") ? link : resolve(dir, link);
      if (!resolved.startsWith(DISK)) continue; // чужие ссылки не трогаем
      say(dryRun, "наше расширение", target);
      if (!dryRun) rmSync(target, { force: true });
    }
  }
}

/**
 * MCP: снимаем только серверы из каталога mcp-station. Чужие записи (свой сервер, чужой клиент)
 * оставляем — их ставил не набор, и в каталоге их нет. Без каталога не трогаем ничего: иначе
 * «наше» пришлось бы угадывать.
 */
function stepMcp(dryRun) {
  const catalog = catalogServers();
  if (catalog === null) {
    process.stdout.write(`отказ     MCP: каталога ${MCP_CATALOG} нет — какие серверы наши, неизвестно; не трогаю\n`);
    return;
  }
  const configs = [
    { file: join(paths.ompAgent, "mcp.json"), key: "mcpServers" },
    { file: join(paths.piAgent, "mcp.json"), key: "mcpServers" },
    { file: join(paths.opencodeConfig, "opencode.json"), key: "mcp" },
  ];
  for (const { file, key } of configs) {
    guard(file);
    if (!existsSync(file)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      process.stdout.write(`пропуск   ${file}: не разобрать как JSON\n`);
      continue;
    }
    const names = Object.keys(config[key] ?? {});
    if (names.length === 0) continue;
    const ours = names.filter((name) => catalog.has(name));
    const foreign = names.filter((name) => !catalog.has(name));
    if (ours.length === 0) {
      process.stdout.write(`оставляю ${file}: чужие записи (${foreign.join(", ")}) — наших нет\n`);
      continue;
    }
    say(dryRun, `MCP (${ours.length} наших${foreign.length ? `, чужих оставляю ${foreign.length}` : ""})`, `${file}: ${ours.join(", ")}`);
    if (dryRun) continue;
    copyFileSync(file, `${file}.bak`);
    for (const name of ours) delete config[key][name];
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
}

/** Шимы, которые писала не ссылкой, а файлом: их надо снимать по имени. */
function stepShims(dryRun) {
  for (const name of ["mcp-keypool", "mcp-keypool.cmd", "skills-manager", "skills-manager.cmd"]) {
    const target = join(paths.bin, name);
    if (!existsSync(target)) continue;
    try {
      guard(target);
    } catch (error) {
      process.stdout.write(`отказ     ${error.message}\n`);
      continue;
    }
    say(dryRun, "шим", target);
    if (!dryRun) rmSync(target, { force: true });
  }
}

/** Локи, которые оставляют пакетные установщики: без чистки они висят на пустых каталогах. */
function stepLocks(dryRun) {
  for (const file of [paths.agentsLock]) {
    if (!existsSync(file)) continue;
    try {
      guard(file);
    } catch (error) {
      process.stdout.write(`отказ     ${error.message}\n`);
      continue;
    }
    say(dryRun, "лок установщика", file);
    if (!dryRun) rmSync(file, { force: true });
  }
}

/** Юниты systemd user набора: часовая автопроверка, сторож и бэкап центра — снимаем вместе с включением. */
function stepUnits(dryRun) {
  const units = ["skills-hub-check", "center-sentinel", "center-backup"];
  const files = units.flatMap((unit) => [
    { path: join(paths.units, `${unit}.service`), action: "юнит" },
    { path: join(paths.units, `${unit}.timer`), action: "юнит", timer: `${unit}.timer` },
    { path: join(paths.units, `timers.target.wants/${unit}.timer`), action: "юнит" },
  ]);
  // локальная обёртка таймеров — копия, поставленная install-units.sh: без юнитов она мертва.
  // Цель бэкапа (backup.target) и сами архивы — данные, их не снимаем.
  files.push({ path: join(paths.centerState, "center-local.sh"), action: "обёртка" });
  let removed = 0;
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    try {
      guard(file.path);
    } catch (error) {
      process.stdout.write(`отказ     ${error.message}\n`);
      continue;
    }
    say(dryRun, file.action, file.path);
    if (!dryRun) {
      if (file.timer) run(["systemctl", "--user", "disable", file.timer], 30_000);
      rmSync(file.path, { force: true });
      removed += 1;
    }
  }
  if (!dryRun && removed > 0) run(["systemctl", "--user", "daemon-reload"], 30_000);
}

/** Состояние агентов: базы, сессии, кэши. Без этого «начисто» не получается. */
function stepState(dryRun) {
  const targets = [
    join(paths.ompAgent, "agent.db"),
    join(paths.ompAgent, "agent.db-shm"),
    join(paths.ompAgent, "agent.db-wal"),
    join(paths.ompAgent, "history.db"),
    join(paths.ompAgent, "history.db-shm"),
    join(paths.ompAgent, "history.db-wal"),
    join(paths.ompAgent, "models.db"),
    join(paths.ompAgent, "models.db-shm"),
    join(paths.ompAgent, "models.db-wal"),
    join(paths.ompAgent, "sessions"),
    join(paths.ompAgent, "cache"),
    join(paths.ompAgent, "logs"),
    join(paths.ompAgent, "terminal-sessions"),
    join(paths.piAgent, "sessions"),
    join(paths.piAgent, "cache"),
    join(paths.piAgent, "logs"),
    join(paths.piAgent, "npm"),
    join(paths.piAgent, "models-store.json"),
  ];
  for (const target of targets) {
    if (!existsSync(target)) continue;
    try {
      guard(target);
    } catch (error) {
      process.stdout.write(`отказ     ${error.message}\n`);
      continue;
    }
    say(dryRun, "состояние агента", target);
    if (!dryRun) rmSync(target, { recursive: true, force: true });
  }
}

/** Конфиги клиентов целиком: чтобы после установки не смешивалось со старыми настройками. */
function stepConfigs(flags) {
  const targets = [
    join(paths.ompAgent, "config.yml"),
    join(paths.ompAgent, "mcp.json"),
    join(paths.ompAgent, "APPEND_SYSTEM.md"),
    join(paths.ompAgent, "SYSTEM.md"),
    join(paths.piAgent, "mcp.json"),
    join(paths.piAgent, "settings.json"),
    join(paths.piAgent, "models-store.json"),
    join(paths.piAgent, "trust.json"),
    join(paths.opencodeConfig, "opencode.json"),
    join(paths.opencodeConfig, "AGENTS.md"),
  ];
  const present = targets.filter((target) => existsSync(target));
  if (present.length === 0) {
    process.stdout.write("конфигов клиентов нет — снимать нечего\n");
    return true; // это не отказ, просто нечего делать
  }
  process.stdout.write(`будут снесены конфиги клиентов целиком (${present.length} файлов):\n`);
  for (const target of present) process.stdout.write(`  ${target}\n`);
  if (!flags.dryRun && !confirmOrRefuse(flags, "снести конфиги клиентов целиком (провайдеры, модели, MCP, прошивки)")) return false;
  for (const target of present) {
    say(flags.dryRun, "конфиг клиента", target);
    if (!flags.dryRun) rmSync(target, { force: true });
  }
  return true;
}

/** Логины, настройки и секреты: только по явной просьбе — после этого надо логиниться заново. */
function stepPurge(dryRun) {
  process.stdout.write("внимание: purge сносит логины, настройки и файл ключей — потом вводить заново\n");
  const targets = [
    join(paths.piAgent, "auth.json"),
    join(paths.opencodeConfig, "secrets/env"),
  ];
  for (const target of targets) {
    if (!existsSync(target)) continue;
    try {
      guard(target);
    } catch (error) {
      process.stdout.write(`отказ     ${error.message}\n`);
      continue;
    }
    say(dryRun, "логины/секреты", target);
    if (!dryRun) rmSync(target, { force: true });
  }
}

function cmdPlan(asJson) {
  const rows = [
    { step: "cli", what: Object.values(CLIS).map((spec) => `${spec.manager} uninstall -g ${spec.package}`) },
    { step: "skills", what: [paths.skillsGlobal, paths.skillsProject, paths.skillsOpencode, paths.skillsClaude] },
    {
      step: "prompts",
      what: [
        join(paths.ompAgent, "APPEND_SYSTEM.md"),
        join(paths.piAgent, "APPEND_SYSTEM.md"),
        join(paths.opencodeConfig, "AGENTS.md"),
      ],
    },
    { step: "extensions", what: [join(paths.ompAgent, "extensions"), join(paths.piAgent, "extensions"), join(paths.opencodeConfig, "plugins"), paths.bin] },
    { step: "mcp", what: [join(paths.ompAgent, "mcp.json"), join(paths.piAgent, "mcp.json"), join(paths.opencodeConfig, "opencode.json")] },
    { step: "shims", what: [join(paths.bin, "mcp-keypool"), join(paths.bin, "skills-manager")] },
    { step: "locks", what: [paths.agentsLock] },
    {
      step: "units",
      what: [
        join(paths.units, "skills-hub-check.timer"),
        join(paths.units, "skills-hub-check.service"),
        join(paths.units, "center-sentinel.timer"),
        join(paths.units, "center-backup.timer"),
        join(paths.centerState, "center-local.sh"),
      ],
    },
    { step: "state (--state/--deep)", what: [join(paths.ompAgent, "*.db"), join(paths.ompAgent, "sessions"), join(paths.piAgent, "npm")] },
    { step: "configs (--configs/--deep)", what: [join(paths.ompAgent, "config.yml"), join(paths.ompAgent, "mcp.json"), join(paths.opencodeConfig, "opencode.json")] },
    { step: "purge (--purge/--deep)", what: [join(paths.piAgent, "auth.json"), join(paths.opencodeConfig, "secrets/env")] },
  ];
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ home: HOME, disk: DISK, steps: rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`дом: ${HOME}\nдиск (не трогаем): ${DISK}\n\n`);
    for (const row of rows) {
      process.stdout.write(`${row.step}:\n`);
      for (const item of row.what) process.stdout.write(`  ${item}\n`);
    }
    process.stdout.write(`\nчужое не снимается: скиллы — только ссылки на диск, MCP — только записи из каталога mcp-station\n`);
    process.stdout.write(`данные не снимаются: цель бэкапа (backup.target) и архивы центра в ней остаются — их решает владелец\n`);
    process.stdout.write(`полный снос: cleanup-station clean-all --yes\n`);
  }
  return 0;
}

// ------------------------------------------------------------------ разбор аргументов

const argv = process.argv.slice(2);
const commands = new Set([
  "plan", "clean-cli", "clean-skills", "clean-prompts", "clean-extensions", "clean-mcp",
  "clean-shims", "clean-locks", "clean-units", "clean-state", "clean-configs", "clean-purge", "clean-all",
]);
const flags = { dryRun: false, json: false, yes: false, only: [], layer: "all", home: null, state: false, purge: false, configs: false };
let command = "plan";

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (commands.has(arg) && i === 0) command = arg;
  else if (arg === "--dry-run") flags.dryRun = true;
  else if (arg === "--json") flags.json = true;
  else if (arg === "--yes") flags.yes = true;
  else if (arg === "--state") flags.state = true;
  else if (arg === "--purge") flags.purge = true;
  else if (arg === "--configs") flags.configs = true;
  else if (arg === "--deep") { flags.state = true; flags.configs = true; flags.purge = true; }
  else if (arg === "--only") flags.only.push(argv[++i]);
  else if (arg === "--layer") flags.layer = argv[++i];
  else if (arg === "--home") flags.home = argv[++i];
  else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    process.stderr.write(`cleanup-station: неизвестный флаг ${arg}\n`);
    process.exit(2);
  }
}

try {
  if (flags.home) {
    HOME = resolve(flags.home);
    paths = computePaths();
  }
  if (command === "clean-all" && !flags.yes) flags.dryRun = true;
  let code = 0;
  if (command === "plan") code = cmdPlan(flags.json);
  else if (command === "clean-cli") stepCli(flags.only, flags.dryRun);
  else if (command === "clean-skills") stepSkills(flags.layer, flags.dryRun);
  else if (command === "clean-prompts") stepPrompts(flags.dryRun);
  else if (command === "clean-extensions") stepExtensions(flags.dryRun);
  else if (command === "clean-mcp") stepMcp(flags.dryRun);
  else if (command === "clean-shims") stepShims(flags.dryRun);
  else if (command === "clean-locks") stepLocks(flags.dryRun);
  else if (command === "clean-units") stepUnits(flags.dryRun);
  else if (command === "clean-state") stepState(flags.dryRun);
  else if (command === "clean-configs") code = stepConfigs(flags) ? 0 : 1;
  else if (command === "clean-purge") stepPurge(flags.dryRun);
  else if (command === "clean-all") {
    if (flags.dryRun) process.stdout.write("(план: реальное выполнение — с --yes)\n\n");
    stepCli(flags.only, flags.dryRun);
    stepSkills("all", flags.dryRun);
    stepExtensions(flags.dryRun);
    stepShims(flags.dryRun);
    stepLocks(flags.dryRun);
    stepPrompts(flags.dryRun);
    stepMcp(flags.dryRun);
    stepUnits(flags.dryRun);
    if (flags.state) stepState(flags.dryRun);
    let configsRefused = false;
    if (flags.configs) configsRefused = !stepConfigs(flags);
    if (configsRefused) process.exitCode = 1;
    else if (flags.purge) stepPurge(flags.dryRun);
  }
  if (flags.dryRun && command !== "plan") process.stdout.write("\n(dry-run: ничего не снято)\n");
  process.exit(code);
} catch (error) {
  process.stderr.write(`cleanup-station: ${error.message}\n`);
  process.exit(1);
}
