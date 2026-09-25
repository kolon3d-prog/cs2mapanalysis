#!/usr/bin/env node
// mcp-station: bin/entryenv.mjs — запуск stdio-сервера с ключами из файла секретов, без шелла.
//
// Зачем: Unix-форма записи каталога берёт ключи шеллом (`set -a; . "$MCP_SECRETS"; set +a; exec …`),
// а в конфиге Windows шелла нет, и `bash` в PATH там обычно заглушка WSL, которая печатает «поставь
// дистрибутив» и выходит с нулём — клиент получает мёртвый сервер. Эта обёртка делает то же самое
// нативно: читает файл секретов целиком, кладёт переменные в окружение и запускает настоящую команду.
//
// Вызов — ровно так его пишет каталог в argvWindows:
//   node <корень станции>/bin/entryenv.mjs -- npx -y firecrawl-mcp@3.25.4
// Значения секретов никуда не печатаются: наружу уходят только код возврата и вывод самой команды.
import { readFileSync, existsSync, accessSync, readdirSync, statSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute as isAbsolutePath, win32 as winPath } from "node:path";
import { spawn } from "node:child_process";

/** Ветка Windows — тот же хук, что у станции: иначе её не прогнать на Linux. */
const IS_WIN = (process.env.MCP_STATION_PLATFORM || process.platform) === "win32";
/** Файл ключей: тот же путь, что у станции и bin/keys.mjs (меняется MCP_STATION_SECRETS). */
const AGENT_HOME = process.env.MCP_STATION_HOME || homedir();
const SECRETS = process.env.MCP_STATION_SECRETS || join(AGENT_HOME, ".config/opencode/secrets/env");

/** Короткая строка в stderr: клиент показывает её как причину, а не молчание. */
function fail(message) {
  process.stderr.write(`mcp-station: ${message}\n`);
  process.exit(1);
}

/** Переменные файла ключей. Разбор тот же, что у станции: `VAR=значение`, кавычки и # — как принято. */
function readSecrets() {
  const values = new Map();
  for (const line of readFileSync(SECRETS, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 1) continue;
    values.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return values;
}

/**
 * Разделитель PATH определяем по самой строке: на Windows это обычно «;», но из Git Bash та же переменная
 * приходит через «:» с путями `/c/...` — разбор по «;» нашёл бы ноль каталогов.
 */
function pathSeparator(value) {
  return value.includes(";") || /^[A-Za-z]:[\\/]/.test(value) ? ";" : ":";
}

/** Есть ли команда в PATH: на Windows — с PATHEXT (имя `npx` означает `npx.cmd`), на Unix — X_OK. */
function whichTool(name) {
  const path = String(process.env.PATH ?? "");
  if (IS_WIN) {
    const exts = String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean);
    const wanted = [name, ...exts.map((ext) => `${name}${ext}`)].map((candidate) => candidate.toLowerCase());
    for (const dir of path.split(pathSeparator(path))) {
      if (!dir) continue;
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const candidate of wanted) {
        const hit = entries.find((entry) => entry.toLowerCase() === candidate);
        if (!hit) continue;
        const full = join(dir, hit);
        try {
          if (statSync(full).isFile()) return full;
        } catch {
          // файл исчез между чтениями — не наш ответ
        }
      }
    }
    return undefined;
  }
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const full = join(dir, name);
    try {
      accessSync(full, fsConstants.X_OK);
      return full;
    } catch {
      // нет файла или он не исполняемый — дальше
    }
  }
  return undefined;
}

/** Как спавнить команду: `.cmd`/`.bat` на Windows идут через `cmd.exe /c` (node их напрямую не запускает). */
function spawnArgv(argv) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(String(argv[0] ?? ""))) return ["cmd.exe", "/c", ...argv];
  return argv;
}

const argv = process.argv.slice(2);
// Вызов строго по конвенции каталога: сначала «--», дальше команда сервера. Так «--» внутри самой
// команды (например `npx -y pkg -- --flag`) остаётся её собственным и ничего не путает.
const payload = argv[0] === "--" ? argv.slice(1) : [];
if (payload.length === 0) {
  fail("нужна команда сервера после «--»: node bin/entryenv.mjs -- npx -y <сервер>");
}
if (!existsSync(SECRETS)) {
  fail(`нет файла ключей ${SECRETS} — серверу с ключом его негде взять: bin/keys.sh add <сервер> (на Windows bin/keys.ps1 add <сервер>)`);
}

let secrets;
try {
  secrets = readSecrets();
} catch (error) {
  fail(`не прочитать файл ключей ${SECRETS}: ${error.message}`);
}

// Значения файла важнее унаследованных — это буквальный эквивалент `set -a; . "$MCP_SECRETS"; set +a`.
const env = { ...process.env };
for (const [name, value] of secrets) env[name] = value;

const isAbs = IS_WIN ? winPath.isAbsolute : isAbsolutePath;
/** Команда запуска: путь берём как есть, имя ищем в PATH (на Windows — с PATHEXT: `npx` это `npx.cmd`). */
const resolved = isAbs(payload[0]) ? payload[0] : whichTool(payload[0]) ?? payload[0];
const [command, ...rest] = spawnArgv([resolved, ...payload.slice(1)]);
const child = spawn(command, rest, { stdio: "inherit", env });
child.on("error", (error) => fail(`не удалось запустить ${command}: ${error.code ?? error.message}`));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
// Сигнал клиента передаём серверу: без этого обёртка пережила бы сервер и висел бы лишний процесс.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
