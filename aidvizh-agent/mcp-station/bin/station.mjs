#!/usr/bin/env node
// mcp-station — одна команда ставит MCP-серверы в конфиги клиентов (omp/pi, opencode).
//
// Источник правды — каталог (catalog/*.json): без секретов, без абсолютных путей ($HOME, $MCP_SECRETS).
// У каждой записи каталога есть тир: core (без ключей, ставится по умолчанию) и keyed (нужен ключ,
// только явной командой). Тиры — не украшение: сервер без ключа из tier=keyed станция молча не ставит.
// Состояние станции (что поставлено, с каким отпечатком, последние снимки для отката) лежит в рантайме:
// $HOME/.local/state/mcp-station/installed.json. На него опираются outdated, update и rollback.
// Конфиги правятся точечно: чужие ключи и чужие записи не трогаются, файл перезаписывается только при
// изменениях, рядом кладётся .bak. Повторный запуск идемпотентен, --dry-run / -WhatIf ничего не пишут.
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, mkdirSync, chmodSync, rmSync, statSync, accessSync, renameSync, constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, basename, resolve as resolvePath, isAbsolute as isAbsolutePath, win32 as winPath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createInterface as createPromptInterface } from "node:readline/promises";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // bin/station.mjs -> корень станции
const CATALOG_DIR = process.env.MCP_STATION_CATALOG || join(ROOT, "catalog");

/**
 * Платформа станции. MCP_STATION_PLATFORM — хук для тестов и для явного выбора: ветку Windows
 * надо уметь прогнать на Linux, иначе она остаётся непроверенной (так и вышло с записями,
 * которым на Windows нужен bash).
 */
const PLATFORM = process.env.MCP_STATION_PLATFORM || process.platform;
/**
 * Ветка Windows. На ней ни один путь станции не спавнит `bash` из PATH: там обычно заглушка WSL
 * (`%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`), которая печатает «поставь дистрибутив» и выходит
 * с нулём — «команда есть» и «сервер ответил» становятся ложью. Либо нативная ветка (node / cmd.exe),
 * либо настоящий Git Bash, найденный по абсолютному пути и проверенный делом.
 */
const IS_WIN = PLATFORM === "win32";

/** Домашний каталог, относительно которого считаются все пути. Подменяется в тестах. */
const AGENT_HOME = process.env.MCP_STATION_HOME || homedir();
/** Файл с секретами: единственное место, где лежат ключи (абсолютный путь — для чтения и проверок). */
const SECRETS_ABS = process.env.MCP_STATION_SECRETS || join(AGENT_HOME, ".config/opencode/secrets/env");
/**
 * Что попадает в конфиг вместо $MCP_SECRETS. По умолчанию это литерал "$HOME/..." — bash раскроет его
 * при запуске сервера, и конфиг остаётся переносимым (никаких абсолютных путей в файлах клиентов).
 * Если файл ключей задан явно (MCP_STATION_SECRETS или --secrets-file), пишем этот путь как есть.
 */
const SECRETS_IN_CONFIG = process.env.MCP_STATION_SECRETS
  ? process.env.MCP_STATION_SECRETS
  : "$HOME/.config/opencode/secrets/env";
/** Состояние станции: в рантайме, не в репозитории и не на диске данных. */
const STATE_DIR = process.env.MCP_STATION_STATE_DIR || join(AGENT_HOME, ".local/state/mcp-station");
const STATE_FILE = join(STATE_DIR, "installed.json");
/** Куда уносим старые `.bak` конфигов: рантайм станции, а не удаление — история остаётся под рукой. */
const BACKUP_DUMP = join(STATE_DIR, "dump");
/** Схема состояния и сколько снимков держим для отката. */
const SCHEMA = 1;
const SNAPSHOT_KEEP = 5;
const TIERS = ["core", "keyed"];
const CLIENT_ORDER = ["omp", "opencode", "pi"];

const CLIENTS = {
  omp: {
    label: "omp/pi",
    config: () =>
      process.env.PI_CODING_AGENT_DIR
        ? join(process.env.PI_CODING_AGENT_DIR, "mcp.json")
        : join(AGENT_HOME, ".omp/agent/mcp.json"),
    key: "mcpServers",
  },
  opencode: {
    label: "opencode",
    config: () =>
      process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "opencode/opencode.json")
        : join(AGENT_HOME, ".config/opencode/opencode.json"),
    key: "mcp",
  },
  pi: {
    // pi сам MCP не умеет: серверы читает расширение pi-mcp-adapter из <agent dir>/mcp.json
    label: "pi (через pi-mcp-adapter)",
    config: () =>
      process.env.PI_CODING_AGENT_DIR
        ? join(process.env.PI_CODING_AGENT_DIR, "mcp.json")
        : join(AGENT_HOME, ".pi/agent/mcp.json"),
    key: "mcpServers",
  },
};

/**
 * Строка про тиры для справки. Имена берутся из каталога, а не держатся в тексте: список в справке
 * уже устаревал молча (восемь имён при пятнадцати записях). Каталог не прочитать — говорим об этом,
 * а не показываем прежний список: справка врёт так же тихо, как и всё остальное.
 */
function tierLine() {
  const { entries, problems } = loadCatalog();
  if (problems.length) {
    return `Тиры: core — серверы без ключей (по умолчанию), keyed — с ключом (только явно);\nкаталог не прочитать (${CATALOG_DIR}) — список тиров не собран.`;
  }
  const names = (tier) => entries.filter((entry) => entry.tier === tier).map((entry) => entry.name).join(", ") || "—";
  return `Тиры: core — серверы без ключей (${names("core")});\nkeyed — с ключом (${names("keyed")}).`;
}

function usage() {
  process.stdout.write(`mcp-station — поставка MCP-серверов в клиентов одной командой

  mcp-station                     поставить core-серверы каталога (без ключей)
  mcp-station install [имена...]  то же самое, можно выбрать серверы (--client omp|pi|opencode|all)
  mcp-station update [имена...]   привести конфиги к каталогу: переписать изменившиеся наши записи,
                                  добавить недостающее, с --prune снять сирот, чужое — только доложить
  mcp-station outdated            что устарело: каталог против состояния станции и конфигов клиентов
  mcp-station rollback            вернуть конфиги к предыдущему снимку состояния
  mcp-station remove [имена...]   снять серверы с клиентов
  mcp-station list                что есть в каталоге
  mcp-station status              что стоит в клиентах: тир и свежесть
  mcp-station check [имена...]    проверить: файлы, переменные, доступность команд
  mcp-station verify [имена...]   живая проверка: поднять сервер по записи из конфига клиента и
                                  сделать рукопожатие MCP (initialize → tools/list) — «connected»,
                                  а не «ключ есть». Проверка не бесплатна: часть серверов поднимает
                                  браузер, поэтому есть --timeout, --exclude и имена

Флаги:
  --client <omp|pi|opencode|all>  куда ставить (по умолчанию all (omp/pi/opencode))
  --timeout <сек>                 (verify) сколько ждать один сервер (по умолчанию 20; у тяжёлой
                                  записи каталога может быть своё поле verifyTimeout)
  --exclude <имена>               (verify) пропустить серверы (через запятую): быстрое подмножество
  --no-lock                       (verify) не брать блокировку браузера (явный обход: два прогона
                                  на одной машине столкнутся — предупреждаем об этом в выводе)
  --profile core|keyed|all        что брать из каталога: core — по умолчанию, keyed — только явно:
                                  серверы с ключом без ключа в файле не ставятся
  --dry-run                       показать, что изменится, и ничего не писать
  --prune                         (update) снять записи, которых в каталоге больше нет
  --yes                           не спрашивать подтверждения (для --prune)
  --json                          машинный вывод там, где он есть
  --secrets-file <путь>           файл с ключами (по умолчанию $HOME/.config/opencode/secrets/env)
  --pool                          http-серверы ставить через пул ключей (перебор при отказе)
  --opencode-headers literal|env  как подставлять ключи в http-заголовки opencode:
                                literal — значение из файла ключей (по умолчанию, как сейчас),
                                env — {env:VAR}, если клиент сам видит переменные
                                (на Windows omp и pi тоже берут значение из файла: шелла там нет;
                                MCP_STATION_OMP_HEADERS=env / MCP_STATION_PI_HEADERS=env — ссылка на VAR)

${tierLine()}
Проверки не заменяют друг друга: check — файлы, переменные и команды; verify — живое рукопожатие по
записи из конфига клиента; outdated — версии и отпечатки против каталога.
Блокировка браузера (verify перед браузерными записями каталога — поле browser): ${LOCK_FILE}
TTL ${Math.round(lockTtl() / 60)} мин (CENTER_BROWSER_LOCK_TTL, секунды); протухшую (мёртвый pid или старше TTL) станция
снимает сама и говорит об этом, занятую живым владельцем — не трогает и называет владельца.
«Зарегистрирован ≠ видно в сессии»: конфиг новее запуска клиента — verify говорит строкой и ставит
session_stale в --json (процессов клиента нет — про сессию не говорим ничего).
Windows: записи ставятся нативной формой (argvWindows: node / cmd.exe / bin/entryenv.mjs) — bash из PATH
там не спавнится; записи без argvWindows не ставятся, если на машине нет настоящего Git Bash.
Состояние станции: ${STATE_FILE}
Каталог: ${CATALOG_DIR}
`);
}

/**
 * В конфиг путь к ключам попадает через $MCP_SECRETS (по умолчанию литерал `$HOME/...`), а сам $HOME
 * остаётся как есть: bash раскроет его при запуске сервера, поэтому конфиг не привязывается к машине.
 * $STATION — корень станции: в Unix-форме он не нужен, а в записи Windows шелла нет, поэтому станция
 * раскрывает его сама (на момент установки, как и $HOME).
 */
function expand(value) {
  return String(value).replaceAll("$MCP_SECRETS", SECRETS_IN_CONFIG).replaceAll("$STATION", stationToken());
}

/** Корень станции в записи: на Windows — с виндовыми разделителями, там его никто не раскроет. */
function stationToken() {
  return IS_WIN ? ROOT.replaceAll("/", "\\") : ROOT;
}

// ---------------------------------------------------------------- нативные хелперы (контракт Windows)

/** Абсолютность пути — по правилам той платформы, для которой пишем запись: на win32 это `C:\…`, `\\server\…` и `/…`. */
const isAbs = IS_WIN ? winPath.isAbsolute : isAbsolutePath;

/**
 * Разделитель PATH. На Windows это обычно «;», но из Git Bash и WSL та же переменная приходит через «:»
 * с путями вида `/c/Program Files/...` — разбор по «;» нашёл бы ноль каталогов, и живой набор снова
 * выглядел бы пустым. Поэтому разделитель определяем по самой строке, а не по платформе.
 */
function pathSeparator(value) {
  return value.includes(";") || /^[A-Za-z]:[\\/]/.test(value) ? ";" : ":";
}

/**
 * Есть ли инструмент в PATH. На Windows — разбор PATH по его разделителю и PATHEXT (расширение без учёта
 * регистра), поэтому имя `npx` находит `npx.cmd`. `skipWindowsApps` пропускает каталог подстановок
 * WindowsApps: там лежат заглушки-алиасы (`bash.exe` из WSL и родня), и «файл есть» про них ничего не значит.
 */
function whichTool(name, options = {}) {
  const skipWindowsApps = options.skipWindowsApps === true;
  if (IS_WIN) {
    const path = String(process.env.PATH ?? "");
    const sep = pathSeparator(path);
    const exts = String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean);
    const wanted = [name, ...exts.map((ext) => `${name}${ext}`)].map((candidate) => candidate.toLowerCase());
    for (const dir of path.split(sep)) {
      if (!dir) continue;
      if (skipWindowsApps && /[\\/]WindowsApps([\\/]|$)/i.test(dir)) continue;
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // каталога нет или он не читается — идём дальше, как это делает сам Windows
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
  for (const dir of String(process.env.PATH ?? "").split(":")) {
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

/** Настоящий bash на Windows: кэш ответа — проба делом стоит запуска процесса. */
let bashProbe;

/**
 * Настоящий bash (Git for Windows), а не заглушка WSL. Порядок: AGGG_BASH → MCP_STATION_BASH → каталоги
 * Git for Windows → PATH без WindowsApps. Каждый кандидат обязан ответить `--version` строкой «GNU bash»:
 * заглушка WSL печатает инструкцию и выходит с нулём, поэтому «запустилось» тут не считается.
 */
function resolveBash() {
  if (!IS_WIN) return { path: "bash" };
  if (bashProbe !== undefined) return bashProbe;
  const candidates = [
    process.env.AGGG_BASH,
    process.env.MCP_STATION_BASH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git/bin/bash.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git/bin/bash.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs/Git/bin/bash.exe"),
  ].filter(Boolean);
  const found = whichTool("bash", { skipWindowsApps: true });
  if (found) candidates.push(found);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 20000 });
    if (probe.error || probe.status !== 0) continue;
    if (!/GNU bash/i.test(String(probe.stdout ?? ""))) continue; // заглушка WSL отвечает инструкцией
    bashProbe = { path: candidate };
    return bashProbe;
  }
  bashProbe = {
    error: "нет настоящего bash: WSL-заглушка не годится (другой $HOME и другой корень диска) — поставь Git for Windows (winget install Git.Git) или задай AGGG_BASH",
  };
  return bashProbe;
}

/**
 * Как спавнить команду на Windows: node ≥ 18.20 не запускает `.cmd`/`.bat` напрямую (EINVAL), поэтому
 * такие имена идут через `cmd.exe /c` — иначе `npx.cmd` и родня падают ещё до старта сервера.
 */
function spawnArgv(argv) {
  const first = String(argv?.[0] ?? "");
  if (IS_WIN && /\.(cmd|bat)$/i.test(first)) return ["cmd.exe", "/c", ...argv];
  return argv;
}

/**
 * На Windows запись с `bash` (или с путём в WindowsApps) станция поднимает только настоящим Git Bash,
 * найденным по абсолютному пути: `bash` из PATH — обычно заглушка WSL, и её ответ («поставь дистрибутив»)
 * выглядел бы мусором в stdout, а не причиной. Нет настоящего bash — возвращаем причину, а не команду.
 */
function windowsBashArgv(argv) {
  if (!IS_WIN) return null;
  const first = String(argv?.[0] ?? "");
  if (!/^bash(\.exe)?$/i.test(first) && !/[\\/]WindowsApps[\\/]/i.test(first)) return null;
  const bash = resolveBash();
  if (bash.error) return { error: bash.error };
  return { argv: [bash.path, ...argv.slice(1)] };
}

// ---------------------------------------------------------------- блокировка браузера

/**
 * Браузерных прогонов на машине может быть один за раз, и это правило держит механизм, а не память агента.
 * Блокировка живёт в рантайме центра (путь заморожен контрактом: его же показывает `center ps`), формат —
 * строки KEY=VALUE, чтобы файл читали node, bash и pwsh.
 */
const LOCK_FILE = process.env.CENTER_BROWSER_LOCK || join(AGENT_HOME, ".local/state/command-center/browser.lock");
/** Сколько живёт блокировка без обновления: старше — протухшая, её снимает тот, кто пришёл следующим. */
const LOCK_TTL = 1800;
/** Наша блокировка: её надо снять на выходе, чем бы прогон ни закончился. */
let heldLock = false;

/** TTL блокировки: настраиваемый (CENTER_BROWSER_LOCK_TTL, секунды), по умолчанию 30 минут. */
function lockTtl() {
  const value = Number(process.env.CENTER_BROWSER_LOCK_TTL);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : LOCK_TTL;
}

/** Время для глаза: день.месяц часы:минуты:секунды по местным часам. */
function timeText(ms) {
  if (!Number.isFinite(ms)) return "?";
  const at = new Date(ms);
  const two = (value) => String(value).padStart(2, "0");
  return `${two(at.getDate())}.${two(at.getMonth() + 1)} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/** Жив ли процесс: сигнал 0 (unix) или tasklist (windows) — без выдумок про чужие платформы. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (IS_WIN) {
    const found = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", timeout: 20000 });
    return (found.status ?? -1) === 0 && String(found.stdout ?? "").includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // чужой процесс: он жив, просто сигналы нам не разрешены
  }
}

/** Что записано в блокировке. Пустой или битый файл — это «блокировки нет»: владельца не выдумываем. */
function readLockInfo() {
  if (!existsSync(LOCK_FILE)) return null;
  const fields = {};
  for (const line of readFileSync(LOCK_FILE, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const pid = Number(fields.pid);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    owner: fields.owner ?? "",
    run: fields.run ?? "",
    started: fields.started ?? "",
    ttl: Number(fields.ttl) > 0 ? Number(fields.ttl) : lockTtl(),
  };
}

/** Состояние блокировки: свободна, держится живым владельцем (held) или протухла (stale) — и почему. */
function lockState() {
  const lock = readLockInfo();
  if (!lock) return { state: "free", lock: null };
  const startedAt = Date.parse(lock.started);
  const ageSeconds = Number.isFinite(startedAt) ? Math.round((Date.now() - startedAt) / 1000) : null;
  const alive = lock.pid !== null && pidAlive(lock.pid);
  const old = ageSeconds !== null && ageSeconds > lock.ttl;
  const why = !alive ? `pid ${lock.pid ?? "?"} не жив` : old ? `старше TTL (${Math.round(lock.ttl / 60)} мин)` : "";
  return { state: why ? "stale" : "held", lock, ageSeconds, why };
}

/** Владелец блокировки одной строкой: кто её взял и чем занят. */
function lockOwnerText(lock) {
  const who = lock.owner || "неизвестный владелец";
  return lock.run ? `${who} (${lock.run})` : who;
}

/**
 * Взять блокировку браузера перед проверкой браузерных серверов. Протухшую (pid мёртв или старше TTL)
 * снимаем сами и говорим об этом; занятую живым владельцем не трогаем — говорим, кто держит и как снять.
 */
function takeBrowserLock({ owner, run, progress }) {
  const ttl = lockTtl();
  const before = lockState();
  if (before.state === "held") {
    const since = timeText(Date.parse(before.lock.started));
    progress(`браузер занят ${lockOwnerText(before.lock)}: pid ${before.lock.pid} с ${since}\n`);
    progress(`снять принудительно: rm ${LOCK_FILE} (только если владельца уже нет)\n`);
    return { ok: false, error: `браузер занят ${lockOwnerText(before.lock)}: pid ${before.lock.pid} с ${since}; снять принудительно: rm ${LOCK_FILE}` };
  }
  if (before.state === "stale") {
    progress(`блокировка протухла (${before.why}) — снимаю и беру свою\n`);
    rmSync(LOCK_FILE, { force: true });
  }
  const body = `pid=${process.pid}\nowner=${owner}\nrun=${run}\nstarted=${now()}\nttl=${ttl}\n`;
  try {
    mkdirSync(dirname(LOCK_FILE), { recursive: true });
    // wx: два verify, стартовавшие одновременно, не перезапишут блокировку друг друга
    writeFileSync(LOCK_FILE, body, { flag: "wx" });
    heldLock = true;
    progress(`взял блокировку браузера (${LOCK_FILE}, TTL ${Math.round(ttl / 60)} мин)\n`);
    return { ok: true };
  } catch (error) {
    if (error.code === "EEXIST") {
      const raced = lockState();
      const who = raced.lock ? `${lockOwnerText(raced.lock)}: pid ${raced.lock.pid}` : "кто-то успел";
      progress(`браузер занят — ${who} (блокировку взяли между проверкой и записью)\n`);
      return { ok: false, error: `браузер занят ${who}; снять принудительно: rm ${LOCK_FILE}` };
    }
    throw error;
  }
}

/** Снять свою блокировку. Чужую не трогаем: файл мог смениться, пока мы работали. */
function releaseBrowserLock() {
  if (!heldLock) return;
  heldLock = false;
  try {
    const lock = readLockInfo();
    if (lock && lock.pid !== null && lock.pid !== process.pid) return;
    rmSync(LOCK_FILE, { force: true });
  } catch {
    // снять не вышло (файла нет/права): молчать нельзя только про чужую блокировку, свою отпускаем молча
  }
}

// ---------------------------------------------------------------- процессы клиентов

/** Какой клиент это за процесс: opencode (в т.ч. opencode2 и служба), omp, pi. */
function clientOf(cmd) {
  if (/opencode/i.test(cmd)) return "opencode";
  if (/(__omp|oh-my-pi|\/\.omp\/|(^|[\s/])omp([\s/]|$))/i.test(cmd)) return "omp";
  if (/(^|[\s/])pi([\s/]|$)/.test(cmd)) return "pi";
  return null;
}

/**
 * Запущенные клиенты одним проходом: по каждому — самый старый процесс. Клиент читает конфиг на старте,
 * поэтому старший процесс и держит старое представление о записях. /proc есть только на Linux: нет его —
 * про сессии не говорим ничего (macOS/Windows: «не знаю» честнее выдумки).
 */
function clientProcesses() {
  const oldest = {};
  if (IS_WIN || !existsSync(join(PROC_ROOT, "stat"))) return oldest;
  const hz = clockTicks();
  const boot = bootEpoch();
  for (const entry of readdirSync(PROC_ROOT)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(join(PROC_ROOT, entry, "cmdline"), "utf8").replaceAll("\0", " ").trim();
      if (!cmd) continue;
      const client = clientOf(cmd);
      if (!client) continue;
      const line = readFileSync(join(PROC_ROOT, entry, "stat"), "utf8");
      const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]); // 22-е поле stat: время старта в тиках после загрузки
      if (!Number.isFinite(ticks)) continue;
      const started = boot + (ticks / hz) * 1000;
      if (!oldest[client] || started < oldest[client].started) oldest[client] = { pid: Number(entry), started };
    } catch {
      // процесс успел умереть между чтениями — его в снимке просто нет
    }
  }
  return oldest;
}

/** Откуда берём процессы: /proc на Linux. MCP_STATION_PROC_ROOT — хук для тестов (свой снимок). */
const PROC_ROOT = process.env.MCP_STATION_PROC_ROOT ? resolvePath(process.env.MCP_STATION_PROC_ROOT) : "/proc";

/** Тики часов в секунду и эпоха загрузки: в них считается время старта из /proc. */
function clockTicks() {
  const probe = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 10000 });
  const value = Number(String(probe.stdout ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function bootEpoch() {
  const stat = readFileSync(join(PROC_ROOT, "stat"), "utf8");
  const btime = /^btime\s+(\d+)/m.exec(stat);
  if (btime) return Number(btime[1]) * 1000;
  return Date.now() - Number(readFileSync(join(PROC_ROOT, "uptime"), "utf8").split(" ")[0]) * 1000;
}

/**
 * «Зарегистрирован ≠ видно в сессии»: конфиг клиента новее запуска самого клиента — значит клиент прочитал
 * его до правки и новых тулов в текущей сессии не увидит. Процессов клиента нет — не выдумываем ничего
 * (null), процессов нет по платформе — тоже null.
 */
function sessionStale(client, file, processes) {
  const running = processes[client];
  if (!running || !existsSync(file)) return null;
  try {
    const modified = statSync(file).mtimeMs;
    if (modified <= running.started) return false;
    return { pid: running.pid, since: timeText(running.started), modified: timeText(modified) };
  } catch {
    return null;
  }
}

/** Строка про устаревшую сессию клиента — та же, что говорит центр в verify. */
const STALE_HINT = "тулы появятся после перезапуска (opencode2 service restart / новый сеанс omp, pi)";

/** Для проверок $HOME раскрывается в реальный домашний каталог (в тестах — в MCP_STATION_HOME). */
function expandForCheck(value) {
  return expand(value).replaceAll("$HOME", AGENT_HOME);
}

/** Переменные, без которых сервер не заработает: requiresEnv у stdio и env у http-заголовков. */
function keyVars(entry) {
  const vars = new Set(entry.requiresEnv ?? []);
  for (const spec of Object.values(entry.headers ?? {})) if (spec.env) vars.add(spec.env);
  return [...vars];
}

/**
 * Каталог — единственный источник правды, и тир в нём выводится из ключей: сервер с ключом обязан быть
 * keyed (иначе он молча уедет в базовый набор), сервер без ключа — core. Расхождение ругается вслух.
 *
 * Нечитаемый каталог наружу не бросается: команда, которой каталог нужен для дела (install, update,
 * check, list, status, verify, remove), получает `problems` и падает с причиной, а сверка (`outdated`)
 * докладывает их как «не смог узнать». Иначе пустой или нечитаемый каталог выглядел бы как «всё
 * свежо» — источник недоступен, а сверка молчит зелёным.
 */
function loadCatalog() {
  const entries = [];
  const problems = [];
  let files;
  try {
    files = readdirSync(CATALOG_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch (error) {
    return { entries, problems: [{ where: "(каталог)", why: `каталог не прочитать (${CATALOG_DIR}): ${error.message}` }] };
  }
  if (!files.length) {
    return { entries, problems: [{ where: "(каталог)", why: `каталог пуст: в ${CATALOG_DIR} нет ни одной записи .json — сверять не с чем` }] };
  }
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(CATALOG_DIR, file), "utf8"));
      if (!data.name) throw new Error(`в ${file} нет name`);
      const vars = keyVars(data);
      const expected = vars.length ? "keyed" : "core";
      if (!TIERS.includes(data.tier)) {
        throw new Error(`в ${file} нет tier (core|keyed): по ключам (${vars.join(", ") || "ключей нет"}) ожидается ${expected}`);
      }
      if (data.tier !== expected) {
        throw new Error(`в ${file} tier=${data.tier}, а по ключам выходит ${expected} (${vars.join(", ") || "ключей нет"})`);
      }
      entries.push({ ...data, file: basename(file) });
    } catch (error) {
      // имя записи может быть нечитаемо вместе с файлом — тогда в отчёте стоит имя файла
      problems.push({ where: basename(file, ".json"), why: `${file}: ${error.message}` });
    }
  }
  return { entries, problems };
}

/** Каталог для дела: нечитаемый или пустой — это отказ с причиной, а не «ставить нечего». */
function requireCatalog(problems) {
  if (problems.length) throw new Error(problems.map((problem) => problem.why).join("; "));
}

function readSecrets() {
  const values = new Map();
  if (!existsSync(SECRETS_ABS)) return values;
  for (const line of readFileSync(SECRETS_ABS, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 1) continue;
    values.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return values;
}

/**
 * Как запись получает значение заголовка. На Unix omp и pi подставляют его `!`-командой на старте
 * (шелл читает файл ключей), у opencode это литерал из файла. На Windows шелла нет — `!`-строка там
 * мёртвая (ключ не подставится, сервер получит 401), поэтому omp и pi получают значение так же, как
 * opencode. Явный выбор «пусть клиент сам видит переменную» — переменные по образцу
 * MCP_STATION_OPENCODE_HEADERS: MCP_STATION_OMP_HEADERS=env, MCP_STATION_PI_HEADERS=env.
 */
function headerMode(client) {
  if (client === "opencode") return process.env.MCP_STATION_OPENCODE_HEADERS === "env" ? "envref" : "literal";
  const override = client === "omp" ? process.env.MCP_STATION_OMP_HEADERS : process.env.MCP_STATION_PI_HEADERS;
  if (override === "env") return "envref";
  return IS_WIN ? "literal" : "shell";
}

/**
 * Значение для http-заголовка: у omp/pi на Unix — подстановка из файла ключей на старте сервера, на
 * Windows и у opencode — значение из файла на момент установки ({env:VAR} — ссылка на переменную).
 * Ключ в конфиг не попадает только в форме подстановки: у opencode и на Windows он берётся станцией.
 */
function headerValue(client, spec, secrets) {
  const format = spec.format ?? "%s";
  const mode = headerMode(client);
  if (mode === "shell") {
    // и omp, и адаптер pi понимают значение, начинающееся с "!": оно выполняется как команда
    const shellFormat = format === "%s" ? "%s" : `'${format}'`;
    return { value: `!set -a; . "${SECRETS_IN_CONFIG}"; set +a; printf ${shellFormat} "$${spec.env}"` };
  }
  if (mode === "envref") return { value: `{env:${spec.env}}` };
  const value = secrets.get(spec.env);
  // ключа в файле нет — запись не пишется вовсе (см. правило тира keyed), это запасной вариант
  return { value: value ? format.replace("%s", value) : `{env:${spec.env}}` };
}

/** Чем положить ключ: на Unix это bin/keys.sh, на Windows — та же работа через pwsh-обёртку bin/keys.ps1. */
function keysAddHint(name) {
  return `${IS_WIN ? "bin/keys.ps1" : "bin/keys.sh"} add ${name}`;
}

/**
 * Файл ключей — единственное место, где живут секреты. Если его нет, install/update заводит пустой
 * (права 600, best-effort) и говорит, чем положить ключ: иначе непонятно, куда его класть, а сервер
 * keyed молча не поставится. `--dry-run` ничего не пишет — там только тишина.
 */
function ensureSecretsFile(targets, { dryRun, json }) {
  if (dryRun || existsSync(SECRETS_ABS)) return;
  const say = json ? (line) => process.stderr.write(line) : (line) => process.stdout.write(line);
  try {
    mkdirSync(dirname(SECRETS_ABS), { recursive: true });
    writeFileSync(SECRETS_ABS, "", { mode: 0o600 });
  } catch (error) {
    say(`не завести файл ключей ${SECRETS_ABS}: ${error.message}\n`);
    return;
  }
  const keyed = targets.find((entry) => keyVars(entry).length);
  say(`файл ключей ${SECRETS_ABS} заведён пустым — положи ключ: ${keysAddHint(keyed ? keyed.name : "<сервер>")}\n`);
}

/** Шим пула ключей: конфиг клиента ссылается на $HOME/.local/bin/mcp-keypool, диск тут ни при чём. */
function writePoolShim() {
  const dir = join(AGENT_HOME, ".local/bin");
  mkdirSync(dir, { recursive: true });
  const proxy = join(ROOT, "bin/keypool.mjs").replaceAll("\\", "/");
  const target = IS_WIN ? join(dir, "mcp-keypool.cmd") : join(dir, "mcp-keypool");
  const body =
    IS_WIN
      ? `@echo off\r\nrem mcp-station: пул ключей\r\nnode "${proxy}" %*\r\n`
      : `#!/usr/bin/env bash\n# mcp-station: пул ключей\nexec node "${proxy}" "$@"\n`;
  writeFileSync(target, body, { mode: 0o755 });
  if (!IS_WIN) chmodSync(target, 0o755);
  return target;
}

/**
 * Переменные записи из `envWindows`: на Windows Unix-обёртки (`export CAMOUFOX_CAPS=...`) нет, поэтому
 * профиль сервера задаётся окружением в конфиге клиента. Значение, уже заданное пользователем в записи,
 * не перетирается: сужение профиля — его решение, станция его только сохраняет.
 */
function envValues(entry, client, actual) {
  if (!IS_WIN) return null;
  const wanted = entry.envWindows;
  if (!wanted || !Object.keys(wanted).length) return null;
  const bucket = client === "opencode" ? actual?.environment : actual?.env;
  const out = {};
  for (const [name, value] of Object.entries(wanted)) {
    out[name] = bucket && typeof bucket === "object" && typeof bucket[name] === "string" ? bucket[name] : value;
  }
  return out;
}

function renderEntry(entry, client, secrets, pool, actual) {
  if (entry.kind === "stdio") {
    const argv = entryArgv(entry).map(expand);
    const env = envValues(entry, client, actual);
    if (client === "opencode") return { value: { type: "local", command: argv, ...(env ? { environment: env } : {}) } };
    return { value: { command: argv[0], args: argv.slice(1), ...(env ? { env } : {}) } }; // omp и pi — плоская схема
  }

  if (pool) {
    // через шим: он перебирает ключи и переключается, когда очередной отбит
    const argv = IS_WIN
      // у Windows свой шим (.cmd: его пишет writePoolShim) и свой способ его позвать — bash там нет
      ? ["cmd.exe", "/c", join(AGENT_HOME, ".local/bin/mcp-keypool.cmd").replaceAll("/", "\\"), entry.name]
      : ["bash", "-lc", `exec "$HOME/.local/bin/mcp-keypool" ${entry.name}`];
    if (client === "opencode") return { value: { type: "local", command: argv } };
    return { value: { command: argv[0], args: argv.slice(1) } };
  }

  const headers = {};
  for (const [name, spec] of Object.entries(entry.headers ?? {})) {
    headers[name] = headerValue(client, spec, secrets).value;
  }
  const hasHeaders = Object.keys(headers).length > 0;
  if (client === "pi") {
    // у адаптера pi схема плоская: url + headers, поля type нет
    return { value: { url: entry.url, ...(hasHeaders ? { headers } : {}) } };
  }
  const value = client === "omp"
    ? { type: "http", url: entry.url, ...(hasHeaders ? { headers } : {}) }
    : { type: "remote", url: entry.url, ...(hasHeaders ? { headers } : {}) };
  return { value };
}

// ---------------------------------------------------------------- отпечатки записей

/**
 * Отпечаток — sha256 от нормализованного содержимого записи (argv/url/заголовки). Значения ключей в
 * отпечаток НЕ входят: у заголовка остаются имя переменной и формат (Bearer %s и т.п.), поэтому смена
 * ключа не выглядит как «каталог изменился», а смена argv/url/формата — выглядит.
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function fingerprint(shape) {
  return createHash("sha256").update(JSON.stringify(stable(shape))).digest("hex");
}

/** В argv путь к ключам не привязываем к машине: он всегда записан как $MCP_SECRETS. */
function normalizeArgv(argv) {
  return argv.map((token) => String(token).replaceAll(SECRETS_IN_CONFIG, "$MCP_SECRETS"));
}

/** Что нужно знать о записи, чтобы сравнивать её с фактом: вид, спецификации заголовков и имена env-переменных. */
function specOf(entry) {
  if (entry.kind === "stdio") return { kind: "stdio", envVars: Object.keys(entry.envWindows ?? {}) };
  return {
    kind: "http",
    headers: Object.fromEntries(
      Object.entries(entry.headers ?? {}).map(([name, spec]) => [name, { env: spec.env, format: spec.format ?? "%s" }]),
    ),
  };
}

/**
 * Состав команды под текущую платформу: `argv` — для Unix, `argvWindows` — если запись объявила его
 * для Windows. Без него запись с `bash` на Windows не ставится вовсе: bash там может оказаться
 * заглушкой из дистрибутива WSL, которая на `-lc` печатает «поставь дистрибутив» и выходит с нулём —
 * клиент получает мёртвый сервер, а check молчит зелёным. Если настоящий Git Bash на машине есть,
 * Unix-форма ставится с АБСОЛЮТНЫМ путём к нему — никакого `bash` из PATH.
 */
function entryArgv(entry) {
  if (!IS_WIN) return entry.argv;
  if (Array.isArray(entry.argvWindows) && entry.argvWindows.length) {
    return entry.argvWindows.map((token) => {
      const text = String(token);
      if (!text.includes("$HOME") && !text.includes("$STATION")) return text;
      // Шелла в конфиге Windows нет: ни $HOME, ни $STATION там никто не раскроет, поэтому раскрываем
      // сами, а разделители приводим к виндовым. Переносимость держится переустановкой (update).
      return text.replaceAll("$HOME", AGENT_HOME).replaceAll("$STATION", ROOT).replaceAll("/", "\\");
    });
  }
  if (String(entry.argv?.[0] ?? "") === "bash") {
    const bash = resolveBash();
    if (!bash.error) return [bash.path, ...entry.argv.slice(1)];
  }
  return entry.argv;
}

/** Запись требует bash, которого на Windows нет: своей нативной формы у неё нет, а настоящего bash не нашли. */
function needsBashOnWindows(entry) {
  if (!IS_WIN || entry.kind !== "stdio") return false;
  if (Array.isArray(entry.argvWindows) && entry.argvWindows.length) return false;
  if (String(entry.argv?.[0] ?? "") !== "bash") return false;
  return Boolean(resolveBash().error);
}

/** Текст контракта: запись просит bash, а на Windows его нет. */
const BASH_MISSING_TEXT = "запись требует bash, а на Windows его нет — дай argvWindows в каталоге или поставь Git for Windows";

/**
 * Запись в конфиге — наша же Unix-форма (`bash -lc …`), оставшаяся от установки на Unix: каталог на
 * этой платформе даёт argvWindows, а в конфиге лежит старая форма. Это наша запись, а не чужая, и
 * update обязан её переписать (см. unixFormShape), а не доложить «не трогаю».
 */
function unixFormShape(entry, client) {
  if (!IS_WIN || entry.kind !== "stdio") return null;
  if (!Array.isArray(entry.argvWindows) || !entry.argvWindows.length) return null;
  const argv = entry.argv.map(expand);
  const value = client === "opencode" ? { command: argv } : { command: argv[0], args: argv.slice(1) };
  return shapeOf(specOf(entry), client, value);
}

/** Совпала ли запись клиента с Unix-формой нашей же записи. */
function looksLikeUnixForm(entry, client, actualShape) {
  const shape = unixFormShape(entry, client);
  return Boolean(shape && actualShape && fingerprint(shape) === fingerprint(actualShape));
}

/**
 * Состав команды из записи клиента. Терпим обе формы у любого клиента: opencode пишет массив
 * `command`, omp/pi — строку `command` плюс массив `args`. Запись, попавшая не в свою форму
 * (omp-вид в opencode), читается так же — иначе update счёл бы её чужой и не починил.
 */
function flattenCommand(value) {
  if (Array.isArray(value.command)) return value.command.map(String);
  if (typeof value.command === "string") return [value.command, ...(Array.isArray(value.args) ? value.args.map(String) : [])];
  return null;
}

/** Как записан заголовок: подстановка из файла (shell), ссылка на переменную (envref) или значение (literal). */
function headerShape(headerSpec, raw) {
  if (!headerSpec?.env) return { mode: "unknown" };
  const format = headerSpec.format ?? "%s";
  const value = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
  const mode = { mode: "empty", env: headerSpec.env, format };
  if (!value) return mode;
  if (value.startsWith("!set -a;") && value.includes(`"$${headerSpec.env}"`)) return { mode: "shell", env: headerSpec.env, format };
  if (value === `{env:${headerSpec.env}}`) return { mode: "envref", env: headerSpec.env, format };
  const at = format.indexOf("%s");
  if (at < 0) return value === format ? { mode: "literal", env: headerSpec.env, format } : { mode: "other", env: headerSpec.env, format };
  const prefix = format.slice(0, at);
  const suffix = format.slice(at + 2);
  if (value.length > prefix.length + suffix.length && value.startsWith(prefix) && value.endsWith(suffix)) {
    return { mode: "literal", env: headerSpec.env, format };
  }
  return { mode: "other", env: headerSpec.env, format };
}

/**
 * Есть ли в записи переменные, которыми управляет станция (envWindows). В форму входит только ФАКТ их
 * наличия, не значения: сузив профиль в конфиге (CAMOUFOX_CAPS=research,browser), пользователь не должен
 * выглядеть как расхождение — иначе станция перетёрла бы его значение своим.
 */
function managedEnv(spec, client, value) {
  const names = spec.envVars ?? [];
  if (!names.length) return false;
  const bucket = client === "opencode" ? value.environment : value.env;
  if (!bucket || typeof bucket !== "object") return false;
  return names.some((name) => Object.prototype.hasOwnProperty.call(bucket, name));
}

/** Канонический вид записи клиента (то, что сравнивается и хешируется). */
function shapeOf(spec, client, value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return { kind: "other", client, type: typeof value };
  if (spec.kind === "stdio") {
    const argv = flattenCommand(value);
    return { kind: "stdio", client, argv: argv ? normalizeArgv(argv) : null, envManaged: managedEnv(spec, client, value) };
  }
  const headers = {};
  for (const [name, raw] of Object.entries(value.headers ?? {})) headers[name] = headerShape(spec.headers?.[name], raw);
  return { kind: "http", client, url: typeof value.url === "string" ? value.url : null, headers };
}

/** Каким запись должна быть по каталогу — без чтения ключей (значение в отпечаток всё равно не входит). */
function desiredShapeOf(entry, client, pool) {
  if (entry.kind === "stdio" || pool) return shapeOf(specOf(entry), client, renderEntry(entry, client, new Map(), pool).value);
  const headers = {};
  for (const [name, spec] of Object.entries(entry.headers ?? {})) {
    headers[name] = { mode: headerMode(client), env: spec.env, format: spec.format ?? "%s" };
  }
  return { kind: "http", client, url: entry.url ?? null, headers };
}

/**
 * Гейты подтверждения на опасные тулы сервера: каталог объявляет `approval: ["<тул>", …]`,
 * станция переводит их в родные механизмы клиентов — opencode `permission["<сервер>_<тул>"] = "ask"`,
 * omp `tools.approval["mcp__<сервер>_<тул>"] = "prompt"` (дефисы имени сервера — в подчёркивания).
 * У pi такого механизма нет — гейты туда не пишутся.
 */
function applyApprovals(entry, client, json) {
  const tools = Array.isArray(entry?.approval) ? entry.approval : [];
  if (!tools.length) return;
  if (client === "opencode") {
    json.permission = json.permission ?? {};
    for (const tool of tools) json.permission[`${entry.name}_${tool}`] = "ask";
  } else if (client === "omp") {
    json.tools = json.tools ?? {};
    json.tools.approval = json.tools.approval ?? {};
    const server = entry.name.replace(/[^A-Za-z0-9]+/g, "_");
    for (const tool of tools) json.tools.approval[`mcp__${server}_${tool}`] = "prompt";
  }
}

/**
 * Наша ли это запись. Состояние помнит отпечатки всего, что поставила станция; записи, поставленные до
 * появления состояния (или после его потери), узнаём по форме: та же схема, тот же argv[0], тот же url.
 * Чужая запись (например camoufox от установщика проекта — он пишет абсолютный путь к venv) не наша.
 */
function looksLikeOurs(desiredShape, actualShape) {
  if (!desiredShape || !actualShape) return false;
  const poolShim = (shape) => shape.kind === "stdio" && String(shape.argv?.[2] ?? "").includes("mcp-keypool");
  if (poolShim(actualShape)) return true; // запись через шим пула ключей — точно наша
  if (poolShim(desiredShape) && typeof actualShape.url === "string") return true; // прямой эндпоинт вместо шима
  if (desiredShape.kind !== actualShape.kind) return false;
  if (desiredShape.kind === "stdio") {
    return Boolean(actualShape.argv?.[0]) && actualShape.argv[0] === desiredShape.argv?.[0];
  }
  return actualShape.url === desiredShape.url;
}

/**
 * Наша ли это запись клиента — одна логика на survey и verify. Сначала отпечаток состояния (станция
 * помнит всё, что поставила), потом форма каталога: та же схема, тот же argv[0]/url, в том числе наша
 * же Unix-форма на Windows. Чужая запись (свой сервер покупателя, camoufox от установщика проекта)
 * не наша: её провал — не наш провал.
 *
 * `stateDown` — состояние станции не прочитать: формой не гадаем (её источник — то же состояние),
 * а считаем своей запись с именем из каталога; verify говорит об этом в отчёте полем `owners`.
 */
function recordIsOurs({ entry, stRec, client, actualShape, wanted = true, pool = false, stateDown = false }) {
  if (stRec && actualShape && fingerprint(actualShape) === stRec.fingerprint) return true;
  if (stateDown) return Boolean(entry);
  const desiredShape = entry && wanted ? desiredShapeOf(entry, client, pool) : null;
  return looksLikeOurs(desiredShape, actualShape)
    || Boolean(entry && looksLikeUnixForm(entry, client, actualShape));
}

/** Что именно разошлось — чтобы в отчёте было не «изменилось», а «argv» или «url». */
function diffAspects(spec, actualShape, desiredShape) {
  if (!actualShape || !desiredShape) return ["весь набор"];
  if (actualShape.kind !== desiredShape.kind) return ["вид записи"];
  const out = [];
  if (spec.kind === "stdio") {
    if (JSON.stringify(actualShape.argv) !== JSON.stringify(desiredShape.argv)) out.push("argv");
  } else {
    if (actualShape.url !== desiredShape.url) out.push("url");
    const names = [...new Set([...Object.keys(actualShape.headers), ...Object.keys(desiredShape.headers)])].sort();
    for (const name of names) {
      if (JSON.stringify(actualShape.headers[name]) !== JSON.stringify(desiredShape.headers[name])) out.push(`заголовок ${name}`);
    }
  }
  return out.length ? out : ["содержимое"];
}

// ---------------------------------------------------------------- конфиги клиентов

function loadConfig(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function loadClientFiles(clients) {
  const files = new Map();
  for (const client of clients) {
    const path = CLIENTS[client].config();
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    let json = {};
    if (before.trim()) {
      try {
        json = JSON.parse(before);
      } catch (error) {
        throw new Error(`${path}: не разобрать JSON (${error.message})`);
      }
    }
    files.set(client, { path, before, json });
  }
  return files;
}

/** Один .bak на файл за запуск: иначе восемь записей подряд перетирают копию восемь раз. */
const backedUp = new Set();
/** Сколько `.bak` оставляем рядом с конфигом; остальные уезжают в рантайм (BACKUP_DUMP). */
let backupsMoved = 0;

/**
 * Ротация бэкапов конфига: рядом остаются последние SNAPSHOT_KEEP штук по времени правки, остальные
 * переезжают в рантайм станции (не удаляются — история остаётся). Трогаем только имена, начинающиеся
 * с `<имя конфига>.bak`: ручные копии вида `opencode.json.bak-bashfail` попадают под то же правило,
 * а всё чужое рядом с конфигом остаётся нетронутым.
 */
function rotateBackups(path) {
  const dir = dirname(path);
  const prefix = `${basename(path)}.bak`;
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return; // каталога нет — и бэкапов в нём нет
  }
  const files = names
    .map((name) => {
      try {
        return { name, at: statSync(join(dir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  const extra = files.slice(SNAPSHOT_KEEP);
  if (!extra.length) return;
  try {
    mkdirSync(BACKUP_DUMP, { recursive: true });
  } catch {
    return; // рантайм недоступен — оставляем как есть, это не повод падать
  }
  for (const file of extra) {
    try {
      renameSync(join(dir, file.name), join(BACKUP_DUMP, file.name));
      backupsMoved += 1;
    } catch {
      // перенести не вышло (занят/права) — файл остаётся на месте
    }
  }
}

/** Наш .bak: копия кладётся один раз за запуск, сразу за ней — ротация лишних. */
function backupOnce(path) {
  if (backedUp.has(path)) return;
  copyFileSync(path, `${path}.bak`);
  backedUp.add(path);
  rotateBackups(path);
}

/** Строка отчёта про перенесённые бэкапы — только когда что-то перенесли. */
function backupReport(json) {
  if (!backupsMoved) return;
  const line = `старые .bak перенесены в рантайм: ${backupsMoved} (${BACKUP_DUMP})\n`;
  (json ? process.stderr : process.stdout).write(line);
}

function saveConfig(path, before, after) {
  const rendered = `${JSON.stringify(after, null, 2)}\n`;
  if (before === rendered) return false;
  mkdirSync(dirname(path), { recursive: true });
  if (before.trim()) backupOnce(path);
  writeFileSync(path, rendered);
  return true;
}

function targetClients(requested) {
  const names = requested === "all" ? Object.keys(CLIENTS) : [requested];
  for (const name of names) {
    if (!CLIENTS[name]) throw new Error(`--client принимает ${Object.keys(CLIENTS).join(", ")} или all, получено: ${name}`);
  }
  return names;
}

function selectEntries(catalog, names) {
  if (names.length === 0) return catalog;
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  return names.map((name) => {
    const entry = byName.get(name);
    if (!entry) throw new Error(`в каталоге нет сервера ${name} (см. mcp-station list)`);
    return entry;
  });
}

// ---------------------------------------------------------------- состояние станции

function now() {
  return new Date().toISOString();
}

function emptyState() {
  return { schema: SCHEMA, catalog_hash: "", installed_at: null, updated_at: null, servers: {}, snapshots: [] };
}

/**
 * Состояние станции: причина, по которой его не прочитать (битый или нечитаемый файл), иначе null.
 * Пустое состояние у машины, где станция ещё ничего не ставила, — это не проблема, а битый файл — да:
 * без своей памяти станция не может сказать, что из записей клиентов поставила она.
 */
let stateProblem = null;

function loadState() {
  stateProblem = null;
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { ...emptyState(), ...data, servers: data.servers ?? {}, snapshots: data.snapshots ?? [] };
  } catch (error) {
    stateProblem = `${STATE_FILE}: ${error.message}`;
    process.stderr.write(`mcp-station: состояние ${STATE_FILE} не разобрать (${error.message}) — считаю, что его нет\n`);
    return emptyState();
  }
}

/** Запись состояния не трогаем, если содержимое не изменилось: повторный прогон ничего не пишет. */
function saveState(state) {
  const body = `${JSON.stringify(state, null, 2)}\n`;
  if (existsSync(STATE_FILE) && readFileSync(STATE_FILE, "utf8") === body) return false;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, body);
  return true;
}

function rememberClient(state, entry, client, shape) {
  const spec = specOf(entry);
  const server = (state.servers[entry.name] = state.servers[entry.name] ?? {
    tier: entry.tier,
    kind: entry.kind,
    spec,
    at: now(),
    clients: {},
  });
  server.tier = entry.tier;
  server.kind = entry.kind;
  server.spec = spec;
  server.clients[client] = { fingerprint: fingerprint(shape), at: now() };
}

function forgetClient(state, name, client) {
  const server = state.servers[name];
  if (!server) return;
  delete server.clients[client];
  if (Object.keys(server.clients).length === 0) delete state.servers[name];
}

/** Снимок перед изменением конфигов: и файлы, и состояние — чтобы rollback вернул прошлое целиком. */
function takeSnapshot(state, reason, files) {
  state.snapshots.push({ at: now(), reason, files, servers: JSON.parse(JSON.stringify(state.servers)) });
  while (state.snapshots.length > SNAPSHOT_KEEP) state.snapshots.shift();
}

function snapshotFiles(files, paths) {
  const out = {};
  for (const path of paths) out[path] = existsSync(path) ? readFileSync(path, "utf8") : null;
  return out;
}

function catalogHash(catalog) {
  return fingerprint(
    catalog.map((entry) => ({
      name: entry.name,
      tier: entry.tier,
      clients: entry.clients ?? null,
      spec: specOf(entry),
      argv: entry.kind === "stdio" ? normalizeArgv(entry.argv) : null,
      url: entry.url ?? null,
    })),
  );
}

// ---------------------------------------------------------------- диагностика: три стороны

/**
 * Сверка трёх сторон: каталог (желаемое), состояние станции (что ставили мы) и конфиги клиентов (факт).
 * Статусы: current — всё сходится; changed — каталог или отпечаток разошёлся; missing — в каталоге есть,
 * у клиента нет; orphan — стоит, но в каталоге его больше нет (запись наша); foreign — стоит, а ставил не
 * я; unknown — сверка не состоялась: источник (каталог или состояние станции) не прочитать, и вердикт был
 * бы догадкой. Недоступный источник — это «не смог узнать», а не «свежо».
 */
function survey(catalog, state, clients, pool, problems = {}) {
  const catalogProblems = problems.catalog ?? [];
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const names = new Set(byName.keys());
  for (const name of Object.keys(state.servers)) names.add(name);
  const configs = {};
  for (const client of clients) {
    configs[client] = loadConfig(CLIENTS[client].config());
    for (const name of Object.keys(configs[client][CLIENTS[client].key] ?? {})) names.add(name);
  }

  const rows = [];
  for (const name of [...names].sort()) {
    const entry = byName.get(name) ?? null;
    const stored = state.servers[name] ?? null;
    const spec = entry ? specOf(entry) : stored?.spec ?? null;
    const clients_ = [];
    for (const client of CLIENT_ORDER.filter((c) => clients.includes(c))) {
      const actual = configs[client][CLIENTS[client].key]?.[name];
      const stRec = stored?.clients?.[client] ?? null;
      const wanted = entry ? !entry.clients || entry.clients.includes(client) : false;
      const desiredShape = entry && wanted ? desiredShapeOf(entry, client, pool) : null;
      const actualShape = actual === undefined || !spec ? null : shapeOf(spec, client, actual);
      // на Windows в конфиге могла остаться наша же Unix-форма (`bash -lc …`): это наша запись,
      // а не чужая — её надо переписать нативную, а не докладывать «не трогаю» (см. recordIsOurs)
      const ours = recordIsOurs({ entry, stRec, client, actualShape, wanted, pool });
      let stateName;
      if (actual === undefined) stateName = "absent";
      else if (desiredShape && fingerprint(actualShape) === fingerprint(desiredShape)) stateName = "current";
      else if (ours) stateName = "stale";
      else stateName = "foreign";
      clients_.push({ client, state: stateName, actual, actualShape, desiredShape, stRec, wanted, ours });
    }

    const desiredClients = clients_.filter((row) => row.wanted);
    const foreign = clients_.filter((row) => row.state === "foreign");
    const oursAnywhere = clients_.some((row) => row.state === "current" || row.state === "stale");
    let status;
    let why = "";
    if (!entry) {
      status = oursAnywhere || (clients_.length > 0 && clients_.every((row) => row.state === "absent") && stored) ? "orphan" : "foreign";
      why = status === "orphan"
        ? `в каталоге больше нет${clients_.some((row) => row.actual !== undefined) ? `, а запись наша: ${clients_.filter((row) => row.actual !== undefined).map((row) => row.client).join(", ")}` : ", записей у клиентов тоже нет"}`
        : `поставлено не станцией: ${clients_.filter((row) => row.actual !== undefined).map((row) => row.client).join(", ")}`;
    } else if (foreign.length) {
      status = "foreign";
      why = `стоит, но ставил не я: ${foreign.map((row) => row.client).join(", ")} — не трогаю, это не наша запись`;
    } else if (desiredClients.length && desiredClients.every((row) => row.state === "absent")) {
      status = "missing";
      why = `нет у клиента ${desiredClients.map((row) => row.client).join(", ")}`;
    } else if (desiredClients.every((row) => row.state === "current")) {
      status = "current";
    } else {
      status = "changed";
      const parts = [];
      for (const row of desiredClients) {
        if (row.state === "current") continue;
        if (row.state === "absent") {
          parts.push(`нет у клиента ${row.client}`);
          continue;
        }
        const drifted = row.stRec && row.actualShape && fingerprint(row.actualShape) !== row.stRec.fingerprint;
        parts.push(`${drifted ? "запись разошлась" : "каталог изменился"}: ${diffAspects(spec, row.actualShape, row.desiredShape).join(", ")} (${row.client})`);
      }
      why = parts.join("; ");
    }
    rows.push({ name, tier: entry?.tier ?? stored?.tier ?? null, status, why, clients: clients_, entry, stored, spec });
  }

  // Источник недоступен — вердикт по серверам был бы догадкой, и «свежо» тут было бы враньём:
  // без каталога не с чем сверять, без состояния станции не понять, чьи это записи.
  const catalogDown = catalogProblems.find((problem) => problem.where === "(каталог)") ?? null;
  if (catalogDown || problems.state) {
    const why = catalogDown ? catalogDown.why : `состояние станции не прочитать (${problems.state}) — не могу судить, что из записей поставила станция`;
    for (const row of rows) {
      row.status = "unknown";
      row.why = why;
    }
  }
  // Запись каталога, которую не прочитать, — своя строка отчёта: имени сервера в ней может и не быть,
  // а у каталога целиком строка одна на всех — иначе «current 0» читалось бы как «всё хорошо».
  // Если сервер и так известен (по состоянию или конфигу), строка у него одна: причина — файл каталога.
  for (const problem of catalogProblems) {
    const known = rows.find((row) => row.name === problem.where);
    if (known) {
      known.status = "unknown";
      known.why = problem.why;
      continue;
    }
    rows.push({ name: problem.where, tier: null, status: "unknown", why: problem.why, clients: [], entry: null, stored: null, spec: null });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

function summarize(rows) {
  const summary = { current: 0, changed: 0, missing: 0, orphan: 0, foreign: 0, unknown: 0 };
  for (const row of rows) summary[row.status] += 1;
  return summary;
}

// ---------------------------------------------------------------- проверка и таблица

/**
 * Есть ли команда в PATH. На Unix — `bash -lc command -v`, на Windows — свой разбор PATH и PATHEXT
 * (никакого шелла): имя `npx` там означает `npx.cmd`. Для `bash` ответ даёт resolveBash: заглушка WSL
 * в PATH — это не «bash есть», а ровно та причина, по которой записи на Windows и оказывались мёртвыми.
 */
function commandProbe(name) {
  if (IS_WIN) {
    if (/^bash(\.exe)?$/i.test(name)) {
      const bash = resolveBash();
      return bash.error ? { ok: false, why: bash.error } : { ok: true };
    }
    if (!whichTool(name, { skipWindowsApps: true })) return { ok: false, why: `в PATH нет ${name}` };
    return { ok: true };
  }
  const probe = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8", timeout: 10000 });
  if (probe.error) return { ok: false, why: `не проверить ${name}: ${probe.error.code ?? probe.error.message}` };
  if (probe.status !== 0) return { ok: false, why: `в PATH нет ${name}` };
  if (!String(probe.stdout ?? "").trim()) return { ok: false, why: `${name} в PATH отвечает пусто — похоже на заглушку` };
  return { ok: true };
}

/**
 * Проверка записи: файлы команды, ключи, доступность инструмента. На Windows команда берётся из
 * argvWindows — её там и ставит станция, — а пути проверяются isAbsolute: «начинается с /» пропускало бы
 * `C:\…` мимо проверки. Запись, которой на Windows нужен bash, помечается неставимой, а не «ок».
 */
function checkEntry(entry, secrets) {
  const problems = [];
  if (entry.kind === "stdio") {
    const argv = entryArgv(entry).map(expandForCheck);
    if (needsBashOnWindows(entry)) problems.push(BASH_MISSING_TEXT);
    if (isAbs(argv[0])) {
      if (!existsSync(argv[0])) problems.push(`нет файла ${argv[0]}`);
    } else {
      const probe = commandProbe(argv[0]);
      if (!probe.ok) problems.push(probe.why);
    }
    // пути внутри командной строки (скрипты MCP-серверов) тоже должны существовать
    for (const token of argv.join(" ").split(/[\s"'<>]+/)) {
      if (!/\.(mjs|js|cjs|ts|py|sh)$/.test(token)) continue;
      if (!isAbs(token)) continue;
      if (!existsSync(token)) problems.push(`нет файла ${token}`);
    }
    // Ключи stdio-сервера в конфиг не попадают: их читает обёртка (на Unix — шелл, на Windows —
    // bin/entryenv.mjs) из файла ключей. Поэтому спрашиваем файл, а не командную строку: иначе на
    // Windows проверка молчала бы зелёным про сервер, которому ключа негде взять.
    if (entry.requiresEnv?.length) {
      if (!existsSync(SECRETS_ABS)) problems.push(`нет файла ключей ${SECRETS_ABS}`);
      else for (const name of entry.requiresEnv) {
        if (!secrets.has(name)) problems.push(`в ${SECRETS_ABS} нет переменной ${name}`);
      }
    }
  }
  if (entry.kind === "http" && !entry.url) problems.push("пустой url");
  for (const [name, spec] of Object.entries(entry.headers ?? {})) {
    if (!secrets.has(spec.env)) problems.push(`в ${SECRETS_ABS} нет переменной ${spec.env} (заголовок ${name})`);
  }
  return problems;
}

const FRESHNESS = { current: "актуально", stale: "устарело", foreign: "чужое", absent: "нет" };

function statusTable(rows, clients) {
  const lines = [];
  for (const client of clients) {
    const spec = CLIENTS[client];
    const installed = rows.filter((row) => row.clients.some((c) => c.client === client && c.state !== "absent"));
    const missing = rows.filter((row) => row.entry && row.clients.some((c) => c.client === client && c.wanted) && row.clients.some((c) => c.client === client && c.state === "absent"));
    const extra = installed.filter((row) => !row.entry);
    lines.push(`${spec.label} (${spec.config()})`);
    if (installed.length === 0) {
      lines.push("  стоит: ничего");
    } else {
      lines.push(`  стоит (${installed.length}):`);
      for (const row of installed) {
        const own = row.clients.find((c) => c.client === client);
        const junk = own.state === "stale" || own.state === "foreign";
        lines.push(`    ${row.name.padEnd(16)} ${(row.tier ?? "-").padEnd(6)} ${FRESHNESS[own.state] ?? own.state}${junk ? ` (${row.why})` : ""}`);
      }
    }
    for (const tier of TIERS) {
      const gone = missing.filter((row) => row.tier === tier).map((row) => row.name);
      if (gone.length) lines.push(`  нет из каталога (${tier}): ${gone.join(", ")}`);
    }
    if (extra.length) {
      lines.push(`  вне каталога: ${extra.map((row) => `${row.name}${row.status === "orphan" ? " (наша, снять: update --prune)" : " (чужое, не трогаю)"}`).join(", ")}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- reconcile: install / update

function selectTargets(catalog, state, positional, profile, mode, clients, files) {
  if (positional.length) return selectEntries(catalog, positional);
  if (profile === "all") return catalog;
  if (profile === "core" || profile === "keyed") return catalog.filter((entry) => entry.tier === profile);
  // Без профиля: install ставит только базовый набор (keyed — по согласованию), update дополнительно
  // берёт то, что уже стоит: обновлять поставленное можно, а навязывать новое с ключом — нет.
  if (mode === "install") return catalog.filter((entry) => entry.tier === "core");
  const installed = new Set(Object.keys(state.servers));
  for (const client of clients) {
    for (const name of Object.keys(files.get(client).json[CLIENTS[client].key] ?? {})) installed.add(name);
  }
  return catalog.filter((entry) => entry.tier === "core" || installed.has(entry.name));
}

/**
 * reconcile: привести конфиги клиентов к каталогу.
 * install — явная команда: запись переписывается, даже если она не наша (имя названо голосом).
 * update — режим доверия к факту: переписываем только наши записи (состояние помнит отпечаток, либо
 * запись выглядит как наша), чужое не трогаем и докладываем, сирот снимаем только с --prune.
 */
async function reconcile(options) {
  const { mode, catalog, targets, clients, secrets, pool, dryRun, prune, yes, json, explicit } = options;
  const state = loadState();
  const files = loadClientFiles(clients);
  const at = (client, name) => files.get(client).json[CLIENTS[client].key]?.[name];
  const plan = [];
  const skipped = [];
  ensureSecretsFile(targets, { dryRun, json });

  for (const entry of targets) {
    const spec = specOf(entry);
    const missingKeys = keyVars(entry).filter((name) => !secrets.has(name));
    // Запись, которой на Windows нужен bash, туда не ставится: клиент получит мёртвый сервер
    if (needsBashOnWindows(entry)) {
      for (const client of clients) {
        plan.push({
          name: entry.name,
          client,
          label: CLIENTS[client].label,
          action: "skip-platform",
          detail: BASH_MISSING_TEXT,
        });
      }
      continue;
    }
    for (const client of clients) {
      const label = CLIENTS[client].label;
      const actual = at(client, entry.name);
      const wanted = !entry.clients || entry.clients.includes(client);
      const desired = wanted ? renderEntry(entry, client, secrets, pool, actual).value : null;
      const desiredShape = wanted ? desiredShapeOf(entry, client, pool) : null;
      const actualShape = actual === undefined ? null : shapeOf(spec, client, actual);
      const stRec = state.servers[entry.name]?.clients?.[client] ?? null;

      if (!wanted) {
        // каталог не прописывает сервер этому клиенту
        if (actual === undefined) {
          if (mode === "install") plan.push({ name: entry.name, client, label, action: "skip", detail: "пропуск (сервер не для него)" });
          continue;
        }
        const ours = (stRec && actualShape && fingerprint(actualShape) === stRec.fingerprint) || looksLikeOurs(null, actualShape);
        if (mode === "update" && ours) {
          plan.push({ name: entry.name, client, label, action: "remove", detail: "снят: каталог не прописывает сервер этому клиенту" });
        } else if (mode === "install") {
          plan.push({ name: entry.name, client, label, action: "skip", detail: "пропуск (сервер не для него)" });
        } else {
          plan.push({ name: entry.name, client, label, action: "foreign", detail: "не трогаю, это не наша запись" });
        }
        continue;
      }

      if (actual !== undefined && fingerprint(actualShape) === fingerprint(desiredShape)) {
        plan.push({ name: entry.name, client, label, entry, action: stRec ? "keep" : "adopt", detail: "уже стоит", shape: desiredShape });
        continue;
      }

      const ours = stRec && actualShape ? fingerprint(actualShape) === stRec.fingerprint : false;
      // На Windows Unix-форма (`bash -lc …`) в конфиге — это наша же запись прошлой установки: её
      // переписываем нативную, а не объявляем чужой. Настоящее чужое (например camoufox с абсолютным
      // путём к venv от установщика проекта) не трогаем без имени: ни update, ни голый install —
      // забрать такую запись себе можно только командой с именем сервера (`install camoufox`).
      const unixForm = looksLikeUnixForm(entry, client, actualShape);
      const claimed = ours || unixForm || looksLikeOurs(desiredShape, actualShape);
      if (actual !== undefined && !claimed && (mode === "update" || !explicit)) {
        plan.push({ name: entry.name, client, label, action: "foreign", detail: "не трогаю, это не наша запись" });
        continue;
      }
      if (missingKeys.length) {
        skipped.push({ name: entry.name, client, label });
        plan.push({ name: entry.name, client, label, action: "skip-key", detail: `нужен ключ ${missingKeys.join(", ")}` });
        continue;
      }
      const aspects = actual === undefined ? [] : diffAspects(spec, actualShape, desiredShape);
      // Если запись ещё та, что мы оставили, а желаемое уехало — виноват каталог; иначе запись разошлась.
      const intact = Boolean(ours) && actualShape && fingerprint(actualShape) === stRec.fingerprint;
      plan.push({
        name: entry.name,
        client,
        label,
        entry,
        action: actual === undefined ? "write" : "rewrite",
        detail: actual === undefined ? "записан" : `переписан — ${aspects.join(", ")}`,
        aspects,
        reason: actual === undefined ? "new" : unixForm ? "unix" : intact ? "catalog" : "drift",
        value: desired,
        shape: desiredShape,
      });
    }
  }

  // сироты: стоит у клиента, в каталоге больше нет, отпечаток наш — только такие снимает --prune
  const catalogNames = new Set(catalog.map((entry) => entry.name));
  if (mode === "update") {
    for (const name of Object.keys(state.servers).sort()) {
      if (catalogNames.has(name)) continue;
      const stored = state.servers[name];
      for (const client of clients) {
        const actual = at(client, name);
        const stRec = stored.clients?.[client];
        if (actual === undefined) continue;
        const actualShape = stored.spec ? shapeOf(stored.spec, client, actual) : null;
        const ours = Boolean(stRec && actualShape && fingerprint(actualShape) === stRec.fingerprint);
        if (!ours) {
          plan.push({ name, client, label: CLIENTS[client].label, action: "foreign", detail: "не трогаю: запись не наша или её изменили" });
          continue;
        }
        if (prune) {
          plan.push({ name, client, label: CLIENTS[client].label, action: "prune", detail: "снят: в каталоге его больше нет" });
        } else if (state.servers[name]) {
          plan.push({ name, client, label: CLIENTS[client].label, action: "orphan", detail: "в каталоге больше нет — снять: update --prune" });
        }
      }
    }
  }

  const prunes = plan.filter((item) => item.action === "prune");
  let pruneRefused = false;
  if (prunes.length && !yes && !dryRun) {
    const agreed = await confirm(`снять ${prunes.length} записей-сирот (${[...new Set(prunes.map((p) => p.name))].join(", ")})?`);
    if (agreed !== true) {
      pruneRefused = true;
      for (const item of prunes) {
        item.action = "orphan";
        item.detail = "в каталоге больше нет, но подтверждения не было — оставляю (--yes или ответ y)";
      }
    }
  }
  // трогаем файлы только там, где правда меняется (снятый из-за отказа prune — не в счёт)
  const touches = new Set(plan.filter((item) => ["write", "rewrite", "remove", "prune"].includes(item.action)).map((item) => item.client));
  const adoptions = plan.filter((item) => item.action === "adopt");

  // Гейты подтверждения из каталога: применяем к записям, которые пишем или уже держим как свои,
  // и считаем файл тронутым, если поменялись только гейты — тогда его тоже сохраняем и снапшотим.
  if (!dryRun) {
    for (const item of plan) {
      if (!["write", "rewrite", "adopt", "keep"].includes(item.action)) continue;
      const file = files.get(item.client);
      const before = JSON.stringify(file.json);
      applyApprovals(item.entry, item.client, file.json);
      if (JSON.stringify(file.json) !== before && !["write", "rewrite"].includes(item.action)) touches.add(item.client);
    }
  }

  if (pool && targets.some((entry) => entry.kind === "http")) {
    process.stdout.write(dryRun ? `шим пула: будет создан ${join(AGENT_HOME, ".local/bin/mcp-keypool")}\n` : `шим пула: ${writePoolShim()}\n`);
  }
  if (!dryRun && (touches.size || adoptions.length)) {
    if (touches.size) {
      takeSnapshot(state, `${mode}${targets.length === 1 ? ` ${targets[0].name}` : ""}`, snapshotFiles(files, [...touches].map((client) => files.get(client).path)));
    }
    for (const item of plan) {
      const file = files.get(item.client);
      const bucket = (file.json[CLIENTS[item.client].key] = file.json[CLIENTS[item.client].key] ?? {});
      if (["write", "rewrite"].includes(item.action)) {
        bucket[item.name] = item.value;
        rememberClient(state, item.entry, item.client, item.shape);
      } else if (["remove", "prune"].includes(item.action)) {
        delete bucket[item.name];
        forgetClient(state, item.name, item.client);
      }
    }
    for (const client of touches) {
      const file = files.get(client);
      saveConfig(file.path, file.before, file.json);
    }
    // запись, совпавшую с каталогом, станция принимает как свою: файл не трогаем, состояние ведём
    for (const item of adoptions) rememberClient(state, item.entry, item.client, item.shape);
    for (const name of Object.keys(state.servers)) {
      // записи, которых у клиентов уже нет, из состояния убираем: иначе оно копит фантомы
      if (catalogNames.has(name)) continue;
      const stored = state.servers[name];
      for (const client of clients) {
        if (stored.clients?.[client] && at(client, name) === undefined) forgetClient(state, name, client);
      }
    }
    state.catalog_hash = catalogHash(catalog);
    state.installed_at = state.installed_at ?? now();
    state.updated_at = now();
    saveState(state);
  }
  backupReport(json);

  const summary = { written: 0, rewritten: 0, adopted: 0, removed: 0, pruned: 0, skipped: 0, platform: 0, foreign: 0, orphans: 0, unchanged: 0 };
  for (const item of plan) {
    if (item.action === "write") summary.written += 1;
    else if (item.action === "rewrite") summary.rewritten += 1;
    else if (item.action === "adopt") summary.adopted += 1;
    else if (item.action === "remove") summary.removed += 1;
    else if (item.action === "prune") summary.pruned += 1;
    else if (item.action === "skip-key") summary.skipped += 1;
    else if (item.action === "skip-platform") summary.platform += 1;
    else if (item.action === "foreign") summary.foreign += 1;
    else if (item.action === "orphan") summary.orphans += 1;
    else if (item.action === "keep") summary.unchanged += 1;
  }
  const problems = summary.skipped + summary.platform + (pruneRefused ? 1 : 0);
  // dry-run — только показ: ничего не записано, поэтому и код возврата нулевой
  const exitCode = dryRun || problems === 0 ? 0 : 1;

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: problems === 0,
      schema: SCHEMA,
      mode,
      dry_run: dryRun,
      profile: options.profile ?? null,
      state_file: STATE_FILE,
      targets: targets.map((entry) => entry.name),
      actions: plan.map((item) => ({ name: item.name, client: item.client, action: item.action, detail: item.detail, aspects: item.aspects ?? [] })),
      skipped: plan.filter((item) => item.action === "skip-key").map((item) => ({ name: item.name, client: item.client, reason: item.detail, hint: keysAddHint(item.name) })),
      foreign: plan.filter((item) => item.action === "foreign").map((item) => ({ name: item.name, client: item.client })),
      summary,
      problems,
    }, null, 2)}\n`);
    return exitCode;
  }

  for (const entry of targets) {
    const mine = plan.filter((item) => item.name === entry.name);
    if (!mine.length) continue;
    process.stdout.write(`${entry.name}\n`);
    let keyLinePrinted = false;
    for (const item of mine) {
      if (item.action === "skip-platform") {
        process.stdout.write(`  ${item.label}: ${item.detail}\n`);
        continue;
      }
      if (item.action === "skip-key") {
        // «сказать одной строкой»: одна строка на сервер, а не на каждого клиента
        if (!keyLinePrinted) {
          keyLinePrinted = true;
          process.stdout.write(`${entry.name}: нужен ключ ${item.detail.replace("нужен ключ ", "")} — ${keysAddHint(entry.name)}, затем повтори mcp-station ${mode} ${entry.name}\n`);
        } else {
          process.stdout.write(`  ${item.label}: пропуск (нет ключа)\n`);
        }
        continue;
      }
      if (item.action === "adopt") {
        process.stdout.write(`  ${item.label}: уже как в каталоге (запись наша, состояние обновлено)\n`);
        continue;
      }
      if (item.action === "orphan") {
        process.stdout.write(`  ${item.label}: ${item.detail}\n`);
        continue;
      }
      const where = files.get(item.client)?.path ?? "";
      const tail = where ? ` (${where})` : "";
      if (item.action === "keep") process.stdout.write(`  ${item.label}: уже стоит\n`);
      else if (item.action === "write") process.stdout.write(`  ${item.label}: ${dryRun ? "будет записан" : "записан"}${tail}\n`);
      else if (item.action === "rewrite") {
        const cause = item.reason === "unix"
          ? "Unix-форма записи (bash -lc) заменена нативной"
          : item.reason === "catalog" ? "каталог изменился" : "запись разошлась";
        process.stdout.write(`  ${item.label}: ${dryRun ? "будет переписан" : "переписан"}${tail} — ${cause}: ${item.aspects.join(", ")}\n`);
      } else if (item.action === "remove") process.stdout.write(`  ${item.label}: ${dryRun ? "будет снят" : item.detail}${tail}\n`);
      else if (item.action === "prune") process.stdout.write(`  ${item.label}: ${dryRun ? "будет снят сиротой" : item.detail}${tail}\n`);
      else if (item.action === "foreign") process.stdout.write(`  ${item.label}: ${item.detail}${tail}\n`);
      else if (item.action === "skip") process.stdout.write(`  ${item.label}: ${item.detail}\n`);
    }
  }
  const rest = plan.filter((item) => !targets.some((entry) => entry.name === item.name));
  if (rest.length) {
    process.stdout.write("вне набора обновления:\n");
    for (const item of rest) process.stdout.write(`  ${item.name} (${item.label}): ${item.detail}\n`);
  }
  if (summary.foreign) process.stdout.write(`\nчужое (не трогаю): ${[...new Set(plan.filter((item) => item.action === "foreign").map((item) => item.name))].join(", ")}\n`);
  if (summary.skipped) process.stdout.write(`\nне поставлено без ключей: ${[...new Set(plan.filter((item) => item.action === "skip-key").map((item) => item.name))].join(", ")} — ${keysAddHint("<сервер>")}, затем повтори команду\n`);
  if (summary.platform) process.stdout.write(`\nне поставлено на этой ОС: ${[...new Set(plan.filter((item) => item.action === "skip-platform").map((item) => item.name))].join(", ")} — ${BASH_MISSING_TEXT}\n`);
  process.stdout.write(dryRun ? "\n(dry-run: ничего не записано)\n" : "\nготово\n");
  return exitCode;
}

/**
 * Спросить подтверждение: только у живого терминала — скрипт не должен ждать ввода вечно.
 * На Windows без настоящего bash спрашиваем сами (node + readline): `bash -c read` там нечем выполнить,
 * а `bash` из PATH — та самая заглушка WSL.
 */
async function confirm(question) {
  if (!process.stdin.isTTY) return null;
  const shell = IS_WIN ? resolveBash() : { path: "bash" };
  if (shell.error) return confirmInNode(question);
  const probe = spawnSync(shell.path, ["-c", `read -r -p ${JSON.stringify(question)} answer; printf %s "$answer"`], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) return null;
  return /^[yYдД]/.test((probe.stdout ?? "").trim());
}

/** Тот же вопрос без шелла: ответ читает node, чтобы на Windows не звать bash вообще. */
async function confirmInNode(question) {
  const prompt = createPromptInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^[yYдД]/.test((await prompt.question(`${question} [y/N] `)).trim());
  } catch {
    return null;
  } finally {
    prompt.close();
  }
}

// ---------------------------------------------------------------- remove и rollback

function removeServers(catalog, clients, names, dryRun, json) {
  const entries = selectEntries(catalog, names);
  const state = loadState();
  const files = loadClientFiles(clients);
  const plan = [];
  for (const entry of entries) {
    for (const client of clients) {
      const bucket = files.get(client).json[CLIENTS[client].key] ?? {};
      if (bucket[entry.name] === undefined) {
        plan.push({ name: entry.name, client, label: CLIENTS[client].label, action: "absent" });
        continue;
      }
      plan.push({ name: entry.name, client, label: CLIENTS[client].label, action: "remove" });
    }
  }
  const touches = new Set(plan.filter((item) => item.action === "remove").map((item) => item.client));
  if (!dryRun && touches.size) {
    takeSnapshot(state, `remove ${entries.map((entry) => entry.name).join(" ")}`, snapshotFiles(files, [...touches].map((client) => files.get(client).path)));
    for (const item of plan) {
      if (item.action !== "remove") continue;
      const bucket = (files.get(item.client).json[CLIENTS[item.client].key] = files.get(item.client).json[CLIENTS[item.client].key] ?? {});
      delete bucket[item.name];
      forgetClient(state, item.name, item.client);
    }
    for (const client of touches) {
      const file = files.get(client);
      saveConfig(file.path, file.before, file.json);
    }
    state.catalog_hash = catalogHash(catalog);
    state.updated_at = now();
    saveState(state);
  }
  backupReport(json);
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: SCHEMA,
      mode: "remove",
      dry_run: dryRun,
      targets: entries.map((entry) => entry.name),
      actions: plan,
      state_file: STATE_FILE,
    }, null, 2)}\n`);
    return 0;
  }
  for (const entry of entries) {
    process.stdout.write(`${entry.name}\n`);
    for (const item of plan.filter((row) => row.name === entry.name)) {
      const where = files.get(item.client).path;
      if (item.action === "absent") process.stdout.write(`  ${item.label}: не стоял\n`);
      else process.stdout.write(`  ${item.label}: ${dryRun ? "будет снят" : "снят"} (${where})\n`);
    }
  }
  process.stdout.write(dryRun ? "\n(dry-run: ничего не записано)\n" : "\nготово\n");
  return 0;
}

function rollback({ dryRun, json }) {
  const state = loadState();
  const snapshot = state.snapshots[state.snapshots.length - 1];
  if (!snapshot) {
    const message = "откатывать нечего: снимков в состоянии станции нет";
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, schema: SCHEMA, mode: "rollback", dry_run: dryRun, restored: [], message, state_file: STATE_FILE }, null, 2)}\n`);
    else process.stderr.write(`mcp-station: ${message}\n`);
    return 1;
  }
  const restored = [];
  for (const [path, content] of Object.entries(snapshot.files)) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === content) continue;
    const what = content === null ? "убран (появился после снимка)" : current === null ? "восстановлен из снимка" : "возвращён к снимку";
    restored.push({ path, what });
    if (dryRun) continue;
    if (content === null) {
      if (existsSync(path)) {
        backupOnce(path);
        rmSync(path);
      }
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (current !== null) backupOnce(path);
    writeFileSync(path, content);
  }
  if (!dryRun) {
    state.snapshots.pop();
    state.servers = snapshot.servers;
    state.updated_at = now();
    saveState(state);
  }
  backupReport(json);
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: SCHEMA,
      mode: "rollback",
      dry_run: dryRun,
      snapshot: { at: snapshot.at, reason: snapshot.reason },
      restored,
      snapshots_left: state.snapshots.length,
      state_file: STATE_FILE,
    }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`снимок ${snapshot.at} (${snapshot.reason})\n`);
  if (restored.length === 0) process.stdout.write("  файлы уже как в снимке — менять нечего\n");
  for (const item of restored) process.stdout.write(`  ${item.path}: ${dryRun ? `будет: ${item.what}` : item.what}\n`);
  process.stdout.write(`\nсостояние тоже вернулось к снимку${dryRun ? " (dry-run: ничего не записано)" : ""}\n`);
  return 0;
}

function outdated(catalog, clients, pool, json, problems = {}) {
  const state = loadState();
  const rows = survey(catalog, state, clients, pool, { catalog: problems.catalog ?? [], state: stateProblem });
  const summary = summarize(rows);
  // `ok` — «расхождений нет»: всё, что видно по трём сторонам, сошлось. Расхождение — не поломка
  // движка, поэтому код возврата остаётся нулевым (его читает центр и скрипты), а `ok` говорит правду.
  // Строки unknown — тоже не «сошлось»: там сверка не состоялась, источника не было.
  const ok = rows.length === summary.current;
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok,
      schema: SCHEMA,
      catalog: catalog.length,
      state_file: STATE_FILE,
      servers: rows.map((row) => ({
        name: row.name,
        tier: row.tier,
        status: row.status,
        why: row.why,
        clients: row.clients.map((client) => ({ client: client.client, state: client.state })),
      })),
      summary,
    }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`каталог: ${catalog.length} серверов, состояние: ${STATE_FILE}\n`);
  process.stdout.write(`итог: ${Object.entries(summary).map(([key, value]) => `${key} ${value}`).join(", ")}\n`);
  // Честная строка: почему часть серверов не сосчитана — иначе «current 0» читается как «всё хорошо»
  const unknown = rows.filter((row) => row.status === "unknown");
  if (unknown.length) process.stdout.write(`не смог узнать: ${unknown.length} — ${unknown[0].why}\n`);
  process.stdout.write("\n");
  for (const row of rows) {
    process.stdout.write(`${row.status.padEnd(8)} ${row.name.padEnd(16)} ${(row.tier ?? "-").padEnd(6)} ${row.why}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------- verify: живое рукопожатие

/**
 * Живая проверка: станция берёт запись ровно такой, какой её получит клиент из своего конфига (omp/pi
 * подставляют ключи `!`-командой на старте, opencode держит литерал), и поднимает настоящее соединение —
 * initialize → tools/list. Это не замена двух других проверок: check смотрит файлы, переменные и
 * доступность команд, outdated — версии и отпечатки, а verify — то, что сервер отвечает по протоколу.
 * Проверка не бесплатна: часть серверов поднимает браузер, поэтому есть таймаут, --exclude и --timeout.
 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_CLIENT_INFO = { name: "mcp-station", version: "1.0" };
/** С этого времени ожидания говорим человеку, почему висит: похоже, сервер поднимает браузер. */
const SLOW_AFTER_MS = 5000;

/** Ключи и значения заголовков в вывод не попадают: всё, что похоже на секрет, заменяется на ***. */
function scrubber(secrets) {
  const values = [...secrets.values()].filter((value) => value && value.length >= 6);
  const scrub = (text) => {
    let line = String(text ?? "").split("\n")[0];
    for (const value of values) line = line.split(value).join("***");
    return line.slice(0, 200);
  };
  scrub.add = (value) => {
    if (typeof value === "string" && value.length >= 6 && !values.includes(value)) values.push(value);
  };
  return scrub;
}

/** Первая непустая строка: в ошибке должна быть одна человеческая строка, а не простыня stderr. */
function firstLine(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * Значение `!`-подстановки без шелла: на Windows шелла нет, а ключ всё равно лежит в файле секретов.
 * Форма подстановки наша же (её пишет станция): `printf '<формат>' "$VAR"` — отсюда берём и переменную,
 * и формат. Ничего похожего на нашу подстановку не разбираем: честнее сказать, что раскрыть нечем.
 */
function shellHeaderValue(text, secrets) {
  const variable = /"\$([A-Za-z_][A-Za-z0-9_]*)"\s*$/.exec(text);
  if (!variable) return { error: "подстановка заголовка не раскрывается без шелла: в ней не видно переменной" };
  const value = secrets.get(variable[1]) ?? process.env[variable[1]];
  if (!value) return { error: `нет значения для заголовка: ни в ${SECRETS_ABS}, ни в окружении (${variable[1]})` };
  const format = /printf\s+'([^']*)'/.exec(text);
  return { value: (format ? format[1] : "%s").replace("%s", value) };
}

/**
 * Заголовки http-записи — так же, как их получит клиент: omp и pi подставляют значение `!`-командой на
 * старте (выполняем её), opencode держит литерал или ссылку {env:VAR}. Значения не печатаются нигде.
 */
function verifyHeaders(raw, secrets, scrub) {
  const headers = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
    const envRef = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
    if (text.startsWith("!")) {
      if (IS_WIN) {
        // ни одного bash из PATH: на Windows значение берём из файла секретов, а не выполняем строку
        const resolved = shellHeaderValue(text, secrets);
        if (resolved.error) return { error: `не удалось получить значение заголовка ${name}: ${resolved.error}` };
        headers[name] = resolved.value;
      } else {
        const probe = spawnSync("bash", ["-c", text.slice(1)], { encoding: "utf8", timeout: 10000 });
        if (probe.status !== 0) return { error: `не удалось получить значение заголовка ${name}` };
        headers[name] = (probe.stdout ?? "").trim();
      }
    } else if (envRef) {
      const resolved = process.env[envRef[1]] ?? secrets.get(envRef[1]);
      if (!resolved) return { error: `нет значения для заголовка ${name}: ни в окружении, ни в ${SECRETS_ABS}` };
      headers[name] = resolved;
    } else if (text) {
      headers[name] = text;
    }
    if (headers[name]) scrub.add(headers[name]);
  }
  return { headers };
}

/** Во что превращается запись клиента: stdio-команда или http-эндпоинт с рабочими заголовками. */
function verifyTarget(client, record, secrets, scrub) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { error: "запись не объект" };
  if (typeof record.url === "string" && record.url) {
    const resolved = verifyHeaders(record.headers, secrets, scrub);
    if (resolved.error) return { kind: "http", error: resolved.error };
    return { kind: "http", url: record.url, headers: resolved.headers };
  }
  const argv = flattenCommand(record);
  if (!argv || argv.length === 0) return { error: "в записи нет ни url, ни command" };
  const extra = record.env ?? record.environment ?? null;
  return { kind: "stdio", argv, env: extra && typeof extra === "object" ? extra : null };
}

/** Живые серверы прогона: их нужно погасить, даже если станция падает или её прерывают. */
const liveChildren = new Set();

/** Сирот после проверки быть не должно: гасим не только сервер, но и всю его группу процессов. */
function killTree(child) {
  return new Promise((resolve) => {
    const pid = child?.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) {
      liveChildren.delete(child);
      resolve();
      return;
    }
    if (IS_WIN) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      liveChildren.delete(child);
      resolve();
      return;
    }
    const exited = new Promise((done) => child.once("exit", () => done(true)));
    const signal = (name) => {
      try {
        process.kill(-pid, name); // группа: сервер убивается вместе со своими детьми (браузером и т.п.)
      } catch {
        try {
          child.kill(name);
        } catch {
          // уже мёртв
        }
      }
    };
    const after = (ms) => Promise.race([exited, new Promise((done) => setTimeout(() => done(false), ms))]);
    signal("SIGTERM");
    after(1000).then((gone) => {
      if (gone) {
        liveChildren.delete(child);
        resolve();
        return;
      }
      signal("SIGKILL");
      after(1000).then(() => {
        liveChildren.delete(child);
        resolve();
      });
    });
  });
}

function killAllChildren() {
  for (const child of liveChildren) {
    const pid = child?.pid;
    if (!pid) continue;
    if (IS_WIN) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // уже мёртв
        }
      }
    }
  }
  liveChildren.clear();
}

process.on("exit", () => {
  releaseBrowserLock();
  killAllChildren();
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    killAllChildren();
    process.exit(130);
  });
}

/**
 * Рукопожатие по stdio. stdout сервера — это протокол: строка не в формате JSON-RPC считается поломкой,
 * а не «шумом» (так же считает наш собственный прогон сервера в контейнере). Таймаут — на весь диалог:
 * не ответил — гасим процесс с детьми и говорим, на каком шаге он встал.
 */
function verifyStdio({ argv, env, timeoutMs, scrub, note }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const result = { state: "connected", ms: 0, tools: 0, server: "", error: "" };
    let settled = false;
    let child = null;
    let timer = null;
    let slowTimer = null;
    let version = 0;
    let phase = "initialize";
    let buffer = "";
    let stderr = "";
    const done = (state, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(slowTimer);
      result.state = state;
      result.error = error ?? "";
      result.ms = Date.now() - started;
      killTree(child).then(() => resolve(result));
    };
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // сервер уже закрыл поток — о поломке скажет выход
      }
    };
    const askInitialize = () =>
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSIONS[version], capabilities: {}, clientInfo: MCP_CLIENT_INFO } });
    function handle(message) {
      if (message.id === 1) {
        if (message.error) {
          // версию протокола сервер мог не принять — перебираем разумные, прежде чем ругаться
          if (version + 1 < PROTOCOL_VERSIONS.length) {
            version += 1;
            askInitialize();
            return;
          }
          done("no-handshake", `initialize отвергнут: ${scrub(message.error.message ?? message.error.code ?? "без объяснения")}`);
          return;
        }
        if (typeof message.result?.protocolVersion !== "string") {
          done("no-handshake", "ответ на initialize без protocolVersion");
          return;
        }
        const info = message.result.serverInfo ?? {};
        result.server = [info.name, info.version].filter(Boolean).join(" ").slice(0, 80);
        phase = "tools";
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          done("no-handshake", `tools/list отвергнут: ${scrub(message.error.message ?? "без объяснения")}`);
          return;
        }
        result.tools = Array.isArray(message.result?.tools) ? message.result.tools.length : 0;
        done("connected");
      }
    }
    try {
      const [program, ...rest] = spawnArgv(argv);
      child = spawn(program, rest, {
        stdio: ["pipe", "pipe", "pipe"],
        detached: !IS_WIN, // своя группа процессов: её и гасим
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (error) {
      done("spawn-failed", `не удалось запустить ${basename(argv[0])}: ${scrub(error.code ?? error.message)}`);
      return;
    }
    liveChildren.add(child);
    timer = setTimeout(() => done("timeout", phase === "initialize" ? "нет ответа на initialize" : "нет ответа на tools/list"), timeoutMs);
    if (timeoutMs >= SLOW_AFTER_MS) slowTimer = setTimeout(note, SLOW_AFTER_MS);
    child.on("error", (error) => done("spawn-failed", `не удалось запустить ${basename(argv[0])}: ${scrub(error.code ?? error.message)}`));
    child.stdin.on("error", () => {
      // сервер закрыл stdin: либо он уже ответил, либо падает — это видно по выходу
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0 && !settled) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        if (!line.startsWith("{")) {
          done("no-handshake", `в stdout не JSON-RPC: ${scrub(line)}`);
          return;
        }
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          done("no-handshake", `строка stdout не разбирается как JSON: ${scrub(line)}`);
          return;
        }
        handle(message);
      }
    });
    child.on("exit", (code) => {
      if (settled) return;
      const hint = firstLine(stderr);
      if (code !== 0) done("spawn-failed", `процесс завершился с кодом ${code}${hint ? `: ${scrub(hint)}` : ""}`);
      else done("no-handshake", phase === "initialize" ? "сервер завершился, не ответив на initialize" : "сервер завершился на tools/list");
    });
    askInitialize();
  });
}

/** Тело ответа MCP по http бывает и обычным JSON, и потоком SSE: разбираем оба вида. */
function messagesOf(text, contentType) {
  const body = String(text ?? "").trim();
  if (!body) return { messages: [], empty: true };
  const parse = (chunk) => {
    try {
      const value = JSON.parse(chunk);
      return Array.isArray(value) ? value : [value];
    } catch {
      return [];
    }
  };
  if (contentType.includes("text/event-stream") || body.startsWith("event:") || body.includes("\ndata:")) {
    const data = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .flatMap(parse);
    return { messages: data, empty: data.length === 0 };
  }
  const messages = parse(body);
  return { messages, empty: messages.length === 0 };
}

/** Хост эндпоинта без строки запроса: в url ключа быть не должно, но и печатать его целиком незачем. */
function endpointHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "эндпоинт";
  }
}

/** Рукопожатие по http: initialize → tools/list с заголовками ровно из записи (значения не печатаем). */
async function verifyHttp({ url, headers, timeoutMs, scrub, note }) {
  const started = Date.now();
  const host = endpointHost(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const slowTimer = timeoutMs >= SLOW_AFTER_MS ? setTimeout(note, SLOW_AFTER_MS) : null;
  const result = { state: "connected", ms: 0, tools: 0, server: "", error: "" };
  let phase = "initialize";
  let session = null;
  let emptyBody = false;
  const post = async (message) => {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
        ...headers,
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    if (response.headers.get("mcp-session-id")) session = response.headers.get("mcp-session-id");
    const parsed = messagesOf(await response.text(), (response.headers.get("content-type") ?? "").toLowerCase());
    emptyBody = parsed.empty;
    return parsed.messages;
  };
  const dialog = async () => {
    let answer = null;
    for (let version = 0; version < PROTOCOL_VERSIONS.length; version += 1) {
      const messages = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSIONS[version], capabilities: {}, clientInfo: MCP_CLIENT_INFO } });
      answer = messages.find((message) => message?.id === 1) ?? null;
      if (!answer || !answer.error) break; // ответили (или промолчали) — версии больше не перебираем
    }
    if (!answer) return { state: "no-handshake", error: emptyBody ? "на initialize пришёл пустой ответ" : "в ответе нет JSON-RPC — сервер отвечает не по MCP" };
    if (answer.error) return { state: "no-handshake", error: `initialize отвергнут: ${scrub(answer.error.message ?? answer.error.code ?? "без объяснения")}` };
    if (typeof answer.result?.protocolVersion !== "string") return { state: "no-handshake", error: "ответ на initialize без protocolVersion" };
    const info = answer.result.serverInfo ?? {};
    result.server = [info.name, info.version].filter(Boolean).join(" ").slice(0, 80);
    phase = "tools";
    await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const listed = (await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).find((message) => message?.id === 2) ?? null;
    if (!listed) return { state: "no-handshake", error: "на tools/list нет ответа с нашим id" };
    if (listed.error) return { state: "no-handshake", error: `tools/list отвергнут: ${scrub(listed.error.message ?? "без объяснения")}` };
    result.tools = Array.isArray(listed.result?.tools) ? listed.result.tools.length : 0;
    return {};
  };
  let outcome;
  try {
    outcome = await dialog();
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      outcome = { state: "timeout", error: phase === "initialize" ? "нет ответа на initialize" : "нет ответа на tools/list" };
    } else if (/^HTTP \d/.test(error?.message ?? "")) {
      outcome = { state: "http-error", error: scrub(error.message) };
    } else {
      outcome = { state: "http-error", error: `запрос не прошёл (${host}): ${scrub(error?.cause?.code ?? error?.message ?? "причина неизвестна")}` };
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(slowTimer);
  }
  return { ...result, ...outcome, ms: Date.now() - started };
}

/**
 * verify: по каждой записи клиента — живое рукопожатие. Записи берём из конфига как есть, каталог нужен
 * только чтобы узнать имя с таймаутом из поля verifyTimeout (тяжёлые серверы поднимаются дольше).
 *
 * Каждая строка помечается `ours` — наша ли это запись (та же логика, что у survey): у ICP уже есть
 * свои MCP-записи, и их провал не наш. Своих провалов нет — код 0, даже если чужие не поднялись;
 * чужие называются строкой «чужое, не считаем» и полем `foreign_failed`, а `failed` остаётся суммой
 * (совместимость). Состояние станции не прочитать — не гадаем: своё то, чьё имя есть в каталоге,
 * и об этом сказано полем `owners: "catalog"`.
 *
 * Перед проверкой браузерных записей (поле каталога browser) станция берёт блокировку браузера: браузерных
 * прогонов на машине может быть один за раз. --no-lock — явный обход с предупреждением; занятую живым
 * владельцем блокировку не трогаем, протухшую снимаем сами.
 */
async function verifyServers({ catalog, clients, names, exclude, timeout, json, secrets, lock, pool = false }) {
  const scrub = scrubber(secrets);
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const files = loadClientFiles(clients);
  // состояние — тем же способом, что у outdated: принадлежность записи решается по нему, а не на глаз
  const state = loadState();
  const stateDown = Boolean(stateProblem);
  const excluded = new Set(exclude);
  const requested = [...new Set(names)].filter((name) => !excluded.has(name));
  const progress = json
    ? (line) => process.stderr.write(line)
    : (line) => process.stdout.write(line);
  const clientRows = [];
  let total = 0;
  let connectedCount = 0;

  // Что вообще проверяем: нужно до старта серверов — по этому набору решается, брать ли блокировку
  const targets = new Map();
  const wantedAll = new Set();
  for (const client of CLIENT_ORDER.filter((name) => clients.includes(name))) {
    const file = files.get(client);
    const bucket = file.json[CLIENTS[client].key] ?? {};
    const installed = Object.keys(bucket);
    const wanted = requested.length ? requested : installed.filter((name) => !excluded.has(name));
    targets.set(client, { file, bucket, installed, wanted });
    for (const name of wanted) wantedAll.add(name);
  }
  const browsers = [...wantedAll].filter((name) => byName.get(name)?.browser === true);
  const sessions = clientProcesses();

  progress(`живая проверка: поднимаю настоящие серверы (часть из них тянет браузер), до ${timeout} с на сервер\n`);
  if (browsers.length) {
    if (lock === false) {
      progress(`--no-lock: проверяю браузерные серверы (${browsers.join(", ")}) без блокировки — два прогона на одной машине столкнутся\n\n`);
    } else {
      const taken = takeBrowserLock({ owner: "mcp-station verify", run: `браузерные: ${browsers.join(", ")}`, progress });
      if (!taken.ok) {
        if (json) {
          process.stdout.write(`${JSON.stringify({
            ok: false,
            schema: SCHEMA,
            timeout,
            clients: [],
            summary: { total: 0, connected: 0, failed: 0 },
            error: taken.error,
          }, null, 2)}\n`);
        }
        return 1;
      }
    }
  }
  progress("\n");

  for (const client of CLIENT_ORDER.filter((name) => clients.includes(name))) {
    const { file, bucket, installed, wanted } = targets.get(client);
    const servers = [];
    progress(`${CLIENTS[client].label} — ${file.path}\n`);
    if (installed.length === 0) progress("  в конфиге записей нет — проверять нечего\n");
    for (const name of wanted) {
      const entry = byName.get(name) ?? null;
      const record = bucket[name];
      const stored = state.servers[name] ?? null;
      // принадлежность записи — той же логикой, что и в survey: своё не путаем с чужим
      const spec = entry ? specOf(entry) : stored?.spec ?? null;
      const actualShape = record === undefined || !spec ? null : shapeOf(spec, client, record);
      const stRec = stored?.clients?.[client] ?? null;
      const wantedForClient = entry ? !entry.clients || entry.clients.includes(client) : false;
      // записи нет вовсе (имя назвали, а в конфиге пусто) — чужим такое не называем: чужого тут нет
      const ours = record === undefined
        ? true
        : recordIsOurs({ entry, stRec, client, actualShape, wanted: wantedForClient, pool, stateDown });
      const seconds = entry && Number.isFinite(Number(entry.verifyTimeout)) && Number(entry.verifyTimeout) > 0 ? Number(entry.verifyTimeout) : timeout;
      const limitMs = seconds * 1000;
      const row = { name, state: "spawn-failed", ms: 0, tools: 0, server: "", error: "", ours };
      if (record === undefined) {
        row.error = `в конфиге ${CLIENTS[client].label} записи нет — поднимать нечего`;
      } else {
        const target = verifyTarget(client, record, secrets, scrub);
        if (target.error) {
          // http-запись без рабочего заголовка — это не «не поднялся», а «запрос не отправить»
          row.state = target.kind === "http" ? "http-error" : "spawn-failed";
          row.error = target.error;
        } else {
          const windows = target.kind === "stdio" ? windowsBashArgv(target.argv) : null;
          if (windows?.error) {
            // пред-полёт: без настоящего bash поднимать нечего — иначе вместо причины был бы мусор WSL
            row.state = "spawn-failed";
            row.error = windows.error;
          } else {
            if (windows) target.argv = windows.argv;
            progress(`  ${name}: проверяю… (до ${seconds} с)\n`);
            const note = () => progress(`  ${name}: пока не ответил — поднимаю браузер, это долго\n`);
            const outcome = target.kind === "stdio"
              ? await verifyStdio({ argv: target.argv, env: target.env, timeoutMs: limitMs, scrub, note })
              : await verifyHttp({ url: target.url, headers: target.headers, timeoutMs: limitMs, scrub, note });
            Object.assign(row, outcome);
          }
        }
      }
      progress(row.state === "connected"
        ? `  ${name}: connected — ${row.ms} мс, тулов ${row.tools}${row.server ? ` (${row.server})` : ""}\n`
        : `  ${name}: ${row.state} — ${row.error} (${row.ms} мс)\n`);
      if (row.state === "connected") connectedCount += 1;
      total += 1;
      servers.push(row);
    }
    // Конфиг новее запуска клиента: запись есть, а тулов в текущей сессии нет — это видно и в выводе, и в JSON
    const stale = sessionStale(client, file.path, sessions);
    if (stale) {
      progress(`${CLIENTS[client].label}: запись новее запуска клиента (процесс с ${stale.since}, конфиг правлен ${stale.modified}, pid ${stale.pid}): ${STALE_HINT}\n`);
    }
    clientRows.push({
      client,
      label: CLIENTS[client].label,
      file: file.path,
      installed,
      servers,
      ...(stale === null ? {} : { session_stale: Boolean(stale) }),
    });
  }

  const failed = total - connectedCount;
  // Чужие провалы — отдельно: у ICP уже есть свои MCP-записи, и их поломка — не наша
  const foreignFailures = [];
  for (const entry of clientRows) {
    for (const server of entry.servers) {
      if (server.state === "connected" || server.ours !== false) continue;
      foreignFailures.push({ client: entry.client, name: server.name, state: server.state, ms: server.ms, error: server.error });
    }
  }
  const failedOurs = failed - foreignFailures.length;
  const summary = { total, connected: connectedCount, failed, failed_ours: failedOurs, foreign_failed: foreignFailures.length };
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: failedOurs === 0,
      schema: SCHEMA,
      timeout,
      owners: stateDown ? "catalog" : "state",
      clients: clientRows,
      summary,
      foreign_failures: foreignFailures,
      ...(stateDown ? { state_error: stateProblem } : {}),
    }, null, 2)}\n`);
    return failedOurs === 0 ? 0 : 1;
  }
  progress(`\nитог: проверок ${total}, connected ${connectedCount}, не поднялось ${failedOurs}\n`);
  if (stateDown) progress(`принадлежность записей — по каталогу: состояние станции не прочитать (${stateProblem})\n`);
  for (const failure of foreignFailures) {
    progress(`чужое, не считаем: ${failure.client}/${failure.name} — ${failure.state}\n`);
  }
  progress("verify — только соединение: файлы, переменные и команды — check, версии и отпечатки — outdated\n");
  if (failedOurs) progress("код возврата 1: не всё отвечает по протоколу (--exclude пропускает лишнее, --timeout даёт больше времени)\n");
  return failedOurs === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- разбор аргументов

const argv = process.argv.slice(2);
const flags = { client: "all", dryRun: false, json: false, secrets: null, opencodeHeaders: null, pool: false, profile: null, prune: false, yes: false, timeout: 20, exclude: [], lock: true };
const positional = [];
const commands = new Set(["install", "remove", "list", "status", "check", "outdated", "update", "rollback", "verify"]);
let command = "install";

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (commands.has(arg) && i === 0) {
    command = arg;
  } else if (arg === "--client") {
    flags.client = argv[++i];
  } else if (arg === "--profile") {
    flags.profile = argv[++i];
    if (flags.profile !== null && ![...TIERS, "all"].includes(flags.profile)) {
      process.stderr.write(`mcp-station: --profile принимает ${[...TIERS, "all"].join("|")}, получено: ${flags.profile}\n`);
      process.exit(2);
    }
  } else if (arg === "--dry-run") {
    flags.dryRun = true;
  } else if (arg === "--prune") {
    flags.prune = true;
  } else if (arg === "--no-lock") {
    flags.lock = false;
  } else if (arg === "--yes") {
    flags.yes = true;
  } else if (arg === "--pool") {
    flags.pool = true;
  } else if (arg === "--json") {
    flags.json = true;
  } else if (arg === "--timeout") {
    flags.timeout = Number(argv[++i]);
    if (!Number.isFinite(flags.timeout) || flags.timeout < 1) {
      process.stderr.write("mcp-station: --timeout принимает секунды (число ≥ 1)\n");
      process.exit(2);
    }
  } else if (arg === "--exclude") {
    flags.exclude = [...flags.exclude, ...String(argv[++i] ?? "").split(",").map((name) => name.trim()).filter(Boolean)];
  } else if (arg === "--secrets-file") {
    flags.secrets = argv[++i];
  } else if (arg === "--opencode-headers") {
    flags.opencodeHeaders = argv[++i];
  } else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    process.stderr.write(`mcp-station: неизвестный флаг ${arg}\n`);
    process.exit(2);
  } else {
    positional.push(arg);
  }
}

if (flags.opencodeHeaders) process.env.MCP_STATION_OPENCODE_HEADERS = flags.opencodeHeaders;
if (flags.secrets) process.env.MCP_STATION_SECRETS = flags.secrets;

/**
 * Выход с кодом, который не теряет крупный вывод. `process.exit()` не ждёт слива stdout в трубу, и
 * `outdated --json` обрезался на середине строки — тест «битое состояние станции» это и ловил.
 *
 * Прерывание и дописывание делаются сразу: кидаем исключение, его ловит общий catch и там уже
 * выставляет код и даёт процессу выйти самому (так stdout дописывается всегда). Ждать событие
 * `drain` после записи нельзя: если буфер опустел раньше подписки, событие не придёт вовсе, процесс
 * останется с невыполненным await и умрёт с кодом 13 — «unfinished top-level await».
 */
class Bail extends Error {
  constructor(code) {
    super(`bail ${code}`);
    this.code = code;
    this.bail = true;
  }
}

function finish(code) {
  throw new Bail(code);
}

/** Незавершённый выход: код кладём в process.exitCode и даём event loop дописать stdout. */
function linger(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}

try {
  const { entries: catalog, problems: catalogProblems } = loadCatalog();
  const secrets = readSecrets();
  const clients = targetClients(flags.client);

  // rollback — путь восстановления: ему каталог не нужен вовсе, и битый каталог не повод не откатить
  if (command === "rollback") {
    finish(rollback({ dryRun: flags.dryRun, json: flags.json }));
  }

  // сверка сама докладывает нечитаемый каталог как «не смог узнать» (status unknown, summary.unknown)
  if (command === "outdated") {
    finish(outdated(catalog, clients, flags.pool, flags.json, { catalog: catalogProblems }));
  }

  // остальным каталог нужен для дела: пустой или нечитаемый — отказ с причиной, а не «ставить нечего»
  requireCatalog(catalogProblems);

  if (command === "list") {
    for (const entry of catalog) {
      const where = entry.clients ? entry.clients.join("/") : "все клиенты";
      process.stdout.write(`${entry.name.padEnd(14)} ${entry.tier.padEnd(6)} ${entry.kind.padEnd(5)} ${where.padEnd(18)} ${entry.description ?? ""}\n`);
    }
    finish(0);
  }

  if (command === "status") {
    const rows = survey(catalog, loadState(), clients, flags.pool, { state: stateProblem });
    process.stdout.write(`${statusTable(rows, clients).join("\n")}\n`);
    finish(0);
  }

  if (command === "check") {
    let bad = 0;
    for (const entry of selectEntries(catalog, positional)) {
      const problems = checkEntry(entry, secrets);
      if (problems.length === 0) {
        process.stdout.write(`${entry.name.padEnd(12)} ok\n`);
      } else {
        bad += 1;
        process.stdout.write(`${entry.name.padEnd(12)} ${problems.join("; ")}\n`);
      }
    }
    finish(bad === 0 ? 0 : 1);
  }

  if (command === "verify") {
    finish(await verifyServers({
      catalog,
      clients,
      names: positional,
      exclude: flags.exclude,
      timeout: flags.timeout,
      json: flags.json,
      secrets,
      lock: flags.lock,
      pool: flags.pool,
    }));
  }

  if (command === "remove") {
    finish(removeServers(catalog, clients, positional, flags.dryRun, flags.json));
  }

  const state = loadState();
  const targets = selectTargets(catalog, state, positional, flags.profile, command, clients, loadClientFiles(clients));
  finish(await reconcile({
    mode: command,
    profile: flags.profile,
    catalog,
    targets,
    clients,
    secrets,
    pool: flags.pool,
    dryRun: flags.dryRun,
    prune: flags.prune,
    yes: flags.yes,
    json: flags.json,
    // имя сервера в командной строке — это «приведи запись к каталогу»: только так станция забирает
    // себе чужую запись (см. README, «Записи, поставленные не станцией, она не трогает»)
    explicit: positional.length > 0,
  }));
} catch (error) {
  if (error?.bail) {
    // свой выход, а не ошибка: печатать нечего, важно не оборвать вывод и отдать код
    linger(error.code);
  } else {
    process.stderr.write(`mcp-station: ${error.message}\n`);
    process.exit(1);
  }
}
