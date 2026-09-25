/**
 * Ядро плагинов центра — одно на все три клиента (opencode2, omp, pi).
 *
 * Здесь только то, что не зависит от API клиента: список команд, запуск `center`
 * с таймаутом, человеческий вывод и дешёвая сводка для старта сессии. Обёртки
 * клиентов (agent/center.ts для omp и pi, opencode/center.ts для opencode2)
 * не дублируют логику, а зовут эти функции.
 *
 * Пути считаются от самого файла (реального, а не симлинка в каталоге клиента):
 * абсолютных путей диска в исходниках станции нет — она переезжает вместе с диском.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Реальный путь этого файла: из каталога клиента он подключён симлинком. */
const SELF = (() => {
  const own = fileURLToPath(import.meta.url);
  try {
    return realpathSync(own);
  } catch {
    return own;
  }
})();

/** Каталог станции `command-center/` — на уровень выше `plugin/lib/`. */
export const CENTER_ROOT = process.env.CENTER_ROOT_OVERRIDE || join(dirname(SELF), "..", "..");

/** HOME можно подменить в тестах; в бою — настоящий. */
export function home(): string {
  return process.env.CENTER_HOME || homedir();
}

export type Command = {
  /** Подкоманда центра: `/center <name>`. */
  name: string;
  /** Что делает — уходит в список команд клиента и в подсказку. */
  description: string;
  /** Сколько ждать. update запускает установку станций, поэтому щедрее остальных. */
  timeoutMs: number;
  /** Аргумент, который нужен команде (для подсказки), если он обязателен. */
  needs?: string;
};

/**
 * Контракт плагина: ровно те команды, что заморожены в задании. Каждая просто
 * зовёт центр и отдаёт его вывод как есть (центр и так печатает для человека).
 */
export const COMMANDS: Command[] = [
  { name: "status", description: "Что с каждым проектом: файлы, git, тесты, ссылки", timeoutMs: 120_000 },
  { name: "verify", description: "Живая проверка MCP: отвечают ли серверы (все три среды)", timeoutMs: 300_000 },
  { name: "outdated", description: "Что устарело: сверки проектов и сводка", timeoutMs: 300_000 },
  { name: "update", description: "Обновить проекты их же командами, потом перепроверить связи", timeoutMs: 1_800_000 },
  { name: "ps", description: "Процессы и блокировка браузера", timeoutMs: 30_000 },
  { name: "logs", description: "Логи проекта: /center logs <проект> [--tail N]", timeoutMs: 60_000, needs: "<проект>" },
  { name: "docs", description: "Документация системы: /center docs [тема]", timeoutMs: 60_000 },
];

const TIMEOUT_OVERRIDE = Number(process.env.CENTER_PLUGIN_TIMEOUT_MS || 0);
/** Предел вывода: длинную простыню в диалог не тащим. */
const OUTPUT_LIMIT = Number(process.env.CENTER_PLUGIN_OUTPUT_LIMIT || 200_000);

/** Подсказка со списком подкоманд — она же ответ на неизвестную команду. */
export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    "center — команды центра координации (каждая зовёт `center` и печатает его вывод):",
    ...COMMANDS.map((command) => `  /center ${command.name.padEnd(width)}  ${command.description}`),
    "",
    "Подробности: /center docs",
  ].join("\n");
}

export type RunResult = {
  /** Код возврата центра (124 — наш таймаут). */
  code: number;
  /** stdout + stderr, обрезанные по OUTPUT_LIMIT. */
  text: string;
  /** Одна строка про то, почему не позвали (нет node, таймаут и т.п.). */
  error?: string;
};

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** stdout и stderr в одном тексте: центру есть что сказать в обоих. */
function merge(out: string, err: string): string {
  const left = out.trimEnd();
  const right = err.trimEnd();
  if (!right) return left;
  if (!left) return right;
  return `${left}\n${right}`;
}

/**
 * Запустить `center` и вернуть его вывод. Рантаймом берём node, а не текущий
 * процесс: под omp/pi `process.execPath` — сам клиент, и подставить его сюда
 * значило бы запустить клиент вместо центра.
 */
export function runCenter(args: string[], options: { timeoutMs?: number } = {}): Promise<RunResult> {
  const timeoutMs = TIMEOUT_OVERRIDE > 0 ? TIMEOUT_OVERRIDE : options.timeoutMs ?? 60_000;
  const node = process.env.CENTER_NODE || "node";
  const { promise, resolve } = Promise.withResolvers<RunResult>();

  let child;
  try {
    child = spawn(node, [join(CENTER_ROOT, "bin", "center.mjs"), ...args], {
      cwd: CENTER_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    resolve({ code: 127, text: "", error: `не запустить ${node}: ${String(error)}` });
    return promise;
  }

  let out = "";
  let err = "";
  let done = false;
  const collect = (chunk: Buffer, into: (text: string) => void) => {
    if (out.length + err.length > OUTPUT_LIMIT) return;
    into(chunk.toString("utf8"));
  };

  child.stdout?.on("data", (chunk: Buffer) => collect(chunk, (text) => (out += text)));
  child.stderr?.on("data", (chunk: Buffer) => collect(chunk, (text) => (err += text)));

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    resolve({
      code: 124,
      text: merge(out, err),
      error: `таймаут ${Math.round(timeoutMs / 1000)} с`,
    });
  }, timeoutMs);

  child.on("error", (error: NodeJS.ErrnoException) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({
      code: 127,
      text: "",
      error: error.code === "ENOENT" ? `нет ${node} в PATH (им запускается движок центра)` : String(error.message),
    });
  });

  child.on("close", (code: number | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({ code: code ?? 0, text: merge(out, err) });
  });

  return promise;
}

export type CommandResult = {
  /** Человеческий текст: вывод центра либо одна строка про причину отказа. */
  text: string;
  /** Команда отработала без ошибки. */
  ok: boolean;
};

/**
 * Ответ на `/center <подкоманда> [аргументы]`: заголовок, вывод центра и — если
 * команда упала — одна строка про причину. Человек читает текст, а не JSON.
 */
export async function runCommand(input: string): Promise<CommandResult> {
  const parts = splitArgs(input);
  const name = parts[0];
  if (!name) return { text: helpText(), ok: true };

  const command = COMMANDS.find((item) => item.name === name);
  if (!command)
    return {
      text: `center: нет команды «${name}». Есть: ${COMMANDS.map((item) => item.name).join(" | ")}\n\n${helpText()}`,
      ok: false,
    };
  if (command.needs && parts.length < 2)
    return { text: `center ${name}: нужен аргумент ${command.needs}`, ok: false };

  const result = await runCenter([name, ...parts.slice(1)], { timeoutMs: command.timeoutMs });
  if (result.error && !result.text) return { text: `center ${name}: ${result.error}`, ok: false };
  if (result.error) return { text: `center ${name}: ${result.error}\n\n${result.text}`, ok: false };
  if (result.code !== 0) {
    const why = firstLine(result.text) || `код ${result.code}`;
    return { text: `center ${name}: ошибка — ${why}\n\n${result.text}`, ok: false };
  }
  return { text: result.text || `center ${name}: пусто (команда ничего не напечатала)`, ok: true };
}

/** Аргументы как в шелле: кавычки снимаются, внутри кавычек пробелы сохраняются. */
export function splitArgs(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  return matches.map((item) => item.replace(/^["']|["']$/g, ""));
}

// ---------------------------------------------------------------------------
// Сводка на старте сессии: считается локально из файлов, без спавна станций —
// поэтому она дешёвая и её не стыдно запускать на каждом старте. Живые
// соединения MCP здесь не проверяются: это дорого и это работа `/center verify`.
// ---------------------------------------------------------------------------

export type Summary = {
  /** Одна строка для статусной панели клиента. */
  line: string;
  /** Развёрнуто: то же, но по строке на пункт. */
  lines: string[];
  /** Конкретные расхождения, если есть; пусто — значит расхождений не нашли. */
  drift: string[];
};

type ClientConfig = { client: string; file: string; key: string };

/** Где у клиентов лежат реестры MCP — те же файлы, что читает doctor центра. */
function clientConfigs(): ClientConfig[] {
  return [
    { client: "omp", file: join(home(), ".omp/agent/mcp.json"), key: "mcpServers" },
    { client: "pi", file: join(home(), ".pi/agent/mcp.json"), key: "mcpServers" },
    {
      client: "opencode",
      file: join(process.env.XDG_CONFIG_HOME || join(home(), ".config/opencode"), "opencode.json"),
      key: "mcp",
    },
  ];
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function countKeys(value: unknown, key: string): number {
  if (!value || typeof value !== "object") return 0;
  const section = (value as Record<string, unknown>)[key];
  if (!section || typeof section !== "object") return 0;
  return Object.keys(section as Record<string, unknown>).length;
}

/** Каталоги слоёв скиллов: у каждого клиента свой, считаем объединение имён. */
function skillRoots(): string[] {
  return [
    join(home(), ".agents/skills"),
    join(process.env.XDG_CONFIG_HOME || join(home(), ".config/opencode"), "skills"),
    join(home(), ".omp/agent/skills"),
    join(home(), ".pi/agent/skills"),
  ];
}

function countSkills(): number {
  const names = new Set<string>();
  for (const root of skillRoots()) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) names.add(entry.name);
      }
    } catch {
      /* слоя нет — не беда */
    }
  }
  return names.size;
}

/** Версия набора лежит рядом со станцией, в корне набора. */
function suiteVersion(): string | undefined {
  try {
    const version = readFileSync(join(CENTER_ROOT, "..", "VERSION"), "utf8").trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

/** Наши симлинки у клиентов: имя → куда должен вести. */
function pluginLinks(): { client: string; path: string }[] {
  const xdg = process.env.XDG_CONFIG_HOME || join(home(), ".config/opencode");
  return [
    { client: "opencode", path: join(xdg, "plugins/center.ts") },
    { client: "omp", path: join(home(), ".omp/agent/extensions/center.ts") },
    { client: "pi", path: join(home(), ".pi/agent/extensions/center.ts") },
  ];
}

function linkState(path: string): "ok" | "broken" | "missing" {
  try {
    readFileSync(path);
    return "ok";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    return "broken";
  }
}

/**
 * Сводка для старта сессии. Никаких спавнов: только чтение файлов, поэтому
 * укладывается в десятки миллисекунд и не тормозит старт.
 */
export function summary(): Summary {
  const version = suiteVersion();
  const mcp = clientConfigs().map((config) => ({
    client: config.client,
    count: countKeys(readJson(config.file), config.key),
  }));
  const skills = countSkills();
  const links = pluginLinks().map((link) => ({ ...link, state: linkState(link.path) }));

  const drift: string[] = [];
  if (!version) drift.push("набор не читается (VERSION рядом со станцией не найден)");
  const counts = mcp.map((item) => item.count);
  const most = Math.max(0, ...counts);
  if (most === 0) drift.push("MCP нигде не зарегистрирован");
  else if (counts.some((count) => count !== most))
    drift.push(`MCP разошлись: ${mcp.map((item) => `${item.client} ${item.count}`).join(", ")}`);
  for (const link of links)
    if (link.state !== "ok") drift.push(`плагин центра у ${link.client}: ${link.state === "broken" ? "битая ссылка" : "не поставлен"}`);

  const mcpLine = mcp.map((item) => `${item.client} ${item.count}/${most}`).join(", ");
  const state = drift.length === 0 ? "расхождений нет" : `устарело: ${drift.length}`;
  const line = `DATA ${version ? "ok" : "нет"} · MCP ${mcpLine} · скиллов ${skills} · набор ${version ?? "?"} · ${state}`;

  return {
    line,
    lines: [
      `${version ? "•" : "×"} DATA смонтирован: ${version ? `да, набор ${version}` : "нет"}`,
      `• MCP зарегистрировано: ${mcpLine} (живые соединения — /center verify)`,
      `• Скиллов в слоях: ${skills}`,
      `• Версия набора: ${version ?? "не прочитать"}`,
      drift.length ? `• Устарело: ${drift.join("; ")}` : "• Устарело: ничего не нашли",
    ],
    drift,
  };
}
