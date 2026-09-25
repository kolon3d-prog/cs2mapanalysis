#!/usr/bin/env node
// Проба MCP: поднимает сервер, делает initialize + tools/list, печатает число инструментов.
// Использование: node mcp-handshake.mjs <команда> [аргументы...] [--min <N>]
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const minIndex = argv.indexOf("--min");
const min = minIndex === -1 ? 1 : Number(argv[minIndex + 1]);
const target = minIndex === -1 ? argv : argv.slice(0, minIndex);
if (target.length === 0) {
  console.error("нужна команда сервера: node mcp-handshake.mjs <команда> [аргументы] [--min N]");
  process.exit(2);
}

const child = spawn(target[0], target.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
let buffer = "";
let done = false;

const finish = (code) => {
  if (done) return;
  done = true;
  child.kill("SIGTERM");
  process.exit(code);
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
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    }
    if (message.id === 2) {
      const names = (message.result?.tools ?? []).map((t) => t.name);
      console.log(`инструментов: ${names.length}`);
      if (names.length) console.log(`первые: ${names.slice(0, 6).join(", ")}`);
      finish(names.length >= min ? 0 : 3);
    }
  }
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-center", version: "1" } } });
setTimeout(() => {
  console.log("таймаут: сервер не ответил на handshake");
  finish(2);
}, 120000).unref();
