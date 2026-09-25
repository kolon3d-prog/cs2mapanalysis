#!/usr/bin/env node
// Единственный движок гейта доков: числа, списки и команды в README/docs против факта.
// Обёртки bin/docs-check.sh и bin/docs-check.ps1 зовут его — логика живёт в одном месте,
// поэтому вердикт на bash и на PowerShell один и тот же.
//
// Факт берётся из кода, реестра и файлов на диске (не из самих доков):
//   · число проектов и список проектов      ← command-center/registry.json (записи без optional)
//   · число скиллов в коллекции             ← skills-station/collection (каталоги с SKILL.md)
//   · число тестов в наборе станции         ← '^@test' по <станция>/tests/**/*.bats
//   · число тестов и файлов в прогоне       ← skills-hub/contrib/skills-hub-check.sh (что зовёт center check)
//   · шаги плана bootstrap                  ← center.mjs (cmdBootstrap)
//   · команды центра                        ← center.mjs (набор команд) и README центра
//   · версия набора                         ← VERSION
//   · каждая упомянутая команда             ← usage/диспетчер самой станции (статически, без запуска)
//   · индекс доков                          ← наличие файлов, на которые ссылается docs/README.md
//   · кастомные скиллы из доков             ← каталог проекта на диске, collection/catalog.json, ~/.agents/skills
//   · платформенная полнота                 ← platform-exceptions.txt: .sh без соседа .ps1 — только с причиной
//
// Что понимает в тексте:
//   «13 проектов», «23 теста», «65 скиллов», «N штук», «тестов: N», «всего проектов: N»,
//   «N файлов bats», «N шагов», «bin/<станция>.sh <команда>». Числа сверяются как есть:
//   «~200» — это тоже двадцать-ноль-ноль, приблизительность тут не оправдание.
//
// Использование: bin/docs-check.mjs [--json] [--quiet]
//   --json   машинный вывод (ok, факты, расхождения)
//   --quiet  только расхождения (без строки фактов)
//   DOCS_CHECK_ROOT — проверить другое дерево (наборы тестов подкладывают мини-диск)
//
// Доки чужого (collection/, wiki-библиотека, корпусы camoufox) не читаются: там чужие тексты.
import { readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isPathWithin, normalizePathKey } from "./path-utils.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DISK = process.env.DOCS_CHECK_ROOT ? resolve(process.env.DOCS_CHECK_ROOT) : resolve(ROOT, "..");
// с DOCS_CHECK_ROOT проверяем другое дерево целиком: и доки, и факты берутся из него же
const CENTER = process.env.DOCS_CHECK_ROOT ? join(DISK, "command-center") : ROOT;
const HOME = process.env.HOME || homedir();
/**
 * Платформа гейта. На Windows пути приходят с обратными разделителями и в другом регистре, поэтому
 * сравнивать их «как есть» нельзя: иначе у каждого .sh «пропадает» сосед .ps1, который лежит рядом.
 */
const PLATFORM = process.env.DOCS_CHECK_PLATFORM || process.platform;
const IS_WIN = PLATFORM === "win32";

const HELP = `docs-check: гейт доков — ЧИСЛА, СПИСКИ и КОМАНДЫ в README/docs против факта.

Факт берётся из кода, реестра и файлов на диске (не из самих доков): проекты и их список —
из command-center/registry.json, скиллы — из skills-station/collection, тесты — из '^@test'
по наборам bats, шаги плана — из center.mjs, версия — из VERSION, упомянутые команды — из
usage станций. Числа сверяются как есть: «~200» — это тоже двадцать-ноль-ноль.

Платформенная полнота: у каждого .sh на диске должен быть сосед .ps1, иначе путь обязан
лежать в command-center/platform-exceptions.txt строкой «путь|причина» (системное: systemd,
cron, git-хук, docker). Протухшее исключение (файла нет или .ps1 появился) — тоже расхождение.

Использование: bin/docs-check.sh [--json] [--quiet]   (Windows: bin/docs-check.ps1 …)
  --json   машинный вывод (ok, факты, расхождения)
  --quiet  только расхождения (без строки фактов)
  DOCS_CHECK_ROOT — проверить другое дерево (наборы тестов подкладывают мини-диск)`;

const argv = process.argv.slice(2);
let AS_JSON = 0;
let QUIET = 0;
for (const arg of argv) {
  if (arg === "--json") AS_JSON = 1;
  else if (arg === "--quiet") QUIET = 1;
  else if (arg === "-h" || arg === "--help") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`docs-check: неизвестный флаг ${arg} (см. bin/docs-check.sh --help)\n`);
    process.exit(2);
  }
}

// ── чтение дерева ────────────────────────────────────────────────────────────
function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Обход в глубину: только настоящие файлы (как `find -type f`: ссылки не разворачиваются). */
function walk(root, { skipDir = () => false, keep = () => true } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir(path, entry.name)) stack.push(path);
        continue;
      }
      if (entry.isFile() && keep(path)) out.push(path);
    }
  }
  return out;
}

/** Путь от корня диска в одном виде на всех ОС: разделители прямые, как в докладах и исключениях. */
function rel(abs) {
  if (isPathWithin(DISK, abs, { caseInsensitive: IS_WIN })) {
    return abs === DISK ? "" : abs.slice(DISK.length).replace(/^[/\\]/, "").replaceAll("\\", "/");
  }
  return abs;
}

/** Ключ сравнения путей: на Windows регистр не важен — файловая система его не различает. */
function pathKey(path) {
  return normalizePathKey(path, { caseInsensitive: IS_WIN });
}

/** Строки файла с номерами — то же, что даёт `grep -n`. */
function lines(text) {
  return text.split("\n").map((row, index) => ({ line: index + 1, text: row }));
}

/** Первое совпадение регулярки в строке — как `grep -oE … | head -1`. */
function firstMatch(text, regex) {
  const found = text.match(regex);
  return found ? found[0] : undefined;
}

const SKIP_DIRS = [".git", "node_modules", "vendor", ".venv"];

/** Служебный мусор и чужие копии: их не считаем ни за скрипты, ни за доки. */
function skipService(root, collection) {
  return (path, name) => {
    if (SKIP_DIRS.includes(name)) return true;
    if (collection && isPathWithin(collection, path, { caseInsensitive: IS_WIN })) return true;
    return false;
  };
}

if (!isDir(DISK)) {
  process.stderr.write(`docs-check: нет каталога ${DISK}\n`);
  process.exit(2);
}

const ISSUES = [];
const ITEMS = [];
let COMMANDS_CHECKED = 0;
let DOCS_SCANNED = 0;
let BROKEN_SCAN = "";

function jesc(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// add_issue kind file line said actual what message
function addIssue(kind, file, line, said, actual, what, message) {
  ISSUES.push(message);
  ITEMS.push(
    `{"kind":"${jesc(kind)}","file":"${jesc(file)}","line":${line},"said":"${jesc(said)}","actual":"${jesc(actual)}","what":"${jesc(what)}","message":"${jesc(message)}"}`,
  );
}

/** label для человека: «README станции X» / «док путь» */
function labelFor(relative, scope) {
  return relative.endsWith("/README.md") ? `README станции ${scope}` : `док ${relative}`;
}

// ── факты ────────────────────────────────────────────────────────────────────
if (!isFile(join(CENTER, "registry.json"))) {
  process.stderr.write(`docs-check: нет реестра ${join(CENTER, "registry.json")} — не от чего считать\n`);
  process.exit(2);
}

let PROJECT_NAMES = [];
let REGISTRY = null;
try {
  const data = JSON.parse(readFileSync(join(CENTER, "registry.json"), "utf8"));
  if (!Array.isArray(data.projects)) throw new Error("поле projects — не список");
  REGISTRY = data;
  PROJECT_NAMES = data.projects.filter((row) => !row.optional).map((row) => row.name);
} catch (error) {
  process.stderr.write(`docs-check: registry.json не разобран: ${error.message}\n`);
  process.exit(2);
}
const PROJECTS = PROJECT_NAMES.length;
const VERSION_ACTUAL = (readText(join(DISK, "VERSION")) ?? "").replace(/\s+/g, "");

// Не даём документации незаметно разъехаться с манифестами и списком персон.
if (REGISTRY) {
  const personasDir = join(DISK, "personas");
  const personaWhat = String(REGISTRY.projects?.find((row) => row.name === "personas")?.what ?? "");
  for (const file of walk(personasDir, { keep: (path) => /\.(txt|md)$/i.test(path) })) {
    const name = basename(file).replace(/\.(txt|md)$/i, "");
    if (!personaWhat.includes(name)) {
      addIssue("list", "command-center/registry.json", 0, name, personaWhat || "нет списка", "персоны", `реестр personas не перечисляет файл ${name}`);
    }
  }

  const pyproject = readText(join(DISK, "camoufox-research/pyproject.toml"));
  const requirements = readText(join(DISK, "camoufox-research/mcp/requirements.txt"));
  const camoufoxReadme = readText(join(DISK, "camoufox-research/README.md"));
  if (pyproject && requirements) {
    for (const name of ["mcp", "camoufox"]) {
      const projectPin = new RegExp(`\"${name}==([^\"\\s]+)`).exec(pyproject)?.[1];
      const requirementsPin = new RegExp(`^${name}==([^\\s]+)`, "m").exec(requirements)?.[1];
      if (projectPin !== requirementsPin) {
        addIssue("dependency", "camoufox-research/mcp/requirements.txt", 0, requirementsPin ?? "нет пина", projectPin ?? "нет пина", "зависимости MCP", `пин ${name} в pyproject.toml и mcp/requirements.txt разошёлся`);
      }
    }
  }
  if (pyproject && camoufoxReadme) {
    const projectPin = /"camoufox==([^\"\s]+)/.exec(pyproject)?.[1];
    const badgePin = /Camoufox-([0-9.]+)/.exec(camoufoxReadme)?.[1];
    if (projectPin && badgePin && projectPin !== badgePin) {
      addIssue("version", "camoufox-research/README.md", 0, badgePin, projectPin, "Camoufox", "бейдж Camoufox в README разошёлся с pyproject.toml");
    }
  }
}

const COLLECTION = join(DISK, "skills-station/collection");
let dirs = [];
try {
  dirs = readdirSync(DISK).sort();
} catch {
  dirs = [];
}
const stations = dirs.filter((name) => isDir(join(DISK, name)));

let SKILLS = 0;
if (isDir(COLLECTION)) {
  for (const name of dirsOf(COLLECTION)) {
    if (isFile(join(COLLECTION, name, "SKILL.md"))) SKILLS += 1;
  }
}

function dirsOf(dir) {
  try {
    return readdirSync(dir).filter((name) => isDir(join(dir, name))).sort();
  } catch {
    return [];
  }
}

function countTests(file, cache) {
  const text = cache.get(file) ?? readText(file) ?? "";
  cache.set(file, text);
  return text.split("\n").filter((row) => row.startsWith("@test")).length;
}

const TESTS_OF = new Map();
const FILES_OF = new Map();
const TEXT_CACHE = new Map();
for (const station of stations) {
  const testsDir = join(DISK, station, "tests");
  if (!isDir(testsDir)) continue;
  let count = 0;
  let files = 0;
  for (const file of walk(testsDir, { keep: (path) => path.endsWith(".bats") })) {
    files += 1;
    count += countTests(file, TEXT_CACHE);
  }
  TESTS_OF.set(station, count);
  FILES_OF.set(station, files);
}

// сколько наборов и тестов на диске целиком — включая вложенные каталоги тестов, которые не лежат
// прямо в <станция>/tests (например command-center/plugin/tests). Чужие копии и рантайм не считаем.
let DISK_TESTS = 0;
let DISK_FILES = 0;
const batsFiles = walk(DISK, {
  skipDir: skipService(DISK, COLLECTION),
  keep: (path) => path.endsWith(".bats"),
});
for (const file of batsFiles) {
  DISK_FILES += 1;
  DISK_TESTS += countTests(file, TEXT_CACHE);
}

// что реально гоняет `center check`: наборы, которые зовёт сквозная проверка хаба. Файлы берём
// построчно (у станции может быть несколько наборов, а в прогон попадает не каждый). Заодно
// собираем СПИСОК этих наборов: его сверяет с диском проверка покрытия (см. ниже).
const HUB_CHECK = join(DISK, "skills-hub/contrib/skills-hub-check.sh");
let CHECK_TESTS = 0;
let CHECK_FILES = 0;
const CHECKED_BATS = new Set();

/**
 * Набор, который зовёт прогон, — как путь от корня набора. Скрипт называет его относительно каталога
 * станции (`bats tests/station.bats`), а каталог берёт из своей переменной, поэтому мало знать
 * «текущий каталог»: пробуем его, а если файла там нет — ищем единственный набор с таким хвостом
 * пути. Так разбор не разъезжается, когда прогон зовёт вложенный каталог (`plugin/tests/…`) или
 * называет станцию своей переменной.
 */
function resolveBatsTarget(target, current) {
  const clean = target.replace(/^\.\//, "");
  const direct = join(DISK, current, clean);
  if (isFile(direct)) return rel(direct);
  const matches = batsFiles.filter((file) => rel(file).endsWith(`/${clean}`));
  return matches.length === 1 ? rel(matches[0]) : undefined;
}

const hubText = readText(HUB_CHECK);
if (hubText === undefined) {
  BROKEN_SCAN = HUB_CHECK;
  CHECK_TESTS = -1;
  CHECK_FILES = -1;
} else {
  CHECK_TESTS = -1;
  CHECK_FILES = -1;
  let current = "skills-hub";
  for (const { text } of lines(hubText)) {
    // прогон печатает заголовок набора («== bats: mcp-station») — это самый надёжный признак,
    // чей набор зовётся: имя переменной и путь к каталогу могут быть любыми
    const bannerMatch = text.match(/==\s*bats:\s*([a-z0-9-]+)/);
    if (bannerMatch) {
      current = bannerMatch[1];
      continue;
    }
    const dirMatch = text.match(/pwd\)\/([a-z0-9-]+)"/);
    if (dirMatch) {
      current = dirMatch[1];
      continue;
    }
    const batsMatch = text.match(/bats\s+([^\s]+\.bats)/);
    if (batsMatch) {
      const resolved = resolveBatsTarget(batsMatch[1], current);
      if (resolved) {
        if (CHECK_TESTS < 0) {
          CHECK_TESTS = 0;
          CHECK_FILES = 0;
        }
        CHECKED_BATS.add(pathKey(resolved));
        CHECK_TESTS += countTests(join(DISK, resolved), TEXT_CACHE);
        CHECK_FILES += 1;
      } else {
        BROKEN_SCAN = `${BROKEN_SCAN} ${current}/${batsMatch[1]}`;
      }
    }
  }
  if (CHECK_TESTS < 0) {
    BROKEN_SCAN = `${HUB_CHECK} (не разобрал наборы)`;
    addIssue(
      "scan",
      "skills-hub/contrib/skills-hub-check.sh",
      0,
      "",
      "",
      "наборы center check",
      "не разобрал, какие наборы зовёт skills-hub-check.sh — числа прогона center check проверить нечем",
    );
  }
}

// шаги плана bootstrap и набор команд центра — из движка центра
let BOOTSTRAP_STEPS = -1;
let CENTER_COMMANDS = "";
const engineText = readText(join(CENTER, "bin/center.mjs"));
if (engineText !== undefined) {
  let inRange = false;
  let steps = 0;
  const commandSet = engineText.match(/const commands = new Set\(\[[^\]]*\]\)/g) ?? [];
  CENTER_COMMANDS = uniqueSorted(
    commandSet.flatMap((row) => row.match(/"[a-z][a-z0-9-]*"/g) ?? []).map((row) => row.replaceAll('"', "")),
  ).join("\n");

  for (const { text } of lines(engineText)) {
    if (!inRange && /^function cmdBootstrap/.test(text)) inRange = true;
    else if (inRange && /^  const manual/.test(text)) {
      inRange = false;
      continue;
    }
    if (inRange && /^\s*\["[0-9]+", /.test(text)) steps += 1;
  }
  // awk-диапазон печатает и строку-конец: считаем только то, что до неё (команды шагов не трогаем)
  BOOTSTRAP_STEPS = steps;
}
function uniqueSorted(rows) {
  return [...new Set(rows)].sort();
}

// команды плагина клиентов — из его ядра (plugin/lib/center.ts)
let PLUGIN_COMMANDS = "";
const pluginCore = readText(join(CENTER, "plugin/lib/center.ts"));
if (pluginCore !== undefined) {
  const block = [];
  let inside = false;
  for (const { text } of lines(pluginCore)) {
    if (!inside && /export const COMMANDS/.test(text)) inside = true;
    else if (inside && /^\];/.test(text)) break;
    if (inside) block.push(text);
  }
  PLUGIN_COMMANDS = uniqueSorted(
    block.flatMap((row) => row.match(/name: "[a-z][a-z0-9-]*"/g) ?? []).map((row) => firstMatch(row, /"[a-z][a-z0-9-]*"/)?.replaceAll('"', "") ?? ""),
  )
    .filter(Boolean)
    .join("\n");
}

/** Команды станции: диспетчер (case/command ===/Set) + строки usage («<инструмент> <команда>»). */
function knownCommands(station, tool) {
  const dir = join(DISK, station, "bin");
  if (!isDir(dir)) return "";
  const found = new Set();
  const keep = (chunk) => {
    for (const token of chunk.match(/[a-z][a-z0-9-]*/g) ?? []) found.add(token);
  };
  for (const file of walk(dir)) {
    const text = readText(file);
    if (text === undefined) continue;
    for (const { text: row } of lines(text)) {
      for (const chunk of row.match(/case[ \t]+"[a-z][a-z0-9-]*"/g) ?? []) keep(chunk);
      for (const chunk of row.match(/command[ \t]*[=!]==[ \t]*"[a-z][a-z0-9-]*"/g) ?? []) keep(chunk);
      for (const chunk of row.match(/commands[ \t]*=[ \t]*new Set\(\[[^\]]*\]\)/g) ?? []) keep(chunk);
      for (const chunk of row.match(/^[ \t]+[a-z][a-z0-9-]*\)/g) ?? []) keep(chunk);
      for (const chunk of row.match(new RegExp(`${tool}[ \\t]+[a-z][a-z0-9-]*`, "g")) ?? []) {
        keep(chunk.replace(new RegExp(`^${tool}[ \\t]+`), " "));
      }
    }
  }
  return `${[...found].sort().join(" ")} `;
}

/** $1 = имя скрипта (center.sh) → каталог станции */
function stationOfScript(script) {
  for (const station of stations) {
    if (isFile(join(DISK, station, "bin", script))) return station;
  }
  return undefined;
}

// ── доки ─────────────────────────────────────────────────────────────────────
function docsList() {
  return walk(DISK, {
    skipDir: (path, name) =>
      SKIP_DIRS.includes(name) ||
      name === "__pycache__" ||
      isPathWithin(COLLECTION, path, { caseInsensitive: IS_WIN }) ||
      path === join(DISK, "wiki-station/wiki") ||
      path === join(DISK, "camoufox-research/research") ||
      path === join(DISK, "dist") ||
      name === "dump" ||
      path.endsWith("/tests/fixtures"),
    keep: (path) => path.endsWith(".md") && !path.includes("__pycache__") && !path.includes("/dump/"),
  }).sort();
}

/** файлы, где речь именно о коллекции скиллов (в чужих доках «N скиллов» — про маркеты) */
function isCollectionDoc(relative) {
  return [
    "skills-station/README.md",
    "agent-bundle/harness/skills-station.md",
    "command-center/docs/04-skills.md",
    "command-center/README.md",
    "test-center/README.md",
  ].includes(relative);
}

/** файлы, где числа — про диск целиком (проекты, шаги плана) */
function isDiskDoc(relative) {
  return (
    relative === "command-center/README.md" ||
    relative.startsWith("command-center/docs/") ||
    relative === "agent-bundle/README.md" ||
    relative === "agent-bundle/harness/command-center.md" ||
    relative === "test-center/README.md" ||
    relative === "cleanup-station/README.md"
  );
}

/** шаги плана установки — только у центра */
function isCenterDoc(relative) {
  return (
    relative === "README.md" ||
    relative === "command-center/README.md" ||
    relative.startsWith("command-center/docs/") ||
    relative === "agent-bundle/harness/command-center.md"
  );
}

for (const doc of docsList()) {
  const relative = rel(doc);
  let scope = relative.split("/")[0];
  if (relative.startsWith("agent-bundle/harness/") && relative.endsWith(".md")) {
    const candidate = basename(relative, ".md");
    if (isDir(join(DISK, candidate))) scope = candidate;
  }
  const label = labelFor(relative, scope);
  DOCS_SCANNED += 1;
  const text = readText(doc) ?? "";
  const rows = lines(text);

  // A. «N тестов» и «N файлов bats» в наборе станции (или в прогоне center check)
  if (TESTS_OF.has(scope)) {
    for (const { line, text: row } of rows) {
      if (!/[0-9]+\s*(тест|файл)/.test(row)) continue;
      if (/(\.py|python|unittest|pytest|гейт|gates\.sh|модель)/.test(row)) continue;
      if (/[0-9]+\/[0-9]+/.test(row)) continue;
      const isDiskRow = /(набор[а-я]*\s+тестов\s+диска|тестов\s+диска|все набор|всех набор|наборов диска|skills-hub-check|center check|прогон)/.test(row);

      const saidFiles = firstMatch(row, /[0-9]+\s+файл(ов|а)?\s+bats/)?.match(/^[0-9]+/)?.[0];
      if (saidFiles) {
        const actualFiles = isDiskRow && CHECK_FILES >= 0 ? String(CHECK_FILES) : String(FILES_OF.get(scope) ?? 0);
        const whatFiles = isDiskRow && CHECK_FILES >= 0 ? "файлов bats в прогоне center check" : `файлов bats в наборе ${scope}`;
        if (saidFiles !== actualFiles) {
          addIssue(
            "number",
            relative,
            line,
            saidFiles,
            actualFiles,
            whatFiles,
            `${label}: сказано ${saidFiles}, на деле ${actualFiles} — ${whatFiles}`,
          );
        }
      }

      const said = firstMatch(row, /~?[0-9]+\s+тест/)?.match(/[0-9]+/)?.[0];
      if (!said) continue;
      // в строке может быть назван конкретный набор («bats plugin/tests/plugins.bats # 11 тестов»):
      // тогда считаем по нему, а не по станции целиком
      const namedFile = firstMatch(row, /[A-Za-z0-9_./-]+\.bats/);
      let actual;
      let what;
      if (namedFile) {
        for (const candidate of [join(DISK, namedFile), join(DISK, scope, namedFile)]) {
          if (isFile(candidate)) {
            actual = String(countTests(candidate, TEXT_CACHE));
            what = `тестов в наборе ${namedFile}`;
            break;
          }
        }
      }
      if (actual === undefined) {
        if (isDiskRow && CHECK_TESTS >= 0) {
          actual = String(CHECK_TESTS);
          what = "тестов в прогоне center check";
        } else {
          actual = String(TESTS_OF.get(scope));
          what = `тестов в наборе ${scope}`;
        }
      }
      if (said !== actual) {
        addIssue("number", relative, line, said, actual, what, `${label}: сказано ${said}, на деле ${actual} — ${what}`);
      }
    }
  }

  // A2. «11 файлов bats ... из 20 на диске» — второе число сверяем со всем диском
  for (const { line, text: row } of rows) {
    if (!row.includes("bats")) continue;
    const saidTotal = firstMatch(row, /из\s+[0-9]+\s+на\s+диске/)?.match(/[0-9]+/)?.[0];
    if (!saidTotal) continue;
    if (saidTotal !== String(DISK_FILES)) {
      addIssue(
        "number",
        relative,
        line,
        saidTotal,
        String(DISK_FILES),
        "файлов bats на диске",
        `${label}: сказано ${saidTotal}, на деле ${DISK_FILES} — файлов bats на диске`,
      );
    }
  }

  // B. «N скиллов» / «N штук» про коллекцию
  if (isCollectionDoc(relative)) {
    for (const { line, text: row } of rows) {
      if (!/[0-9]+\s*(скилл|штук)/.test(row)) continue;
      const said = firstMatch(row, /[0-9]+\s*(скилл(ов|а|ы)|штук(и)?)/)?.match(/^[0-9]+/)?.[0];
      if (!said) continue;
      if (said !== String(SKILLS)) {
        addIssue(
          "number",
          relative,
          line,
          said,
          String(SKILLS),
          "скиллов в коллекции",
          `${label}: сказано ${said}, на деле ${SKILLS} — скиллов в коллекции (collection/*/SKILL.md)`,
        );
      }
    }
  }

  // C. «N проектов» на диске и «N шагов» в плане bootstrap
  if (isDiskDoc(relative)) {
    for (const { line, text: row } of rows) {
      const said = firstMatch(row, /[0-9]+\s*проект/)?.match(/^[0-9]+/)?.[0];
      if (said && said !== String(PROJECTS)) {
        addIssue(
          "number",
          relative,
          line,
          said,
          String(PROJECTS),
          "проектов в реестре",
          `${label}: сказано ${said}, на деле ${PROJECTS} — проектов в реестре (без рантайм-записей)`,
        );
      }
    }
  }

  // шаги плана установки бывают только у центра — в чужих доках «N шагов» это про своё
  if (isCenterDoc(relative) && BOOTSTRAP_STEPS >= 0) {
    for (const { line, text: row } of rows) {
      const said = firstMatch(row, /[0-9]+\s*шаг/)?.match(/^[0-9]+/)?.[0];
      if (!said) continue;
      if (said !== String(BOOTSTRAP_STEPS)) {
        addIssue(
          "number",
          relative,
          line,
          said,
          String(BOOTSTRAP_STEPS),
          "шагов в плане bootstrap",
          `${label}: сказано ${said}, на деле ${BOOTSTRAP_STEPS} — шагов в плане bootstrap (center bootstrap)`,
        );
      }
    }
  }

  // D. версия набора: «версия набора … 5.2.0»
  if (relative.startsWith("command-center/") && VERSION_ACTUAL) {
    for (const { line, text: row } of rows) {
      if (!/(версия набора|версии набора|VERSION)/.test(row)) continue;
      if (/(patch|minor|major)/.test(row)) continue;
      const said = firstMatch(row, /[0-9]+\.[0-9]+\.[0-9]+/);
      if (!said) continue;
      if (said !== VERSION_ACTUAL) {
        addIssue(
          "number",
          relative,
          line,
          said,
          VERSION_ACTUAL,
          "версия набора",
          `${label}: сказано ${said}, на деле ${VERSION_ACTUAL} — версия набора (файл VERSION)`,
        );
      }
    }
  }

  // E. упомянутые команды: bin/<станция>.sh <команда> должна быть в её usage
  for (const { line, text: row } of rows) {
    if (!/bin\/[a-z0-9-]+\.sh\s+[a-z]/.test(row)) continue;
    for (const pair of row.match(/bin\/[a-z0-9-]+\.sh[ \t]+[a-z][a-z0-9-]*/g) ?? []) {
      const [script, cmd] = pair.split(/[ \t]+/);
      const tool = basename(script, ".sh");
      const station = stationOfScript(basename(script));
      if (!station) {
        addIssue(
          "command",
          relative,
          line,
          cmd,
          "",
          `станция скрипта ${script}`,
          `${label}: упомянут ${script}, а такого скрипта на диске нет`,
        );
        continue;
      }
      const known = ` ${knownCommands(station, tool)} `;
      COMMANDS_CHECKED += 1;
      if (!known.includes(` ${cmd} `)) {
        addIssue(
          "command",
          relative,
          line,
          cmd,
          "нет в usage",
          `команда станции ${station}`,
          `${label}: команда «${script} ${cmd}» не найдена в usage станции ${station}`,
        );
      }
    }
  }
}

// F. индекс доков: что перечислено — то и есть, и наоборот
const DOCS_INDEX = join(CENTER, "docs/README.md");
if (isFile(DOCS_INDEX)) {
  const indexText = readText(DOCS_INDEX) ?? "";
  for (const { text: row } of lines(indexText)) {
    const target = firstMatch(row, /\]\([0-9][a-z0-9-]*\.md\)/)?.replace(/[\]()]/g, "");
    if (!target) continue;
    if (!isFile(join(CENTER, "docs", target))) {
      addIssue(
        "list",
        "command-center/docs/README.md",
        0,
        target,
        "нет файла",
        "индекс доков",
        `док command-center/docs/README.md: ссылается на ${target}, а файла нет`,
      );
    }
  }

  const docsDir = join(CENTER, "docs");
  let names = [];
  try {
    names = readdirSync(docsDir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name === "README.md") continue;
    if (!indexText.includes(`(${name})`)) {
      addIssue(
        "list",
        "command-center/docs/README.md",
        0,
        "",
        "",
        "индекс доков",
        `док command-center/docs/README.md: тема ${name} не попала в индекс`,
      );
    }
  }
}

// G. список проектов: все записи реестра — в README центра и в карте
const CENTER_README = join(CENTER, "README.md");
if (isFile(CENTER_README)) {
  const readme = readText(CENTER_README) ?? "";
  const mapFile = join(CENTER, "docs/00-map.md");
  const map = isFile(mapFile) ? readText(mapFile) ?? "" : undefined;
  for (const name of PROJECT_NAMES) {
    if (!readme.includes(`\`${name}\``)) {
      addIssue(
        "list",
        "command-center/README.md",
        0,
        "",
        "",
        "список проектов",
        `README станции command-center: проект ${name} есть в реестре, а в README — нет`,
      );
    }
    if (map !== undefined && !map.includes(name)) {
      addIssue(
        "list",
        "command-center/docs/00-map.md",
        0,
        "",
        "",
        "карта диска",
        `док command-center/docs/00-map.md: проект ${name} есть в реестре, а в карте — нет`,
      );
    }
  }
}

// H. команды центра: набор из движка против README (в обе стороны)
const haveCenterCommands = CENTER_COMMANDS.length > 0;
if (haveCenterCommands) {
  const readme = readText(CENTER_README) ?? "";
  const readmeLines = lines(readme).map(({ text }) => text);
  for (const cmd of CENTER_COMMANDS.split("\n")) {
    if (!cmd) continue;
    const direct = new RegExp(`(center\\.sh|center\\.mjs) ${cmd}(\\s|$)`);
    const short = new RegExp(`center ${cmd}(\\s|$)`);
    if (!readmeLines.some((row) => direct.test(row) || short.test(row))) {
      addIssue(
        "list",
        "command-center/README.md",
        0,
        "",
        "",
        "команды центра",
        `README станции command-center: команда «center ${cmd}» есть в движке, а в README — нет`,
      );
    }
  }
}

// H2. команды плагина клиентов: он оборачивает центр — значит, команды те же (и список — тот же)
if (PLUGIN_COMMANDS) {
  const pluginDocs = [join(CENTER, "plugin/README.md")];
  try {
    for (const name of readdirSync(join(CENTER, "docs")).sort()) {
      if (name.includes("plugins") && name.endsWith(".md")) pluginDocs.push(join(CENTER, "docs", name));
    }
  } catch {
    // каталога доков нет — остаётся только plugin/README.md
  }
  const centerSet = ` ${CENTER_COMMANDS.split("\n").join(" ")} `;

  for (const cmd of PLUGIN_COMMANDS.split("\n")) {
    if (!cmd) continue;
    if (haveCenterCommands && !centerSet.includes(` ${cmd} `)) {
      addIssue(
        "list",
        "command-center/plugin/lib/center.ts",
        0,
        cmd,
        "нет в движке центра",
        "команды плагина",
        `док command-center/plugin/lib/center.ts: плагин оборачивает «center ${cmd}», а такой команды у центра нет`,
      );
    }
    let found = false;
    for (const doc of pluginDocs) {
      const text = readText(doc);
      if (text !== undefined && text.includes(`/center ${cmd}`)) found = true;
    }
    if (!found) {
      addIssue(
        "list",
        "command-center/docs/10-plugins.md",
        0,
        "",
        "",
        "команды плагина",
        `док command-center/docs/10-plugins.md: команда плагина «${cmd}» не названа ни в доке плагинов, ни в plugin/README.md`,
      );
    }
  }

  const pluginSet = ` ${PLUGIN_COMMANDS.split("\n").join(" ")} `;
  for (const doc of pluginDocs) {
    const text = readText(doc);
    if (text === undefined) continue;
    const path = rel(doc);
    for (const { line, text: row } of lines(text)) {
      if (!/\/center [a-z]/.test(row)) continue;
      for (const cmd of (row.match(/\/center [a-z][a-z0-9-]*/g) ?? []).map((hit) => hit.replace(/^\/center /, ""))) {
        if (pluginSet.includes(` ${cmd} `)) continue;
        addIssue(
          "list",
          path,
          line,
          cmd,
          "нет в плагине",
          "команды плагина",
          `${labelFor(path, "command-center")}: названа команда «/center ${cmd}», а в plugin/lib/center.ts её нет`,
        );
      }
    }
  }
}

// I. кастомные скиллы, названные в доках: каталог проекта / collection / слой ~/.agents/skills
const KNOWN_SKILL_WORDS = [
  "skills-hub",
  "skills-station",
  "command-center",
  "mcp-station",
  "memory-station",
  "wiki-station",
  "spec-station",
  "prompt-station",
  "cli-station",
  "cleanup-station",
  "test-center",
  "agent-bundle",
  "sysprompt",
  "catalog.json",
  "personal-skills.txt",
  "skill",
  "collection",
  "global",
  "project",
  "opencode",
  "claude",
  "verify",
  "status",
];

/**
 * Личные скиллы: живут в слое машины владельца, на диск набора не попадают по замыслу. Список —
 * рядом с коллекцией, строкой «имя|причина» (тот же приём, что у platform-exceptions.txt): так гейт
 * даёт один и тот же вердикт и на машине владельца, и на чистой Windows, где личного слоя ещё нет.
 */
const PERSONAL_FILE = join(DISK, "skills-station/personal-skills.txt");
const personal = new Map();
const personalText = readText(PERSONAL_FILE);
if (personalText !== undefined) {
  lines(personalText).forEach(({ line, text: raw }) => {
    const row = raw.trim();
    if (!row || row.startsWith("#")) return;
    const cut = raw.indexOf("|");
    if (cut < 0) {
      addIssue("list", "skills-station/personal-skills.txt", line, row, "нет причины", "личные скиллы", `список: строка ${line} без причины — формат «имя|причина», причина обязательна`);
      return;
    }
    const name = raw.slice(0, cut).trim();
    const reason = raw.slice(cut + 1).trim();
    if (!reason) addIssue("list", "skills-station/personal-skills.txt", line, name, "пустая причина", "личные скиллы", `список: у ${name} пустая причина — напиши, почему он не в наборе`);
    if (isDir(join(DISK, name)) || isDir(join(COLLECTION, name))) {
      addIssue("list", "skills-station/personal-skills.txt", line, name, "появился на диске", "личные скиллы", `список: ${name} уже есть на диске — строку про личный скилл пора убрать`);
    }
    personal.set(name, reason);
  });
}

/** Имена своих скиллов: шапка `name:` в SKILL.md любого проекта на диске (коллекция — чужая, не в счёт). */
function declaredSkillNames() {
  const names = new Set();
  for (const file of walk(DISK, { skipDir: (path) => path === COLLECTION || skipService(DISK, path), keep: (path) => path.endsWith("SKILL.md") })) {
    const text = readText(file);
    const name = text?.match(/^name:\s*([A-Za-z0-9._-]+)\s*$/m)?.[1];
    if (name) names.add(name);
  }
  return names;
}

const DECLARED_SKILLS = declaredSkillNames();

for (const doc of [join(DISK, "skills-station/README.md"), join(CENTER, "docs/04-skills.md")]) {
  const text = readText(doc);
  if (text === undefined) continue;
  const path = rel(doc);
  for (const { line, text: row } of lines(text)) {
    if (!/(не копир|кастомн|сво[еёи]|своих скилл)/.test(row)) continue;
    for (const name of (row.match(/`[a-z][a-z0-9-]{2,}`/g) ?? []).map((hit) => hit.replaceAll("`", ""))) {
      if (KNOWN_SKILL_WORDS.includes(name)) continue;
      if (isDir(join(DISK, name))) continue;
      if (DECLARED_SKILLS.has(name)) continue;
      if (isDir(join(COLLECTION, name))) continue;
      if (personal.has(name)) continue;
      if (isDir(join(HOME, ".agents/skills", name))) continue;
      addIssue(
        "list",
        path,
        line,
        name,
        "нет",
        "скиллы, названные в доке",
        `${labelFor(path, "skills-station")}: упомянут свой скилл «${name}», а его нет ни проектом на диске, ни в коллекции, ни в личном списке (skills-station/personal-skills.txt), ни в ~/.agents/skills`,
      );
    }
  }
}

// J. платформенная полнота: у каждого .sh — сосед .ps1, иначе строка в platform-exceptions.txt
const PLATFORM_FILE = join(CENTER, "platform-exceptions.txt");
const shFiles = walk(DISK, { skipDir: skipService(DISK, undefined), keep: (path) => path.endsWith(".sh") })
  .map(rel)
  .sort();
const exceptions = new Map();
const platformText = readText(PLATFORM_FILE);
if (platformText !== undefined) {
  lines(platformText).forEach(({ line, text: raw }) => {
    const row = raw.trim();
    if (!row || row.startsWith("#")) return;
    const cut = raw.indexOf("|");
    if (cut < 0) {
      addIssue(
        "platform",
        "command-center/platform-exceptions.txt",
        line,
        row,
        "нет причины",
        "исключения платформ",
        `platform: platform-exceptions.txt: строка ${line} без причины — формат «путь|причина», причина обязательна`,
      );
      return;
    }
    const path = raw.slice(0, cut).trim();
    const reason = raw.slice(cut + 1).trim();
    if (!reason) {
      addIssue(
        "platform",
        "command-center/platform-exceptions.txt",
        line,
        path,
        "пустая причина",
        "исключения платформ",
        `platform: platform-exceptions.txt: у ${path} пустая причина — напиши, почему он Unix-only`,
      );
    }
    if (!path.endsWith(".sh")) {
      addIssue(
        "platform",
        "command-center/platform-exceptions.txt",
        line,
        path,
        "не .sh",
        "исключения платформ",
        `platform: platform-exceptions.txt: исключение про ${path}, а он не .sh-скрипт — такие строки тут не нужны`,
      );
    }
    if (exceptions.has(pathKey(path))) {
      addIssue(
        "platform",
        "command-center/platform-exceptions.txt",
        line,
        path,
        "уже было",
        "исключения платформ",
        `platform: platform-exceptions.txt: ${path} назван дважды — оставь одну строку`,
      );
    }
    exceptions.set(pathKey(path), { path, reason });
  });
}

let shCovered = 0;
for (const path of shFiles) {
  if (isFile(join(DISK, path.replace(/\.sh$/, ".ps1")))) {
    shCovered += 1;
    continue;
  }
  if (exceptions.has(pathKey(path))) continue;
  addIssue(
    "platform",
    path,
    0,
    "",
    path.replace(/\.sh$/, ".ps1"),
    "платформенная полнота",
    `platform: ${path} — .sh без соседа ${basename(path.replace(/\.sh$/, ".ps1"))} и нет в platform-exceptions.txt (допиши порт или внеси строку с причиной)`,
  );
}

for (const { path, reason } of exceptions.values()) {
  const abs = join(DISK, path);
  if (!isFile(abs)) {
    addIssue(
      "platform",
      "command-center/platform-exceptions.txt",
      0,
      path,
      "нет файла",
      "исключения платформ",
      `platform: platform-exceptions.txt: ${path} — такого .sh на диске нет (исключение протухло: убери строку)`,
    );
  } else if (isFile(abs.replace(/\.sh$/, ".ps1"))) {
    addIssue(
      "platform",
      "command-center/platform-exceptions.txt",
      0,
      path,
      "есть .ps1",
      "исключения платформ",
      `platform: platform-exceptions.txt: ${path} — у него появился сосед .ps1 «${reason}» больше не причина (исключение протухло: убери строку)`,
    );
  }
}

// K и L. Строгий режим скриптов и покрытие прогона — по тому же приёму, что платформенная полнота:
// правило проверяется в обе стороны, а исключение — это строка «путь|причина» в своём файле.
// Протухшая строка (правило уже выполнено или файла нет) — тоже расхождение: список нельзя ни
// замалчивать, ни забыть.

/** Сколько первых строк скрипта считаются шапкой: строгий режим обязан стоять здесь, до работы. */
const STRICT_LINES = 25;

/**
 * Читает файл исключений формата «путь|причина» (тот же формат, что у platform-exceptions.txt):
 * комментарии и пустые строки пропускаются, строка без причины — расхождение.
 */
function readExceptions(file, kind, what, emptyReasonNote) {
  const map = new Map();
  const text = readText(file);
  if (text === undefined) return map;
  lines(text).forEach(({ line, text: raw }) => {
    const row = raw.trim();
    if (!row || row.startsWith("#")) return;
    const cut = raw.indexOf("|");
    if (cut < 0) {
      addIssue(
        kind,
        rel(file),
        line,
        row,
        "нет причины",
        what,
        `${kind}: ${basename(file)}: строка ${line} без причины — формат «путь|причина», причина обязательна`,
      );
      return;
    }
    const path = raw.slice(0, cut).trim();
    const reason = raw.slice(cut + 1).trim();
    if (!reason) {
      addIssue(kind, rel(file), line, path, "пустая причина", what, `${kind}: ${basename(file)}: у ${path} пустая причина — ${emptyReasonNote}`);
    }
    if (map.has(pathKey(path))) {
      addIssue(kind, rel(file), line, path, "уже было", what, `${kind}: ${basename(file)}: ${path} назван дважды — оставь одну строку`);
    }
    map.set(pathKey(path), { path, reason });
  });
  return map;
}

/** Строгий режим строкой: `set` с флагом u (или -o nounset) и pipefail — иначе скрипт не строгий. */
function strictLine(line) {
  if (!/^\s*set\s/.test(line)) return false;
  const flags = line.match(/(^|\s)-[A-Za-z]+/g) ?? [];
  const hasU = flags.some((flag) => flag.includes("u")) || /\s-o\s+nounset\b/.test(line);
  return hasU && /\bpipefail\b/.test(line);
}

/**
 * Почему скрипт не строгий — одной строкой (пусто = он строгий). Разбираем весь файл, а не только
 * первые строки: иначе про «set на 57-й строке» гейт говорил бы «строки set нет вовсе».
 */
function strictNote(text) {
  const all = lines(text);
  if (all.some(({ text: row }, index) => index < STRICT_LINES && strictLine(row))) return "";
  const first = all.find(({ text: row }) => /^\s*set\s/.test(row));
  if (!first) return "строки set нет вовсе";
  if (first.line > STRICT_LINES) return `строка «${first.text.trim()}» стоит на строке ${first.line}, а нужна в первых ${STRICT_LINES}`;
  return `строка «${first.text.trim()}» без -u или без pipefail`;
}

const STRICT_FILE = join(CENTER, "strict-exceptions.txt");
const strictExceptions = readExceptions(STRICT_FILE, "strict", "исключения строгого режима", "напиши, почему строгий режим здесь не поставить");
const strictViolations = new Map();
for (const path of shFiles) {
  const note = strictNote(readText(join(DISK, path)) ?? "");
  if (!note) continue;
  strictViolations.set(pathKey(path), path);
  if (strictExceptions.has(pathKey(path))) continue;
  addIssue(
    "strict",
    path,
    0,
    "",
    `set с -u и pipefail в первых ${STRICT_LINES} строках`,
    "строгий режим скриптов",
    `strict: ${path} — ${note}; поправь скрипт или внеси строку «путь|причина» в command-center/strict-exceptions.txt`,
  );
}

for (const { path } of strictExceptions.values()) {
  const abs = join(DISK, path);
  if (!isFile(abs)) {
    addIssue(
      "strict",
      "command-center/strict-exceptions.txt",
      0,
      path,
      "нет файла",
      "исключения строгого режима",
      `strict: strict-exceptions.txt: ${path} — такого .sh на диске нет (исключение протухло: убери строку)`,
    );
  } else if (!strictViolations.has(pathKey(path))) {
    addIssue(
      "strict",
      "command-center/strict-exceptions.txt",
      0,
      path,
      "строгий режим есть",
      "исключения строгого режима",
      `strict: strict-exceptions.txt: ${path} — у него уже есть set с -u и pipefail, исключение больше не причина (убери строку)`,
    );
  }
}

// L. Покрытие прогона: наборы, которые зовёт skills-hub/contrib/skills-hub-check.sh, против всех
// наборов на диске. Непокрытый набор обязан быть строкой «путь|причина» в check-coverage-exceptions.txt.
const COVERAGE_FILE = join(CENTER, "check-coverage-exceptions.txt");
const coverageExceptions = readExceptions(COVERAGE_FILE, "coverage", "исключения покрытия прогона", "напиши, почему этот набор не в прогоне");
const batsAll = batsFiles.map(rel).sort();
const uncovered = batsAll.filter((path) => !CHECKED_BATS.has(pathKey(path)));
// Прогон не разобран — покрытие считать нечем: об этом уже сказано расхождением про наборы (см. выше),
// выдумывать здесь «не покрыт никто» нельзя.
const coverageKnown = CHECK_TESTS >= 0;
if (coverageKnown) {
  for (const path of uncovered) {
    if (coverageExceptions.has(pathKey(path))) continue;
    addIssue(
      "coverage",
      path,
      0,
      "",
      "набор не в прогоне",
      "покрытие прогона",
      `coverage: ${path} — набор лежит на диске, а skills-hub/contrib/skills-hub-check.sh его не зовёт (добавь вызов в прогон или строку «путь|причина» в command-center/check-coverage-exceptions.txt)`,
    );
  }

  for (const { path } of coverageExceptions.values()) {
    const abs = join(DISK, path);
    if (!isFile(abs)) {
      addIssue(
        "coverage",
        "command-center/check-coverage-exceptions.txt",
        0,
        path,
        "нет файла",
        "исключения покрытия прогона",
        `coverage: check-coverage-exceptions.txt: ${path} — такого набора на диске нет (исключение протухло: убери строку)`,
      );
    } else if (CHECKED_BATS.has(pathKey(path))) {
      addIssue(
        "coverage",
        "command-center/check-coverage-exceptions.txt",
        0,
        path,
        "набор в прогоне",
        "исключения покрытия прогона",
        `coverage: check-coverage-exceptions.txt: ${path} — набор уже зовётся прогоном, исключение больше не причина (убери строку)`,
      );
    }
  }
}

// ── вывод ────────────────────────────────────────────────────────────────────
const FACTS = `проектов ${PROJECTS}, скиллов в коллекции ${SKILLS}, тестов на диске ${DISK_TESTS} в ${DISK_FILES} файлах, в прогоне center check ${
  CHECK_TESTS >= 0 ? `${CHECK_TESTS} в ${CHECK_FILES} файлах` : "неизвестно"
}, шагов bootstrap ${BOOTSTRAP_STEPS >= 0 ? BOOTSTRAP_STEPS : "неизвестно"}, версия ${VERSION_ACTUAL || "нет"}`;

if (AS_JSON) {
  process.stdout.write(
    `{"ok":${ISSUES.length === 0},"version":"${jesc(VERSION_ACTUAL)}","facts":{"projects":${PROJECTS},"skills":${SKILLS},"tests_all":${DISK_TESTS},"bats_files_all":${DISK_FILES},"tests_center_check":${CHECK_TESTS},"bats_files_center_check":${CHECK_FILES},"bootstrap_steps":${BOOTSTRAP_STEPS},"sh_files":${shFiles.length},"sh_with_ps1":${shCovered},"platform_exceptions":${exceptions.size},"strict_sh":${shFiles.length},"strict_violations":${strictViolations.size},"strict_exceptions":${strictExceptions.size},"bats_covered":${CHECKED_BATS.size},"bats_uncovered":${coverageKnown ? uncovered.length : -1},"coverage_exceptions":${coverageExceptions.size}},"docs_scanned":${DOCS_SCANNED},"commands_checked":${COMMANDS_CHECKED},"mismatches":[${ITEMS.join(",")}]}\n`,
  );
  process.exit(ISSUES.length === 0 ? 0 : 1);
}

if (QUIET === 0) {
  process.stdout.write(`docs-check: факт — ${FACTS}\n`);
  process.stdout.write(`docs-check: прочитано доков ${DOCS_SCANNED}, проверено команд ${COMMANDS_CHECKED}\n`);
  if (BROKEN_SCAN) {
    process.stdout.write(`docs-check: ${BROKEN_SCAN} не найден — числа прогона check не сверяются\n`);
  }
  process.stdout.write(
    `docs-check: платформы — .sh ${shFiles.length}, с соседом .ps1 ${shCovered}, в исключениях ${exceptions.size}\n`,
  );
  process.stdout.write(
    `docs-check: строгий режим — .sh ${shFiles.length}, без set с -u и pipefail в первых ${STRICT_LINES} строках ${strictViolations.size}, в strict-exceptions.txt ${strictExceptions.size}\n`,
  );
  process.stdout.write(
    `docs-check: покрытие прогона — наборов bats на диске ${batsAll.length}, зовёт skills-hub-check.sh ${CHECKED_BATS.size}, вне прогона ${
      coverageKnown ? uncovered.length : "неизвестно"
    }, в check-coverage-exceptions.txt ${coverageExceptions.size}\n`,
  );
}

if (ISSUES.length === 0) {
  process.stdout.write("docs-check: числа и списки в доках сходятся с фактом\n");
  process.exit(0);
}

process.stdout.write(`${ISSUES.join("\n")}\n`);
process.stdout.write(
  `docs-check: расхождений ${ISSUES.length} — поправь доки (числа берутся из кода/реестра, не наоборот)\n`,
);
process.exit(1);
