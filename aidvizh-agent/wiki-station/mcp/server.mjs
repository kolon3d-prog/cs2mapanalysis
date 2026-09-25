#!/usr/bin/env node
// MCP-сервер вики: stdio, без зависимостей, один движок на linux/macOS/Windows.
//
// Философия инструментов — «один вопрос, один вызов»:
//   wiki_find  — поиск + тела постов + подсказки одним ответом (типовой вопрос «что есть про X»);
//   wiki_stats — вся картина библиотеки (темы, теги, покрытие индекса, возраст базы, список вики);
//   wiki_search/wiki_read/wiki_index/wiki_add_post/wiki_log/wiki_lint/wiki_build/wiki_list — точечные.
//
// Контракты, которые здесь соблюдаются:
//   • пустой результат — обычный ответ (count:0 + suggestions/notes), НЕ ошибка;
//   • ошибка — isError:true, одна человеческая строка и что делать дальше (без сырого stdout движка);
//   • каждый ответ несёт контекст: wiki (имя), root, mode (db|files), posts, index_age, stale;
//   • если база старше самого нового поста — пересобираем её сами (один раз) либо честно говорим stale.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGGG = process.env.WIKI_STATION_ROOT ? resolve(process.env.WIKI_STATION_ROOT) : resolve(ROOT, "..");
const WIKIS_FILE = process.env.WIKI_STATION_REGISTRY || join(ROOT, "wikis.json");
const SKIP_FILES = new Set(["README.md", "index.md", "log.md"]);
const SKIP_DIRS = new Set(["_templates", "db", "db-tools", ".git", "node_modules"]);
const TYPES = ["Post", "Insight", "Reference", "Idea", "Howto"];
const FIND_BODY_CHARS = 1200;
const SNIPPET_CHARS = 200;

// --- реестр вики ---

const readWikis = () => {
  if (!existsSync(WIKIS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(WIKIS_FILE, "utf8")).wikis ?? [];
  } catch (error) {
    throw new Error(`wikis.json не читается: ${error.message}`);
  }
};
const wikiDir = (wiki) => resolve(AGGG, wiki.path);
const confinedPath = (root, relativePath) => {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  const inside = target === base || target.startsWith(`${base}${sep}`);
  if (!inside) throw new Error("путь выходит за пределы вики");
  return target;
};
const today = () => new Date().toISOString().slice(0, 10);
const nowStamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const stamp = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : null);

function humanAge(durationMs) {
  if (!Number.isFinite(durationMs)) return "—";
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 90) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days} д` : `${Math.round(days / 30)} мес`;
}

function findWiki(name) {
  const wikis = readWikis();
  if (!wikis.length) throw new Error(`в ${basename(WIKIS_FILE)} нет ни одной вики — заведи: wiki-station new "Wiki Название"`);
  if (!name) return wikis[0];
  const wiki = wikis.find((w) => w.name === name) ?? wikis.find((w) => w.name.toLowerCase() === String(name).toLowerCase());
  if (!wiki) throw new Error(`нет такой вики: ${name} (есть: ${wikis.map((w) => w.name).join(", ")}) — вызови wiki_stats, чтобы увидеть список`);
  return wiki;
}

// --- чтение постов ---

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

const unquote = (value) => {
  const text = String(value ?? "").trim();
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
    return text.slice(1, -1);
  }
  return text;
};

// Разбор YAML-frontmatter: скаляры, кавычки, инлайн-списки, блок-списки,
// многострочные блоки `|`/`>` (в том числе `>-`) и многострочные кавычечные скаляры.
// Вложенные блоки (generated:) верхние поля не портят.
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const lines = text.slice(3, end).split("\n");
  const data = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // строка вложенного блока — верхние поля не трогаем
    const match = /^([^:]+):(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const raw = match[2].trim();

    const block = /^([|>])([+-]?)(\d*)$/.exec(raw);
    if (block) {
      const chunk = [];
      while (index + 1 < lines.length && (lines[index + 1].trim() === "" || /^\s/.test(lines[index + 1]))) {
        index += 1;
        chunk.push(lines[index].replace(/^\s+/, ""));
      }
      data[key] = block[1] === ">" ? chunk.join(" ").trim() : chunk.join("\n").replace(/\s+$/, "");
      continue;
    }

    // многострочный скаляр в кавычках: 'строка …\n  продолжение'
    if ((raw.startsWith("'") || raw.startsWith('"')) && !raw.endsWith(raw[0])) {
      const quote = raw[0];
      const chunk = [raw];
      while (index + 1 < lines.length) {
        index += 1;
        chunk.push(lines[index].trim());
        if (lines[index].trimEnd().endsWith(quote)) break;
      }
      data[key] = unquote(chunk.join(" "));
      continue;
    }

    if (raw.startsWith("[") && raw.endsWith("]")) {
      data[key] = raw.slice(1, -1).split(",").map((value) => unquote(value)).filter(Boolean);
      continue;
    }
    if (raw === "" || raw === "~" || raw === "null") {
      const items = [];
      let scan = index + 1;
      while (scan < lines.length && !lines[scan].trim()) scan += 1;
      while (scan < lines.length && /^\s*-\s+/.test(lines[scan])) {
        items.push(unquote(lines[scan].replace(/^\s*-\s+/, "")));
        scan += 1;
      }
      if (items.length) {
        data[key] = items;
        index = scan - 1;
      } else {
        data[key] = []; // пустое поле либо вложенный блок — вложенное пропускаем
      }
      continue;
    }

    // plain-скаляр: « #» — комментарий, отступленные продолжения сворачиваются пробелом
    // (basic-memory переписывает description/title именно так — свёрнутым скаляром)
    const parts = [raw.split(/\s+#/)[0].trim()];
    while (
      index + 1 < lines.length &&
      /^\s/.test(lines[index + 1]) &&
      lines[index + 1].trim() &&
      !lines[index + 1].trimStart().startsWith("- ") &&
      !lines[index + 1].trimStart().startsWith("#")
    ) {
      index += 1;
      parts.push(lines[index].trim());
    }
    data[key] = unquote(parts.filter(Boolean).join(" "));
  }
  return data;
}

const stripFrontmatter = (text) => {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text : text.slice(end + 4).replace(/^\s*\n/, "");
};

function meta(dir, path) {
  const text = readFileSync(path, "utf8");
  const fm = parseFrontmatter(text);
  return {
    rel: relative(dir, path).replace(/\\/g, "/"),
    topic: relative(dir, path).replace(/\\/g, "/").split("/")[0],
    title: String(fm.title ?? basename(path, ".md")),
    description: collapse(fm.description),
    date: String(fm.date ?? ""),
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : String(fm.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    type: String(fm.type ?? ""),
    text,
  };
}

// --- свежесть базы ---

function freshness(dir) {
  const files = articleFiles(dir);
  let newest = 0;
  for (const file of files) {
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime > newest) newest = mtime;
    } catch {
      // файл исчез между обходом и stat — не повод падать
    }
  }
  const dbPath = join(dir, "db", "wiki.db");
  const db = existsSync(dbPath) ? statSync(dbPath) : null;
  return { files, posts: files.length, dbPath, db, newest, stale: Boolean(db) && newest > db.mtimeMs };
}

const pythonReady = (() => {
  let cached = null;
  return () => {
    if (cached === null) cached = spawnSync("python3", ["-c", "import sqlite3"], { stdio: "ignore" }).status === 0;
    return cached;
  };
})();

const capsCache = new Map();
function engineCaps(script) {
  if (capsCache.has(script)) return capsCache.get(script);
  const res = spawnSync("python3", [script, "--help"], { encoding: "utf8" });
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const caps = {
    available: res.status === 0,
    queries: text.includes("--queries"),
    explain: text.includes("--explain"),
    noBody: text.includes("--no-body"),
  };
  capsCache.set(script, caps);
  return caps;
}

function context(wiki, dir, fresh, mode) {
  return {
    wiki: wiki.name,
    root: dir,
    mode,
    posts: fresh.posts,
    index_age: fresh.db ? humanAge(Date.now() - fresh.db.mtimeMs) : null,
    index_built_at: fresh.db ? stamp(fresh.db.mtimeMs) : null,
    stale: fresh.stale,
  };
}

function contextHead(ctx) {
  const base = `база: ${ctx.index_built_at ?? "не собрана"}${ctx.index_built_at ? ` (${ctx.index_age} назад)` : ""} · ${ctx.stale ? "УСТАРЕЛА" : "свежая"}`;
  return `вика: ${ctx.wiki} · корень: ${ctx.root}\nрежим: ${ctx.mode} · постов: ${ctx.posts} · ${base}`;
}

// --- движок поиска ---

function tryJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function engineFailure(res) {
  if (res.error) return `python3 не запускается (${res.error.message})`;
  const lines = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return `движок завершился с кодом ${res.status}`;
  // у питоновского трейсбека суть — в последней строке; иначе ищем первую осмысленную
  const last = lines[lines.length - 1];
  const meaningful = last.length <= 200 ? last : lines.find((line) => /error|exception|нет |не найден|unable|no such/i.test(line)) ?? last;
  return `движок упал: ${meaningful.slice(0, 200)}`;
}

function callEngine(dir, queries, options) {
  const script = join(dir, "db-tools", "search.py");
  const caps = engineCaps(script);
  const run = (list) => {
    const args = [script, "-r", dir, "--json", `--limit=${options.limit}`];
    if (list.length > 1) args.push(`--queries=${list.join(";")}`);
    else args.push(list[0]);
    if (options.tags) args.push(`--tags=${options.tags}`);
    if (options.topic) args.push(`--topic=${options.topic}`);
    if (options.explain && caps.explain) args.push("--explain");
    // тело постов сервер читает сам из файлов — движку незачем его везти
    if (caps.noBody) args.push("--no-body");
    return spawnSync("python3", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  };

  if (!caps.available) return { error: `движок поиска недоступен: ${relative(AGGG, script)} не отвечает на --help` };

  if (caps.queries || queries.length === 1) {
    const res = run(queries);
    const data = tryJson(res.stdout);
    if (data === null) return { error: engineFailure(res) };
    if (data.ok === false) return { error: data.error ?? "движок вернул ok:false" };
    return { data };
  }

  // старый движок без --queries: пакет разворачиваем в отдельные вызовы и сливаем
  const merged = [];
  const seen = new Set();
  const suggestions = [];
  const notes = [];
  let mode = null;
  let index = null;
  for (const query of queries) {
    const res = run([query]);
    const data = tryJson(res.stdout);
    if (data === null) return { error: engineFailure(res) };
    if (data.ok === false) return { error: data.error ?? "движок вернул ok:false" };
    mode = mode ?? data.mode ?? null;
    index = index ?? data.index ?? null;
    suggestions.push(...(data.suggestions ?? []));
    notes.push(...(data.notes ?? []));
    for (const result of data.results ?? []) {
      if (seen.has(result.path)) continue;
      seen.add(result.path);
      merged.push({ ...result, query: result.query ?? query });
    }
  }
  return { data: { ok: true, mode, queries, count: merged.length, index, results: merged, suggestions, notes } };
}

function normalizeEngine(data, queries) {
  const results = Array.isArray(data.results) ? data.results : [];
  const mode = /^(db|база)$/.test(String(data.mode ?? "")) || String(data.mode ?? "").includes("база") ? "db" : "files";
  return {
    mode,
    queries: Array.isArray(data.queries) && data.queries.length ? data.queries : queries,
    count: Number.isFinite(data.count) ? data.count : results.length,
    index: data.index && typeof data.index === "object" ? data.index : null,
    results,
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
  };
}

function searchFiles(dir, queries, options) {
  const tagList = String(options.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const results = [];
  const seen = new Set();
  for (const query of queries) {
    const needle = String(query).toLowerCase().trim();
    if (!needle) continue;
    for (const file of articleFiles(dir)) {
      const item = meta(dir, file);
      if (seen.has(item.rel)) continue;
      if (options.topic && item.topic !== options.topic) continue;
      if (tagList.length && !tagList.every((tag) => item.tags.includes(tag))) continue;
      const at = item.text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      seen.add(item.rel);
      const start = item.text.lastIndexOf("\n", at) + 1;
      const stop = item.text.indexOf("\n", at);
      results.push({
        path: item.rel,
        title: item.title,
        description: item.description,
        tags: item.tags.join(", "),
        date: item.date,
        topic: item.topic,
        snippet: item.text.slice(start, stop < 0 ? undefined : stop).trim().slice(0, SNIPPET_CHARS),
        score: 0,
        query,
      });
      if (results.length >= options.limit) break;
    }
    if (results.length >= options.limit) break;
  }
  return results;
}

function snippetFor(text, token) {
  const needle = String(token ?? "").toLowerCase();
  if (!needle) return "";
  const at = String(text).toLowerCase().indexOf(needle);
  if (at < 0) return "";
  const start = text.lastIndexOf("\n", at) + 1;
  const stop = text.indexOf("\n", at);
  return collapse(text.slice(start, stop < 0 ? undefined : stop)).slice(0, SNIPPET_CHARS);
}

// Поиск по словам запроса: совпадение в заголовке/описании/тегах весит больше, чем в теле.
// Нужен, когда движок нашёл ноль (он ищет строго по всем словам), чтобы типовой вопрос
// всё равно закрывался ОДНИМ вызовом, а не серией уточнений.
function tokenScore(dir, queries) {
  const tokens = [...new Set((queries.join(" ").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 3))];
  if (!tokens.length) return [];
  const scored = [];
  for (const file of articleFiles(dir)) {
    const item = meta(dir, file);
    const head = `${item.title} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
    const body = item.text.toLowerCase();
    let score = 0;
    let best = null;
    for (const token of tokens) {
      const hit = head.includes(token) ? 3 : body.includes(token) ? 1 : 0;
      if (!hit) continue;
      score += hit;
      if (!best || hit > best.hit) best = { token, hit };
    }
    if (score >= 2) scored.push({ score, item, best });
  }
  scored.sort((a, b) => b.score - a.score || a.item.rel.localeCompare(b.item.rel));
  return scored;
}

function asResult(item, best, score, query) {
  return {
    path: item.rel,
    title: item.title,
    description: item.description,
    tags: item.tags.join(", "),
    date: item.date,
    topic: item.topic,
    snippet: snippetFor(item.text, best?.token),
    score,
    query,
  };
}


function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// Цели из табличных строк index.md (а не любые упоминания пути: внизу индекса бывает
// легенда тегов со ссылками, из-за которой покрытие раньше казалось полным).
function indexTargets(dir) {
  const path = join(dir, "index.md");
  if (!existsSync(path)) return new Set();
  const targets = new Set();
  for (const match of readFileSync(path, "utf8").matchAll(/^\|\s*\[[^\]]*\]\(([^)]+)\)/gm)) targets.add(match[1].trim());
  return targets;
}

function nearestTitles(dir, needle, count = 5) {
  const target = String(needle ?? "").toLowerCase().trim();
  if (!target) return [];
  const scored = [];
  for (const file of articleFiles(dir)) {
    const item = meta(dir, file);
    const slug = basename(file, ".md").toLowerCase();
    const title = item.title.toLowerCase();
    let distance = Math.min(editDistance(target, slug), editDistance(target, title));
    if (slug.includes(target) || title.includes(target) || target.includes(slug)) distance = 0;
    scored.push({ distance, rel: item.rel, title: item.title });
  }
  scored.sort((a, b) => a.distance - b.distance || a.rel.localeCompare(b.rel));
  return scored.slice(0, count);
}

// --- общий поиск: свежесть → движок → тела постов ---

function runSearch(wiki, dir, { queries, tags, topic, limit, explain, bodyChars }) {
  const notes = [];
  let fresh = freshness(dir);
  if (fresh.stale) {
    const build = join(dir, "db-tools", "build.py");
    if (existsSync(build) && pythonReady()) {
      const res = spawnSync("python3", [build, "-r", dir, "-o", fresh.dbPath], { encoding: "utf8" });
      if (res.status !== 0) {
        notes.push("база устарела, пересобрать не удалось");
      } else {
        const after = freshness(dir);
        if (after.stale) {
          notes.push("база устарела, пересборка её не освежила");
        } else {
          fresh = after;
          notes.push("база была устаревшей — пересобрал её сам");
        }
      }
    } else {
      notes.push("база устарела, пересобрать нечем (нет db-tools/build.py или python3)");
    }
  }
  const forceFiles = fresh.stale;
  const options = { tags, topic, limit, explain };

  let mode;
  let results;
  let suggestions = [];
  let index = null;
  const engine = !forceFiles && existsSync(join(dir, "db-tools", "search.py")) && pythonReady() ? callEngine(dir, queries, options) : null;
  if (forceFiles) {
    mode = "files";
    results = searchFiles(dir, queries, options);
    notes.push("искал по файлам, а не по базе");
  } else if (!engine) {
    mode = "files";
    results = searchFiles(dir, queries, options);
    notes.push("движок db-tools/search.py недоступен — искал по файлам");
  } else if (engine.error) {
    throw new Error(`${engine.error} — проверь вику или пересобери базу: wiki_build`);
  } else {
    const normalized = normalizeEngine(engine.data, queries);
    mode = normalized.mode;
    results = normalized.results;
    suggestions = normalized.suggestions;
    index = normalized.index;
    notes.push(...normalized.notes);
  }

  if (!results.length) {
    const scored = tokenScore(dir, queries);
    if (scored.length) {
      results = scored.slice(0, limit).map(({ item, best, score }) => asResult(item, best, score, queries[0]));
      mode = "files";
      suggestions = scored.slice(limit, limit + 6).map(({ item }) => item.rel);
      notes.push("точных совпадений в базе нет — расширил поиск по словам (файлы)");
    } else {
      const wikis = readWikis();
      if (wikis.length > 1 && wiki.name === wikis[0].name) {
        const others = wikis
          .filter((w) => w.name !== wiki.name && existsSync(wikiDir(w)))
          .map((w) => `${w.name}: ${articleFiles(wikiDir(w)).length}`);
        if (others.length) notes.push(`искал в дефолтной вике «${wiki.name}»; другие вики — ${others.join(", ")}`);
      }
    }
  }

  if (bodyChars > 0) {
    for (const result of results) {
      const abs = join(dir, String(result.path ?? ""));
      let body = "";
      if (result.path && existsSync(abs)) {
        try {
          body = stripFrontmatter(readFileSync(abs, "utf8")).trim();
        } catch {
          body = "";
        }
      }
      const truncated = body.length > bodyChars;
      result.body = body.slice(0, bodyChars);
      result.body_chars = result.body.length;
      if (truncated) result.body_truncated = true;
    }
  } else {
    for (const result of results) {
      if (result.body === undefined) result.body = "";
      if (result.body_chars === undefined) result.body_chars = 0;
    }
  }

  const ctx = context(wiki, dir, fresh, mode);
  return {
    context: ctx,
    results,
    suggestions,
    notes,
    index: index ?? {
      posts: fresh.posts,
      built_at: ctx.index_built_at,
      stale: fresh.stale,
      newest_post: stamp(fresh.newest),
    },
    queries,
  };
}

function payload(result) {
  return {
    ok: true,
    mode: result.context.mode,
    wiki: result.context.wiki,
    root: result.context.root,
    posts: result.context.posts,
    index_age: result.context.index_age,
    stale: result.context.stale,
    queries: result.queries,
    count: result.results.length,
    index: result.index,
    results: result.results,
    suggestions: result.suggestions,
    notes: result.notes,
  };
}

function renderFind(result, bodyChars) {
  const { context: ctx, results, suggestions, notes } = result;
  const lines = [contextHead(ctx), `запрос${result.queries.length > 1 ? "ы" : ""}: ${result.queries.map((q) => `«${q}»`).join(", ")} · найдено: ${results.length}`];
  if (!results.length) {
    lines.push("");
    lines.push("ничего не нашлось — это не ошибка, а ответ: по этим словам постов нет.");
    if (suggestions.length) lines.push(`похожие по названию/описанию: ${suggestions.join(", ")}`);
    lines.push(...notes.map((note) => `• ${note}`));
    lines.push("что дальше: переформулируй запрос, посмотри wiki_stats (какие темы и теги вообще есть); если знания нет — добавь пост через wiki_add_post.");
    return lines.join("\n");
  }
  for (const [index, item] of results.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${item.title}`);
    const parts = [
      `путь: ${item.path}`,
      `теги: ${item.tags || "—"}`,
      `дата: ${item.date || "—"}`,
      `тема: ${item.topic || "—"}`,
    ];
    if (result.queries.length > 1 && item.query) parts.push(`запрос: «${item.query}»`);
    lines.push(`   ${parts.join(" · ")}`);
    if (item.description) lines.push(`   описание: ${collapse(item.description)}`);
    if (item.snippet) lines.push(`   сниппет: ${collapse(item.snippet)}`);
    if (item.body) {
      lines.push(`   тело (${item.body_chars}${item.body_truncated ? ` из ${bodyChars}+` : ""} симв.):`);
      lines.push(item.body);
    }
  }
  if (suggestions.length) {
    lines.push("");
    lines.push(`ещё близкое: ${suggestions.join(", ")}`);
  }
  lines.push(...notes.map((note) => `• ${note}`));
  return lines.join("\n");
}

// --- запись ---

function yamlScalar(value) {
  const text = String(value ?? "");
  if (!text) return '""';
  if (/[:#"'\n]|^\s|\s$|^[[{>|&*!%@`-]/.test(text)) return `'${text.replace(/'/g, "''")}'`;
  return text;
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function tableCell(value) {
  return collapse(value).replace(/\|/g, "\\|");
}

// --- инструменты ---

const tools = {
  wiki_find: {
    description:
      "ГЛАВНЫЙ инструмент для вопроса «что у меня есть про X»: за ОДИН вызов ищет по вики и возвращает " +
      "топ-N постов с описанием, тегами, сниппетом и телом поста. Пустой ответ — нормальный ответ " +
      "(count:0 и подсказки «похожее»), а не ошибка. Можно передать пачку запросов (queries) — тоже один вызов.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "что искать (одна строка)" },
        queries: { type: "array", items: { type: "string" }, description: "пачка запросов — пакетом, одним вызовом" },
        wiki: { type: "string", description: "имя вики (по умолчанию дефолтная из wikis.json)" },
        tags: { type: "string", description: "теги через запятую, все должны встретиться" },
        topic: { type: "string", description: "тематическая папка (ai, coding, tools, ...)" },
        limit: { type: "number", description: "сколько постов вернуть (по умолчанию 5)" },
        body_chars: { type: "number", description: `сколько символов тела поста показать (по умолчанию ${FIND_BODY_CHARS}, 0 — без тела)` },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const queries = pickQueries(args);
      const limit = clampInt(args.limit, 1, 50, 5);
      const bodyChars = clampInt(args.body_chars, 0, 20000, FIND_BODY_CHARS);
      const wiki = findWiki(args.wiki);
      const dir = wikiDir(wiki);
      if (!existsSync(dir)) throw new Error(`каталог вики не найден: ${wiki.path} — проверь wikis.json или заведи вику: wiki-station new "Wiki Название"`);
      const result = runSearch(wiki, dir, { queries, tags: args.tags, topic: args.topic, limit, explain: false, bodyChars });
      return renderFind(result, bodyChars);
    },
  },

  wiki_search: {
    description:
      "Поиск по вики (база FTS5 или файлы) с машинным ответом: ровно тот же JSON, что отдаёт движок search.py " +
      "(--json): mode, wiki, root, queries, count, index, results, suggestions, notes. Пусто — это ok:true,count:0.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "что искать (одна строка)" },
        queries: { type: "array", items: { type: "string" }, description: "пачка запросов — пакетом, одним вызовом" },
        wiki: { type: "string", description: "имя вики (по умолчанию дефолтная из wikis.json)" },
        tags: { type: "string", description: "теги через запятую, все должны встретиться" },
        topic: { type: "string", description: "тематическая папка (ai, coding, tools, ...)" },
        limit: { type: "number", description: "сколько результатов (по умолчанию 10)" },
        body_chars: { type: "number", description: "сколько символов тела поста добавить в каждый результат (по умолчанию 0)" },
        explain: { type: "boolean", description: "попросить движок объяснить ранжирование" },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const queries = pickQueries(args);
      const limit = clampInt(args.limit, 1, 50, 10);
      const bodyChars = clampInt(args.body_chars, 0, 20000, 0);
      const wiki = findWiki(args.wiki);
      const dir = wikiDir(wiki);
      if (!existsSync(dir)) throw new Error(`каталог вики не найден: ${wiki.path} — проверь wikis.json или заведи вику: wiki-station new "Wiki Название"`);
      const result = runSearch(wiki, dir, { queries, tags: args.tags, topic: args.topic, limit, explain: Boolean(args.explain), bodyChars });
      return JSON.stringify(payload(result), null, 2);
    },
  },

  wiki_stats: {
    description:
      "Вся картина библиотеки за один вызов: список вики с пометкой дефолтной, число постов по темам, топ тегов, " +
      "покрытие index.md, возраст поисковой базы. Начинай с него, чтобы понять, где вообще искать.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => {
      const wikis = readWikis();
      if (!wikis.length) throw new Error(`в ${basename(WIKIS_FILE)} нет ни одной вики — заведи: wiki-station new "Wiki Название"`);
      const blocks = [];
      const summary = [];
      let totals = { posts: 0, indexed: 0 };
      for (const [index, wiki] of wikis.entries()) {
        const marker = index === 0 ? " (дефолт)" : "";
        const dir = wikiDir(wiki);
        if (!existsSync(dir)) {
          blocks.push(`${wiki.name}${marker} — НЕТ КАТАЛОГА ${wiki.path}`);
          summary.push({ name: wiki.name, posts: 0, default: index === 0 });
          continue;
        }
        const files = articleFiles(dir);
        const topics = new Map();
        const tags = new Map();
        for (const file of files) {
          const item = meta(dir, file);
          topics.set(item.topic, (topics.get(item.topic) ?? 0) + 1);
          for (const tag of item.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
        }
        const targets = indexTargets(dir);
        const indexed = files.filter((file) => targets.has(relative(dir, file).replace(/\\/g, "/"))).length;
        const fresh = freshness(dir);
        totals = { posts: totals.posts + files.length, indexed: totals.indexed + indexed };
        summary.push({ name: wiki.name, posts: files.length, default: index === 0 });

        const topicLine = [...topics.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ") || "—";
        const tagLine = [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([name, count]) => `${name} ${count}`).join(", ") || "—";
        const dbLine = fresh.db
          ? `${stamp(fresh.db.mtimeMs)} (${humanAge(Date.now() - fresh.db.mtimeMs)} назад) · ${fresh.stale ? "УСТАРЕЛА — пересобери wiki_build" : "свежая"}`
          : "не собрана — собери wiki_build";
        const missing = files.length - indexed;
        blocks.push(
          `${wiki.name}${marker} — ${wiki.path}${wiki.created ? ` · заведена ${wiki.created}` : ""}\n` +
            `  постов: ${files.length} · темы: ${topicLine}\n` +
            `  теги: ${tagLine}\n` +
            `  index.md: ${indexed} из ${files.length}${missing ? ` (нет ${missing} — пересобери wiki_index)` : " (полное)"}\n` +
            `  база: ${dbLine}`
        );
      }
      const defaultWiki = summary[0];
      const biggest = summary.reduce((best, item) => (item.posts > best.posts ? item : best), summary[0]);
      const notes = [];
      if (wikis.length > 1 && defaultWiki && biggest && biggest.name !== defaultWiki.name) {
        notes.push(`дефолтная вика «${defaultWiki.name}» (${defaultWiki.posts} постов) меньше «${biggest.name}» (${biggest.posts}) — если ищешь не там, передай wiki: "${biggest.name}"`);
      }
      blocks.push("");
      blocks.push(`итого: вики ${summary.length} · постов ${totals.posts} · в index.md ${totals.indexed}`);
      blocks.push(...notes.map((note) => `• ${note}`));
      return blocks.join("\n");
    },
  },

  wiki_read: {
    description: "Прочитать пост вики целиком по пути (тема/файл.md), по слагу или по подстроке заголовка. При промахе показывает ближайшие похожие названия.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "тема/файл.md, слаг или часть названия" },
        wiki: { type: "string", description: "имя вики (по умолчанию дефолтная)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    run: ({ path, wiki }) => {
      const target = findWiki(wiki);
      const dir = wikiDir(target);
      const files = articleFiles(dir);
      const needle = String(path).toLowerCase().trim();
      const hit =
        files.find((p) => relative(dir, p).replace(/\\/g, "/").toLowerCase() === needle) ??
        files.find((p) => basename(p).toLowerCase() === needle) ??
        files.find((p) => basename(p).toLowerCase().replace(/\.md$/, "") === needle) ??
        files.find((p) => p.toLowerCase().endsWith(`${needle}.md`)) ??
        files.find((p) => p.toLowerCase().includes(needle));
      if (!hit) {
        const nearest = nearestTitles(dir, needle, 5);
        const lines = [`пост не найден: ${path}`, ""];
        if (nearest.length) {
          lines.push("ближайшие похожие названия:");
          lines.push(...nearest.map((item) => `  • ${item.rel} — ${item.title}`));
        } else {
          lines.push("в вики вообще нет постов");
        }
        lines.push("");
        lines.push("что дальше: передай точный путь из подсказки выше или найди пост через wiki_find.");
        return lines.join("\n");
      }
      const item = meta(dir, hit);
      const fresh = freshness(dir);
      const ctx = context(target, dir, fresh, fresh.db ? "db" : "files");
      return `${contextHead(ctx)}\n\n== ${item.rel} · ${item.title}\n\n${item.text}`;
    },
  },

  wiki_index: {
    description:
      "Пересобрать каталог index.md вики из frontmatter постов (закрывает долг «постов больше, чем строк в индексе»). " +
      "Файл перезаписывается целиком: порядок — по дате, свежие сверху; ведущий frontmatter index.md сохраняется, " +
      "в log.md дописывается строка. Каталог не изменился — файл и log.md не трогаются (повторный вызов не плодит дубли).",
    inputSchema: {
      type: "object",
      properties: { wiki: { type: "string", description: "имя вики (по умолчанию дефолтная)" } },
      additionalProperties: false,
    },
    run: ({ wiki }) => {
      const target = findWiki(wiki);
      const dir = wikiDir(target);
      if (!existsSync(dir)) throw new Error(`каталог вики не найден: ${target.path} — проверь wikis.json`);
      const articles = articleFiles(dir).map((path) => meta(dir, path));
      articles.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.rel.localeCompare(b.rel));
      const indexPath = join(dir, "index.md");
      const previous = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
      const previousRows = (previous.match(/^\|\s*\[/gm) ?? []).length;
      const head = previous.startsWith("---") ? `${previous.slice(0, previous.indexOf("\n---", 3) + 4)}\n` : "";
      const lines = [
        `${head}# Index — каталог Wiki`,
        "",
        `Последнее обновление: ${today()}`,
        "",
        "| Пост | Тема | Теги | Дата | Папка |",
        "|------|------|------|------|-------|",
      ];
      for (const item of articles) {
        lines.push(`| [${tableCell(item.title)}](${item.rel}) | ${tableCell(item.description) || "(no description)"} | ${tableCell(item.tags.join(", "))} | ${item.date || "?"} | ${item.topic}/ |`);
      }
      lines.push("");
      // Не изменилось — не пишем и не сорим в log.md: строка значит «каталог пересобран», а не «тул позвали».
      const next = lines.join("\n");
      if (next === previous) {
        return `index.md уже актуален: ${articles.length} записей (строк в файле ${previousRows}) — файл и log.md не тронуты\nвика: ${target.name} (${target.path})`;
      }
      writeFileSync(indexPath, next);
      const logPath = join(dir, "log.md");
      if (!existsSync(logPath)) writeFileSync(logPath, "# Log — журнал изменений Wiki\n\nФормат: `YYYY-MM-DD HH:MM — действие — файл(ы) — что сделано`\n");
      appendFileSync(logPath, `- ${nowStamp()} — index — index.md — каталог пересобран из frontmatter (${articles.length} постов)\n`);
      return `index.md пересобран: ${articles.length} записей (было ${previousRows}) · в log.md дописана строка index\nвика: ${target.name} (${target.path})`;
    },
  },

  wiki_add_post: {
    description:
      "Добавить пост в вики по конвенциям: файл тема/слаг.md с frontmatter, строка в index.md, запись в log.md, пересборка базы. " +
      "Проверяет теги (нижний регистр, без пробелов), type по списку и похожий ЗАГОЛОВОК — о дубле предупреждает.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "заголовок поста" },
        description: { type: "string", description: "одно предложение — о чём пост" },
        tags: { type: "string", description: "теги через запятую: первый — категория (ai|coding|tools|...)" },
        body: { type: "string", description: "текст поста (как есть)" },
        topic: { type: "string", description: "тематическая папка (по умолчанию tools)" },
        slug: { type: "string", description: "имя файла без .md (по умолчанию из заголовка)" },
        source: { type: "string", description: "ссылка на первоисточник" },
        wiki: { type: "string", description: "имя вики (по умолчанию дефолтная)" },
        type: { type: "string", enum: TYPES, description: "тип концепта" },
        duplicate_ok: { type: "boolean", description: "писать, даже если заголовок совпал с существующим постом" },
      },
      required: ["title", "description", "tags", "body"],
      additionalProperties: false,
    },
    run: ({ title, description, tags, body, topic, slug, source, wiki, type, duplicate_ok }) => {
      const target = findWiki(wiki);
      const dir = wikiDir(target);
      if (!existsSync(dir)) throw new Error(`каталог вики не найден: ${target.path} — проверь wikis.json`);

      const problems = [];
      let postType = "Post";
      if (type !== undefined && type !== null && String(type).trim()) {
        postType = String(type).trim();
        const known = TYPES.find((t) => t.toLowerCase() === postType.toLowerCase());
        if (!known) throw new Error(`type «${postType}» не из списка: ${TYPES.join(" | ")} — повтори вызов с одним из них`);
        postType = known;
      }

      const rawTags = String(tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const tagList = [...new Set(rawTags.map((t) => t.toLowerCase().replace(/\s+/g, "-")))];
      if (!tagList.length) throw new Error("нужен хотя бы один тег: первый — категория (ai|coding|tools|...), дальше 2–5 предметных");
      const changed = rawTags.filter((t, i) => t !== tagList[i]);
      if (changed.length) problems.push(`теги приведены к таксономии: ${changed.map((t) => `«${t}»→«${t.toLowerCase().replace(/\s+/g, "-")}»`).join(", ")}`);

      const folder = String(topic ?? "tools");
      if (!folder.trim() || folder.includes("\0") || isAbsolute(folder) || folder.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
        throw new Error("topic: запрещён абсолютный путь, пустые сегменты и . или ..");
      }
      const fileSlug = slugify(slug ?? title);
      if (!fileSlug) throw new Error("из заголовка не получился слаг — передай slug явно (латиница, цифры, дефисы)");
      const rel = `${folder}/${fileSlug}.md`;
      const path = confinedPath(dir, rel);
      if (existsSync(path)) {
        throw new Error(`пост уже есть: ${rel} — обнови существующий файл, а не создавай дубль (wiki_read «${fileSlug}»)`);
      }

      const normalize = (value) => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const wanted = normalize(title);
      let exact = null;
      let close = null;
      for (const file of articleFiles(dir)) {
        const item = meta(dir, file);
        const other = normalize(item.title);
        if (!wanted || !other) continue;
        if (other === wanted) {
          exact = item;
          break;
        }
        const ratio = 1 - editDistance(wanted, other) / Math.max(wanted.length, other.length);
        if (ratio >= 0.72 && (!close || ratio > close.ratio)) close = { rel: item.rel, title: item.title, ratio };
      }
      const warning = exact
        ? `похоже на дубль: «${exact.title}» [${exact.rel}] — заголовок совпадает`
        : close
          ? `возможный дубль: «${close.title}» [${close.rel}] (совпадение ${Math.round(close.ratio * 100)}%)`
          : null;
      if (warning && !duplicate_ok) {
        return [
          `не стал писать: ${warning}.`,
          `если это тот же пост — обогати существующий (wiki_read «${exact ? exact.rel : close.rel}»), новый файл не нужен;`,
          "если это правда другой пост — повтори вызов с duplicate_ok: true.",
        ].join("\n");
      }
      if (warning) problems.push(warning);

      mkdirSync(dirname(path), { recursive: true });
      const front = [
        "---",
        `type: ${postType}`,
        `title: ${yamlScalar(collapse(title))}`,
        `description: ${yamlScalar(collapse(description))}`,
        `date: ${today()}`,
        `tags: [${tagList.join(", ")}]`,
        ...(source ? [`source: ${yamlScalar(String(source).trim())}`] : []),
        "generated:",
        "  by: wiki-station/mcp",
        `  at: ${new Date().toISOString().slice(0, 19)}Z`,
        "---",
        "",
        `# ${title}`,
        "",
        String(body).trim(),
        "",
      ].join("\n");
      writeFileSync(path, front);

      const indexPath = join(dir, "index.md");
      const row = `| [${tableCell(title)}](${rel}) | ${tableCell(description)} | ${tableCell(tagList.join(", "))} | ${today()} | ${folder}/ |\n`;
      if (existsSync(indexPath)) writeFileSync(indexPath, `${readFileSync(indexPath, "utf8").replace(/\n*$/, "\n")}${row}`);
      else writeFileSync(indexPath, `# Index — каталог Wiki\n\n| Пост | Тема | Теги | Дата | Папка |\n|------|------|------|------|-------|\n${row}`);
      const logPath = join(dir, "log.md");
      if (!existsSync(logPath)) writeFileSync(logPath, "# Log — журнал изменений Wiki\n\nФормат: `YYYY-MM-DD HH:MM — действие — файл(ы) — что сделано`\n");
      appendFileSync(logPath, `- ${nowStamp()} — add — ${rel} — добавлено через MCP\n`);

      const buildTool = join(dir, "db-tools", "build.py");
      let built = "база не пересобрана (нет db-tools/build.py — потом: wiki_build)";
      if (existsSync(buildTool) && pythonReady()) {
        const res = spawnSync("python3", [buildTool, "-r", dir, "-o", join(dir, "db", "wiki.db")], { encoding: "utf8" });
        built = res.status === 0 ? `база пересобрана: ${collapse((res.stdout ?? "").trim().split("\n").pop())}` : "база не пересобрана (сборка упала — проверь wiki_build)";
      }
      const lines = [`добавлено: ${rel}`, `вика: ${target.name} (${target.path})`, "index.md и log.md обновлены", built];
      lines.push(...problems.map((problem) => `• ${problem}`));
      return lines.join("\n");
    },
  },

  wiki_list: {
    description: "Список вики: путь, посты по темам, состояние индекса и поисковой базы (дефолтная помечена).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => {
      const wikis = readWikis();
      if (!wikis.length) throw new Error(`в ${basename(WIKIS_FILE)} нет ни одной вики — заведи: wiki-station new "Wiki Название"`);
      const lines = [];
      for (const [index, wiki] of wikis.entries()) {
        const dir = wikiDir(wiki);
        const marker = index === 0 ? " (дефолт)" : "";
        if (!existsSync(dir)) {
          lines.push(`${wiki.name}${marker}: НЕТ КАТАЛОГА ${wiki.path}`);
          continue;
        }
        const files = articleFiles(dir);
        const topics = [...new Set(files.map((f) => relative(dir, f).split("/")[0]))];
        const fresh = freshness(dir);
        lines.push(
          `${wiki.name}${marker} (${wiki.path}, создана ${wiki.created ?? "?"}): постов ${files.length} в темах ${topics.join(", ") || "—"}` +
            `; база ${fresh.db ? `собрана ${stamp(fresh.db.mtimeMs)}${fresh.stale ? ", УСТАРЕЛА (wiki_build)" : ""}` : "не собрана (wiki_build)"}`
        );
      }
      return lines.join("\n");
    },
  },

  wiki_log: {
    description: "Хвост журнала вики (log.md) — что и когда добавлялось.",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string", description: "имя вики" },
        lines: { type: "number", description: "сколько строк (по умолчанию 20)" },
      },
      additionalProperties: false,
    },
    run: ({ wiki, lines }) => {
      const dir = wikiDir(findWiki(wiki));
      const path = join(dir, "log.md");
      if (!existsSync(path)) throw new Error("нет log.md — вика заведена не по конвенции: wiki-station new \"Wiki Название\"");
      return readFileSync(path, "utf8").split("\n").slice(-(lines ?? 20)).join("\n");
    },
  },

  wiki_lint: {
    description: "Проверка вики: обязательные поля frontmatter, таксономия тегов, расхождения с index.md.",
    inputSchema: {
      type: "object",
      properties: { wiki: { type: "string", description: "имя вики" } },
      additionalProperties: false,
    },
    run: ({ wiki }) => {
      const dir = wikiDir(findWiki(wiki));
      const files = articleFiles(dir);
      const problems = [];
      const required = ["type", "title", "description", "date", "tags"];
      for (const file of files) {
        const item = meta(dir, file);
        const fm = parseFrontmatter(item.text);
        const missing = required.filter((field) => fm[field] === undefined || (Array.isArray(fm[field]) ? !fm[field].length : !String(fm[field]).trim()));
        if (missing.length) problems.push(`${item.rel}: нет обязательных полей: ${missing.join(", ")}`);
        const bad = item.tags.filter((tag) => tag !== tag.toLowerCase() || /\s/.test(tag));
        if (bad.length) problems.push(`${item.rel}: теги не по таксономии: ${bad.join(", ")}`);
      }
      const targets = indexTargets(dir);
      for (const file of files) {
        const rel = relative(dir, file).replace(/\\/g, "/");
        if (!targets.has(rel)) problems.push(`${rel}: нет строки в index.md`);
      }
      return problems.length ? `замечаний: ${problems.length}\n${problems.join("\n")}` : `постов ${files.length}: lint чистый`;
    },
  },

  wiki_build: {
    description: "Пересобрать поисковую базу вики (SQLite FTS5) — после добавления постов.",
    inputSchema: {
      type: "object",
      properties: { wiki: { type: "string", description: "имя вики" } },
      additionalProperties: false,
    },
    run: ({ wiki }) => {
      const target = findWiki(wiki);
      const dir = wikiDir(target);
      const tool = join(dir, "db-tools", "build.py");
      if (!existsSync(tool)) throw new Error("у этой вики нет db-tools/build.py — базу собрать нечем");
      if (!pythonReady()) throw new Error("нет рабочего python3 — базу собрать нечем");
      const res = spawnSync("python3", [tool, "-r", dir, "-o", join(dir, "db", "wiki.db")], { encoding: "utf8" });
      if (res.status !== 0) throw new Error(`сборка базы упала: ${collapse((res.stderr || res.stdout || "").trim()) || `код ${res.status}`}`);
      appendFileSync(join(dir, "log.md"), `- ${nowStamp()} — build — db/wiki.db — пересобрано из MCP\n`);
      return `${(res.stdout ?? "").trim()}\nвика: ${target.name}`;
    },
  },
};

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function pickQueries({ query, queries }) {
  const list = Array.isArray(queries) ? queries.map((item) => String(item).trim()).filter(Boolean) : [];
  if (!list.length && query !== undefined && query !== null && String(query).trim()) list.push(String(query).trim());
  if (!list.length) throw new Error("нужен query (строка) или queries (массив строк) — что именно искать");
  return [...new Set(list)];
}

// --- MCP по stdio: initialize → tools/list → tools/call ---

let buffer = "";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message) {
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "wiki-station", version: "2.0" },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") {
      reply(id, {});
      return;
    }
    if (method === "tools/list") {
      reply(id, {
        tools: Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })),
      });
      return;
    }
    if (method === "tools/call") {
      const tool = tools[params?.name];
      if (!tool) {
        fail(id, -32602, `нет такого инструмента: ${params?.name}`);
        return;
      }
      const text = tool.run(params?.arguments ?? {});
      reply(id, { content: [{ type: "text", text: String(text) }] });
      return;
    }
    if (id !== undefined) fail(id, -32601, `метод не поддержан: ${method}`);
  } catch (error) {
    if (id === undefined) return;
    reply(id, { content: [{ type: "text", text: `ошибка: ${error.message}` }], isError: true });
  }
}
