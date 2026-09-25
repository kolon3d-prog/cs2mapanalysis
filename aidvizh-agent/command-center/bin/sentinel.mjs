#!/usr/bin/env node
/**
 * sentinel: сторож набора — жив ли диск DATA и живы ли ссылки в $HOME.
 *
 * Зачем отдельная проверка: все прочие проверки набора живут НА диске, поэтому пропажа диска
 * означает, что проверять нечем, — а симлинки в $HOME при этом молча мертвы. Сторож отвечает
 * на один вопрос «набор на месте и связи целы?» и отвечает так, чтобы это было видно из таймера:
 * ноль — всё живо, единица и список мёртвого — нет.
 *
 * Проверки:
 *   (а) каталог набора существует И является точкой монтирования (своё устройство или запись
 *       в /proc/mounts; на Windows — просто существование: точек монтирования там нет);
 *   (б) каждая ссылка из expectLinks всех проектов реестра резолвится в существующую цель внутри набора;
 *   (в) VERSION читается.
 *
 * Пути берутся от расположения скрипта и $HOME (никаких абсолютных путей в коде): реестр — рядом
 * с движком, набор — родитель каталога центра, дом — $HOME. Хуки для тестов те же, что у центра:
 * CENTER_HOME, CENTER_REGISTRY, CENTER_PLATFORM, CENTER_PROC_ROOT.
 *
 * Использование: bin/sentinel.mjs [--json] [--quiet]
 *   --json   машинный вывод (ok, диск, ссылки, версия, проблемы)
 *   --quiet  печатать только проблемы (режим таймера)
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DISK = dirname(ROOT);
const HOME = process.env.CENTER_HOME || homedir();
const REGISTRY = process.env.CENTER_REGISTRY ? resolve(process.env.CENTER_REGISTRY) : join(ROOT, "registry.json");
const PLATFORM = process.env.CENTER_PLATFORM || process.platform;
const IS_WIN = PLATFORM === "win32";
const PROC_ROOT = process.env.CENTER_PROC_ROOT ? resolve(process.env.CENTER_PROC_ROOT) : "/proc";

const HELP = `sentinel: сторож набора — жив ли диск DATA и живы ли ссылки в $HOME

  sentinel [--json] [--quiet]

  --json   машинный вывод (ok, диск, ссылки, версия, проблемы)
  --quiet  печатать только проблемы (режим таймера)

код 0 — всё живо, 1 — есть мёртвое (список строкой). Диск — ${DISK}, реестр — ${REGISTRY}
`;

const argv = process.argv.slice(2);
let AS_JSON = false;
let QUIET = false;
for (const arg of argv) {
  if (arg === "--json") AS_JSON = true;
  else if (arg === "--quiet") QUIET = true;
  else if (arg === "-h" || arg === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  } else {
    process.stderr.write(`sentinel: неизвестный флаг ${arg} (см. sentinel --help)\n`);
    process.exit(2);
  }
}

/** Путь из реестра в путь на диске: `$HOME` (так он там и записан) и `~` — это домашний каталог. */
function expand(path) {
  if (path === "~") return HOME;
  if (path.startsWith("~/") || path.startsWith(`~${sep}`)) return join(HOME, path.slice(2));
  return path.replaceAll("$HOME", HOME);
}

/** Путь внутри каталога (или он сам) — так отличаем цель в наборе от цели в чужом месте. */
function inside(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * Состояние каталога набора: существует ли он и лежит ли НА СВОЁМ диске.
 *
 * Набор стоит не в корне диска (`/run/media/<кто>/DATA/AGGG`), поэтому «точка монтирования» — это
 * ближайший предок из /proc/mounts, а не сам каталог. Признак живого диска: такая точка есть и она
 * не корень ФС. Диск отвалился — записи в /proc/mounts нет, каталог достаётся корневой ФС, и это
 * ровно то, что сторож обязан назвать. Где /proc/mounts нет (macOS), остаётся сравнение устройств:
 * своё устройство у набора или у его родителя — значит отдельный диск. На Windows точек монтирования
 * нет: там честный ответ только про существование пути.
 */
function mountState(path) {
  let dev;
  try {
    dev = statSync(path).dev;
  } catch (error) {
    return { exists: false, dev: null, mountPoint: null, error: error.code ?? error.message };
  }
  let parentDev = null;
  try {
    parentDev = statSync(dirname(path)).dev;
  } catch {
    parentDev = null;
  }
  let rootDev = null;
  try {
    rootDev = statSync(sep).dev;
  } catch {
    rootDev = null;
  }

  let mountPoint = null;
  let mountsRead = false;
  if (!IS_WIN) {
    try {
      const real = realpathSync(path);
      for (const line of readFileSync(join(PROC_ROOT, "mounts"), "utf8").split("\n")) {
        const fields = line.split(" ");
        // пробелы в путях /proc/mounts экранирует как \040: у наших путей их нет, разбор простой
        if (fields.length < 3) continue;
        const where = fields[1];
        if (!inside(real, where)) continue;
        if (mountPoint === null || where.length > mountPoint.length) mountPoint = where;
      }
      mountsRead = true;
    } catch {
      // нет /proc/mounts (не Linux) — остаётся сравнение устройств
    }
  }

  const onOwnDevice = rootDev !== null && dev !== rootDev;
  const mounted = IS_WIN
    ? true
    : mountsRead
      ? mountPoint !== null && mountPoint !== sep
      : onOwnDevice || (parentDev !== null && dev !== parentDev);

  return { exists: true, dev, parentDev, rootDev, mountPoint, mountsRead, onOwnDevice, mounted };
}

/**
 * Первый симлинк в пути — от дома и вниз (как это видит шелл). Ссылкой бывает и сам каталог
 * скилла, и файл внутри него, поэтому сначала смотрим указанный путь, потом `путь/SKILL.md`.
 * Выше дома не поднимаемся: системные ссылки (например /var на macOS) к набору не относятся.
 */
function firstSymlink(path) {
  const home = resolve(HOME);
  const chain = [];
  let current = resolve(path);
  while (true) {
    if (current !== home && !current.startsWith(`${home}${sep}`)) break;
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of chain) {
    try {
      if (!lstatSync(candidate).isSymbolicLink()) continue;
      const target = readlinkSync(candidate);
      const absolute = target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
      return absolute ? target : resolve(dirname(candidate), target);
    } catch {
      return undefined; // компонент пути не существует — ссылки нет
    }
  }
  return undefined;
}

/** Состояние ссылки: есть ли, ведёт ли в существующую цель и внутри ли набора эта цель. */
function linkState(link, { allowCopy = false } = {}) {
  const target = firstSymlink(link) ?? firstSymlink(join(link, "SKILL.md"));
  if (target === undefined) {
    if (!existsSync(link)) return { ok: false, why: "ссылки нет: путь не существует" };
    return allowCopy
      ? { ok: true, why: "копия, не ссылка (установщик так и ставит — это рабочее состояние)" }
      : { ok: false, why: "не ссылка: на месте обычный файл или каталог" };
  }
  if (!existsSync(target)) return { ok: false, why: `мёртвая ссылка: цель ${target} не существует` };
  if (!inside(target, DISK)) return { ok: false, why: `цель ${target} вне набора ${DISK} — после пропажи диска она не вернётся` };
  return { ok: true, why: `→ ${target}` };
}

const problems = [];
const disk = mountState(DISK);
if (!disk.exists) {
  problems.push(`диск DATA не найден: каталога ${DISK} нет (${disk.error})`);
} else if (!disk.mounted) {
  problems.push(
    disk.mountsRead && disk.mountPoint === sep
      ? `набор лежит на корневой ФС (${DISK}), а не на отдельном диске DATA — диск DATA не примонтирован, ссылки в $HOME мертвы`
      : `не нашёл точку монтирования для ${DISK} в ${join(PROC_ROOT, "mounts")} — диск DATA не примонтирован, ссылки в $HOME мертвы`,
  );
}

let projects = [];
try {
  const data = JSON.parse(readFileSync(REGISTRY, "utf8"));
  if (!Array.isArray(data.projects)) throw new Error("поле projects — не список");
  projects = data.projects;
} catch (error) {
  problems.push(`реестр не разобран: ${REGISTRY}: ${error.message}`);
}

const links = [];
for (const project of projects) {
  for (const { link, into, allowCopy } of project.expectLinks ?? []) {
    const expanded = expand(link);
    const state = linkState(expanded, { allowCopy });
    const who = Array.isArray(into) ? into.join("|") : into;
    links.push({ link: expanded, project: project.name, into, ok: state.ok, why: state.why });
    if (!state.ok) problems.push(`${expanded} (${project.name} → ${who}): ${state.why}`);
  }
}

let version = "";
try {
  version = readFileSync(join(DISK, "VERSION"), "utf8").trim();
  if (!version) problems.push(`VERSION пуст: ${join(DISK, "VERSION")} — версию набора не прочитать`);
} catch (error) {
  problems.push(`VERSION не читается: ${join(DISK, "VERSION")}: ${error.code ?? error.message}`);
}

const ok = problems.length === 0;
const broken = links.filter((row) => !row.ok).length;

if (AS_JSON) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        disk: DISK,
        registry: REGISTRY,
        home: HOME,
        mounted: disk.exists && disk.mounted,
        mountPoint: disk.mountPoint ?? null,
        device: disk.dev ?? null,
        rootDevice: disk.rootDev ?? null,
        links: { total: links.length, ok: links.length - broken, broken },
        version,
        problems,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(ok ? 0 : 1);
}

if (!ok) {
  process.stdout.write(`sentinel: мёртвое — ${problems.length}\n`);
  for (const problem of problems) process.stdout.write(`— ${problem}\n`);
  process.stdout.write(`\nsentinel: ссылок мёртвых ${broken} из ${links.length}, версия набора ${version || "не прочитана"}\n`);
  process.exit(1);
}

if (!QUIET) {
  const where = IS_WIN ? DISK : `${disk.mountPoint ?? "?"} (набор ${DISK})`;
  process.stdout.write(
    `sentinel: диск DATA примонтирован: ${where}, ссылок целых ${links.length} из ${links.length}, версия набора ${version}\n`,
  );
}
process.exit(0);
