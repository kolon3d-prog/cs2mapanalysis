#!/usr/bin/env node
// Пул ключей для http-MCP: перебирает ключи сервера, пока какой-нибудь не сработает.
//
// Клиент запускает это как обычный stdio-MCP-сервер (mcp__… через шим mcp-keypool).
// Мы принимаем JSON-RPC строками, отправляем их на http-эндпоинт с текущим ключом и,
// если ключ отвалился (401/403/429/5xx/сеть), берём следующий из файла секретов и пробуем снова —
// один полный круг по всем ключам, после чего ошибка уходит клиенту как есть.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_DIR = process.env.MCP_STATION_CATALOG || join(ROOT, "catalog");
const AGENT_HOME = process.env.MCP_STATION_HOME || homedir();
const SECRETS = process.env.MCP_STATION_SECRETS || join(AGENT_HOME, ".config/opencode/secrets/env");
const HTTP_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MCP_STATION_HTTP_TIMEOUT_MS ?? 20_000);
  if (!Number.isInteger(raw) || raw < 1) fail("MCP_STATION_HTTP_TIMEOUT_MS принимает целое число от 1");
  return raw;
})();
const RETRYABLE_STATUS = new Set([401, 403, 429]);

function fail(message) {
  process.stderr.write(`keypool: ${message}\n`);
  process.exit(1);
}

/** failover — держимся рабочего ключа и меняем только при отказе; round-robin — по кругу на каждый запрос. */
const STRATEGY = (() => {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--strategy");
  return at === -1 ? (process.env.MCP_STATION_POOL_STRATEGY || "failover") : argv[at + 1];
})();
if (!["failover", "round-robin"].includes(STRATEGY)) fail(`--strategy принимает failover или round-robin, получено ${STRATEGY}`);

const serverName = (() => {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--server");
  return at === -1 ? argv.find((a) => !a.startsWith("-")) : argv[at + 1];
})();
if (!serverName) fail("нужно имя сервера: keypool.mjs --server exa");

const files = readdirSync(CATALOG_DIR).filter((f) => f.endsWith(".json"));
const entry = files
  .map((file) => JSON.parse(readFileSync(join(CATALOG_DIR, file), "utf8")))
  .find((item) => item.name === serverName);
if (!entry) fail(`в каталоге нет сервера ${serverName}`);
if (entry.kind !== "http") fail(`${serverName} не http-сервер: пул ключей ему не нужен`);

const headerSpecs = Object.entries(entry.headers ?? {});
if (headerSpecs.length === 0) fail(`у ${serverName} нет заголовков с ключом`);
const [poolHeader, poolSpec] = headerSpecs[0];

function readValues() {
  const values = new Map();
  if (!existsSync(SECRETS)) return values;
  for (const line of readFileSync(SECRETS, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 1) continue;
    values.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return values;
}

/** Ключи сервера по порядку: VAR, VAR_2, VAR_3… (перечитываем файл перед каждым запросом). */
function poolKeys() {
  const values = readValues();
  const base = poolSpec.env;
  const keys = [];
  if (values.has(base)) keys.push(values.get(base));
  for (let i = 2; ; i += 1) {
    const name = `${base}_${i}`;
    if (!values.has(name)) break;
    keys.push(values.get(name));
  }
  return keys;
}

function buildHeaders(key) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const [name, spec] of headerSpecs) {
    if (name === poolHeader) {
      headers[name] = (spec.format ?? "%s").replace("%s", key);
      continue;
    }
    const value = readValues().get(spec.env);
    if (value === undefined) fail(`в ${SECRETS} нет переменной ${spec.env} для заголовка ${name}`);
    headers[name] = (spec.format ?? "%s").replace("%s", value);
  }
  return headers;
}

function extractJson(body) {
  const text = body.trim();
  if (!text) return null;
  if (text.startsWith("{")) return text;
  // SSE: берём последний блок data:
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return dataLines.length ? dataLines[dataLines.length - 1] : null;
}

let currentIndex = 0;
let sessionId = null;

async function forward(payload) {
  const keys = poolKeys();
  if (keys.length === 0) fail(`в ${SECRETS} нет ни одного ключа ${poolSpec.env}`);

  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const index = (currentIndex + attempt) % keys.length;
    const headers = buildHeaders(keys[index]);
    if (sessionId) headers["mcp-session-id"] = sessionId;
    try {
      const response = await fetch(entry.url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const body = await response.text();
      if (response.ok) {
        const newSession = response.headers.get("mcp-session-id");
        if (newSession) sessionId = newSession;
        if (STRATEGY === "round-robin") {
          currentIndex = (index + 1) % keys.length;
        } else if (index !== currentIndex) {
          process.stderr.write(`keypool: ключ #${index + 1} работает, переключился на него\n`);
          currentIndex = index;
        }
        return { ok: true, body: extractJson(body) };
      }
      const retryable = RETRYABLE_STATUS.has(response.status) || response.status >= 500;
      if (!retryable) {
        return { ok: false, body: extractJson(body), status: response.status };
      }
      process.stderr.write(`keypool: ключ #${index + 1} отбит (HTTP ${response.status}), пробую следующий\n`);
    } catch (error) {
      process.stderr.write(`keypool: ключ #${index + 1} не доехал (${error.message}), пробую следующий\n`);
    }
  }
  return { ok: false, body: null, status: null };
}

let buffer = "";
let queue = Promise.resolve();

function processLine(trimmed) {
  return forward(trimmed).then((result) => {
    if (!result.ok) {
      let id = null;
      try {
        id = JSON.parse(trimmed).id ?? null;
      } catch {
        id = null;
      }
      if (id !== null) {
        const message = result.status ? `keypool: HTTP ${result.status}` : `keypool: ни один ключ ${poolSpec.env} не сработал`;
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
      }
      return;
    }
    if (result.body) process.stdout.write(`${result.body}\n`);
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    queue = queue.then(() => processLine(trimmed));
  }
});
