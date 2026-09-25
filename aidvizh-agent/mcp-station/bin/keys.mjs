#!/usr/bin/env node
// Ключи станции: один файл секретов, сколько угодно ключей на провайдера.
//
//   keys                интерактивно (для двойного щелчка)
//   keys list           что лежит: имена переменных, маскированные значения, счёт по серверам
//   keys add <сервер>   добавить ключ (значение спрашивается скрыто или приходит в --key)
//   keys remove <сервер> [--var VAR] снять ключ (по умолчанию — последний)
//
// Первый ключ пишется как VAR, следующие — VAR_2, VAR_3… Станция и пул-прокси перебирают их по порядку.
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_DIR = process.env.MCP_STATION_CATALOG || join(ROOT, "catalog");
const AGENT_HOME = process.env.MCP_STATION_HOME || homedir();
const SECRETS = process.env.MCP_STATION_SECRETS || join(AGENT_HOME, ".config/opencode/secrets/env");

/** Переменные сервера: из заголовков http и из requiresEnv у stdio. */
function serverKeys() {
  const map = new Map();
  for (const file of readdirSync(CATALOG_DIR).filter((f) => f.endsWith(".json"))) {
    const entry = JSON.parse(readFileSync(join(CATALOG_DIR, file), "utf8"));
    const vars = new Set(entry.requiresEnv ?? []);
    for (const spec of Object.values(entry.headers ?? {})) vars.add(spec.env);
    if (vars.size) map.set(entry.name, [...vars]);
  }
  return map;
}

function readEnv() {
  if (!existsSync(SECRETS)) return [];
  return readFileSync(SECRETS, "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim(), raw: line };
    });
}

function writeEnv(entries, comments = []) {
  mkdirSync(dirname(SECRETS), { recursive: true });
  const body = [...comments, ...entries.map((e) => `${e.name}=${e.value}`)].join("\n");
  writeFileSync(SECRETS, `${body}\n`, { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
}

function mask(value) {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} симв.)`;
}

/** Имена переменных одного сервера: VAR, VAR_2, VAR_3… */
function variants(entries, base) {
  return entries
    .filter((e) => e.name === base || new RegExp(`^${base}_\\d+$`).test(e.name))
    .sort((a, b) => (a.name === base ? -1 : b.name === base ? 1 : Number(a.name.split("_").pop()) - Number(b.name.split("_").pop())));
}

function nextName(entries, base) {
  const used = new Set(entries.map((e) => e.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }
    // скрытый ввод: глушим эхо и не печатаем значение
    const stdin = process.stdin;
    process.stdout.write(question);
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text.includes("\n") || text.includes("\r")) {
        stdin.removeListener("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        rl.close();
        process.stdout.write("\n");
        resolve(text.replace(/[\r\n]+.*$/s, "").trim());
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    if (stdin.isTTY) process.stdout.write("\x1b[8m"); // невидимый ввод там, где нет raw-режима
    stdin.on("data", onData);
  });
}

function usage() {
  process.stdout.write(`ключи станции (${SECRETS})

  keys list                     имена переменных и маскированные значения
  keys add <сервер>             добавить ключ: спросит значение скрыто (или --key ЗНАЧЕНИЕ)
  keys remove <сервер>          снять последний ключ сервера (или --var VAR)
  keys import [--file ФАЙЛ]     залить пачку ключей строками VAR=значение (со stdin или из файла)
  keys                        интерактивное меню

серверы с ключами: ${[...serverKeys().keys()].join(", ")}
Файл один для всех: скрывается 600, значения не печатаются. Один сервер может держать
сколько угодно ключей — первый пишется как VAR, следующие как VAR_2, VAR_3…
`);
}

function listCli(serverKeysMap) {
  const entries = readEnv();
  if (entries.length === 0) {
    process.stdout.write(`ключей нет (${SECRETS})\n`);
    return 0;
  }
  const byServer = new Map();
  for (const [server, vars] of serverKeysMap) {
    const rows = [];
    for (const base of vars) {
      for (const entry of variants(entries, base)) rows.push(`${entry.name} = ${mask(entry.value)}`);
    }
    if (rows.length) byServer.set(server, rows);
  }
  const known = new Set([...byServer.values()].flat().map((row) => row.split(" ")[0]));
  for (const [server, rows] of byServer) {
    process.stdout.write(`${server}\n${rows.map((r) => `  ${r}`).join("\n")}\n`);
  }
  const others = entries.filter((e) => !known.has(e.name));
  if (others.length) {
    process.stdout.write(`прочее\n${others.map((e) => `  ${e.name} = ${mask(e.value)}`).join("\n")}\n`);
  }
  return 0;
}

async function addKey(serverKeysMap, server, provided) {
  const base = (serverKeysMap.get(server) ?? [])[0];
  if (!base) {
    process.stderr.write(`неизвестный сервер: ${server} (с ключами: ${[...serverKeysMap.keys()].join(", ")})\n`);
    return 1;
  }
  const value = provided ?? (await ask(`ключ для ${server} (${base}), ввод скрыт: `, { hidden: true }));
  if (!value) {
    process.stderr.write("пустое значение — ничего не меняю\n");
    return 1;
  }
  const entries = readEnv();
  const existing = entries.find((e) => e.value === value);
  if (existing) {
    process.stdout.write(`такой ключ уже лежит как ${existing.name}\n`);
    return 0;
  }
  const name = nextName(entries, base);
  entries.push({ name, value });
  writeEnv(entries);
  process.stdout.write(`добавлен ${name} (всего у ${server}: ${variants(entries, base).length})\n`);
  return 0;
}

function removeKey(serverKeysMap, server, varName) {
  const base = (serverKeysMap.get(server) ?? [])[0];
  if (!base) {
    process.stderr.write(`неизвестный сервер: ${server}\n`);
    return 1;
  }
  const entries = readEnv();
  const rows = variants(entries, base);
  if (!rows.length) {
    process.stderr.write(`у ${server} нет ключей\n`);
    return 1;
  }
  const victim = varName ? rows.find((r) => r.name === varName) : rows[rows.length - 1];
  if (!victim) {
    process.stderr.write(`нет переменной ${varName} у ${server}\n`);
    return 1;
  }
  writeEnv(entries.filter((e) => e.name !== victim.name));
  process.stdout.write(`снят ${victim.name} (осталось у ${server}: ${variants(readEnv(), base).length})\n`);
  return 0;
}

/** Быстрый ввод пачкой: строки VAR=значение со stdin или из --file, значения не печатаются. */
async function importKeys(serverKeysMap, file) {
  let text = "";
  if (file) {
    text = readFileSync(file, "utf8");
  } else {
    if (process.stdin.isTTY) {
      process.stderr.write("вставь строки VAR=значение (пустая строка — конец):\n");
    }
    text = await new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
    });
  }

  const known = new Map();
  for (const [server, vars] of serverKeysMap) for (const base of vars) known.set(base, server);
  const entries = readEnv();
  const added = [];
  const skipped = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 1) {
      skipped.push(trimmed.split("=")[0]);
      continue;
    }
    const name = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, "");
    if (!value) {
      skipped.push(name);
      continue;
    }
    const base = name.replace(/_\d+$/, "");
    if (!known.has(base)) {
      skipped.push(name);
      continue;
    }
    if (entries.some((e) => e.value === value)) {
      skipped.push(`${name} (дубликат)`);
      continue;
    }
    // если имя занято другим значением — кладём под следующим свободным
    const target = entries.some((e) => e.name === name) ? nextName(entries, base) : name;
    entries.push({ name: target, value });
    added.push(`${target} (${known.get(base)})`);
  }
  if (added.length) writeEnv(entries);
  process.stdout.write(`добавлено: ${added.length ? added.join(", ") : "ничего"}\n`);
  if (skipped.length) process.stdout.write(`пропущено: ${skipped.join(", ")}\n`);
  return 0;
}

async function menu(serverKeysMap) {
  const servers = [...serverKeysMap.keys()];
  for (;;) {
    process.stdout.write(`\nсерверы с ключами: ${servers.join(", ")}\n1) показать  2) добавить  3) снять  4) залить пачкой  q) выход\n> `);
    const choice = await ask("");
    if (choice === "q" || choice === "") return 0;
    if (choice === "1") listCli(serverKeysMap);
    else if (choice === "4") await importKeys(serverKeysMap);
    else if (choice === "2" || choice === "3") {
      const server = await ask("сервер: ");
      if (!servers.includes(server)) {
        process.stderr.write("нет такого сервера\n");
        continue;
      }
      if (choice === "2") await addKey(serverKeysMap, server);
      else removeKey(serverKeysMap, server);
    }
  }
}

const argv = process.argv.slice(2);
const [command = "menu", ...rest] = argv;
const flag = (name) => {
  const at = rest.indexOf(name);
  return at === -1 ? undefined : rest[at + 1];
};
const positional = rest.filter((arg) => !arg.startsWith("--") && arg !== flag("--key") && arg !== flag("--var"));

try {
  const serverKeysMap = serverKeys();
  let code = 0;
  if (command === "list") code = listCli(serverKeysMap);
  else if (command === "add") code = await addKey(serverKeysMap, positional[0], flag("--key"));
  else if (command === "remove") code = removeKey(serverKeysMap, positional[0], flag("--var"));
  else if (command === "import") code = await importKeys(serverKeysMap, flag("--file"));
  else if (command === "menu" || command === "-h" || command === "--help") {
    if (command === "menu" && !process.stdin.isTTY) usage();
    else if (command === "menu") code = await menu(serverKeysMap);
    else usage();
  } else {
    usage();
    code = 2;
  }
  process.exit(code);
} catch (error) {
  process.stderr.write(`keys: ${error.message}\n`);
  process.exit(1);
}
