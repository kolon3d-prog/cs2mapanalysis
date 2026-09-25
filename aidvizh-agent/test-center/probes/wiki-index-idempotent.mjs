#!/usr/bin/env node
// Проба MCP вики: wiki_index дважды подряд. Первый вызов пересобирает каталог и пишет строку
// в log.md; второй видит, что каталог не изменился, и не трогает ни файл, ни журнал.
// Проверяется именно MCP-путь: у CLI и сервера код разный, а поведение обязано совпадать.
// Использование: node wiki-index-idempotent.mjs [путь-к-server.mjs]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = process.argv[2] ?? join(process.env.HOME ?? "", ".agents", "wiki-station", "mcp", "server.mjs");
if (!existsSync(server)) {
  console.error(`нет сервера вики: ${server} (поставь: wiki-station install)`);
  process.exit(2);
}

// Подменяем корень набора, реестр вики и каталог вики — реальные данные не трогаются.
const root = mkdtempSync(join(tmpdir(), "wiki-index-probe-"));
const dir = join(root, "wiki", "Wiki Probe");
mkdirSync(join(dir, "ai"), { recursive: true });
writeFileSync(
  join(root, "wikis.json"),
  `${JSON.stringify({ wikis: [{ name: "Wiki Probe", path: "wiki/Wiki Probe", project: "wiki-probe", created: "2026-09-23" }] }, null, 2)}\n`,
);
writeFileSync(join(dir, "index.md"), "# Index — каталог Wiki\n\n| Пост | Тема | Теги | Дата | Папка |\n|------|------|------|------|-------|\n");
writeFileSync(join(dir, "log.md"), "# Log — журнал изменений Wiki\n");
writeFileSync(
  join(dir, "ai", "probe.md"),
  "---\ntype: Post\ntitle: Проба\ndescription: Пост для пробы идемпотентности индекса\ndate: 2026-09-23\ntags: [ai, probe]\n---\n# Проба\n\nТекст.\n",
);

const child = spawn(process.execPath, [server], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, WIKI_STATION_ROOT: root, WIKI_STATION_REGISTRY: join(root, "wikis.json") },
});
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
let buffer = "";
let done = false;
let first = null;

const finish = (code, message) => {
  if (done) return;
  done = true;
  if (message) console.log(message);
  child.kill("SIGTERM");
  process.exit(code);
};

const textOf = (message) => (message.result?.content ?? []).map((part) => part.text ?? "").join("\n");

const checkSecond = (message) => {
  const text = textOf(message);
  const logLines = readFileSync(join(dir, "log.md"), "utf8").split("\n").filter((line) => line.includes("index.md")).length;
  if (!text.includes("уже актуален")) finish(1, `провал: второй вызов не сказал «уже актуален» — ${text.split("\n")[0]}`);
  else if (logLines !== 1) finish(1, `провал: в log.md строк про index.md ${logLines}, а после первого вызова была 1`);
  else finish(0, `wiki_index идемпотентен: первый вызов пересобрал, второй не тронул файл и log.md (${text.split("\n")[0]})`);
};

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line.startsWith("{")) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wiki_index", arguments: {} } });
    }
    if (message.id === 2) {
      first = textOf(message);
      if (!first.includes("пересобран")) finish(1, `провал: первый вызов не пересобрал каталог — ${first.split("\n")[0]}`);
      else send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wiki_index", arguments: {} } });
    }
    if (message.id === 3) checkSecond(message);
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-center", version: "1" } },
});
setTimeout(() => finish(2, "таймаут: сервер вики не ответил"), 30000).unref();
