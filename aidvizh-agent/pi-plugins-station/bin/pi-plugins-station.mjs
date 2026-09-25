#!/usr/bin/env node
// pi-plugins-station — ставит сторонние плагины pi из своего каталога.
//
// Состояние держит сам pi: список источников — в settings.json его агент-каталога, файлы — в
// npm/node_modules рядом. Станция ничего не дублирует: она читает это состояние, а установку,
// обновление и снятие отдаёт `pi install|update|remove`. Пути считаются от $HOME — абсолютных
// путей диска в станции нет.
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG = process.env.PI_PLUGINS_STATION_CATALOG || join(ROOT, "catalog.json");
const HOME = process.env.PI_PLUGINS_STATION_HOME || homedir();
const AGENT_DIR =
  process.env.PI_PLUGINS_STATION_AGENT ||
  process.env.PI_AGENT_DIR ||
  process.env.PI_CODING_AGENT_DIR ||
  join(HOME, ".pi/agent");
const SETTINGS = join(AGENT_DIR, "settings.json");
const MODULES = join(AGENT_DIR, "npm/node_modules");
const PI = process.env.PI_PLUGINS_STATION_PI || "pi";
/** Сколько ждём ответ npm по одному пакету, мс. Перебивается ради тестов. */
const NPM_TIMEOUT_MS = Number(process.env.PI_PLUGINS_STATION_NPM_TIMEOUT) || 20000;

function usage() {
  process.stdout.write(`pi-plugins-station — сторонние плагины pi из каталога станции

    pi-plugins-station list                        каталог: что есть и что из этого стоит
    pi-plugins-station status [--json]             стоит / объявлен без файлов / нет; лишнее в settings
    pi-plugins-station install [имена…|all] [--dry-run] [--json]   поставить отсутствующие
    pi-plugins-station update  [имена…|all] [--dry-run]            обновить стоящие
    pi-plugins-station remove  [имена…|all] [--dry-run]            снять
    pi-plugins-station outdated [--json]           сверить стоящие версии с последними в npm
    pi-plugins-station verify [--json]             целостность каталога и состояния pi

флаги: --dry-run, --json
агент-каталог pi: ${AGENT_DIR}
`);
}

function catalog() {
  const rows = JSON.parse(readFileSync(CATALOG, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${CATALOG}: ожидался массив записей`);
  return rows;
}

/** Имена пакетов, объявленные в settings.json pi. */
function declared() {
  if (!existsSync(SETTINGS)) return [];
  let doc;
  try {
    doc = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    throw new Error(`${SETTINGS} не разбирается как JSON`);
  }
  const packages = doc && typeof doc === "object" ? doc.packages : undefined;
  return Array.isArray(packages) ? packages.filter((item) => typeof item === "string") : [];
}

/** Пакет из источника `npm:<имя>`; null для git/путей — их версию так не узнать. */
function npmName(source) {
  return source.startsWith("npm:") ? source.slice(4) : null;
}

/** Стоящая версия пакета или null, если файлов нет. */
function installedVersion(source) {
  const name = npmName(source);
  if (!name) return existsSync(join(MODULES, source)) ? "?" : null;
  const manifest = join(MODULES, name, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    return typeof version === "string" ? version : "?";
  } catch {
    return "?";
  }
}

/** Одна строка состояния: стоит / объявлен без файлов / нет. */
function stateOf(entry, packages) {
  const version = installedVersion(entry.source);
  const isDeclared = packages.includes(entry.source);
  if (version && isDeclared) return { kind: "стоит", version, isDeclared };
  if (isDeclared) return { kind: "объявлен, файлов нет", version: null, isDeclared };
  if (version) return { kind: "файлы есть, в settings нет", version, isDeclared };
  return { kind: "нет", version: null, isDeclared };
}

function select(names) {
  const all = catalog();
  if (names.length === 0 || names[0] === "all") return all;
  return names.map((name) => {
    const found = all.find((entry) => entry.name === name);
    if (!found) throw new Error(`в каталоге нет ${name} (см. pi-plugins-station list)`);
    return found;
  });
}

/** Позвать pi. Возвращает код возврата; вывод уходит в наш stdout/stderr как есть. */
function callPi(args, dryRun) {
  if (dryRun) {
    process.stdout.write(`  pi ${args.join(" ")}   (dry-run)\n`);
    return 0;
  }
  const result = spawnSync(PI, args, { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`pi-plugins-station: не позвать ${PI}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function cmdList(asJson) {
  const packages = declared();
  const rows = catalog().map((entry) => ({ ...entry, ...stateOf(entry, packages) }));
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`каталог: ${rows.length} плагинов (${CATALOG})\n\n`);
  for (const row of rows) {
    const mark = row.kind === "стоит" ? `стоит ${row.version}` : row.kind;
    process.stdout.write(`${row.name.padEnd(36)} ${mark.padEnd(22)} ${row.what}\n`);
  }
  return 0;
}

function cmdStatus(asJson) {
  const packages = declared();
  const rows = catalog().map((entry) => ({ ...entry, ...stateOf(entry, packages) }));
  const extra = packages.filter((source) => !rows.some((row) => row.source === source));
  const missing = rows.filter((row) => row.kind !== "стоит");
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ plugins: rows, extra, missing: missing.length }, null, 2)}\n`);
    return missing.length === 0 ? 0 : 1;
  }
  process.stdout.write(`агент-каталог pi: ${AGENT_DIR}${isDir(AGENT_DIR) ? "" : " (нет)"}\n\n`);
  for (const row of rows) {
    const version = row.version ? ` ${row.version}` : "";
    process.stdout.write(`${row.name.padEnd(36)} ${row.kind}${version}\n`);
  }
  if (extra.length) {
    process.stdout.write(`\nстоит, но не из каталога станции (${extra.length}): ${extra.join(", ")}\n`);
  }
  process.stdout.write(`\nиз каталога не стоит: ${missing.length} из ${rows.length}\n`);
  return missing.length === 0 ? 0 : 1;
}

function cmdInstall(names, flags) {
  const packages = declared();
  let failed = 0;
  for (const entry of select(names)) {
    const state = stateOf(entry, packages);
    if (state.kind === "стоит") {
      process.stdout.write(`${entry.name.padEnd(36)} уже стоит ${state.version}\n`);
      continue;
    }
    process.stdout.write(`${entry.name.padEnd(36)} ставлю (${entry.source})\n`);
    failed += callPi(["install", entry.source], flags.dryRun) === 0 ? 0 : 1;
  }
  process.stdout.write(flags.dryRun ? "\n(dry-run: ничего не поставлено)\n" : `\nготово (провалов: ${failed})\n`);
  return failed === 0 ? 0 : 1;
}

function cmdUpdate(names, flags) {
  const packages = declared();
  let failed = 0;
  for (const entry of select(names)) {
    if (!packages.includes(entry.source)) {
      process.stdout.write(`${entry.name.padEnd(36)} не стоит — пропускаю\n`);
      continue;
    }
    process.stdout.write(`${entry.name.padEnd(36)} обновляю (${entry.source})\n`);
    failed += callPi(["update", entry.source], flags.dryRun) === 0 ? 0 : 1;
  }
  process.stdout.write(flags.dryRun ? "\n(dry-run: ничего не обновлено)\n" : `\nготово (провалов: ${failed})\n`);
  return failed === 0 ? 0 : 1;
}

function cmdRemove(names, flags) {
  const packages = declared();
  let failed = 0;
  for (const entry of select(names)) {
    if (!packages.includes(entry.source)) {
      process.stdout.write(`${entry.name.padEnd(36)} и так нет\n`);
      continue;
    }
    process.stdout.write(`${entry.name.padEnd(36)} снимаю (${entry.source})\n`);
    failed += callPi(["remove", entry.source], flags.dryRun) === 0 ? 0 : 1;
  }
  process.stdout.write(flags.dryRun ? "\n(dry-run: ничего не снято)\n" : `\nготово (провалов: ${failed})\n`);
  return failed === 0 ? 0 : 1;
}

/**
 * Последняя версия пакета в npm; null — «спросить не вышло»: нет npm в PATH, он упал, реестр
 * недоступен или не ответил за NPM_TIMEOUT_MS. Отличить «не смог узнать» от «узнал» обязан
 * вызывающий: вернуть null вместо версии и промолчать — это соврать, что пакет свежий.
 */
function latestVersion(name) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let done = false;
    const finish = (version) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(version);
    };
    try {
      child = spawn("npm", ["view", name, "version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, NPM_TIMEOUT_MS);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout.trim().split("\n").pop() || null : null));
  });
}

/**
 * Сверка с npm. Формат — как у mcp-station: центр читает `summary` и считает устаревшим всё,
 * где ненулевое значение любого ключа кроме `current`. Пробы независимы и идут разом: тринадцать
 * последовательных `npm view` — это восемь секунд, они же параллельно — меньше двух.
 * Код возврата всегда 0: сверка — это ответ, а не приговор (центр кода не судит).
 */
async function cmdOutdated(asJson) {
  const rows = catalog();
  const packages = declared();
  const states = rows.map((entry) => stateOf(entry, packages));
  const latest = await Promise.all(
    rows.map((entry, index) => {
      const name = states[index].kind === "нет" ? null : npmName(entry.source);
      return name ? latestVersion(name) : null;
    }),
  );
  const plugins = rows.map((entry, index) => {
    const state = states[index];
    const found = latest[index];
    if (state.kind === "нет") return { name: entry.name, installed: null, latest: null, status: "missing" };
    // «не смог узнать» — не «свежо»: без версии стоят и npm-источник вне npm, и нечитаемый пакет.
    const status =
      !found || !state.version || state.version === "?"
        ? "unknown"
        : found === state.version
          ? "current"
          : "behind";
    return { name: entry.name, installed: state.version, latest: found, status };
  });
  const summary = { current: 0, behind: 0, unknown: 0, missing: 0 };
  for (const row of plugins) summary[row.status] += 1;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, schema: 1, catalog: rows.length, plugins, summary }, null, 2)}\n`);
    return 0;
  }
  if (plugins.length === 0) {
    process.stdout.write("нечего сверять: каталог пуст\n");
    return 0;
  }
  for (const row of plugins) {
    const state =
      row.status === "missing"
        ? "не стоит"
        : row.status === "unknown"
          ? `${row.installed ?? "?"} → ? (не смог узнать)`
          : `${row.installed} → ${row.latest}`;
    process.stdout.write(`${row.name.padEnd(36)} ${state}${row.status === "behind" ? "  есть новее" : ""}\n`);
  }
  process.stdout.write(
    `\nсвежих: ${summary.current}, отстали: ${summary.behind}, не смог узнать: ${summary.unknown}, не стоит: ${summary.missing}\n`,
  );
  return 0;
}

function cmdVerify(asJson) {
  const problems = [];
  let rows = [];
  try {
    rows = catalog();
  } catch (error) {
    problems.push(`каталог не читается: ${error.message}`);
  }
  for (const entry of rows) {
    const where = entry.name ?? "(без имени)";
    if (!entry.name) problems.push("запись без name");
    if (!entry.source) problems.push(`${where}: нет source`);
    else if (!entry.source.startsWith("npm:")) problems.push(`${where}: source не npm: (${entry.source})`);
    if (!entry.what) problems.push(`${where}: нет what`);
  }
  if (rows.length === 0 && problems.length === 0) problems.push("каталог пуст");
  const names = rows.map((entry) => entry.name);
  for (const name of new Set(names)) {
    if (names.filter((item) => item === name).length > 1) problems.push(`дубль в каталоге: ${name}`);
  }
  if (existsSync(SETTINGS)) {
    try {
      declared();
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (asJson) process.stdout.write(`${JSON.stringify({ plugins: rows.length, problems }, null, 2)}\n`);
  else if (problems.length === 0) process.stdout.write(`каталог в порядке: ${rows.length} плагинов, у каждого name, source npm: и what\n`);
  else process.stdout.write(problems.join("\n") + "\n");
  return problems.length === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
const commands = new Set(["list", "status", "install", "update", "remove", "outdated", "verify"]);
const flags = { dryRun: false, json: false };
let command = "list";
let explicit = false;
const positional = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (commands.has(arg) && !explicit) {
    command = arg;
    explicit = true;
  } else if (arg === "--dry-run") flags.dryRun = true;
  else if (arg === "--json") flags.json = true;
  else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    process.stderr.write(`pi-plugins-station: неизвестный флаг ${arg}\n`);
    process.exit(2);
  } else positional.push(arg);
}

try {
  let code = 0;
  if (command === "list") code = cmdList(flags.json);
  else if (command === "status") code = cmdStatus(flags.json);
  else if (command === "install") code = cmdInstall(positional, flags);
  else if (command === "update") code = cmdUpdate(positional, flags);
  else if (command === "remove") code = cmdRemove(positional, flags);
  else if (command === "outdated") code = await cmdOutdated(flags.json);
  else if (command === "verify") code = cmdVerify(flags.json);
  process.exit(code);
} catch (error) {
  process.stderr.write(`pi-plugins-station: ${error.message}\n`);
  process.exit(1);
}

/** Каталог существует и он именно каталог. */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
