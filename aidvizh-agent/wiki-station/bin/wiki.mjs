#!/usr/bin/env node
// wiki-station: центр вики по схеме Karpathy LLM Wiki + OKF-frontmatter (как в Wiki VibeCoding).
// Корень станции вычисляется от самого файла: абсолютных путей здесь нет.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync, rmSync, lstatSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGGG = process.env.WIKI_STATION_ROOT ? resolve(process.env.WIKI_STATION_ROOT) : resolve(ROOT, "..");
const HOME = process.env.WIKI_STATION_HOME || homedir();
const WIKIS_FILE = process.env.WIKI_STATION_REGISTRY || join(ROOT, "wikis.json");
const SKILL_SRC = join(ROOT, "skills", "wiki");
const SKILL_LINK = join(HOME, ".agents", "skills", "wiki");
const OPENCODE_LINK = join(HOME, ".config", "opencode", "skills", "wiki");

const SKIP_FILES = new Set(["README.md", "index.md", "log.md"]);
const SKIP_DIRS = new Set(["_templates", "db", "db-tools", ".git", "node_modules"]);
const REQUIRED_FIELDS = ["type", "title", "description", "date", "tags"];

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const command = positional[0] ?? "list";
const flagValue = (name) => (args.find((a) => a.startsWith(`--${name}=`)) ?? "").split("=")[1];
const DRY = flags.has("--dry-run");

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

/**
 * Есть ли команда в PATH. Ищем сами, без `command -v` через bash: на Windows bash в PATH — часто
 * заглушка WSL, которая отвечает инструкцией и выходит с нулём, то есть «есть» становится ложью.
 * Разделитель PATH берём по виду строки: в Git Bash та же переменная приходит через «:».
 */
function whichTool(name) {
  const path = String(process.env.PATH ?? "");
  const sep = path.includes(";") || /^[A-Za-z]:[\\/]/.test(path) ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ...String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (statSync(join(dir, name + ext)).isFile()) return true;
      } catch {
        /* нет файла — следующий кандидат */
      }
    }
  }
  return false;
}

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");

function readWikis() {
  if (!existsSync(WIKIS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(WIKIS_FILE, "utf8")).wikis ?? [];
  } catch {
    return [];
  }
}

function writeWikis(wikis) {
  writeFileSync(WIKIS_FILE, `${JSON.stringify({ wikis }, null, 2)}\n`);
}

function findWiki(name) {
  const wikis = readWikis();
  if (!name) return wikis[0] ?? null;
  return wikis.find((w) => w.name === name) ?? wikis.find((w) => w.name.toLowerCase() === name.toLowerCase()) ?? null;
}

const wikiDir = (wiki) => resolve(AGGG, wiki.path);

function articleFiles(dir) {
  const found = [];
  const walk = (current, depth) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path, depth + 1);
      } else if (entry.name.endsWith(".md") && depth >= 1 && !SKIP_FILES.has(entry.name)) {
        found.push(path);
      }
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return found.sort();
}

/** Скаляр в кавычках: одинарные — `''` как экранированная кавычка, двойные — `\X`. */
function unquoteYaml(value) {
  const text = String(value ?? "").trim();
  if (text.length >= 2 && text[0] === text[text.length - 1] && (text[0] === "'" || text[0] === '"')) {
    const inner = text.slice(1, -1);
    return text[0] === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(.)/g, "$1");
  }
  return text;
}

/** Индекс закрывающей кавычки в скаляре, начинающемся с кавычки (-1 — не закрыта). */
function closingQuote(value, quote) {
  let i = 1;
  while (i < value.length) {
    const ch = value[i];
    if (quote === '"' && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && value[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Разбор YAML-frontmatter поста: скаляры, списки (`[a, b]` и `- пункт`), блоки `>`/`|`/`>-`,
 * многострочные скаляры — plain и в кавычках. По YAML перевод строки в скаляре сворачивается
 * в пробел, поэтому `description: первая строка` + отступленные продолжения читаются целиком
 * (basic-memory переписывает фронтматтер именно так). Вложенные словари (`generated:`)
 * верхние поля не портят. Разбор совпадает с `db-tools/wikitext.py`, чтобы индекс, база и MCP
 * видели один и тот же текст поста.
 */
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const lines = text.slice(3, end).split("\n");
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    if (line[0] === " " || line[0] === "\t") {
      i += 1;
      continue; // вложенность без ключа — не наш случай
    }
    const sep = line.indexOf(":");
    if (sep === -1) {
      i += 1;
      continue;
    }
    const key = line.slice(0, sep).trim();
    const rest = line.slice(sep + 1).trim();
    i += 1;

    const block = /^([|>])([+-]?)(\d*)$/.exec(rest);
    if (block) {
      const collected = [];
      let indent = null;
      while (i < lines.length && (!lines[i].trim() || lines[i][0] === " " || lines[i][0] === "\t")) {
        const raw = lines[i];
        if (!raw.trim()) collected.push("");
        else {
          if (indent === null) indent = raw.length - raw.trimStart().length;
          collected.push(raw.slice(indent).replace(/\s+$/, ""));
        }
        i += 1;
      }
      data[key] = (block[1] === ">" ? collected.filter(Boolean).join(" ") : collected.join("\n")).trim();
      continue;
    }

    if (rest === "") {
      const items = [];
      let nested = false;
      while (i < lines.length) {
        const raw = lines[i];
        if (!raw.trim()) {
          i += 1;
          continue;
        }
        if (raw[0] !== " " && raw[0] !== "\t" && !raw.trimStart().startsWith("- ")) break;
        if (raw.trimStart().startsWith("- ")) {
          items.push(unquoteYaml(raw.trimStart().slice(2).trim()));
          i += 1;
          continue;
        }
        nested = true;
        i += 1;
      }
      data[key] = items.length ? items : nested ? {} : []; // список, вложенный блок или пусто
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = rest.slice(1, -1).split(",").map((v) => unquoteYaml(v.trim())).filter(Boolean);
      continue;
    }

    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0];
      const parts = [rest.replace(/\s+$/, "")];
      let close = closingQuote(parts[0], quote);
      while (close === -1 && i < lines.length) {
        parts.push(lines[i].trim());
        i += 1;
        close = closingQuote(parts.join(" "), quote);
      }
      const joined = parts.join(" ");
      close = closingQuote(joined, quote);
      const inner = close === -1 ? joined.slice(1) : joined.slice(1, close);
      data[key] = (quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(.)/g, "$1")).trim();
      continue;
    }

    // plain-скаляр: « #» — комментарий, отступленные продолжения сворачиваются пробелом
    const parts = [rest.split(/\s+#/)[0].trim()];
    while (
      i < lines.length &&
      (lines[i][0] === " " || lines[i][0] === "\t") &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith("- ") &&
      !lines[i].trimStart().startsWith("#")
    ) {
      parts.push(lines[i].trim());
      i += 1;
    }
    data[key] = parts.filter(Boolean).join(" ");
  }
  return data;
}

function articleMeta(dir, path) {
  const meta = parseFrontmatter(readFileSync(path, "utf8"));
  const rel = relative(dir, path).replace(/\\/g, "/");
  return {
    path,
    rel,
    topic: rel.split("/")[0],
    slug: basename(path, ".md"),
    title: String(meta.title ?? basename(path, ".md")),
    description: String(meta.description ?? ""),
    date: String(meta.date ?? ""),
    tags: Array.isArray(meta.tags) ? meta.tags : String(meta.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    type: String(meta.type ?? ""),
    status: String(meta.status ?? ""),
    meta,
  };
}

/** Строки index.md: заголовок, цель ссылки и колонки таблицы (описание, теги, дата, папка). */
function indexEntries(dir) {
  const path = join(dir, "index.md");
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\|\s*\[(.+?)\]\((.+?)\)\s*\|(.*)\|\s*$/);
    if (!m) continue;
    // описание — единственная свободная колонка и может содержать экранированный «\|»,
    // поэтому три хвостовые колонки (теги, дата, папка) отрезаем справа, а внутри описания
    // пробелы вокруг «|» не трогаем (иначе «win | iex» станет «win|iex»)
    const cells = m[3].split("|");
    const topic = (cells.pop() ?? "").trim();
    const date = (cells.pop() ?? "").trim();
    const tags = (cells.pop() ?? "").trim();
    rows.push({
      title: m[1].trim(),
      target: m[2].trim(),
      description: cells.join("|").replace(/\\\|/g, "|").trim(),
      tags,
      date,
      topic,
    });
  }
  return rows;
}

function logAdd(dir, action, what, note) {
  const path = join(dir, "log.md");
  const line = `- ${now()} — ${action} — ${what}${note ? ` — ${note}` : ""}\n`;
  if (!existsSync(path)) writeFileSync(path, "# Log — журнал изменений Wiki\n\nФормат: `YYYY-MM-DD HH:MM — действие — файл(ы) — что сделано`\n");
  writeFileSync(path, `${readFileSync(path, "utf8").replace(/\n*$/, "\n")}${line}`);
}

function bm(bmArgs, { quiet = false } = {}) {
  const res = spawnSync("basic-memory", bmArgs, { encoding: "utf8" });
  if (!res.error && res.status === 0) return { ok: true, stdout: res.stdout ?? "" };
  if (!quiet) err((res.stderr || res.error?.message || "").trim());
  return { ok: false, stdout: res.stdout ?? "" };
}

function bmProjects() {
  const res = bm(["tool", "list-projects"], { quiet: true });
  if (!res.ok) return [];
  try {
    return JSON.parse(res.stdout).projects ?? [];
  } catch {
    return [];
  }
}

function slug(name) {
  const map = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  const latin = name
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  // «Wiki VibeCoding» → wiki-vibecoding, а не wiki-wiki-vibecoding
  return latin.startsWith("wiki-") || latin === "wiki" ? latin : `wiki-${latin}`;
}

function linkSkill() {
  const results = [];
  // ~/.agents/wiki-station — стабильный домашний путь к станции: на него смотрит MCP-каталог
  for (const [target, source] of [[SKILL_LINK, SKILL_SRC], [OPENCODE_LINK, SKILL_LINK], [join(HOME, ".agents", "wiki-station"), ROOT]]) {
    if (target === OPENCODE_LINK && !existsSync(join(HOME, ".config", "opencode"))) {
      results.push(`${target}: пропуск (нет каталога opencode)`);
      continue;
    }
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isSymbolicLink()) {
        results.push(`${target}: пропуск (не ссылка)`);
        continue;
      }
      const current = spawnSync("readlink", [target], { encoding: "utf8" }).stdout.trim();
      if (resolve(dirname(target), current) === resolve(source)) {
        results.push(`${target}: уже стоит`);
        continue;
      }
      rmSync(target);
    }
    mkdirSync(dirname(target), { recursive: true });
    try {
      // На Windows каталог обычно живёт junction-ом (Developer Mode не нужен). Если и его
      // запретили, копия сохраняет работоспособность станции и честно помечается в выводе.
      symlinkSync(relative(dirname(target), resolve(source)), target, process.platform === "win32" ? "junction" : undefined);
      results.push(`${target}: поставлено`);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
      cpSync(resolve(source), target, { recursive: true, force: true });
      results.push(`${target}: копия (junction/symlink недоступен; после обновления источника удалите этот каталог и повторите install)`);
    }
  }
  return results;
}

function ensureBmProject(wiki) {
  const dir = wikiDir(wiki);
  const existing = bmProjects().find((p) => p.name === wiki.project);
  if (existing) {
    return (existing.local_path ?? existing.path) === dir ? "уже есть" : `есть, но путь ${existing.local_path ?? existing.path}`;
  }
  if (!bm(["project", "add", wiki.project, dir], { quiet: true }).ok) return "не смог завести (есть ли basic-memory?)";
  // без reindex MCP видит проект, но поиск по нему пустой
  bm(["reindex", "--project", wiki.project, "--search"], { quiet: true });
  return "заведён + индекс собран";
}

function stepList() {
  const wikis = readWikis();
  if (wikis.length === 0) {
    out("вики нет: создай командой new \"Wiki Название\"");
    return;
  }
  const projects = bmProjects().map((p) => p.name);
  for (const wiki of wikis) {
    const dir = wikiDir(wiki);
    if (!existsSync(dir)) {
      out(`${wiki.name}: нет каталога ${wiki.path}`);
      continue;
    }
    const files = articleFiles(dir);
    const topics = [...new Set(files.map((f) => relative(dir, f).split("/")[0]))];
    out(`${wiki.name}`);
    out(`  путь: ${wiki.path}   создана: ${wiki.created ?? "?"}`);
    out(`  постов: ${files.length} в темах: ${topics.join(", ") || "—"}`);
    out(`  индекс: ${indexEntries(dir).length} записей, база: ${existsSync(join(dir, "db", "wiki.db")) ? "собрана" : "нет (build)"}`);
    out(`  mcp-проект: ${wiki.project} ${projects.includes(wiki.project) ? "(подключён)" : "(нет — install)"}`);
  }
}

function stepNew(name, pathFlag) {
  if (!name) {
    err("нужно имя: wiki-station new \"Wiki Название\" [--path=<папка>]");
    process.exit(2);
  }
  // канон: вики живут внутри станции (wiki-station/wiki/<имя>), путь можно переопределить --path=
  const path = pathFlag ?? join("wiki-station", "wiki", name);
  const dir = resolve(AGGG, path);
  if (existsSync(dir)) {
    err(`каталог уже есть: ${path} (для подключения — add)`);
    process.exit(1);
  }
  if (DRY) {
    out(`создал бы ${path}/ (index.md, log.md, _templates/post.md)`);
    return;
  }
  mkdirSync(join(dir, "_templates"), { recursive: true });
  writeFileSync(join(dir, "index.md"), `# Index — каталог Wiki\n\nПоследнее обновление: ${today()}\n\n| Пост | Тема | Теги | Дата | Папка |\n|------|------|------|------|-------|\n`);
  writeFileSync(join(dir, "log.md"), `# Log — журнал изменений Wiki\n\nФормат: \`YYYY-MM-DD HH:MM — действие — файл(ы) — что сделано\`\n`);
  for (const [from, to] of [
    [join(ROOT, "templates", "_templates", "post.md"), join(dir, "_templates", "post.md")],
    [join(ROOT, "templates", "db-tools"), join(dir, "db-tools")],
  ]) {
    if (existsSync(from)) cpSync(from, to, { recursive: true });
  }
  const wikis = readWikis();
  wikis.push({ name, path, project: slug(name), created: today() });
  writeWikis(wikis);
  out(`создана: ${path}/ (index.md, log.md, _templates/post.md)`);
  out(`в wikis.json: ${name} → mcp-проект ${slug(name)}`);
  out(`строка для реестра центра: { "name": "${name}", "kind": "вики", "what": "вики «${name}»" }`);
}

function stepAdd(path) {
  if (!path) {
    err("нужен путь: wiki-station add <папка>");
    process.exit(2);
  }
  const dir = resolve(AGGG, path);
  if (!existsSync(join(dir, "index.md")) || !existsSync(join(dir, "log.md"))) {
    err("не похоже на вику: нужны index.md и log.md (создать — new)");
    process.exit(1);
  }
  const name = basename(dir);
  const wikis = readWikis();
  if (wikis.some((w) => w.name === name)) {
    out("уже подключена");
    return;
  }
  wikis.push({ name, path, project: slug(name), created: today() });
  writeWikis(wikis);
  out(`подключена: ${name} (mcp-проект: ${slug(name)})`);
}

function resolvePage(dir, query) {
  const files = articleFiles(dir);
  if (!query || query === "index" || query === "index.md") return join(dir, "index.md");
  if (query === "log" || query === "log.md") return join(dir, "log.md");
  const needle = query.toLowerCase();
  return (
    files.find((p) => basename(p).toLowerCase() === needle) ??
    files.find((p) => basename(p).toLowerCase().replace(/\.md$/, "") === needle) ??
    files.find((p) => p.toLowerCase().endsWith(`${needle}.md`)) ??
    files.find((p) => basename(p).toLowerCase().includes(needle)) ??
    null
  );
}

function stepOpen(name, page) {
  const wiki = findWiki(name);
  if (!wiki) {
    err(`нет такой вики: ${name ?? "(пусто)"} (список — wiki-station list)`);
    process.exit(1);
  }
  const dir = wikiDir(wiki);
  const path = resolvePage(dir, page);
  if (!path) {
    err(`страница не найдена: ${page}`);
    process.exit(1);
  }
  const text = readFileSync(path, "utf8");
  out(`== ${relative(AGGG, path)} (${text.split("\n").length} строк)`);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function stepSearch(query, wikiFlag) {
  if (!query) {
    err('нужен запрос: wiki-station search "..." [--wiki=<имя>] [--tags=a,b] [--topic=ai] [--limit=N] [--json]');
    process.exit(2);
  }
  const wikis = wikiFlag ? [findWiki(wikiFlag)].filter(Boolean) : readWikis();
  if (wikis.length === 0) {
    err("не нашёл вики для поиска");
    process.exit(1);
  }
  let status = 1;
  for (const wiki of wikis) {
    const dir = wikiDir(wiki);
    const tool = join(dir, "db-tools", "search.py");
    if (wikis.length > 1) out(`== ${wiki.name}`);
    if (existsSync(tool)) {
      const passed = [tool, "-r", dir, query, `--limit=${flagValue("limit") ?? 10}`];
      if (flagValue("tags")) passed.push(`--tags=${flagValue("tags")}`);
      if (flagValue("topic")) passed.push(`--topic=${flagValue("topic")}`);
      if (flags.has("--json")) passed.push("--json");
      const res = spawnSync("python3", passed, { stdio: "inherit" });
      if (res.status === 0) status = 0;
    } else {
      const needle = query.toLowerCase();
      let hits = 0;
      for (const file of articleFiles(dir)) {
        for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
          if (!line.toLowerCase().includes(needle) || hits >= 30) continue;
          hits += 1;
          out(`${relative(dir, file)}:${index + 1}: ${line.trim().slice(0, 150)}`);
        }
      }
      out(hits ? `\nсовпадений: ${hits}` : "ничего не нашлось (базы нет — собери: wiki-station build)");
      if (hits) status = 0;
    }
  }
  process.exit(status);
}

function stepBuild(name) {
  const wiki = findWiki(name);
  if (!wiki) {
    err(`нет такой вики: ${name ?? "(пусто)"}`);
    process.exit(1);
  }
  const dir = wikiDir(wiki);
  const tool = join(dir, "db-tools", "build.py");
  if (!existsSync(tool)) {
    err(`нет ${relative(AGGG, tool)} — сборка базы доступна только у вики с db-tools`);
    process.exit(1);
  }
  if (DRY) {
    out(`собрал бы базу для ${wiki.name}`);
    return;
  }
  const res = spawnSync("python3", [tool, "-r", dir, "-o", join(dir, "db", "wiki.db")], { encoding: "utf8" });
  process.stdout.write(res.stdout ?? "");
  process.stderr.write(res.stderr ?? "");
  if (res.status !== 0) process.exit(res.status ?? 1);
  const count = articleFiles(dir).length;
  logAdd(dir, "build", "db/wiki.db", `библиотека пересобрана (всего ${count} постов)`);
  out("в log.md дописана строка build");
}

function stepIndex(name) {
  const wiki = findWiki(name);
  if (!wiki) {
    err(`нет такой вики: ${name ?? "(пусто)"}`);
    process.exit(1);
  }
  const dir = wikiDir(wiki);
  const articles = articleFiles(dir).map((p) => articleMeta(dir, p));
  articles.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.rel.localeCompare(b.rel));
  const indexPath = join(dir, "index.md");
  const previous = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  // ведущий frontmatter index.md — метаданные заметки для basic-memory: пересборка их сохраняет
  const head = previous.startsWith("---") && previous.indexOf("\n---", 3) !== -1 ? `${previous.slice(0, previous.indexOf("\n---", 3) + 4)}\n` : "";
  // «|» в описании ломает таблицу — экранируем так же, как MCP (wiki_index)
  const cell = (value) => String(value ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  const lines = [`${head}# Index — каталог Wiki`, "", `Последнее обновление: ${today()}`, "", "| Пост | Тема | Теги | Дата | Папка |", "|------|------|------|------|-------|"];
  for (const a of articles) {
    lines.push(`| [${cell(a.title)}](${a.rel}) | ${cell(a.description) || "(no description)"} | ${cell(a.tags.join(", "))} | ${a.date || "?"} | ${a.topic}/ |`);
  }
  lines.push("");
  if (DRY) {
    out(`пересобрал бы index.md: записей ${articles.length}`);
    return;
  }
  // Каталог не изменился — не пишем файл и не сорим в log.md: строка в журнале значит
  // «каталог пересобран», а не «команду позвали». Иначе повторный прогон плодит дубли.
  const next = lines.join("\n");
  if (next === previous) {
    out(`index.md уже актуален: ${articles.length} записей — файл и log.md не тронуты`);
    return;
  }
  writeFileSync(indexPath, next);
  logAdd(dir, "index", "index.md", `каталог пересобран из frontmatter (${articles.length} постов)`);
  out(`index.md пересобран: ${articles.length} записей`);
}

function stepLog(name, count) {
  const wiki = findWiki(name);
  if (!wiki) {
    err(`нет такой вики: ${name ?? "(пусто)"}`);
    process.exit(1);
  }
  const path = join(wikiDir(wiki), "log.md");
  if (!existsSync(path)) {
    err("нет log.md");
    process.exit(1);
  }
  const lines = readFileSync(path, "utf8").split("\n");
  out(lines.slice(-(count ?? 20)).join("\n"));
}

function stepLint(name) {
  const wiki = findWiki(name);
  if (!wiki) {
    err(`нет такой вики: ${name ?? "(пусто)"}`);
    process.exit(1);
  }
  const dir = wikiDir(wiki);
  const articles = articleFiles(dir).map((p) => articleMeta(dir, p));
  const problems = [];
  for (const a of articles) {
    const missing = REQUIRED_FIELDS.filter((field) => {
      const value = a.meta[field];
      return value === undefined || (Array.isArray(value) ? value.length === 0 : String(value).trim() === "");
    });
    if (missing.length) problems.push(`${a.rel}: нет обязательных полей frontmatter: ${missing.join(", ")}`);
    const badTags = a.tags.filter((t) => t !== t.toLowerCase() || /\s/.test(t));
    if (badTags.length) problems.push(`${a.rel}: теги не по таксономии (нижний регистр, без пробелов): ${badTags.join(", ")}`);
  }
  const entries = indexEntries(dir);
  const inIndex = new Set(entries.map((e) => e.target));
  for (const a of articles) if (!inIndex.has(a.rel)) problems.push(`${a.rel}: нет строки в index.md (index — пересобрать)`);
  const files = new Set(articles.map((a) => a.rel));
  for (const entry of entries) if (!files.has(entry.target)) problems.push(`index.md: ссылка на несуществующий ${entry.target}`);

  // дрейф каталога: строка index.md против frontmatter поста (описание, теги, дата)
  const flat = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const byTarget = new Map();
  for (const entry of entries) if (!byTarget.has(entry.target)) byTarget.set(entry.target, entry);
  for (const a of articles) {
    const entry = byTarget.get(a.rel);
    if (!entry) continue;
    const want = {
      description: flat(a.description) || "(no description)",
      tags: flat(a.tags.join(", ")),
      date: flat(a.date) || "?",
    };
    const got = { description: flat(entry.description), tags: flat(entry.tags), date: flat(entry.date) };
    for (const field of ["description", "tags", "date"]) {
      if (got[field] !== want[field]) {
        problems.push(`${a.rel}: index.md разошёлся с постом по «${field}»: в индексе «${got[field]}», в посте «${want[field]}» (index — пересобрать)`);
      }
    }
  }
  out(`постов: ${articles.length}, записей в индексе: ${inIndex.size}`);
  if (problems.length) {
    for (const p of problems) err(`замечание: ${p}`);
    out(`замечаний: ${problems.length}`);
    return;
  }
  out("lint чистый");
}

function stepProjects() {
  const wikis = readWikis();
  if (wikis.length === 0) {
    out("вики нет — нечего подключать");
    return;
  }
  for (const wiki of wikis) out(`${wiki.name} → mcp-проект ${wiki.project}: ${DRY ? "подключил бы" : ensureBmProject(wiki)}`);
  out("");
  out('доступ для агента через MCP basic-memory: search_notes(query, project="wiki-..."), read_note, write_note, build_context');
  out("доступ через CLI: wiki-station search \"...\" (база FTS5) или open <вика> <страница>");
}

function stepInstall() {
  out("== скилл wiki");
  for (const line of DRY ? ["поставил бы ссылки на скилл"] : linkSkill()) out(`  ${line}`);
  out("== база поиска");
  for (const wiki of readWikis()) {
    const dir = wikiDir(wiki);
    const tool = join(dir, "db-tools", "build.py");
    if (!existsSync(tool)) {
      out(`  ${wiki.name}: нет db-tools — поиск будет grep-режимом`);
      continue;
    }
    const res = spawnSync("python3", [tool, "-r", dir, "-o", join(dir, "db", "wiki.db")], { encoding: "utf8" });
    out(`  ${wiki.name}: ${res.status === 0 ? (res.stdout ?? "").trim().split("\n").pop() : "не собралась"}`);
  }
  out("== mcp-проекты");
  stepProjects();
}

function stepStatus() {
  stepList();
  out("");
  out(`скилл: ${existsSync(SKILL_LINK) ? SKILL_LINK : "не поставлен (install)"}`);
  out(`basic-memory: ${whichTool("basic-memory") ? "есть" : "нет"}`);
  out(`python3: ${whichTool("python3") ? "есть" : "нет"}`);
}

function stepCheck() {
  const problems = [];
  const wikis = readWikis();
  if (wikis.length === 0) problems.push("wikis.json пуст — нет ни одной вики");
  const projects = bmProjects().map((p) => p.name);
  for (const wiki of wikis) {
    const dir = wikiDir(wiki);
    if (!existsSync(dir)) {
      problems.push(`${wiki.name}: нет каталога ${wiki.path}`);
      continue;
    }
    for (const required of ["index.md", "log.md"]) if (!existsSync(join(dir, required))) problems.push(`${wiki.name}: нет ${required}`);
    if (!projects.includes(wiki.project)) problems.push(`${wiki.name}: нет mcp-проекта ${wiki.project} (install)`);
    if (!existsSync(join(dir, "db", "wiki.db"))) problems.push(`${wiki.name}: база поиска не собрана (build)`);
  }
  if (!existsSync(SKILL_SRC)) problems.push(`нет скилла-руководства (${SKILL_SRC})`);
  if (!existsSync(SKILL_LINK)) problems.push("скилл не слинкован в ~/.agents/skills (install)");
  out(`вики: ${wikis.length}, постов всего: ${wikis.reduce((n, w) => n + articleFiles(wikiDir(w)).length, 0)}`);
  if (problems.length) {
    for (const p of problems) err(`проблема: ${p}`);
    process.exit(1);
  }
  out("проверка пройдена");
}

function stepDoctor() {
  stepCheck();
  for (const wiki of readWikis()) {
    out("");
    out(`== lint: ${wiki.name}`);
    stepLint(wiki.name);
  }
}

switch (command) {
  case "list":
    stepList();
    break;
  case "new":
    stepNew(positional[1], flagValue("path"));
    break;
  case "add":
    stepAdd(positional[1]);
    break;
  case "open":
  case "show":
    stepOpen(positional[1], positional[2]);
    break;
  case "search":
    stepSearch(positional[1], flagValue("wiki"));
    break;
  case "build":
    stepBuild(positional[1]);
    break;
  case "index":
    stepIndex(positional[1]);
    break;
  case "log":
    stepLog(positional[1], positional[2] ? Number(positional[2]) : undefined);
    break;
  case "lint":
    stepLint(positional[1]);
    break;
  case "projects":
  case "mcp":
    stepProjects();
    break;
  case "install":
    stepInstall();
    break;
  case "status":
    stepStatus();
    break;
  case "check":
  case "verify":
    stepCheck();
    break;
  case "doctor":
    stepDoctor();
    break;
  default:
    err(`wiki-station: не знаю команду «${command}»`);
    err("команды: list | new | add | open | search | build | index | log | lint | projects | install | status | check | doctor");
    process.exit(2);
}
