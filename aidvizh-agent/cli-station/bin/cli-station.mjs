#!/usr/bin/env node
// cli-station — ставит нужные CLI (omp / pi / opencode) на linux, macOS и Windows.
//
// Каталог (catalog/*.json) описывает, чем ставить на каждой ОС; станция выбирает первый метод,
// у которого на машине есть зависимости, показывает команду и выполняет её. Дальше — проверка:
// нашла ли команда бинарь и какую версию он отдаёт. --dry-run ничего не запускает.
import { readFileSync, existsSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, delimiter, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_DIR = process.env.CLI_STATION_CATALOG || join(ROOT, "catalog");
const PLATFORM = process.env.CLI_STATION_PLATFORM || process.platform; // linux | darwin | win32
const IS_WIN = PLATFORM === "win32";
const VERIFY_TIMEOUT_MS = Number(process.env.CLI_STATION_TIMEOUT_MS || 20_000);
// Расширения исполняемых файлов Windows. Заглавные по умолчанию: на самой Windows регистр не важен, а
// при проверке win32-ветки на Linux имена сверяются без учёта регистра.
const PATHEXT = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);

const PLATFORM_LABEL = { linux: "Linux", darwin: "macOS", win32: "Windows" };

function usage() {
  process.stdout.write(`cli-station — установка CLI одной командой (${PLATFORM_LABEL[PLATFORM] ?? PLATFORM})

  cli-station                    поставить всё из каталога
  cli-station install [имена...] то же, можно выбрать (--method ID, --channel dev|latest)
  cli-station status             что стоит: путь и версия
  cli-station doctor             какие методы доступны и чего не хватает
  cli-station list               что есть в каталоге

Флаги:
  --method <id>      конкретный метод установки вместо авто-выбора
  --channel <имя>    канал для CLI с каналами (opencode: dev или latest)
  --dry-run          показать команды, ничего не запускать
  --json             машинный вывод

Каталог: ${CATALOG_DIR}
`);
}

function loadCatalog() {
  return readdirSync(CATALOG_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(CATALOG_DIR, file), "utf8")));
}

/** Каталог WindowsApps — склад алиасов-заглушек (в том числе WSL-баш); pwsh — явное исключение для Store alias. */
function isWindowsApps(dir) {
  return dir.split(/[\\/]/).some((part) => part.toLowerCase() === "windowsapps");
}

/** Файл в каталоге; на Windows Store alias иногда не читается через stat, но доступен access. */
function executableCandidate(path) {
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch (error) {
    if (!IS_WIN || (error.code !== "EACCES" && error.code !== "EPERM")) return undefined;
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      return undefined;
    }
  }
}

/** Файл в каталоге; на win32 регистр не важен (PATHEXT пишут заглавными, а файлы — как получится). */
function findFile(dir, name) {
  const exact = join(dir, name);
  const exactHit = executableCandidate(exact);
  if (exactHit) return exactHit;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const needle = name.toLowerCase();
  const hit = entries.find((entry) => entry.toLowerCase() === needle);
  if (!hit) return undefined;
  return executableCandidate(join(dir, hit));
}

/**
 * Каталоги PATH. Разделитель — по виду строки, а не по платформе: на Windows её пишут через «;», но в
 * Git Bash (и в WSL) та же переменная приходит через «:» с путями /c/... — «;»-разбор там не находит ничего.
 */
function pathDirs() {
  const path = process.env.PATH || "";
  const sep = path.includes(";") || /^[A-Za-z]:[\\/]/.test(path) ? ";" : delimiter;
  return path.split(sep).filter(Boolean);
}

/**
 * Домашний склад бинарей: установщики вендоров и станции набора кладут своё сюда (omp → ~/.local/bin,
 * uv, basic-memory, skills-manager), а PATH свежей оболочки про каталог ещё может не знать. Ищем и здесь,
 * но PATH всегда впереди: то, что человек прописал сам, важнее склада.
 */
function homeStoreDirs() {
  const home = homedir();
  return IS_WIN ? [join(home, ".local", "bin")] : [join(home, ".local", "bin"), join(home, "bin")];
}

/** Лежит ли каталог в PATH этой оболочки: этим решается честная строка «склад не прописан». */
function inPath(dir) {
  const target = resolve(dir);
  return pathDirs().some((candidate) => resolve(candidate) === target);
}

/**
 * Ищем исполняемый файл в PATH. win32: каталоги через `;`, к имени добавляются расширения из PATHEXT,
 * регистр не важен, каталоги WindowsApps пропускаем; возвращаем абсолютный путь. Остальные ОС — как
 * раньше: имя как есть и бит выполнения. Внутри только fs: ни одного spawn, ни одного шелла.
 */
function which(command) {
  for (const dir of [...pathDirs(), ...homeStoreDirs()]) {
    if (!dir) continue;
    if (!IS_WIN) {
      const candidate = join(dir, command);
      try {
        const stat = statSync(candidate);
        if (stat.isFile() && (stat.mode & constants.S_IXUSR) !== 0) return candidate;
      } catch {
        /* нет файла — идём дальше */
      }
      continue;
    }
    if (isWindowsApps(dir) && !/^pwsh(?:\.exe)?$/i.test(command)) continue;
    const suffixes = extname(command) ? [""] : [...PATHEXT, ""];
    const found = suffixes.map((suffix) => findFile(dir, command + suffix)).find(Boolean);
    if (found) return found;
  }
  return undefined;
}

function run(argv, timeoutMs = VERIFY_TIMEOUT_MS, env) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: timeoutMs, ...(env ? { env } : {}) });
  const error = result.error ? result.error.code ?? result.error.message : null;
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), error };
}

/** node ≥ 18.20 не спавнит .cmd/.bat напрямую (EINVAL) — на win32 их запускает cmd.exe. */
function spawnArgv(argv) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(argv[0])) return ["cmd.exe", "/c", ...argv];
  return argv;
}

/** Запуск PowerShell: pwsh, если стоит, иначе powershell.exe из Windows. */
function psRunner() {
  if (!IS_WIN) return ["pwsh", "-NoProfile", "-File"];
  const pwsh = which("pwsh");
  return pwsh ? [pwsh, "-NoProfile", "-File"] : ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];
}

/** Как запускать файл инструмента: .cmd/.bat и .ps1 на win32 требуют обёртки, остальное — напрямую. */
function launchArgv(argv) {
  if (!IS_WIN) return argv;
  const ext = extname(argv[0]).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return spawnArgv(argv);
  if (ext === ".ps1") return [...psRunner(), ...argv];
  return argv;
}

/** Провал запуска обязан нести текст команды: молчаливого null здесь быть не может. */
function launchFailure(argv, result) {
  const cmd = argv.join(" ");
  if (result.error) return `не удалось запустить ${cmd}: ${result.error}`;
  return `не удалось запустить ${cmd}: код ${result.code}`;
}

/**
 * Глобальный префикс npm. На Fedora пакетный npm ставит пакеты в /usr/local, куда без root нет доступа
 * (EACCES на чистой машине). Если префикс не writable — ставим с npm_config_prefix в домашний ~/.local.
 */
const USER_PREFIX = join(homedir(), ".local");

let npmProbeCache;
/**
 * Префикс npm и честная причина, если спросить не вышло. npm на win32 — это npm.cmd: спрашиваем
 * резолвнутый файл через cmd.exe /c, а не шелл-обёртку из PATH. На прочих ОС — прежний `npm prefix -g`.
 */
function npmProbe() {
  if (npmProbeCache) return npmProbeCache;
  const path = which("npm");
  if (!path) {
    npmProbeCache = { prefix: null, error: "npm не найден в PATH" };
    return npmProbeCache;
  }
  const argv = launchArgv(IS_WIN ? [path, "config", "get", "prefix"] : [path, "prefix", "-g"]);
  const result = run(argv, 20_000);
  const line = result.code === 0 ? result.out.split("\n").map((row) => row.trim()).filter(Boolean).pop() : "";
  // только настоящий абсолютный путь: ответы заглушек и мусор не считаем
  const prefix = line && isAbsolute(line) ? line : null;
  let error = "";
  if (result.error || result.code !== 0) error = launchFailure(argv, result);
  else if (!prefix) error = `${argv.join(" ")}: ответ не похож на путь`;
  npmProbeCache = prefix ? { prefix, error: "" } : { prefix: null, error };
  return npmProbeCache;
}

function npmGlobalPrefix() {
  return npmProbe().prefix;
}

function npmPrefixWritable() {
  const prefix = npmGlobalPrefix();
  if (!prefix) return true; // не смогли проверить — не мешаем установке
  try {
    accessSync(prefix, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Что стоит: путь из PATH и версия из verify-команды. Провал запуска называет команду и причину. */
function probe(entry) {
  const command = entry.verify.command;
  const path = which(command);
  if (!path) return { installed: false, path: null, version: null, code: null, error: `нет в PATH: ${command}` };
  const argv = launchArgv([path, ...entry.verify.args]);
  const result = run(argv);
  if (result.error || result.code !== 0) {
    return { installed: false, path, version: null, code: result.code, error: launchFailure(argv, result) };
  }
  const version = result.out.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
  return {
    installed: true,
    path,
    version: version ? version.slice(0, 80) : null,
    code: result.code,
    error: version ? "" : `${argv.join(" ")}: версию не отдал`,
  };
}

/** Команда установки как она пойдёт на этой ОС: имя резолвится в PATH, .cmd/.bat на win32 берёт cmd.exe. */
function installArgv(argv) {
  return launchArgv([which(argv[0]) ?? argv[0], ...argv.slice(1)]);
}

function methodsFor(entry, channel) {
  const list = entry.methods[PLATFORM] ?? [];
  return channel ? list.filter((method) => !method.channel || method.channel === channel) : list;
}

function pickMethod(entry, { method, channel }) {
  if (channel && entry.channels && !entry.channels[channel]) {
    throw new Error(`у ${entry.name} нет канала ${channel} (есть: ${Object.keys(entry.channels).join(", ")})`);
  }
  const list = methodsFor(entry, channel ?? entry.defaultChannel);
  if (method) {
    const found = list.find((item) => item.id === method);
    if (!found) throw new Error(`у ${entry.name} нет метода ${method} для ${PLATFORM} (есть: ${list.map((m) => m.id).join(", ") || "—"})`);
    return found;
  }
  const usable = list.find((item) => (item.requires ?? []).every((tool) => which(tool)));
  if (!usable) {
    const reason = list.map((item) => `${item.id}: нужен ${(item.requires ?? []).join(", ") || "—"}`).join("; ");
    throw new Error(`для ${entry.name} нет доступного метода на ${PLATFORM} — ${reason}`);
  }
  return usable;
}

function printStatus(entries, asJson) {
  const rows = entries.map((entry) => ({ name: entry.name, ...probe(entry) }));
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  for (const row of rows) {
    if (row.installed) {
      process.stdout.write(`${row.name.padEnd(10)} ok     ${row.path}\n${" ".repeat(19)}${row.version ?? "версию не отдал"}\n`);
    } else {
      const why = row.path ? row.error : `не найден в PATH (${entry_hint(row.name, entries)})`;
      process.stdout.write(`${row.name.padEnd(10)} нет    ${why}\n`);
    }
  }
  return rows.every((row) => row.installed) ? 0 : 1;
}

function entry_hint(name, entries) {
  const entry = entries.find((item) => item.name === name);
  return entry ? `ставится: cli-station install ${name}` : "";
}

function printDoctor(entries) {
  const tools = new Set();
  for (const entry of entries) for (const method of entry.methods[PLATFORM] ?? []) for (const tool of method.requires ?? []) tools.add(tool);
  process.stdout.write(`платформа: ${PLATFORM_LABEL[PLATFORM] ?? PLATFORM}\n\n`);
  const npmPath = which("npm");
  if (npmPath) {
    const { prefix, error } = npmProbe();
    const state = !prefix
      ? `префикс не получен: ${error}`
      : npmPrefixWritable()
        ? `префикс ${prefix} (доступен)`
        : `префикс ${prefix} недоступен на запись — установка пойдёт в ${USER_PREFIX}`;
    process.stdout.write(`npm        ${npmPath} — ${state}\n\n`);
  }
  for (const tool of [...tools].sort()) {
    const path = which(tool);
    process.stdout.write(`${tool.padEnd(10)} ${path ? `ok   ${path}` : "нет  нужен для части методов"}\n`);
  }
  process.stdout.write("\n");
  for (const entry of entries) {
    const list = entry.methods[PLATFORM] ?? [];
    const usable = list.filter((method) => (method.requires ?? []).every((tool) => which(tool)));
    process.stdout.write(`${entry.name}: ${usable.length ? `доступно — ${usable[0].id}` : "нечего использовать"}\n`);
    for (const method of list) {
      const missing = (method.requires ?? []).filter((tool) => !which(tool));
      process.stdout.write(`  ${method.id.padEnd(12)}${missing.length ? `нужен ${missing.join(", ")}` : "готов"}\n`);
    }
  }
  return 0;
}

// ------------------------------------------------------------------ аргументы

const argv = process.argv.slice(2);
const commands = new Set(["install", "status", "doctor", "list"]);
const flags = { method: null, channel: null, dryRun: false, json: false };
let command = "install";
const positional = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (commands.has(arg) && i === 0) command = arg;
  else if (arg === "--method") flags.method = argv[++i];
  else if (arg === "--channel") flags.channel = argv[++i];
  else if (arg === "--dry-run") flags.dryRun = true;
  else if (arg === "--json") flags.json = true;
  else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    process.stderr.write(`cli-station: неизвестный флаг ${arg}\n`);
    process.exit(2);
  } else positional.push(arg);
}

try {
  const catalog = loadCatalog();
  const selected = positional.length
    ? positional.map((name) => {
        const entry = catalog.find((item) => item.name === name);
        if (!entry) throw new Error(`в каталоге нет ${name} (см. cli-station list)`);
        return entry;
      })
    : catalog;

  if (command === "list") {
    for (const entry of catalog) {
      const ids = (entry.methods[PLATFORM] ?? []).map((method) => method.id).join(", ");
      process.stdout.write(`${entry.name.padEnd(10)} ${entry.description ?? ""}\n${" ".repeat(11)}методы (${PLATFORM_LABEL[PLATFORM] ?? PLATFORM}): ${ids || "—"}\n`);
    }
    process.exit(0);
  }

  if (command === "status") process.exit(printStatus(selected, flags.json));
  if (command === "doctor") process.exit(printDoctor(selected));

  let failed = 0;
  for (const entry of selected) {
    const method = pickMethod(entry, flags);
    const before = probe(entry);
    process.stdout.write(`${entry.name}: метод ${method.id}${method.channel ? ` (канал ${method.channel})` : ""}\n`);
    process.stdout.write(`  команда: ${installArgv(method.argv).join(" ")}\n`);
    if (flags.dryRun) {
      process.stdout.write(`  сейчас: ${before.installed ? `стоит ${before.version}` : "не установлен"}, запуск пропущен (dry-run)\n`);
      continue;
    }
    // npm под root-префиксом (fedora: /usr/local) на чистой машине даёт EACCES: уводим в домашний префикс
    let env;
    if (method.argv[0] === "npm" && !npmPrefixWritable()) {
      env = { ...process.env, npm_config_prefix: USER_PREFIX };
      process.stdout.write(`  глобальный префикс npm (${npmGlobalPrefix()}) недоступен на запись без root — ставлю в ${USER_PREFIX} (npm_config_prefix)\n`);
    }
    const result = run(installArgv(method.argv), 900_000, env);
    if (result.code !== 0) {
      process.stdout.write(`  не вышло (код ${result.code}):\n${result.out.split("\n").slice(-4).map((l) => `    ${l}`).join("\n")}\n`);
      failed += 1;
      continue;
    }
    const after = probe(entry);
    if (after.installed) {
      process.stdout.write(`  поставлено: ${after.path}\n  версия: ${after.version ?? "не отдал --version"}\n`);
      if (entry.home) process.stdout.write(`  источник: ${entry.home}\n`);
      const dir = dirname(after.path);
      if (!inPath(dir)) {
        process.stdout.write(IS_WIN
          ? `  замечание: каталог ${dir} не в PATH этой оболочки; сейчас: $env:Path = "${dir};$env:Path"\n`
          : `  замечание: каталог ${dir} не в PATH этой оболочки; новая оболочка подхватит его по профилю, а сейчас: export PATH="${dir}:$PATH"\n`);
      }
    } else {
      const where = env ? ` (бинарь лёг в ${USER_PREFIX}/bin — добавь его в PATH)` : "";
      const store = homeStoreDirs().join(", ");
      process.stdout.write(`  установщик отработал, но ${entry.verify.command} не найден ни в PATH, ни в ${store}${where} — перезапусти оболочку или поправь PATH\n`);
      failed += 1;
    }
  }
  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  process.stderr.write(`cli-station: ${error.message}\n`);
  process.exit(1);
}
