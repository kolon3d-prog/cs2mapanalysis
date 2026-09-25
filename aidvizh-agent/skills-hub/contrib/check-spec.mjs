#!/usr/bin/env node
// check-spec — статическая проверка SKILL.md по спеке agentskills.io плюс анти-паттерны
// из PluginEval (слой static: бюджеты тела, триггер, директивы, битые ссылки).
//
//   node check-spec.mjs <каталог скиллов | сам скилл> [--strict] [--json]
//
// FAIL — нарушения MUST спеки: нет SKILL.md, нет name/description, name не по спеке или
// не совпадает с именем каталога, description длиннее 1024.
// warn — рекомендации: триггер в description, бюджеты тела (500/800 строк, 8 KB для Codex),
// плотность директив (MUST/ALWAYS/ВСЕГДА…), битые относительные ссылки, allowed-tools не строкой.
// --strict делает предупреждения такими же дорогими, как ошибки (режим гейта для CI).
// --quiet печатает только FAIL и итог (для хуков и часовой проверки).
// Код возврата: 0 — чисто (или только warn без --strict), 1 — есть ошибки/skip.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TRIGGER_RE = /use (this |when|for|proactively)|использовать|используй|когда|trigger/i;
const DIRECTIVE_RE = /\b(MUST|NEVER|ALWAYS|REQUIRED|SHALL)\b|ВСЕГДА|НИКОГДА|ОБЯЗАТЕЛЬНО|ЗАПРЕЩЕНО/g;

function usage() {
  process.stdout.write(`check-spec — проверка SKILL.md по спеке agentskills.io

  check-spec <каталог скиллов | сам скилл> [--strict] [--quiet] [--json]

  без аргумента-пути — нечего проверять, укажи каталог: коллекцию, ~/.agents/skills или один скилл
  --strict   предупреждения тоже валят проверку (гейт)
  --quiet    печатать только FAIL и итог
  --json     машинный вывод: [{skill, issues: [{level, msg}]}]
`);
}

/** Минимальный разбор frontmatter: верхнеуровневые key: value плюс блочные > и |. */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return { error: "нет frontmatter (---)" };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { error: "frontmatter не закрыт (---)" };

  const fm = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value === ">" || value === ">-" || value === ">+" || value === "|" || value === "|-" || value === "|+") {
      const buf = [];
      for (let j = i + 1; j < end; j += 1) {
        const next = lines[j];
        if (!/^\s/.test(next)) break;
        buf.push(next.replace(/^\s+/, ""));
        i = j;
      }
      fm[key] = value.startsWith("|") ? buf.join("\n") : buf.join(" ").replace(/\s+/g, " ").trim();
    } else {
      fm[key] = value.replace(/^["']|["']$/g, "").trim();
    }
  }
  return { fm, body: lines.slice(end + 1) };
}

function checkSkill(dir) {
  const name = basename(dir);
  const issues = [];
  const push = (level, msg) => {
    if (!issues.some((issue) => issue.msg === msg)) issues.push({ level, msg });
  };
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return { skill: name, issues: [{ level: "FAIL", msg: "нет SKILL.md" }] };

  const text = readFileSync(file, "utf8");
  const parsed = parseFrontmatter(text);
  if (parsed.error) return { skill: name, issues: [{ level: "FAIL", msg: parsed.error }] };
  const { fm, body } = parsed;

  const skillName = fm.name ?? "";
  if (!skillName) push("FAIL", "нет поля name");
  else {
    if (!NAME_RE.test(skillName)) push("FAIL", `name «${skillName}» не по спеке (a-z, 0-9, дефисы)`);
    if (skillName !== name) push("FAIL", `name «${skillName}» ≠ директория «${name}»`);
  }

  const description = fm.description ?? "";
  if (!description) push("FAIL", "нет поля description");
  else {
    if (description.length > 1024) push("FAIL", `description ${description.length} симв. > 1024`);
    if (description.length < 20) push("warn", "description короче 20 символов");
    if (!TRIGGER_RE.test(description)) push("warn", "в description нет триггера («use when / использовать, когда»…)");
  }

  if (String(fm["allowed-tools"] ?? "").startsWith("[")) {
    push("warn", "allowed-tools списком; спека ждёт строку через пробел");
  }

  const bodyLines = body.length;
  const bodyBytes = Buffer.byteLength(body.join("\n"), "utf8");
  const hasRefs = existsSync(join(dir, "references")) || existsSync(join(dir, "assets"));
  if (bodyLines > 500) push("warn", `тело ${bodyLines} строк > 500 — детали вынести в references/`);
  if (bodyLines > 800 && !hasRefs) push("warn", `тело ${bodyLines} строк без references/ (раздутый скилл)`);
  if (bodyBytes > 8192 && !hasRefs) push("warn", `тело ${bodyBytes} байт > 8 KB без references/ (Codex обрежет)`);

  const directives = (body.join("\n").match(DIRECTIVE_RE) ?? []).length;
  if (directives > 15) push("warn", `директив ${directives} > 15 (OVER_CONSTRAINED)`);

  const seen = new Set();
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = (match[1].split("#")[0] ?? "").trim();
    if (!target || seen.has(target)) continue;
    if (/^(https?:|mailto:|data:|#|\/)/.test(target)) continue;
    seen.add(target);
    if (!existsSync(resolve(dir, target))) push("warn", `битая ссылка: ${target}`);
  }

  return { skill: name, issues };
}

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const json = argv.includes("--json");
const quiet = argv.includes("--quiet");
const target = argv.find((arg) => !arg.startsWith("-"));

if (!target) {
  usage();
  process.exit(1);
}
if (!existsSync(target)) {
  process.stderr.write(`check-spec: нет такого пути: ${target}\n`);
  process.exit(1);
}

const skills = [];
if (existsSync(join(target, "SKILL.md"))) {
  skills.push(target);
} else {
  for (const entry of readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(target, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir) {
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) skills.push(path);
  }
}

if (skills.length === 0) {
  process.stderr.write(`check-spec: в ${target} нет ни одного скилла (каталог с SKILL.md)\n`);
  process.exit(1);
}

const results = skills.map(checkSkill);
const errors = results.filter((row) => row.issues.some((issue) => issue.level === "FAIL"));
const warned = results.filter((row) => row.issues.some((issue) => issue.level === "warn"));
const warnings = results.reduce((sum, row) => sum + row.issues.filter((issue) => issue.level === "warn").length, 0);
const failed = errors.length + (strict ? warned.length : 0);

if (json) {
  process.stdout.write(
    `${JSON.stringify({ target, skills: results, errors: errors.length, warned: warned.length, warnings }, null, 2)}\n`,
  );
} else {
  process.stdout.write(`spec-check: ${target} — скиллов ${results.length}\n`);
  for (const row of results) {
    for (const issue of row.issues) {
      if (quiet && issue.level !== "FAIL") continue;
      const mark = issue.level === "FAIL" ? "FAIL" : "warn";
      process.stdout.write(`  ${mark.padEnd(5)} ${row.skill.padEnd(28)} ${issue.msg}\n`);
    }
  }
  process.stdout.write(
    `скиллов: ${results.length} · ошибок: ${errors.length} · предупреждений: ${warnings}` +
      (strict && warned.length ? ` · с предупреждениями: ${warned.length} (--strict)` : "") +
      "\n",
  );
}

process.exit(failed === 0 ? 0 : 1);
