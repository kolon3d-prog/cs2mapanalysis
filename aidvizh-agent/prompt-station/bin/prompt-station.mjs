#!/usr/bin/env node
// prompt-station — прошивка системных промтов (персон) в клиентов: omp, pi, opencode.
//
// Персона берётся из каталога прошивок и кладётся в то место, откуда клиент читает системный контекст:
//   omp      <agent dir>/APPEND_SYSTEM.md  (дополняет свои правила) или SYSTEM.md (заменяет)
//   pi       <agent dir>/APPEND_SYSTEM.md  или SYSTEM.md
//   opencode <config dir>/AGENTS.md        (глобальные инструкции, читаются поверх промта)
// Пути считаются от $HOME (в тестах — от PROMPT_STATION_HOME), никаких абсолютных путей в файлах нет.
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, mkdirSync, rmSync, renameSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Каталог прошивок: рядом со станцией лежит общий каталог персон. Подменяется в тестах. */
const PERSONAS_DIR = process.env.PROMPT_STATION_PERSONAS || join(ROOT, "..", "personas");
const AGENT_HOME = process.env.PROMPT_STATION_HOME || homedir();
/** Личный слой вне набора: факты о собеседнике и своё для этой машины. У каждой машины свой файл. */
const OVERLAY_PATH = process.env.PROMPT_STATION_OVERLAY || join(AGENT_HOME, ".agents/persona-overlay.md");

/** Текст оверлея: пустой файл и отсутствие — одно и то же (ничего не дописываем). */
function overlay() {
  if (!existsSync(OVERLAY_PATH)) return "";
  const text = readFileSync(OVERLAY_PATH, "utf8");
  return text.trim() ? text : "";
}

/** Что реально уедет в клиент: персона каталога, если есть — плюс личный оверлей. */
function flashedContent(persona) {
  const tail = overlay();
  if (!tail) return persona.content;
  const base = persona.content.endsWith("\n") ? persona.content : `${persona.content}\n`;
  return `${base}\n${tail}`;
}

const CLIENTS = {
  omp: {
    label: "omp",
    agentDir: () => process.env.PI_CODING_AGENT_DIR || join(AGENT_HOME, ".omp/agent"),
    targets: { append: "APPEND_SYSTEM.md", system: "SYSTEM.md" },
  },
  pi: {
    label: "pi",
    agentDir: () => process.env.PI_CODING_AGENT_DIR || join(AGENT_HOME, ".pi/agent"),
    targets: { append: "APPEND_SYSTEM.md", system: "SYSTEM.md" },
  },
  opencode: {
    label: "opencode",
    configDir: () =>
      process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "opencode") : join(AGENT_HOME, ".config/opencode"),
    // у opencode нет «заменить системный промт» файлом: инструкции добавляются поверх
    targets: { append: "AGENTS.md" },
  },
};

const ALL_CLIENTS = Object.keys(CLIENTS);

/**
 * Расширения «на ходу»: persona.ts (эта станция) и sysprompt.ts (соседняя станция sysprompt).
 * Оба инжектят текст в системный канал одной обёрткой <system-reminder> и друг о друге не знают,
 * поэтому `status` печатает их рядом и предупреждает о конфликте — приоритета между ними нет.
 */
const EXTENSIONS = {
  persona: { omp: "extensions/persona.ts", pi: "extensions/persona.ts", opencode: "plugins/persona.ts" },
  sysprompt: { omp: "extensions/sysprompt.ts", pi: "extensions/sysprompt.ts", opencode: "plugins/sysprompt.ts" },
};

function extensionPath(client, relative) {
  const spec = CLIENTS[client];
  return join(spec.agentDir ? spec.agentDir() : spec.configDir(), relative);
}

function sameFile(left, right) {
  try {
    return lstatSync(left).isFile() && readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

function extensionSource(name, client) {
  if (name === "persona") {
    return client === "opencode" ? join(ROOT, "opencode/dev/plugin/persona.ts") : join(ROOT, "shared/persona.ts");
  }
  const relative = client === "opencode" ? "opencode/dev/plugin/sysprompt.ts" : `${client}/dev/extension/sysprompt.ts`;
  return join(ROOT, "..", "sysprompt", relative);
}

function extensionState(name, client, targets) {
  const path = extensionPath(client, targets[client]);
  if (!existsSync(path)) return "нет";
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    try {
      return resolve(dirname(path), readlinkSync(path)) === extensionSource(name, client) ? "есть" : "не туда";
    } catch {
      return "битая";
    }
  }
  return sameFile(path, extensionSource(name, client)) ? "копия" : "устарела";
}

/** Строка состояния расширений: «расширения persona: omp=есть pi=копия opencode=нет». */
function extensionRow(name, targets) {
  const marks = ALL_CLIENTS.map((client) => `${client}=${extensionState(name, client, targets)}`);
  return `расширения ${name}: ${marks.join(" ")}`;
}

/** Одна честная строка про конфликт: она верна всегда, а не только когда стоят оба. */
const EXTENSION_CONFLICT =
  "конфликт   persona и sysprompt пишут в системную роль одной обёрткой <system-reminder>: стоят оба — в систему уйдут оба текста, порядок применения — порядок чтения каталога, приоритета между ними нет";

function usage() {
  process.stdout.write(`prompt-station — прошивка системных промтов в клиентов

  prompt-station list                       что есть в каталоге прошивок
  prompt-station show <имя>                 показать текст прошивки целиком
  prompt-station status [--client ...]      что прошито сейчас: имя/хеш и какие расширения стоят
  prompt-station flash <имя> [флаги]        прошить
  prompt-station revert [--client ...]      снять прошивку (вернуть .bak, если был)
  prompt-station verify <имя> [--client ...] проверить, что прошито именно это
  prompt-station install-ext [--client ...] поставить расширение «смена персоны на ходу»

Флаги:
  --client omp,pi,opencode|all   куда прошивать (по умолчанию все)
  --target append|system         какой файл клиента занять (по умолчанию append)
  --dry-run                      показать, что будет записано, и ничего не писать
  --force                        заменить существующее расширение с backup

Каталог прошивок: ${PERSONAS_DIR}
Личный оверлей (вне набора): ${OVERLAY_PATH} — дописывается к персне при flash
`);
}

function personas() {
  if (!existsSync(PERSONAS_DIR)) return [];
  return readdirSync(PERSONAS_DIR)
    .filter((file) => [".txt", ".md"].includes(extname(file)))
    .sort()
    .map((file) => {
      const path = join(PERSONAS_DIR, file);
      const content = readFileSync(path, "utf8");
      return { name: basename(file, extname(file)), path, content, size: content.length };
    });
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function targetPath(client, target) {
  const spec = CLIENTS[client];
  const file = spec.targets[target];
  if (!file) throw new Error(`${client} не умеет target=${target} (есть: ${Object.keys(spec.targets).join(", ")})`);
  const dir = spec.agentDir ? spec.agentDir() : spec.configDir();
  return join(dir, file);
}

function parseClients(value) {
  if (!value || value === "all") return ALL_CLIENTS;
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!CLIENTS[name]) throw new Error(`неизвестный клиент ${name} (есть: ${ALL_CLIENTS.join(", ")}, all)`);
  }
  return names;
}

function pickPersona(name) {
  const found = personas().find((persona) => persona.name === name);
  if (!found) throw new Error(`нет прошивки ${name} (см. prompt-station list)`);
  return found;
}

// ---------------------------------------------------------------- команды

function cmdList() {
  const rows = personas();
  if (rows.length === 0) {
    process.stdout.write(`каталог прошивок пуст: ${PERSONAS_DIR}\n`);
    return 0;
  }
  for (const persona of rows) {
    const first = persona.content.split("\n").find((line) => line.trim()) ?? "";
    process.stdout.write(`${persona.name.padEnd(16)} ${String(persona.size).padStart(6)} симв.  ${sha(persona.content)}  ${first.slice(0, 60)}\n`);
  }
  return 0;
}

function cmdStatus(clients, target) {
  const options = personas().map((persona) => ({ name: persona.name, effective: flashedContent(persona) }));
  const hasOverlay = Boolean(overlay());
  let ok = 0;
  let total = 0;
  for (const client of clients) {
    const path = targetPath(client, target);
    total += 1;
    if (!existsSync(path)) {
      process.stdout.write(`${CLIENTS[client].label.padEnd(10)} пусто    ${path}\n`);
      continue;
    }
    const content = readFileSync(path, "utf8");
    const match = options.find((persona) => persona.effective === content);
    ok += 1;
    const label = match ? `прошито: ${match.name}${hasOverlay ? " (+оверлей)" : ""}` : "прошито: своё (не из каталога)";
    process.stdout.write(`${CLIENTS[client].label.padEnd(10)} ${label.padEnd(32)} ${sha(content)}  ${path}\n`);
  }
  process.stdout.write(`${extensionRow("persona", EXTENSIONS.persona)}\n`);
  process.stdout.write(`${extensionRow("sysprompt", EXTENSIONS.sysprompt)}\n`);
  process.stdout.write(`${EXTENSION_CONFLICT}\n`);
  return ok === total ? 0 : 1;
}

function nextBackupPath(path) {
  let backup = `${path}.bak`;
  let index = 1;
  while (existsSync(backup)) {
    backup = `${path}.bak.${index}`;
    index += 1;
  }
  return backup;
}

function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o644 });
  renameSync(temporary, path);
}

function cmdFlash(name, clients, target, dryRun) {
  const persona = pickPersona(name);
  const content = flashedContent(persona);
  let changed = 0;
  for (const client of clients) {
    const path = targetPath(client, target);
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current === content) {
      process.stdout.write(`${CLIENTS[client].label.padEnd(10)} уже прошито (${persona.name})\n`);
      continue;
    }
    process.stdout.write(
      `${CLIENTS[client].label.padEnd(10)} ${current ? "заменяю" : "пишу"} ${path}${current ? " (копия .bak)" : ""}\n`,
    );
    if (dryRun) continue;
    mkdirSync(dirname(path), { recursive: true });
    if (current) copyFileSync(path, nextBackupPath(path));
    atomicWrite(path, content);
    changed += 1;
  }
  if (dryRun) process.stdout.write("(dry-run: ничего не записано)\n");
  else process.stdout.write(`прошивка ${persona.name}: файлов обновлено ${changed}\n`);
  return 0;
}

function cmdRevert(clients, target, dryRun) {
  for (const client of clients) {
    const path = targetPath(client, target);
    const backup = `${path}.bak`;
    if (!existsSync(path)) {
      process.stdout.write(`${CLIENTS[client].label.padEnd(10)} нечего снимать (${path})\n`);
      continue;
    }
    if (existsSync(backup)) {
      process.stdout.write(`${CLIENTS[client].label.padEnd(10)} возвращаю из .bak: ${path}\n`);
      if (!dryRun) {
        copyFileSync(backup, path);
        rmSync(backup);
      }
    } else {
      process.stdout.write(`${CLIENTS[client].label.padEnd(10)} удаляю (бэкапа не было): ${path}\n`);
      if (!dryRun) rmSync(path);
    }
  }
  if (dryRun) process.stdout.write("(dry-run: ничего не записано)\n");
  return 0;
}

function placeExtension(source, link, force) {
  const sourcePath = resolve(source);
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    try {
      if (resolve(dirname(link), readlinkSync(link)) === sourcePath) return "link";
    } catch {
      /* битая ссылка — пересоздадим */
    }
  } else if (stat && sameFile(link, sourcePath)) {
    return "copy-exists";
  }
  if (stat && !force) {
    throw new Error(`расширение уже существует: ${link}; для замены нужен --force (backup будет создан рядом)`);
  }
  if (stat) {
    const backup = nextBackupPath(link);
    renameSync(link, backup);
    process.stdout.write(`  backup → ${backup}\n`);
  }
  const temporary = `${link}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  try {
    symlinkSync(sourcePath, temporary, "file");
    renameSync(temporary, link);
    return "link";
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    copyFileSync(sourcePath, temporary);
    renameSync(temporary, link);
    return "copy";
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Расширение «смена персоны на ходу»: кладём симлинки в каталоги расширений клиентов. */
function cmdInstallExt(clients, dryRun, force) {
  // у omp и pi общий ExtensionAPI — файл один, но лежит в каталоге каждого клиента
  const files = {
    // файл один на оба клиента: он самодостаточный, относительных импортов нет — симлинк работает
    omp: [["shared/persona.ts", (dir) => join(dir, "extensions/persona.ts")]],
    pi: [["shared/persona.ts", (dir) => join(dir, "extensions/persona.ts")]],
    opencode: [
      ["opencode/dev/plugin/persona.ts", (dir) => join(dir, "plugins/persona.ts")],
      ["opencode/dev/command/persona.md", (dir) => join(dir, "commands/persona.md")],
    ],
  };
  for (const client of clients) {
    const spec = CLIENTS[client];
    const base = spec.agentDir ? spec.agentDir() : spec.configDir();
    for (const [source, target] of files[client] ?? []) {
      const link = target(base);
      const same = client === "omp" || client === "pi" ? " (общий файл для omp и pi)" : "";
      if (dryRun) {
        process.stdout.write(`${client.padEnd(10)} ${link}${same}\n`);
        continue;
      }
      mkdirSync(dirname(link), { recursive: true });
      const mode = placeExtension(join(ROOT, source), link, force);
      if (mode === "copy") {
        process.stdout.write(`${client.padEnd(10)} копия (symlink недоступен; правки в станции не дойдут) → ${link}\n`);
      } else if (mode === "copy-exists") {
        process.stdout.write(`${client.padEnd(10)} уже стоит (копия совпадает) → ${link}\n`);
      } else {
        process.stdout.write(`${client.padEnd(10)} ${link}${same}\n`);
      }
    }
  }

  process.stdout.write(dryRun ? "(dry-run: ничего не записано)\n" : "расширение поставлено\n");
  return 0;
}

function cmdShow(name) {
  const persona = pickPersona(name);
  const content = flashedContent(persona);
  process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
  return 0;
}

function cmdVerify(name, clients, target) {
  const persona = pickPersona(name);
  const expected = flashedContent(persona);
  let bad = 0;
  for (const client of clients) {
    const path = targetPath(client, target);
    const content = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (content === expected) {
      process.stdout.write(`${CLIENTS[client].label.padEnd(10)} ok      ${sha(content)}  ${path}\n`);
    } else {
      bad += 1;
      process.stdout.write(`${CLIENTS[client].label.padEnd(10)} не то   ${content === null ? "файла нет" : `хеш ${sha(content)}`}  ${path}\n`);
    }
  }
  return bad === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- разбор

const argv = process.argv.slice(2);
const commands = new Set(["list", "show", "status", "flash", "revert", "verify", "install-ext"]);
const flags = { client: "all", target: "append", dryRun: false, force: false };
let command = "status";
const positional = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (commands.has(arg) && i === 0) command = arg;
  else if (arg === "--client") flags.client = argv[++i];
  else if (arg === "--target") flags.target = argv[++i];
  else if (arg === "--dry-run") flags.dryRun = true;
  else if (arg === "--force") flags.force = true;
  else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    process.stderr.write(`prompt-station: неизвестный флаг ${arg}\n`);
    process.exit(2);
  } else positional.push(arg);
}

try {
  const clients = parseClients(flags.client);
  if (!["append", "system"].includes(flags.target)) throw new Error("--target принимает append или system");
  let code = 0;
  if (command === "list") code = cmdList();
  else if (command === "install-ext") code = cmdInstallExt(clients, flags.dryRun, flags.force);
  else if (command === "show") {
    if (!positional[0]) throw new Error("нужно имя прошивки: prompt-station show duck");
    code = cmdShow(positional[0]);
  }
  else if (command === "status") code = cmdStatus(clients, flags.target);
  else if (command === "flash") {
    if (!positional[0]) throw new Error("нужно имя прошивки: prompt-station flash duck");
    code = cmdFlash(positional[0], clients, flags.target, flags.dryRun);
  } else if (command === "revert") code = cmdRevert(clients, flags.target, flags.dryRun);
  else if (command === "verify") {
    if (!positional[0]) throw new Error("нужно имя прошивки: prompt-station verify duck");
    code = cmdVerify(positional[0], clients, flags.target);
  }
  process.exit(code);
} catch (error) {
  process.stderr.write(`prompt-station: ${error.message}\n`);
  process.exit(1);
}
