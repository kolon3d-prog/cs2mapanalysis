#!/usr/bin/env node
// memory-station: центр памяти агента (basic-memory) — установка, состояние, записи, проверки.
// Корень станции вычисляется от самого файла: абсолютных путей здесь нет.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, rmSync, lstatSync, statSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGGG = resolve(ROOT, "..");
const HOME = process.env.MEMORY_STATION_HOME || homedir();
const NOTES = process.env.BASIC_MEMORY_HOME || join(HOME, "basic-memory");
const CONF = process.env.BASIC_MEMORY_CONFIG_DIR || join(HOME, ".basic-memory");
const MCP_DIR = process.env.MCP_STATION_DIR || join(AGGG, "mcp-station");
const SKILL_LINK = join(HOME, ".agents", "skills", "memory");
const OPENCODE_LINK = join(HOME, ".config", "opencode", "skills", "memory");
const SKILL_SRC = join(ROOT, "skills", "memory");
const FOLDERS = ["code", "life", "projects"];
const PROJECT = "memory";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const rest = args.filter((a) => !a.startsWith("--"));
const command = rest[0] ?? "status";
const DRY = flags.has("--dry-run");
const BOOTSTRAP_UV = flags.has("--bootstrap-uv");

/**
 * Домашний склад бинарей: astral-установщик кладёт uv в ~/.local/bin, uv — basic-memory туда же,
 * а PATH свежей оболочки про каталог может ещё не знать. Дописываем в PATH процесса, чтобы установка
 * не спотыкалась о то, что появится в новой оболочке.
 */
function withHomeStore() {
  const sep = process.platform === "win32" ? ";" : ":";
  const dir = join(HOME, ".local", "bin");
  const path = String(process.env.PATH ?? "");
  if (!path.split(sep).includes(dir)) process.env.PATH = `${dir}${sep}${path}`;
}
withHomeStore();

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
// вывод часто читают через | head — не падаем трейсбеком на закрытом потоке
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

function bm(bmArgs, { quiet = false } = {}) {
  const res = spawnSync("basic-memory", bmArgs, { encoding: "utf8", env: { ...process.env, BASIC_MEMORY_HOME: NOTES, BASIC_MEMORY_CONFIG_DIR: CONF } });
  if (res.error || res.status !== 0) {
    if (!quiet) err((res.stderr || res.error?.message || "").trim());
    return { ok: false, stdout: res.stdout ?? "" };
  }
  return { ok: true, stdout: res.stdout ?? "" };
}

/**
 * Есть ли команда в PATH. Ищем сами, без `command -v` через bash: на Windows bash в PATH — часто
 * заглушка WSL, она отвечает инструкцией и выходит с нулём, то есть «есть» становится ложью.
 * Разделитель PATH — по виду строки: в Git Bash та же переменная приходит через «:».
 */
function hasBinary(name) {
  const path = String(process.env.PATH ?? "");
  const sep = path.includes(";") || /^[A-Za-z]:[\\/]/.test(path) ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ...String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (statSync(join(dir, name + ext)).isFile()) return true;
      } catch {
        /* нет файла — следующий кандидат */
      }
    }
  }
  return false;
}

function noteCount(dir = NOTES) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    n += entry.isDirectory() ? noteCount(join(dir, entry.name)) : entry.name.endsWith(".md") ? 1 : 0;
  }
  return n;
}

function clientsWithMemory() {
  const checks = [
    ["omp", join(HOME, ".omp", "agent", "mcp.json"), ".mcpServers"],
    ["pi", join(HOME, ".pi", "agent", "mcp.json"), ".mcpServers"],
    ["opencode", join(HOME, ".config", "opencode", "opencode.json"), ".mcp"],
  ];
  const found = [];
  for (const [name, path, key] of checks) {
    if (!existsSync(path)) continue;
    // читаем конфиг сами: jq под рукой не всегда, а bash на Windows — заглушка WSL
    let registered = false;
    try {
      const config = JSON.parse(readFileSync(path, "utf8"));
      registered = Boolean(config?.[key.replace(/^\./, "")]?.["basic-memory"]);
    } catch {
      registered = false;
    }
    found.push([name, registered]);
  }
  return found;
}

function link(target, source) {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isSymbolicLink()) {
      const current = readlinkSync(target);
      if (resolve(dirname(target), current) === resolve(source)) return "уже стоит";
      rmSync(target);
    } else {
      return "пропуск: не ссылка, не трогаю";
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  const rel = resolve(source);
  const linkTarget = rel.startsWith(dirname(target) + "/") ? rel.slice(dirname(target).length + 1) : rel;
  try {
    // На Windows каталог без Developer Mode можно связать junction-ом; если и это запрещено,
    // откатываемся в копию, чтобы установка памяти не обрывалась на первом шаге.
    symlinkSync(linkTarget, target, process.platform === "win32" ? "junction" : undefined);
    return "поставлено";
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    cpSync(rel, target, { recursive: true, force: true });
    return "копия (junction/symlink недоступен; после обновления источника удалите этот каталог и повторите install)";
  }
}

/**
 * Чем позвать установщик mcp-station: на Windows у него своя .ps1-обёртка (у каждого .sh есть сосед),
 * иначе — .sh. Шелл в конфиге Windows нет, а `bash` из PATH там часто заглушка WSL.
 */
function stationInstallArgv(args) {
  const unix = join(MCP_DIR, "bin", "mcp-station.sh");
  const win = unix.replace(/\.sh$/, ".ps1");
  const file = process.platform === "win32" && existsSync(win) ? win : unix;
  if (!existsSync(file)) {
    err(`не нашёл станцию MCP (${file}) — память не подключится к клиентам`);
    return undefined;
  }
  if (file.endsWith(".ps1")) {
    const pwsh = hasBinary("pwsh") ? "pwsh" : "powershell.exe";
    const flags = pwsh === "pwsh" ? [] : ["-ExecutionPolicy", "Bypass"];
    return [pwsh, "-NoProfile", ...flags, "-File", file, ...args];
  }
  return ["bash", file, ...args];
}

function projectsList() {
  const res = bm(["tool", "list-projects"], { quiet: true });
  if (!res.ok) return [];
  try {
    return JSON.parse(res.stdout).projects ?? [];
  } catch {
    return [];
  }
}

// Свежий конфиг объявляет проект «main» в config.json, но в базе его нет:
// project add main отказывается («уже существует»), а записи падают с «no projects are set up».
// Лечится регистрацией проекта с любым другим именем и назначением его по умолчанию.
function ensureProject() {
  if (projectsList().length > 0) return "проект уже есть";
  const added = bm(["project", "add", PROJECT, NOTES], { quiet: true });
  if (!added.ok && !/already exists/i.test(added.stdout)) return "не смог завести проект";
  bm(["project", "default", PROJECT], { quiet: true });
  return `завёл проект ${PROJECT}`;
}

function stepStatus() {
  out(`== данные`);
  out(`  заметки: ${NOTES}`);
  out(`  индекс:  ${CONF}`);
  out(`  заметок: ${noteCount()}`);
  const projects = projectsList();
  out(`  проект: ${projects.length ? projects.map((p) => p.name).join(", ") : "не заведён (install)"}`);
  const status = bm(["status"], { quiet: true });
  if (status.ok) {
    const lines = status.stdout.split("\n").filter((l) => l.includes("│") && !l.includes("╭") && !l.includes("╰"));
    for (const line of lines.slice(0, 6)) out(`  ${line.replace(/[│╭╰]/g, " ").trim()}`);
  } else {
    out("  basic-memory не отвечает — запусти install");
  }
  out(`== клиенты`);
  for (const [name, ok] of clientsWithMemory()) out(`  ${name}: ${ok ? "память подключена" : "нет basic-memory в конфиге"}`);
}

function stepCheck() {
  const problems = [];
  if (!hasBinary("basic-memory")) problems.push("нет команды basic-memory (install)");
  if (!existsSync(join(MCP_DIR, "catalog", "basic-memory.json"))) problems.push(`нет записи в каталоге MCP (${MCP_DIR}/catalog/basic-memory.json)`);
  if (!existsSync(SKILL_SRC)) problems.push(`нет скилла-руководства (${SKILL_SRC})`);
  if (hasBinary("basic-memory") && projectsList().length === 0) problems.push("память не инициализирована (нет проекта) — запусти install");
  const clients = clientsWithMemory();
  if (clients.length === 0) problems.push("не нашёл ни одного конфига клиента");
  for (const [name, ok] of clients) if (!ok) problems.push(`в конфиге ${name} нет basic-memory`);
  out(`заметки: ${notesExists() ? "есть" : "нет каталога"}, заметок ${noteCount()}, память в клиентах: ${clients.filter(([, ok]) => ok).map(([n]) => n).join(", ") || "нет"}`);
  if (problems.length) {
    for (const p of problems) err(`проблема: ${p}`);
    process.exit(1);
  }
  out("проверка пройдена");
}

function notesExists() {
  return existsSync(NOTES);
}

/**
 * uv нужен памяти: basic-memory ставится как uv-инструмент, а на чистой машине uv нет.
 * --bootstrap-uv разрешает поставить его официальным скриптом astral.sh — тот же приём,
 * что у camoufox-research: молча ничего не тянем, только по явному флагу.
 */
function ensureUv() {
  if (hasBinary("uv")) return true;
  if (!BOOTSTRAP_UV) {
    err("нет uv — поставь его (curl -fsSL https://astral.sh/uv/install.sh | sh) или повтори с --bootstrap-uv");
    return false;
  }
  out("== ставлю uv (astral.sh)");
  const [file, argv] = process.platform === "win32"
    ? ["pwsh", ["-NoProfile", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"]]
    : ["sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]];
  const res = spawnSync(file, argv, { stdio: "inherit" });
  withHomeStore();
  if (res.status !== 0 || !hasBinary("uv")) {
    err("uv не встал — поставь руками и повтори");
    return false;
  }
  return true;
}

function stepInstall() {
  if (!hasBinary("basic-memory")) {
    if (!ensureUv()) process.exit(1);
    out("== ставлю basic-memory (uv tool)");
    const res = spawnSync("uv", ["tool", "install", "basic-memory", "--prerelease=allow"], { stdio: "inherit" });
    if (res.status !== 0) {
      err("не удалось поставить basic-memory");
      process.exit(1);
    }
    withHomeStore();
  } else {
    out("== basic-memory уже стоит");
  }

  out("== раскладываю структуру заметок");
  mkdirSync(NOTES, { recursive: true });
  for (const folder of FOLDERS) {
    const path = join(NOTES, folder);
    if (existsSync(path)) {
      out(`  ${folder}/ уже есть`);
      continue;
    }
    if (DRY) {
      out(`  создал бы ${folder}/`);
      continue;
    }
    mkdirSync(path, { recursive: true });
    out(`  создал ${folder}/`);
  }

  out(`== ссылка на скилл-руководство`);
  for (const link_path of [SKILL_LINK, OPENCODE_LINK]) {
    if (link_path === OPENCODE_LINK && !existsSync(join(HOME, ".config", "opencode"))) continue;
    const result = DRY ? "поставил бы" : link(link_path, link_path === SKILL_LINK ? SKILL_SRC : SKILL_LINK);
    out(`  ${link_path}: ${result}`);
  }

  out("== проект памяти");
  out(`  ${DRY ? "завёл бы проект " + PROJECT : ensureProject()}`);

  out("== MCP-сервер в клиентах");
  const stationArgv = stationInstallArgv(["install", "basic-memory", ...(DRY ? ["--dry-run"] : [])]);
  const res = stationArgv ? spawnSync(stationArgv[0], stationArgv.slice(1), { stdio: "inherit" }) : { status: 1 };
  if (res.status !== 0) process.exit(res.status ?? 1);
  out("готово: перезапусти клиенты, в сессии появится инструмент write_note / search_notes");
}

function stepNote(text, folder, title) {
  if (!text) {
    err("нужен текст: memory-station note \"...\" [--folder code|life|projects] [--title \"...\"]");
    process.exit(2);
  }
  const dir = folder ?? "code";
  const name = title ?? text.split("\n")[0].slice(0, 60);
  let res = bm(["tool", "write-note", "--title", name, "--folder", dir, "--content", text]);
  if (!res.ok && ensureProject().startsWith("завёл")) {
    res = bm(["tool", "write-note", "--title", name, "--folder", dir, "--content", text]);
  }
  if (!res.ok) {
    err("не записалось: проверь, что basic-memory установлен и запущен install");
    process.exit(1);
  }
  out(`записано: ${dir}/${name}`);
}

function stepSearch(query) {
  if (!query) {
    err("нужен запрос: memory-station search \"...\"");
    process.exit(2);
  }
  let res = bm(["tool", "search-notes", query]);
  if (!res.ok && ensureProject().startsWith("завёл")) {
    res = bm(["tool", "search-notes", query]);
  }
  if (!res.ok) {
    err("поиск не сработал: проверь install");
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    process.stdout.write(res.stdout);
    return;
  }
  const results = data.results ?? [];
  if (results.length === 0) {
    out("ничего не нашлось");
    return;
  }
  for (const r of results.slice(0, 10)) {
    const head = (r.matched_chunk ?? r.content ?? "").replace(/\s+/g, " ").slice(0, 110);
    out(`• ${r.title} [${r.file_path}]\n  ${head}`);
  }
}

function stepDoctor() {
  out("== basic-memory doctor");
  const res = bm(["doctor"], { quiet: true });
  if (res.ok) out(res.stdout.trim().split("\n").slice(0, 12).join("\n"));
  else out("doctor не прошёл (возможно, индекс ещё пуст)");
  out("");
  stepCheck();
}

switch (command) {
  case "install":
    stepInstall();
    break;
  case "status":
    stepStatus();
    break;
  case "check":
  case "verify":
    stepCheck();
    break;
  case "doctor":
    stepDoctor();
    break;
  case "note":
    stepNote(rest[1], (args.find((a) => a.startsWith("--folder=")) ?? "").split("=")[1], (args.find((a) => a.startsWith("--title=")) ?? "").split("=")[1]);
    break;
  case "search":
    stepSearch(rest.slice(1).join(" "));
    break;
  default:
    err(`memory-station: не знаю команду «${command}»`);
    err("команды: install | status | check | doctor | note <текст> | search <запрос>");
    process.exit(2);
}
