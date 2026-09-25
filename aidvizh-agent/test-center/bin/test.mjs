#!/usr/bin/env node
// test-center: сквозная проверка всей системы AGGG на linux/macOS/Windows.
// Гоняет то, что есть на этой машине (node-проверки станций, bats-наборы, живой запрос к модели)
// и при первом же сбое пишет багрепорт.md — что именно запускалось, чем закончилось и что смотреть.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform, arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGGG = resolve(ROOT, "..");
const HOME = process.env.TEST_CENTER_HOME || homedir();
const REPORT = process.env.TEST_CENTER_REPORT || join(ROOT, "багрепорт.md");
const REGISTRY = join(AGGG, "command-center", "registry.json");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const command = positional[0] ?? "run";
const flagValue = (name) => (args.find((a) => a.startsWith(`--${name}=`)) ?? "").split("=")[1];
const JSON_OUT = flags.has("--json");
/** План вместо прогона: `--dry-run` (в pwsh-обёртке — `-WhatIf`) ничего не запускает. */
const DRY_RUN = flags.has("--dry-run");

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

/**
 * Флаги, которые движок понимает. Список закрытый нарочно: раньше неизвестный флаг просто
 * попадал в `flags`, позиционных не было, команда считалась «run» — и опечатка вроде `--onlye=smoke`
 * запускала полный прогон с живыми запросами к модели вместо отказа. `--help` вёл себя так же:
 * справки не было вовсе, пришлось писать её здесь.
 */
const USAGE = `test-center — сквозная проверка набора AGGG на этой машине

  test-center run [--only=smoke,wiki,memory,bats,model,persona] [--no-model] [--dry-run] [--json]
  test-center status            что проверялось в последнем прогоне
  test-center report [--clear]  последняя запись багрепорт.md / убрать её
  test-center check             хватает ли предпосылок: реестр, пробы, node
  test-center --help            эта справка

  --only=...   только перечисленные наборы (по умолчанию все, что есть на этой ОС)
  --no-model   без живого запроса к модели и без набора persona
  --dry-run    план: набор за набором, шаг за шагом, без запуска
  --json       машинный вид плана и результата

Наборы: smoke, wiki, memory, bats, model, persona. При первом сбое пишется багрепорт.md
(путь, команда, код, вывод) — не «failed», а куда смотреть.`;

const KNOWN_FLAGS = new Set(["--json", "--dry-run", "--no-model"]);
const KNOWN_COMMANDS = new Set(["run", "status", "report", "clear", "check", "verify"]);

if (flags.has("--help") || flags.has("-h") || positional[0] === "-h" || positional[0] === "-help") {
  out(USAGE);
  process.exit(0);
}
const unknownFlag = [...flags].find((flag) => !KNOWN_FLAGS.has(flag) && !flag.startsWith("--only="));
if (unknownFlag) {
  err(`test-center: неизвестный флаг ${unknownFlag} (справка: test-center --help)`);
  process.exit(2);
}
if (positional[0] && !KNOWN_COMMANDS.has(positional[0])) {
  err(`test-center: не знаю команду «${positional[0]}» (справка: test-center --help)`);
  process.exit(2);
}

// ищем в PATH сами: bash -lc тянет логин-профиль и подмешивает чужие каталоги
const has = (name) => {
  // тестовый переключатель: притвориться, что инструмента нет (проверка логики пропуска)
  if ((process.env.TEST_CENTER_FORCE_MISSING ?? "").split(",").map((x) => x.trim()).includes(name)) return false;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  // разделитель — по виду строки: в Git Bash та же переменная приходит через «:» с путями /c/...
  const path = String(process.env.PATH ?? "");
  const sep = path.includes(";") || /^[A-Za-z]:[\\/]/.test(path) ? ";" : ":";
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext.toLowerCase())) || existsSync(join(dir, name + ext.toUpperCase()))) return true;
    }
  }
  return false;
};
const run = (argv, { timeoutMs = 120000, env = {} } = {}) => {
  const res = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, ...env } });
  return {
    code: res.status ?? (res.error ? 127 : 1),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? res.error?.message ?? "",
    argv,
    timedOut: res.error?.code === "ETIMEDOUT" || res.signal === "SIGTERM",
  };
};

const tools = {
  node: () => run(["node", "--version"]).stdout.trim(),
  python: () => (has("python3") ? run(["python3", "--version"]).stdout.trim() || run(["python3", "--version"]).stderr.trim() : "нет"),
  bats: () => (has("bats") ? run(["bats", "--version"]).stdout.trim() : "нет"),
  omp: () => (has("omp") ? run(["omp", "--version"]).stdout.trim().split("\n")[0] : "нет"),
  pwsh: () => (has("pwsh") ? run(["pwsh", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]).stdout.trim() : "нет"),
  bash: () => (has("bash") ? run(["bash", "--version"]).stdout.trim().split("\n")[0] : "нет"),
};

/**
 * Чем позвать станцию: на Windows у неё своя .ps1-обёртка (у каждого .sh есть сосед) — шелла в конфиге
 * Windows нет, а `bash` из PATH там часто заглушка WSL. Иначе — прежний .sh.
 */
function stationArgv(file, args) {
  const win = file.replace(/\.sh$/, ".ps1");
  const target = platform() === "win32" && existsSync(win) ? win : file;
  if (target.endsWith(".ps1")) {
    return has("pwsh")
      ? ["pwsh", "-NoProfile", "-File", target, ...args]
      : ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target, ...args];
  }
  return ["bash", target, ...args];
}

// --- наборы проверок: каждый шаг — команда и то, что ждём в выводе ---
function suites() {
  const center = ["node", join(AGGG, "command-center", "bin", "center.mjs")];
  const wiki = join(AGGG, "wiki-station", "bin", "wiki-station.sh");
  const memory = join(AGGG, "memory-station", "bin", "memory-station.sh");
  const mcp = join(AGGG, "mcp-station", "bin", "mcp-station.sh");
  const skills = join(AGGG, "skills-station", "bin", "skills-station.sh");
  const list = {};

  list.smoke = [
    { name: "центр: состояние", argv: [...center, "status"], expect: "проблемных: 0" },
    { name: "центр: связи", argv: [...center, "doctor"], expect: "связи в порядке" },
    { name: "станция MCP", argv: stationArgv(mcp, ["check"]), expect: null },
    { name: "станция памяти", argv: stationArgv(memory, ["check"]), expect: "проверка пройдена" },
    { name: "станция вики", argv: stationArgv(wiki, ["check"]), expect: "проверка пройдена" },
    { name: "коллекция скиллов", argv: stationArgv(skills, ["verify"]), expect: "коллекция в порядке" },
  ];

  list.wiki = [
    { name: "вики: поиск по базе", argv: stationArgv(wiki, ["search", "память агента", "--limit=1"]), expect: "найдено" },
    { name: "вики: MCP отвечает", argv: ["node", join(ROOT, "probes", "mcp-handshake.mjs"), join(HOME, ".agents", "wiki-station", "mcp", "server.mjs"), "--min", "7"], expect: "инструментов:" },
    { name: "вики: index идемпотентен (MCP)", argv: ["node", join(ROOT, "probes", "wiki-index-idempotent.mjs"), join(HOME, ".agents", "wiki-station", "mcp", "server.mjs")], expect: "идемпотентен" },
  ];

  list.memory = [
    { name: "память: заметки на месте", argv: stationArgv(memory, ["status"]), expect: "заметок:" },
    { name: "память: MCP отвечает", argv: ["node", join(ROOT, "probes", "mcp-handshake.mjs"), "basic-memory", "mcp", "--min", "8"], expect: "инструментов:" },
  ];

  list.bats = [{ name: "все наборы bats", argv: ["node", join(AGGG, "command-center", "bin", "center.mjs"), "check"], expect: "проверка пройдена", timeoutMs: 900000 }];

  list.model = [
    { name: "модель отвечает (omp -p)", argv: ["omp", "-p", "ответь ровно одним словом: ok"], expect: null, timeoutMs: 240000, minLength: 1 },
  ];

  // Живые инварианты персоны: зан, тестовая политика, личный оверлей, уточняющие вопросы.
  // Логика — в probes/persona-probe.mjs: он печатает «persona: ok» только когда все кейсы прошли.
  list.persona = [
    { name: "персона: инварианты (зан, тесты, оверлей, вопросы)", argv: ["node", join(ROOT, "probes", "persona-probe.mjs")], expect: "persona: ok", timeoutMs: 1200000 },
  ];
  return list;
}

function available(name) {
  if (name === "bats") return has("bats");
  if (name === "model" || name === "persona") return has("omp");
  if (name === "memory" || name === "wiki") return has("node");
  return true;
}

function environment() {
  return {
    когда: new Date().toISOString().replace("T", " ").slice(0, 19),
    система: `${platform()} ${release()} ${arch()}`,
    инструменты: Object.fromEntries(Object.entries(tools).map(([name, get]) => [name, get()])),
    версияНабора: existsSync(join(AGGG, "VERSION")) ? readFileSync(join(AGGG, "VERSION"), "utf8").trim() : "?",
  };
}

function writeReport({ step, result, suite }) {
  const env = environment();
  const tail = (text) =>
    text
      .split("\n")
      .filter((line) => line.trim())
      .slice(-40)
      .join("\n");
  const body = [
    `# Багрепорт`,
    ``,
    `- **Когда**: ${env.когда}`,
    `- **Система**: ${env.система}`,
    `- **Версия набора**: ${env.версияНабора}`,
    `- **Инструменты**: ${Object.entries(env.инструменты).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    `- **Набор**: ${suite} · шаг: ${step.name}`,
    `- **Команда**: \`${result.argv.join(" ")}\``,
    `- **Код возврата**: ${result.code}${result.timedOut ? " (таймаут)" : ""}`,
    `- **Ожидалось**: ${step.expect ? `код 0 и «${step.expect}» в выводе` : "код 0 и непустой вывод"}`,
    ``,
    `## Вывод`,
    ``,
    "```",
    tail(result.stdout) || "(пусто)",
    "```",
    ...(result.stderr.trim() ? ["", `## Ошибки (stderr)`, "", "```", tail(result.stderr), "```"] : []),
    ``,
    `## Что проверить`,
    ``,
    checkHint(step, suite),
    ``,
    `---`,
    ``,
  ].join("\n");
  appendFileSync(REPORT, body);
  return REPORT;
}

function checkHint(step, suite) {
  const hints = {
    "центр: состояние": "- посмотри `node command-center/bin/center.mjs status` — какой проект помечен проблемным\n- `center doctor` покажет, какой связи не хватает",
    "центр: связи": "- `center doctor` печатает каждую связь; чинится повторной активацией: `center activate <проект>`",
    "станция MCP": "- `mcp-station check` перечисляет, чего не хватает (файлы серверов, ключи, PATH)\n- конфиги клиентов: `~/.omp/agent/mcp.json`, `~/.pi/agent/mcp.json`, `~/.config/opencode/opencode.json`",
    "станция памяти": "- `memory-station status` — есть ли basic-memory и проект\n- если пусто: `memory-station install`",
    "станция вики": "- `wiki-station list` — есть ли вики и собрана ли база\n- `wiki-station install` пересобирает базу и заводит MCP-проект",
    "коллекция скиллов": "- `skills-station verify` называет скиллы без SKILL.md\n- `skills-station status` покажет расхождение слоёв",
    "вики: поиск по базе": "- база могла не собраться: `wiki-station build`\n- если базы нет, поиск идёт grep-режимом — проверь путь вики в `wiki-station/wikis.json`",
    "вики: MCP отвечает": "- сервер запускается как `node ~/.agents/wiki-station/mcp/server.mjs`\n- если ссылка битая: `wiki-station install`",
    "вики: index идемпотентен (MCP)": "- проба поднимает сервер вики на временной вике и зовёт `wiki_index` дважды\n- повторный вызов обязан сказать «уже актуален» и не трогать index.md и log.md; вручную: `wiki-station index` второй раз",
    "память: заметки на месте": "- `memory-station status` покажет путь заметок\n- проект памяти мог не завестись: `memory-station install`",
    "память: MCP отвечает": "- `basic-memory` должен быть в PATH (`uv tool install basic-memory --prerelease=allow`)\n- проверь `mcp-station check basic-memory`",
    "все наборы bats": "- вывод выше показывает конкретный набор и номер упавшего теста\n- прогони его отдельно: `bats <проект>/tests/*.bats`",
    "модель отвечает (omp -p)": "- проверь логин провайдера: `omp -p \"ping\"` вручную\n- если провайдер недоступен — это внешняя проблема, не набор",
    "персона: инварианты (зан, тесты, оверлей, вопросы)": "- это живой запрос к модели; проверь вручную: `omp -p \"ты кто\"`\n- что прошито сейчас: `prompt-station status`; личный слой: `~/.agents/persona-overlay.md`",
  };
  if (suite === "model") return hints["модель отвечает (omp -p)"];
  if (suite === "persona") return hints["персона: инварианты (зан, тесты, оверлей, вопросы)"];
  return hints[step.name] ?? "- прогони шаг вручную (команда выше) и посмотри полный вывод";
}

/**
 * План прогона: что было бы запущено — ни одной команды и ни одного обращения к модели.
 * Набор, у которого шаги не объявлены заранее (собираются на ходу), честно помечается
 * «без плана: <набор>», а не выдумывается.
 */
function planRun() {
  const only = flagValue("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const wanted = only ?? ["smoke", "wiki", "memory", "bats", "model", "persona"];
  const all = suites();
  const plan = [];
  let steps = 0;

  for (const suite of wanted) {
    const declared = all[suite];
    if (!declared) {
      if (!JSON_OUT) out(`набор ${suite}: неизвестен — в план не попал`);
      continue;
    }
    if (!declared.every((step) => step.name && Array.isArray(step.argv) && step.argv.length > 0)) {
      if (!JSON_OUT) out(`без плана: ${suite}`);
      plan.push({ suite, planned: false, steps: [] });
      continue;
    }
    const noModel = (suite === "model" || suite === "persona") && flags.has("--no-model");
    const skipped = noModel ? "--no-model" : available(suite) ? null : "нет нужных инструментов на этой ОС";
    plan.push({ suite, planned: true, skipped, steps: declared.map((step) => ({ name: step.name, argv: step.argv })) });
    steps += declared.length;
    if (JSON_OUT) continue;
    out(`набор ${suite}: шагов ${declared.length}${skipped ? ` — был бы пропущен (${skipped})` : ""}`);
    for (const step of declared) {
      const limit = step.timeoutMs ? ` (до ${(step.timeoutMs / 60000).toFixed(0)} мин)` : "";
      const argv = step.argv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
      out(`   ${step.name} — ${argv}${limit}`);
    }
  }

  if (JSON_OUT) {
    // ни environment(), ни версии инструментов здесь не собираются: они спрашивают инструменты
    // версией, а план обязан обходиться без единого запуска
    out(JSON.stringify({ plan: true, suites: plan, steps }, null, 2));
  } else {
    out("");
    out(`план: наборов ${plan.filter((row) => row.planned).length}, шагов ${steps} — ничего не запущено`);
    out("запустить: test-center run" + (only ? ` --only=${only.join(",")}` : ""));
  }
  return 0;
}

function stepRun() {
  if (DRY_RUN) return planRun();
  const only = flagValue("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const wanted = only ?? ["smoke", "wiki", "memory", "bats", "model", "persona"];
  const all = suites();
  const results = [];
  let failed = null;

  const say = (line) => {
    if (!JSON_OUT) out(line);
  };
  for (const suite of wanted) {
    if (!all[suite]) {
      say(`набор ${suite}: неизвестен`);
      continue;
    }
    if (!available(suite)) {
      say(`набор ${suite}: пропущен (нет нужных инструментов на этой ОС)`);
      results.push({ suite, status: "skipped" });
      continue;
    }
    if ((suite === "model" || suite === "persona") && flags.has("--no-model")) {
      say(`набор ${suite}: пропущен (--no-model)`);
      results.push({ suite, status: "skipped" });
      continue;
    }
    say(`== набор ${suite}`);
    for (const step of all[suite]) {
      const started = Date.now();
      const result = run(step.argv, { timeoutMs: step.timeoutMs ?? 120000 });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const ok =
        result.code === 0 &&
        (step.expect ? result.stdout.includes(step.expect) || result.stderr.includes(step.expect) : true) &&
        (step.minLength ? result.stdout.trim().length >= step.minLength : true);
      say(`   ${ok ? "ok  " : "СБОЙ"} ${step.name} (${seconds}с)`);
      results.push({ suite, step: step.name, status: ok ? "ok" : "fail", seconds: Number(seconds), code: result.code });
      if (!ok && !failed) {
        const path = writeReport({ step, result, suite });
        failed = { suite, step: step.name, path };
        say("");
        say(`багрепорт: ${path}`);
        say(`  ${step.name}: код ${result.code}${result.timedOut ? " (таймаут)" : ""}`);
        const firstLines = (result.stderr || result.stdout).split("\n").filter((l) => l.trim()).slice(-5);
        for (const line of firstLines) say(`  ${line.slice(0, 160)}`);
      }
    }
  }

  const failedCount = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  if (JSON_OUT) {
    out(JSON.stringify({ environment: environment(), results, failed }, null, 2));
  } else {
    out("");
    out(`итог: шагов ${results.filter((r) => r.status !== "skipped").length}, сбоев ${failedCount}${skipped ? `, пропущено наборов ${skipped}` : ""}`);
    if (failed) out(`багрепорт: ${failed.path}`);
  }
  return failedCount === 0 ? 0 : 1;
}

function stepStatus() {
  const env = environment();
  out(`система: ${env.система}`);
  out(`версия набора: ${env.версияНабора}`);
  out(`инструменты: ${Object.entries(env.инструменты).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  out("");
  const all = suites();
  for (const [suite, steps] of Object.entries(all)) {
    out(`набор ${suite}: ${available(suite) ? "будет запущен" : "пропущен (нет инструментов)"} — шагов ${steps.length}`);
  }
  out("");
  out(`багрепорт: ${existsSync(REPORT) ? REPORT : "пока нет"}`);
}

function stepReport() {
  if (!existsSync(REPORT)) {
    out("багрепортов нет — все прогоны были чистыми");
    return;
  }
  const text = readFileSync(REPORT, "utf8");
  const incidents = text.split("\n---\n").filter((part) => part.trim()).length;
  out(`багрепорт: ${REPORT}`);
  out(`записей: ${incidents}`);
  out("");
  out(text.split("\n---\n").filter((p) => p.trim()).slice(-1)[0].trim());
}

function stepClear() {
  if (existsSync(REPORT)) {
    rmSync(REPORT);
    out("багрепорт удалён");
  } else {
    out("багрепортов нет");
  }
}

function stepCheck() {
  const problems = [];
  if (!existsSync(REGISTRY)) problems.push(`нет реестра центра (${REGISTRY})`);
  if (!existsSync(join(ROOT, "probes", "mcp-handshake.mjs"))) problems.push("нет probes/mcp-handshake.mjs");
  if (!has("node")) problems.push("нет node");
  for (const suite of ["smoke", "bats", "model", "persona"]) {
    if (!available(suite)) out(`набор ${suite}: будет пропущен на этой ОС`);
  }
  if (problems.length) {
    for (const p of problems) err(`проблема: ${p}`);
    process.exit(1);
  }
  out("проверка пройдена");
}

switch (command) {
  case "run":
    process.exit(stepRun());
    break;
  case "status":
    stepStatus();
    break;
  case "report":
    stepReport();
    break;
  case "clear":
    stepClear();
    break;
  case "check":
  case "verify":
    stepCheck();
    break;
  default:
    err(`test-center: не знаю команду «${command}»`);
    err("команды: run [--only=smoke,wiki,memory,bats,model,persona] [--no-model] [--dry-run] [--json] | status | report | clear | check");
    process.exit(2);
}
