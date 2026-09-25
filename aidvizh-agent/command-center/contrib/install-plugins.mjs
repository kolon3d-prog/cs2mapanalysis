#!/usr/bin/env node
// Плагины центра: ссылки слэш-команды /center в каталоги трёх клиентов.
//
// Единственный движок установки: обёртки contrib/install-plugins.sh и contrib/install-plugins.ps1
// зовут его, поэтому на Windows и на Unix ставится одно и то же, а формат строк не разъезжается.
//
//   contrib/install-plugins.sh [install|uninstall|status] [--dry-run]
//
// Пути считаются от самого движка и от $HOME — абсолютных путей диска здесь нет.
// Идемпотентно: если ссылка уже ведёт сюда, ничего не делает.
// Живой файл клиента на месте ссылки не затирается: он уезжает в <файл>.bak.
//
// Тип связи: символическая ссылка → junction для каталогов (Windows даёт его без прав) → копия.
// Копия — последнее средство: она не следит за правками в станции, и об этом говорится прямо.
// CENTER_LINK_MODE (например «copy» или «junction,copy») — хук для тестов: чем пробовать связывать.
import {
  readFileSync,
  writeFileSync,
  readlinkSync,
  lstatSync,
  statSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  cpSync,
} from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SELF = fileURLToPath(import.meta.url);
const CENTER = dirname(dirname(SELF));
const PLUGIN = join(CENTER, "plugin");
const HOME = process.env.HOME || homedir();
const PLATFORM = process.env.CENTER_PLATFORM || process.platform;

const HELP = `usage: install-plugins [install|uninstall|status] [--dry-run]

  install    ссылки на плагин /center в каталоги клиентов (opencode2, omp, pi)
  uninstall  снять только свои ссылки (чужое не трогает)
  status     что стоит и куда ведёт
  --dry-run  показать, ничего не меняя
  CENTER_LINK_MODE=symlink,junction,copy — чем связывать (по умолчанию все три, по порядку)`;

let MODE = "install";
let DRY = 0;
for (const arg of process.argv.slice(2)) {
  if (arg === "install" || arg === "uninstall" || arg === "status") MODE = arg;
  else if (arg === "--dry-run") DRY = 1;
  else if (arg === "-h" || arg === "--help") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`install-plugins: не знаю аргумент ${arg} (install|uninstall|status|--dry-run)\n`);
    process.exit(2);
  }
}

/** Чем разрешено связывать: симлинк → junction (только каталоги) → копия. */
const LINK_MODES = ["symlink", "junction", "copy"];

function linkModes() {
  const raw = process.env.CENTER_LINK_MODE;
  if (!raw) return LINK_MODES;
  const known = raw
    .split(",")
    .map((mode) => mode.trim())
    .filter((mode) => LINK_MODES.includes(mode));
  if (known.length === 0) {
    process.stderr.write(`install-plugins: CENTER_LINK_MODE=${raw} — не знаю ни одного типа (${LINK_MODES.join(", ")})\n`);
    process.exit(2);
  }
  return known;
}

// Что куда ставится: каталог клиента → исходник в станции.
const OPENCODE_CONFIG = process.env.XDG_CONFIG_HOME || join(HOME, ".config/opencode");
const TARGETS = [
  { who: "opencode", dst: join(OPENCODE_CONFIG, "plugins/center.ts"), src: join(PLUGIN, "opencode/center.ts") },
  { who: "omp", dst: join(HOME, ".omp/agent/extensions/center.ts"), src: join(PLUGIN, "agent/center.ts") },
  { who: "pi", dst: join(HOME, ".pi/agent/extensions/center.ts"), src: join(PLUGIN, "agent/center.ts") },
];

const say = (text) => process.stdout.write(`${text}\n`);
const warn = (text) => process.stderr.write(`${text}\n`);
const pad = (who) => who.padEnd(10);
// Префиксы ровно как в bash-версии, вместе с её пробелами: у install «кладу » (дальше ещё пробел
// из формата), у uninstall «снимаю» без хвоста.
const installVerb = () => (DRY ? "будет " : "кладу ");
const removeVerb = () => (DRY ? "будет " : "снимаю");

/** Каталог ли это (по ссылке смотрим на настоящий объект). */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Что-то ли на месте: файл, каталог или ссылка (в том числе битая). */
function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Сырая цель ссылки — как её вернул readlink (у junction на Windows она с префиксом \\?\). */
function rawLink(path) {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** Куда ведёт ссылка — абсолютным путём, как это поймёт шелл. */
function linkTargetOf(path) {
  const raw = rawLink(path);
  if (raw === undefined) return undefined;
  const clean = raw.replace(/^\\\\\?\\/, "");
  return isAbsolute(clean) ? clean : resolve(dirname(path), clean);
}

/** Совпадают ли пути: на Windows регистр не значим, оба приводим к абсолютному виду. */
function samePath(left, right) {
  const norm = (path) => {
    const clean = resolve(path);
    return PLATFORM === "win32" ? clean.toLowerCase() : clean;
  };
  return norm(left) === norm(right);
}

/** Наша ли это копия и свежая ли она: обычный файл в месте ссылки, а не чужая правка клиента.
 *  Свежая — совпадает с исходником байт в байт; записанная, но разошедшаяся — устаревшая копия
 *  (её можно обновить на месте). Запись о копиях лежит в состоянии центра: без неё устаревшую копию
 *  не отличить от чужого файла, и установка после обновления плагина упиралась бы в «занято».
 */
function copyState(src, dst) {
  try {
    if (!lstatSync(dst).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const mine = recordedCopy(dst, src);
  let same = false;
  try {
    same = readFileSync(src).equals(readFileSync(dst));
  } catch {
    same = false;
  }
  if (same) return "fresh";
  return mine ? "stale" : undefined;
}

// Записи о копиях: какие места установки мы закрыли копией, а не ссылкой. Лежат в состоянии центра
// (CENTER_STATE_DIR / XDG_STATE_HOME), поэтому каталоги клиентов не зарастают служебными файлами.
const STATE_DIR = process.env.CENTER_STATE_DIR || join(process.env.XDG_STATE_HOME || join(HOME, ".local/state"), "command-center");
const COPIES_FILE = join(STATE_DIR, "plugin-copies.json");

const copies = readCopies();

function readCopies() {
  try {
    const data = JSON.parse(readFileSync(COPIES_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function recordedCopy(dst, src) {
  const row = copies[dst];
  return Boolean(row) && samePath(row.src ?? "", src);
}

function rememberCopy(dst, src, type) {
  if (type === "copy") copies[dst] = { src, type };
  else delete copies[dst];
}

function saveCopies() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(COPIES_FILE, `${JSON.stringify(copies, null, 2)}\n`);
  } catch (error) {
    warn(`install-plugins: не запомнить копии (${error.message}) — устаревшую копию придётся снять руками`);
  }
}

/** Связать исходник с местом установки: пробуем по порядку, возвращаем то, что вышло. */
function makeLink(src, dst) {
  const failures = [];
  for (const mode of linkModes()) {
    // junction бывает только у каталогов: для файла его не существует, и пробовать нечего
    if (mode === "junction" && !isDir(src)) continue;
    try {
      if (mode === "symlink") {
        symlinkSync(src, dst, PLATFORM === "win32" && isDir(src) ? "dir" : undefined);
        return "symlink";
      }
      if (mode === "junction") {
        symlinkSync(src, dst, "junction");
        return "junction";
      }
      cpSync(src, dst, { recursive: true, force: true });
      return "copy";
    } catch (error) {
      failures.push(`${mode}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(`связать ${dst} с ${src} не вышло (${failures.join("; ")})`);
}

/** Про копию говорим прямо: она не следит за правками, и молчать об этом нельзя. */
function sayLinkType(who, dst, type) {
  if (type === "symlink") return;
  const how = type === "junction" ? "junction (каталог-ссылка без прав)" : "копия (симлинк тут не создать: нужны права или режим разработчика)";
  say(`         ${pad(who)} ${dst} — ${how}: правки в станции до клиента не дойдут, повтори install после обновления плагина`);
}

function installOne({ who, src, dst }) {
  if (!exists(src)) {
    warn(`нет исходника: ${src}`);
    return false;
  }
  const current = linkTargetOf(dst);
  if (current && samePath(current, src)) {
    say(`ok       ${pad(who)} ${dst} (уже ведёт сюда)`);
    return true;
  }
  const copy = copyState(src, dst);
  if (copy === "fresh") {
    say(`ok       ${pad(who)} ${dst} (копия, свежая)`);
    return true;
  }
  if (copy === "stale") {
    say(`${installVerb()} ${pad(who)} ${dst} (обновляю нашу копию: ссылку тут создать нельзя)`);
    if (!DRY) cpSync(src, dst, { recursive: true, force: true });
    return true;
  }
  if (exists(dst)) {
    if (exists(`${dst}.bak`)) {
      warn(`занято:  ${pad(who)} ${dst} — на месте уже есть постороннее, а .bak не перезаписываю`);
      warn(`         ${pad(who)} если это наша копия после обновления плагина: снять её — ${dst}, ${dst}.bak, затем повтори install`);
      return false;
    }
    say(`${installVerb()} ${pad(who)} ${dst} -> ${src} (старое уезжает в ${dst}.bak)`);
    if (!DRY) renameSync(dst, `${dst}.bak`);
  } else {
    say(`${installVerb()} ${pad(who)} ${dst} -> ${src}`);
  }
  if (DRY) return true;
  mkdirSync(dirname(dst), { recursive: true });
  const type = makeLink(src, dst);
  rememberCopy(dst, src, type);
  sayLinkType(who, dst, type);
  return true;
}

/** Снимаем только своё: чужую ссылку и чужой файл не трогаем. */
function uninstallOne({ who, src, dst }) {
  const current = linkTargetOf(dst);
  if (current === undefined) {
    if (copyState(src, dst) !== undefined) {
      say(`${removeVerb()} ${pad(who)} ${dst} (наша копия)`);
      if (!DRY) {
        rmSync(dst, { force: true });
        rememberCopy(dst, src, undefined);
      }
      return true;
    }
    if (exists(dst)) {
      say(`чужое:   ${pad(who)} ${dst} — файл не наш, не трогаю`);
      return true;
    }
    say(`ok       ${pad(who)} ${dst} (нет ссылки)`);
    return true;
  }
  if (!samePath(current, src)) {
    say(`чужое:   ${pad(who)} ${dst} ведёт на ${current} — не трогаю`);
    return true;
  }
  say(`${removeVerb()} ${pad(who)} ${dst}`);
  if (!DRY) {
    rmSync(dst, { force: true });
    rememberCopy(dst, src, undefined);
  }
  return true;
}

function showOne({ who, src, dst }) {
  const raw = rawLink(dst);
  const current = linkTargetOf(dst);
  const copy = copyState(src, dst);
  if (current && samePath(current, src) && exists(dst)) {
    const type = String(raw).startsWith("\\\\?\\") ? "junction" : "симлинк";
    say(`ok       ${pad(who)} ${dst} -> ${current} (${type})`);
  } else if (current) {
    say(`чужое:   ${pad(who)} ${dst} -> ${current}`);
  } else if (copy === "fresh") {
    say(`копия    ${pad(who)} ${dst} (симлинк не встал: правки в станции до клиента не дойдут)`);
  } else if (copy === "stale") {
    say(`копия    ${pad(who)} ${dst} (копия устарела: повтори install)`);
  } else if (exists(dst)) {
    say(`чужое:   ${pad(who)} ${dst} (файл на месте ссылки)`);
  } else {
    say(`нет:     ${pad(who)} ${dst}`);
  }
  if (exists(`${dst}.bak`)) say(`           .bak: ${dst}.bak`);
  return true;
}

let failed = 0;
for (const row of TARGETS) {
  const ok = MODE === "install" ? installOne(row) : MODE === "uninstall" ? uninstallOne(row) : showOne(row);
  if (!ok) failed += 1;
}

// Записи о копиях нужны только после правок: status их читает, но не меняет.
if (MODE !== "status" && !DRY) saveCopies();

if (MODE === "install" && !DRY && failed === 0) {
  say("");
  say("готово. команда — /center в клиенте; сессию после установки надо начать заново,");
  say("список скиллов и команд клиент снимает на старте, иначе /center просто не появится.");
} else if (MODE === "uninstall" && !DRY) {
  say("");
  say("снято. файлы .bak (если были) остались на месте — вернуть: mv <файл>.bak <файл>");
}

process.exit(failed === 0 ? 0 : 1);
