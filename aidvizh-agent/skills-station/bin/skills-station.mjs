#!/usr/bin/env node
// skills-station — раскладывает выбранные скиллы из своей коллекции по слоям клиентов.
//
// Коллекция — копии сторонних скиллов рядом со станцией (collection/<имя>/), источник каждого записан
// в collection/catalog.json; своё кладём туда же ссылкой на файл в его репозитории.
// Установка идёт в слой: глобальный, проектный, клиентский или явный путь.
// Пути считаются от $HOME и текущего каталога — абсолютных путей нигде не прописано.
import {
  readFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, cpSync, renameSync, symlinkSync,
  lstatSync, readlinkSync, openSync, writeSync, closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bodyHead, collectSkills, findSkill, firstLine, parseFrontmatter, parseSkill, searchSkills,
} from "./lib/skill-index.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COLLECTION = process.env.SKILLS_STATION_COLLECTION || join(ROOT, "collection");
const HOME = process.env.SKILLS_STATION_HOME || homedir();
const CWD = process.env.SKILLS_STATION_CWD || process.cwd();

const LAYERS = {
  global: () => join(HOME, ".agents/skills"),
  project: () => join(CWD, ".agents/skills"),
  opencode: () => (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "opencode/skills") : join(HOME, ".config/opencode/skills")),
  claude: () => join(HOME, ".claude/skills"),
};

function usage() {
  process.stdout.write(`skills-station — скиллы из коллекции по слоям

  skills-station list                        что есть в коллекции (имя, источник, описание)
  skills-station find <запрос>               поиск по УСТАНОВЛЕННЫМ скиллам (слои + коллекция)
  skills-station show <имя>                  описание и первые строки тела скилла
  skills-station install <имена...|all>      разложить скиллы в слой
  skills-station remove <имена...|all>       снять из слоя
  skills-station status                      что стоит в слое против коллекции
  skills-station verify                      проверить целостность коллекции и установок

Флаги:
  --layer global|project|opencode|claude   куда ставить (по умолчанию global)
  --dir <путь>                             явный каталог вместо слоя
  --mode link|copy                         ссылкой (по умолчанию) или копией
  --limit <N>                              сколько находок отдать (find; по умолчанию 10)
  --dry-run                                показать, что будет сделано
  --force                                  заменить существующий target с backup
  --json                                   машинный вывод там, где он есть

Поиск идёт по имени, описанию и телу SKILL.md, слои: project, global, opencode, claude,
collection. Ищется сначала по всем словам запроса, если пусто — по любому из них;
пустая выдача отдаёт ближайшие похожие имена. Код возврата find: 0 — нашлось, 1 — нет.

Запись в слой идёт под общим локом с хабом: глобально это ~/.agents/.skill-lock.json,
при --layer project — <проект>/skills-lock.json. Лок занят живым прогоном — станция ждёт
и говорит «слой занят», вместо того чтобы писать поверх чужой установки.

Коллекция: ${COLLECTION}
Слои: global=${LAYERS.global()}  project=${LAYERS.project()}
`);
}

/** Слои для движка: дом, проект и коллекция — те же, что у установки. */
function engineEnv() {
  return {
    home: HOME,
    cwd: CWD,
    collection: COLLECTION,
    configHome: process.env.XDG_CONFIG_HOME,
  };
}

function catalog() {
  const file = join(COLLECTION, "catalog.json");
  const map = new Map();
  if (existsSync(file)) {
    for (const row of JSON.parse(readFileSync(file, "utf8"))) map.set(row.name, row.source);
  }
  return map;
}

/** Скиллы коллекции: каталоги с SKILL.md; описание берём из frontmatter. */
function collection() {
  if (!existsSync(COLLECTION)) return [];
  const sources = catalog();
  return readdirSync(COLLECTION)
    .filter((name) => {
      const path = join(COLLECTION, name);
      return statSync(path).isDirectory() && existsSync(join(path, "SKILL.md"));
    })
    .sort()
    .map((name) => {
      const path = join(COLLECTION, name);
      const text = readFileSync(join(path, "SKILL.md"), "utf8");
      // блочное описание (>- , |) в колонку не влезает — берём первую строку, а не маркер блока
      const description = firstLine(parseSkill(text, join(path, "SKILL.md"), "collection", name).description);
      const files = readdirSync(path, { recursive: true }).length;
      return { name, path, source: sources.get(name) ?? "?", description, files };
    });
}

function targetDir(flags) {
  if (flags.dir) return resolve(flags.dir);
  if (!LAYERS[flags.layer]) throw new Error(`--layer принимает ${Object.keys(LAYERS).join(", ")} или задай --dir`);
  return LAYERS[flags.layer]();
}

// ── лок записи в слой ────────────────────────────────────────────────────────────────────────────
// Глобальный слой `~/.agents/skills` пишут двое: хаб (маркеты через `npx skills`) и станция. Хаб
// держит свои записи в файле-локе — `~/.agents/.skill-lock.json`, при `--project` `<проект>/skills-lock.json`
// (те же пути считает `skills-manager`), но поверх него OS-лока не берёт: `skills CLI` пишет его
// обычным read-modify-write. Поэтому станция берёт тот же путь под свой файл-владелец рядом с ним,
// создаваемый атомарно (`wx`) и содержащий pid и время. `flock` в node нет, а атомарное создание
// файла есть и на POSIX, и на Windows — приём один на обеих ОС. Сам JSON маркета станция не трогает:
// там записи `skills CLI`.
// Что это даёт: два прогона станции (и любой, кто возьмёт тот же лок) в слой одновременно не пишут;
// параллельный `npx skills add` этим локом не остановить — он про него не знает (это граница, не баг).
// Протухший лок (pid мёртв или старше TTL) снимает следующий пришедший — как замок браузера в mcp-station.

/** Сколько живёт лок без обновления: старше — протухшая, её снимает тот, кто пришёл следующим. */
const LOCK_TTL_MS = 1800 * 1000;
/** Сколько ждать мёртвый лок, прежде чем счесть его брошенным (у только что созданного pid мог не записаться). */
const LOCK_GRACE_MS = 2000;
/** Сколько ждать занятый лок: значение из окружения (тесты торопят), по умолчанию 30 с. */
function lockWaitMs() {
  const raw = Number(process.env.SKILLS_STATION_LOCK_WAIT_MS ?? 30000);
  if (!Number.isFinite(raw) || raw < 0) throw new Error("SKILLS_STATION_LOCK_WAIT_MS принимает число миллисекунд");
  return raw;
}

/** Как часто перепроверять занятый лок, пока не вышло время ожидания. */
const LOCK_POLL_MS = 100;

/** Лок-файл, которым хаб сериализует записи в этот слой; null — слой хаб не пишет (opencode/claude/свой путь). */
function hubLockPath(dir) {
  const target = resolve(dir);
  if (target === resolve(HOME, ".agents/skills")) return join(HOME, ".agents/.skill-lock.json");
  if (target === resolve(CWD, ".agents/skills")) return join(CWD, "skills-lock.json");
  return null;
}

/** Жив ли владелец лока: сигнал 0 ничего не убивает, а только спрашивает про процесс. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Владелец лока: pid и время старта; нечитаемый файл судим по времени изменения. */
function lockOwner(holder) {
  try {
    const info = JSON.parse(readFileSync(holder, "utf8"));
    const pid = Number(info.pid);
    const startedAt = Date.parse(info.started);
    return { pid, startedAt: Number.isFinite(startedAt) ? startedAt : 0, alive: pidAlive(pid) };
  } catch {
    let startedAt = 0;
    try {
      startedAt = statSync(holder).mtimeMs;
    } catch {
      startedAt = Date.now();
    }
    return { pid: 0, startedAt, alive: false };
  }
}

/** Пауза без async: движок синхронный, а ждать лок надо — Atomics.wait просыпается по таймауту. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Взять лок слоя: возвращает снятие. Не взяли (слой занят живым владельцем) — исключение, а не запись. */
function takeLayerLock(lockPath) {
  const holder = `${lockPath}.lock`;
  mkdirSync(dirname(holder), { recursive: true });
  const deadline = Date.now() + lockWaitMs();
  for (;;) {
    try {
      const fd = openSync(holder, "wx");
      writeSync(fd, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString() })}\n`);
      closeSync(fd);
      return () => {
        try {
          rmSync(holder, { force: true });
        } catch {
          /* лок уже снят — снимать нечего */
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const owner = lockOwner(holder);
    const ageMs = Date.now() - owner.startedAt;
    if (ageMs > LOCK_TTL_MS || (!owner.alive && ageMs > LOCK_GRACE_MS)) {
      process.stdout.write(`лок слоя протух (pid ${owner.pid || "?"}) — снимаю и беру свой\n`);
      rmSync(holder, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `слой занят: ${holder} держит pid ${owner.pid} с ${new Date(owner.startedAt).toISOString()}` +
          `; владельца нет — снять: rm ${holder}`,
      );
    }
    sleep(LOCK_POLL_MS);
  }
}

/** Запись в слой под локом хаба; dry-run ничего не пишет и лока не берёт. */
function withLayerLock(dir, flags, body) {
  const lockPath = flags.dryRun ? null : hubLockPath(dir);
  const release = lockPath ? takeLayerLock(lockPath) : () => {};
  try {
    return body();
  } finally {
    release();
  }
}


function select(names) {
  const all = collection();
  if (names.length === 0 || names[0] === "all") return all;
  return names.map((name) => {
    const found = all.find((skill) => skill.name === name);
    if (!found) throw new Error(`в коллекции нет скилла ${name} (см. skills-station list)`);
    return found;
  });
}

function linkTarget(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return readlinkSync(path);
  } catch {
    return undefined;
  }
  return undefined;
}

/** Копия дерева с разыменованием: у скиллов коллекции SKILL.md может быть ссылкой наружу,
 *  а cpSync такую ссылку сохраняет — копия осталась бы зависимой от источника. */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    if (statSync(src).isDirectory()) copyTree(src, join(to, entry));
    else copyFileSync(src, join(to, entry));
  }
}

function sameContent(a, b) {
  const left = readdirSync(a, { recursive: true }).sort();
  const right = readdirSync(b, { recursive: true }).sort();
  if (left.length !== right.length || left.some((file, index) => file !== right[index])) return false;
  for (const file of left) {
    if (statSync(join(a, file)).isDirectory()) continue;
    if (!readFileSync(join(a, file)).equals(readFileSync(join(b, file)))) return false;
  }
  return true;
}

function cmdList(asJson) {
  const rows = collection();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows.map(({ name, source, files }) => ({ name, source, files })), null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`коллекция: ${rows.length} скиллов в ${COLLECTION}\n\n`);
  for (const row of rows) {
    process.stdout.write(`${row.name.padEnd(32)} ${String(row.files).padStart(4)} файлов  ${(row.source ?? "?").padEnd(28)} ${row.description.slice(0, 60)}\n`);
  }
  return 0;
}

function cmdFind(query, flags) {
  const skills = collectSkills(engineEnv());
  const found = searchSkills(skills, query, flags.limit ?? 10);
  if (flags.json) {
    const payload = { ok: true, query: found.query, count: found.results.length, results: found.results };
    if (found.suggestions.length) payload.suggestions = found.suggestions;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return found.results.length ? 0 : 1;
  }
  const note = found.mode === "or"
    ? " (по отдельным словам — разом не нашлось)"
    : found.mode === "mixed" ? " (все слова разом нашлись не везде)" : "";
  if (found.query === "") {
    process.stdout.write(`установлено ${found.total} скиллов; первые ${found.results.length} по имени\n\n`);
  } else {
    process.stdout.write(`найдено ${found.results.length} из ${found.total} скиллов по запросу «${found.query}»${note}\n\n`);
  }
  for (const row of found.results) {
    process.stdout.write(`${row.name}  [${row.layer}]  ${row.score}\n`);
    process.stdout.write(`  ${firstLine(row.description, 110)}\n`);
    process.stdout.write(`  ${row.snippet}\n`);
    process.stdout.write(`  ${row.path}\n`);
  }
  if (found.results.length === 0) {
    process.stdout.write("совпадений нет\n");
    process.stdout.write(`ближайшие имена: ${found.suggestions.length ? found.suggestions.map((row) => `${row.name} [${row.layer}]`).join(", ") : "—"}\n`);
  }
  return found.results.length ? 0 : 1;
}

function cmdShow(name, flags) {
  const skills = collectSkills(engineEnv());
  const found = findSkill(skills, name);
  if (!found.skill) {
    const similar = (found.suggestions ?? []).map((row) => `${row.name} [${row.layer}]`).join(", ");
    process.stderr.write(`skills-station: скилла «${name}» нет${similar ? `; похожие: ${similar}` : ""}\n`);
    return 1;
  }
  const skill = found.skill;
  const head = bodyHead(skill, 40);
  if (flags.json) {
    const { name: skillName, layer, path, description } = skill;
    process.stdout.write(`${JSON.stringify({ ok: true, name: skillName, layer, path, description, body: head }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${skill.name} [${skill.layer}]\nпуть: ${skill.path}\n\n${skill.description}\n\n${head}\n`);
  return 0;
}

function backupExisting(target) {
  let backup = `${target}.bak`;
  let index = 1;
  while (existsSync(backup)) {
    backup = `${target}.bak.${index}`;
    index += 1;
  }
  renameSync(target, backup);
  return backup;
}

function installTarget(source, target, mode) {
  const temporary = `${target}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    if (mode === "copy") copyTree(source, temporary);
    else {
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

function cmdInstall(names, flags) {
  const dir = targetDir(flags);
  const skills = select(names);
  return withLayerLock(dir, flags, () => {
    if (!flags.dryRun) mkdirSync(dir, { recursive: true });
    for (const skill of skills) {
      const target = join(dir, skill.name);
      const existing = linkTarget(target);
      if (existing && resolve(dirname(target), existing) === skill.path) {
        process.stdout.write(`${skill.name.padEnd(32)} уже стоит\n`);
        continue;
      }
      let action = "пишу";
      if (existsSync(target)) {
        if (!existing && flags.mode === "copy" && sameContent(skill.path, target)) {
          process.stdout.write(`${skill.name.padEnd(32)} уже стоит (копия совпадает)\n`);
          continue;
        }
        action = existing ? "переставляю" : "заменяю чужое";
      }
      process.stdout.write(`${skill.name.padEnd(32)} ${action} -> ${target}\n`);
      if (flags.dryRun) continue;
      if ((existsSync(target) || existing) && !flags.force) {
        throw new Error(`${skill.name}: target уже существует; для замены нужен --force (backup будет создан рядом)`);
      }
      if (existsSync(target) || existing) {
        const backup = backupExisting(target);
        process.stdout.write(`${skill.name.padEnd(32)} backup → ${backup}\n`);
      }
      installTarget(skill.path, target, flags.mode);
    }
    process.stdout.write(flags.dryRun ? "\n(dry-run: ничего не записано)\n" : `\nслой ${dir}: готово\n`);
    return 0;
  });
}

function cmdRemove(names, flags) {
  const dir = targetDir(flags);
  const skills = names.length === 0 || names[0] === "all" ? collection().filter((skill) => existsSync(join(dir, skill.name))) : select(names);
  return withLayerLock(dir, flags, () => {
    for (const skill of skills) {
      const target = join(dir, skill.name);
      if (!existsSync(target) && !linkTarget(target)) {
        process.stdout.write(`${skill.name.padEnd(32)} и так нет\n`);
        continue;
      }
      process.stdout.write(`${skill.name.padEnd(32)} снимаю ${target}\n`);
      if (!flags.dryRun) rmSync(target, { recursive: true, force: true });
    }
    process.stdout.write(flags.dryRun ? "\n(dry-run: ничего не удалено)\n" : `\nслой ${dir}: снято\n`);
    return 0;
  });
}

function cmdStatus(flags) {
  const dir = targetDir(flags);
  const known = new Set(collection().map((skill) => skill.name));
  if (!existsSync(dir)) {
    process.stdout.write(`слой пуст: ${dir}\n`);
    return 1;
  }
  const installed = readdirSync(dir).sort();
  const fromCollection = installed.filter((name) => known.has(name));
  const alien = installed.filter((name) => !known.has(name));
  // битые ссылки считаем по всему слою, а не только по тому, что ещё есть в коллекции
  const broken = installed.filter((name) => {
    const target = join(dir, name);
    const link = linkTarget(target);
    if (!link) return false;
    // ссылка может быть абсолютной или относительной — проверяем так же, как её понял бы шелл
    return !existsSync(link.startsWith("/") ? link : resolve(dirname(target), link));
  });
  const missing = [...known].filter((name) => !installed.includes(name));
  process.stdout.write(`слой: ${dir}\n  стоит из коллекции: ${fromCollection.length}\n  вне коллекции: ${alien.length}${alien.length ? ` (${alien.slice(0, 6).join(", ")}${alien.length > 6 ? ", …" : ""})` : ""}\n  нет из коллекции: ${missing.length}\n  битых ссылок: ${broken.length}${broken.length ? ` (${broken.join(", ")})` : ""}\n`);
  return broken.length === 0 ? 0 : 1;
}

/** SKILL.md скилла может быть ссылкой на файл в его репозитории: битую ссылку collection()
 *  молча выкидывает из списка, поэтому verify ищет её отдельно — иначе ошибка пройдёт зелёной. */
function brokenSkillLinks() {
  const problems = [];
  if (!existsSync(COLLECTION)) return problems;
  for (const name of readdirSync(COLLECTION).sort()) {
    const skill = join(COLLECTION, name, "SKILL.md");
    const link = linkTarget(skill);
    if (link && !existsSync(skill)) problems.push(`${name}: SKILL.md — битая ссылка (${link})`);
  }
  return problems;
}

function cmdVerify(asJson) {
  const rows = collection();
  const problems = brokenSkillLinks();
  for (const row of rows) {
    const text = readFileSync(join(row.path, "SKILL.md"), "utf8");
    // парсер движка, а не строковый regex: у блочного описания (`description: >-`) описание есть
    const { fields } = parseFrontmatter(text);
    if (!(fields.get("name") ?? "").trim()) problems.push(`${row.name}: нет name в frontmatter`);
    if (!(fields.get("description") ?? "").trim()) problems.push(`${row.name}: нет description в frontmatter`);
  }
  if (asJson) process.stdout.write(`${JSON.stringify({ skills: rows.length, problems }, null, 2)}\n`);
  else if (problems.length === 0) process.stdout.write(`коллекция в порядке: ${rows.length} скиллов, у каждого SKILL.md с name и description\n`);
  else process.stdout.write(problems.join("\n") + "\n");
  return problems.length === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
const commands = new Set(["list", "find", "show", "install", "remove", "status", "verify"]);
const flags = { layer: "global", dir: null, mode: "link", dryRun: false, force: false, json: false, limit: null };
let command = "list";
const positional = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (commands.has(arg) && i === 0) command = arg;
  else if (arg === "--layer") flags.layer = argv[++i];
  else if (arg === "--dir") flags.dir = argv[++i];
  else if (arg === "--mode") flags.mode = argv[++i];
  else if (arg === "--limit") flags.limit = Number(argv[++i]);
  else if (arg === "--dry-run") flags.dryRun = true;
  else if (arg === "--force") flags.force = true;
  else if (arg === "--json") flags.json = true;
  else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    process.stderr.write(`skills-station: неизвестный флаг ${arg}\n`);
    process.exit(2);
  } else positional.push(arg);
}

try {
  if (!["link", "copy"].includes(flags.mode)) throw new Error("--mode принимает link или copy");
  if (flags.limit !== null && (!Number.isInteger(flags.limit) || flags.limit < 1)) {
    throw new Error("--limit принимает целое от 1 и выше");
  }
  let code = 0;
  if (command === "list") code = cmdList(flags.json);
  else if (command === "find") code = cmdFind(positional.join(" "), flags);
  else if (command === "show") {
    if (positional.length === 0) throw new Error("show: укажи имя скилла (см. skills-station find)");
    code = cmdShow(positional.join(" "), flags);
  } else if (command === "install") code = cmdInstall(positional, flags);
  else if (command === "remove") code = cmdRemove(positional, flags);
  else if (command === "status") code = cmdStatus(flags);
  else if (command === "verify") code = cmdVerify(flags.json);
  process.exit(code);
} catch (error) {
  process.stderr.write(`skills-station: ${error.message}\n`);
  process.exit(1);
}
