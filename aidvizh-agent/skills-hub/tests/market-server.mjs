#!/usr/bin/env node
// Заглушка HTTP-индексов для pwsh-тестов хаба: отвечает теми же фикстурами, что и curl-заглушка
// (tests/stubs/curl), поэтому нативные HTTP-ветки skills-manager.ps1 проверяются без сети.
// Слушает свободный порт (listen 0) и печатает PORT=<n> первой строкой — тест читает её и
// подставляет SKILLS_API_URL/SKILLSMP_API_URL. Дальше сервер молчит до остановки.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtures = process.env.FIXTURES;
if (!fixtures) {
  console.error("market-server: FIXTURES не задан");
  process.exit(1);
}

const fixture = (name) => readFileSync(join(fixtures, name), "utf8");

const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const json = (text) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(text);
  };
  if (path === "/api/search") return json(fixture(process.env.FIXTURE_SEARCH || "skills-sh-search.json"));
  if (path === "/api/skills") return json(fixture(process.env.FIXTURE_SKILLSMP || "skillsmp-skills.json"));
  response.writeHead(404, { "content-type": "text/plain" });
  response.end(`market-server: неизвестный URL ${path}\n`);
});

server.listen(0, "127.0.0.1", () => {
  console.log(`PORT=${server.address().port}`);
});
