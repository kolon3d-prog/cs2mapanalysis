// Движок поиска по УСТАНОВЛЕННЫМ скиллам: слои клиентов + коллекция станции.
//
// Ни БД, ни сети: на входе SKILL.md, на выходе структура. Один движок на всех потребителей —
// CLI станции (bin/skills-station.mjs) и MCP хаба (skills-hub/mcp/server.mjs) — чтобы агент
// в живой сессии видел ровно то же, что и оператор в терминале.
//
// Скиллы кладут описание блоком (`description: >-` или `description: |`) — без разбора блока
// поиск по описанию слепой у половины коллекции, поэтому frontmatter разбирается по-настоящему.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Сколько уровней вниз смотрим в слое: скилл — это каталог с SKILL.md, внутрь скилла не заходим. */
export const MAX_DEPTH = 3;

/**
 * Раскладка слоёв. Порядок = приоритет: если один и тот же скилл виден в двух слоях (например,
 * ссылкой из global в collection), в выдаче остаётся тот слой, где его видит агент.
 * @param {{home?: string, cwd?: string, collection?: string, configHome?: string}} env
 */
export function layerRoots(env = {}) {
  const home = env.home ?? homedir();
  const cwd = env.cwd ?? process.cwd();
  const configHome = env.configHome ?? join(home, ".config");
  return [
    { layer: "project", dir: join(cwd, ".agents/skills") },
    { layer: "global", dir: join(home, ".agents/skills") },
    { layer: "opencode", dir: join(configHome, "opencode/skills") },
    { layer: "claude", dir: join(home, ".claude/skills") },
    { layer: "collection", dir: env.collection },
  ].filter((row) => typeof row.dir === "string" && row.dir !== "");
}

const STOPWORDS = new Set([
  // русские
  "а", "без", "бы", "был", "была", "были", "быть", "в", "вам", "вас", "весь", "во", "вот", "все",
  "всё", "вы", "где", "да", "для", "до", "его", "ее", "её", "если", "есть", "еще", "ещё", "же",
  "за", "и", "из", "или", "им", "их", "к", "как", "ко", "когда", "кто", "ли", "мне", "мой", "моя",
  "мы", "на", "над", "надо", "наш", "не", "него", "нее", "нет", "ни", "них", "но",
  "ну", "о", "об", "он", "она", "они", "оно", "от", "по", "под", "при", "про", "с", "сам", "свой",
  "себе", "так", "там", "те", "тем", "то", "того", "тоже", "тот", "ты", "у", "уж", "уже", "хоть",
  "чего", "чей", "чем", "что", "чтобы", "чья", "эти", "это", "этот", "эту", "я", "могу", "можно",
  "нужно", "хочу", "сделать", "делать", "использовать",
  // английские
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from",
  "how", "i", "in", "into", "is", "it", "its", "me", "my", "need", "of", "on", "or", "our", "out",
  "should", "so", "that", "the", "their", "then", "there", "these", "this", "to", "up", "use",
  "used", "using", "was", "we", "what", "when", "where", "which", "who", "why", "will", "with",
  "you", "your",
]);

/**
 * Лёгкое усечение русских окончаний: не морфология, а грубая зачистка хвоста, чтобы
 * «браузер», «браузеры» и «браузерная» сошлись в один токен. Английские слова не трогаем.
 */
const RU_ENDINGS = [
  "иями", "ями", "ами", "ией", "иях", "иям", "ием", "иях", "ыми", "ими", "ого", "его", "ому",
  "ему", "ых", "их", "ая", "яя", "ое", "ее", "ые", "ие", "ой", "ей", "ий", "ый", "ую", "юю",
  "ам", "ям", "ах", "ях", "ов", "ев", "ём", "ем", "ом", "ью", "ия", "ие", "ий", "ла", "ло",
  "ли", "ть", "ет", "ут", "ют", "ит", "ат", "ят", "ны", "на", "но", "ся", "сь", "ть",
  "ы", "и", "а", "я", "о", "е", "у", "ю", "ь", "й",
];

/** Слово из кириллицы? Хвосты усекаем только у таких. */
function isCyrillic(token) {
  return /[\u0400-\u04FF]/.test(token);
}

/** Стем слова: токен уже нормализован (нижний регистр, буквы-цифры). */
function stem(token) {
  if (!isCyrillic(token)) return token;
  let word = token.replace(/ё/g, "е");
  for (const ending of RU_ENDINGS) {
    // оставляем минимум 4 буквы корня: «скиллы» → «скилл», но «сеть» не превращаем в «с»
    if (word.length - ending.length >= 4 && word.endsWith(ending)) {
      word = word.slice(0, word.length - ending.length);
      break;
    }
  }
  return word;
}

/**
 * Русский запрос против английского описания — не синонимами, а короткой таблицей
 * соответствий по частоте в этой коллекции. Ключи — уже усечённые стемы.
 */
const ALIASES = {
  браузер: ["browser", "chromium"],
  браузерн: ["browser"],
  дебаж: ["debug", "debugging"],
  отладк: ["debug", "debugging"],
  зависш: ["hang", "hanging", "stuck", "freeze"],
  виснет: ["hang", "stuck"],
  процесс: ["process", "pid", "daemon"],
  поиск: ["search", "find"],
  искать: ["search", "find"],
  найти: ["search", "find"],
  тест: ["test", "testing", "bats"],
  тестирова: ["test", "testing"],
  доку: ["doc", "docs", "documentation"],
  доки: ["doc", "docs", "documentation"],
  докум: ["doc", "docs", "documentation"],
  скилл: ["skill", "skills"],
  ошибк: ["error", "fail", "failure"],
  падает: ["crash", "fail", "failure"],
  лог: ["log", "logs"],
  парол: ["password", "secret", "vault"],
  секрет: ["secret", "vault", "password"],
  плагин: ["plugin", "extension"],
  установк: ["install", "setup"],
  сет: ["net", "network", "proxy"],
  страниц: ["page", "site", "web"],
  сайт: ["site", "web", "page"],
  сайтов: ["site", "web"],
  скриншот: ["screenshot", "screenshots"],
  вёрстк: ["css", "layout", "frontend"],
  верстк: ["css", "layout", "frontend"],
  дизайн: ["design", "ui", "css"],
  память: ["memory", "notes"],
  заметк: ["note", "notes", "memory"],
  вики: ["wiki"],
  доклад: ["report", "research"],
  исследован: ["research", "explore"],
  ресерч: ["research", "explore"],
  автомат: ["automation", "automate"],
};

/** Нормализация текста в токены: нижний регистр, ё→е, всё не-буквенное — разделитель. */
export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

/** Строки-токены (для поиска совпадения в теле). */
function tokenSet(text) {
  return new Set(tokenize(text));
}

/** Свёртка блока `>` в одну строку: пустая строка = абзац, остальные тянутся через пробел. */
function foldLines(rows) {
  let out = "";
  for (const row of rows) {
    if (row.trim() === "") {
      out = `${out.replace(/ +$/, "")}\n`;
      continue;
    }
    if (out === "") out = row.trim();
    else out += `${out.endsWith("\n") ? "" : " "}${row.trim()}`;
  }
  return out.trim();
}

/**
 * Разбор frontmatter. Понимает блочные `description: >-` и `description: |` с отступом
 * (в коллекции таких скиллов больше двадцати — на них старый построчный regex печатал `>-`),
 * кавычки и перенос обычного значения на следующие строки.
 * @returns {{fields: Map<string,string>, body: string, raw: string}}
 */
export function parseFrontmatter(text) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  const fields = new Map();
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) return { fields, body: source, raw: "" };

  const body = source.slice(match[0].length);
  const lines = match[1].split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s/.test(line) || line.startsWith("#")) continue;
    const entry = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1];
    let value = entry[2].trim();

    if (/^[|>][+\-0-9]*$/.test(value)) {
      const literal = value.startsWith("|");
      const collected = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim() === "") {
          collected.push("");
          continue;
        }
        if (!/^\s/.test(next)) break;
        collected.push(next);
      }
      i = j - 1;
      const indents = collected.filter((row) => row.trim() !== "").map((row) => row.match(/^\s*/)[0].length);
      const indent = indents.length ? Math.min(...indents) : 0;
      const dedented = collected.map((row) => (row.trim() === "" ? "" : row.slice(indent)));
      while (dedented.length && dedented[dedented.length - 1] === "") dedented.pop();
      value = literal ? dedented.join("\n") : foldLines(dedented);
      fields.set(key, value);
      continue;
    }

    // обычное значение продолжается на более отступленных строках
    if (value !== "") {
      const continuation = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim() === "" || !/^\s/.test(next)) break;
        continuation.push(next.trim());
      }
      if (continuation.length) {
        value = [value, ...continuation].join(" ");
        i = j - 1;
      }
    }

    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    fields.set(key, value);
  }

  return { fields, body, raw: match[1] };
}

/** Первая строка описания в одну строку — для колонок и подсказок. */
export function firstLine(description, width = 0) {
  const line = String(description ?? "").split("\n").find((row) => row.trim() !== "") ?? "";
  const clean = line.trim().replace(/\s+/g, " ");
  return width > 0 && clean.length > width ? `${clean.slice(0, width - 1)}…` : clean;
}

/**
 * Скилл из файла: имя и описание из frontmatter (имя — с фолбэком на каталог).
 * @returns {{name: string, description: string, body: string, path: string, layer: string}}
 */
export function parseSkill(text, path, layer, fallbackName = "") {
  const { fields, body } = parseFrontmatter(text);
  return {
    name: (fields.get("name") || fallbackName || basename(dirname(path))).trim(),
    description: (fields.get("description") || "").trim(),
    body,
    path,
    layer,
  };
}

function listSkillDirs(dir, depth = MAX_DEPTH) {
  const found = [];
  if (depth <= 0 || !existsSync(dir)) return found;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue; // битая ссылка — не скилл
    }
    if (!isDir) continue;
    if (existsSync(join(path, "SKILL.md"))) {
      found.push(path);
      continue; // скиллы не вкладываются друг в друга
    }
    found.push(...listSkillDirs(path, depth - 1));
  }
  return found;
}

/**
 * Все скиллы из слоёв. Дубли схлопываются дважды: по реальному файлу (в global скилл лежит
 * ссылкой в collection — это один и тот же скилл) и по имени (инсталляция в слое клиента и
 * копия в коллекции — один скилл для агента). Остаётся слой, что выше по LAYER_ORDER.
 * @param {{home?: string, cwd?: string, collection?: string, configHome?: string}} env
 */
export function collectSkills(env = {}) {
  const skills = [];
  const seenFiles = new Set();
  const seenNames = new Set();
  for (const { layer, dir } of layerRoots(env)) {
    for (const path of listSkillDirs(dir)) {
      const file = join(path, "SKILL.md");
      let key;
      try {
        key = realpathSync(file);
      } catch {
        key = file;
      }
      if (seenFiles.has(key)) continue;
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const skill = parseSkill(text, file, layer, basename(path));
      const nameKey = skill.name.toLowerCase();
      if (seenNames.has(nameKey)) continue;
      seenFiles.add(key);
      seenNames.add(nameKey);
      skill.nameTokens = tokenSet(skill.name.replace(/[-_]/g, " "));
      skill.descriptionTokens = tokenSet(skill.description);
      skill.bodyTokens = tokenSet(skill.body);
      skills.push(skill);
    }
  }
  return skills;
}

/** Совпадение одного токена с набором: точное, иначе префиксное (со 3 букв — «camo» → «camoufox»). */
function tokenStrength(tokens, token) {
  let best = 0;
  for (const candidate of tokens) {
    if (candidate === token) return 1;
    if (candidate.length >= 3 && token.length >= 3 && (candidate.startsWith(token) || token.startsWith(candidate))) {
      best = Math.max(best, 0.7);
    }
  }
  return best;
}

/** Запрос с алиасами: русский токен может сойтись с английским описанием.
 *  Токен приходит уже усечённым, а ключ алиасов — короче («дебажить» → «дебажи», ключ «дебаж»),
 *  поэтому сверяем по началу слова, а не только целиком. */
function aliasesOf(token) {
  const direct = ALIASES[token];
  if (direct) return direct;
  const out = [];
  for (const [key, values] of Object.entries(ALIASES)) {
    if (token.startsWith(key) || key.startsWith(token)) out.push(...values);
  }
  return out;
}

/** Опечатка в слове («camofox» вместо «camoufox»): только имена и описания, тело — по префиксу. */
function fuzzyStrength(tokens, token) {
  if (token.length < 5) return 0;
  for (const candidate of tokens) {
    if (candidate.length < 5 || Math.abs(candidate.length - token.length) > 2) continue;
    const budget = Math.max(candidate.length, token.length) >= 8 ? 2 : 1;
    if (distance(candidate, token) <= budget) return 0.8;
  }
  return 0;
}

/**
 * Сила совпадения токена с набором: точное, префиксное (со 3 букв: «camo» → «camoufox»)
 * и, для имени с описанием, близкое по опечатке.
 */
function bestStrength(tokens, token, fuzzy = false) {
  let strength = tokenStrength(tokens, token);
  if (strength === 0 && fuzzy) strength = fuzzyStrength(tokens, token);
  if (strength === 1) return 1;
  for (const variant of aliasesOf(token)) {
    const alias = stem(variant);
    strength = Math.max(strength, tokenStrength(tokens, alias) * 0.9, fuzzy ? fuzzyStrength(tokens, alias) * 0.8 : 0);
  }
  return strength;
}

function countHits(tokens, token) {
  let hits = 0;
  for (const candidate of tokens) {
    if (candidate === token || (candidate.length >= 3 && token.length >= 3 && candidate.startsWith(token))) hits += 1;
  }
  return hits;
}

function scoreSkill(skill, tokens) {
  let score = 0;
  let matched = 0;
  // совпадение в теле большого справочника весит меньше, чем в коротком скилле:
  // у «reverse-engineering» таких токенов как process/debug на весь документ
  const sizePenalty = 1 / Math.sqrt(1 + skill.bodyTokens.size / 400);
  for (const token of tokens) {
    const nameHit = bestStrength(skill.nameTokens, token, true);
    const descriptionHit = bestStrength(skill.descriptionTokens, token, true);
    const bodyHit = bestStrength(skill.bodyTokens, token);
    if (nameHit === 0 && descriptionHit === 0 && bodyHit === 0) continue;
    matched += 1;
    score += nameHit * 6;
    score += descriptionHit * 4;
    if (bodyHit > 0) score += bodyHit * (1 + Math.min(countHits(skill.bodyTokens, token), 4) * 0.25) * sizePenalty;
  }
  // все слова разом — это заметно сильнее совпадения по одному слову
  if (matched > 0 && matched === tokens.length) score *= 1.4;
  if (matched > 0) {
    const flattened = tokens.join(" ");
    const name = skill.name.toLowerCase().replace(/[-_]/g, " ");
    if (name === flattened || skill.name.toLowerCase() === flattened) score += 20;
  }
  return { score: Math.round(score * 10) / 10, matched };
}

/** Кусок тела, где встретился запрос: строка с совпадением, иначе начало тела. */
export function snippetOf(skill, tokens, width = 160) {
  const lines = String(skill.body ?? "").split("\n");
  const hit = lines.find((line) => {
    const lineTokens = tokenize(line);
    return tokens.some((token) => lineTokens.some((candidate) => candidate === token || (candidate.length >= 3 && token.length >= 3 && candidate.startsWith(token))));
  });
  const raw = (hit ?? lines.find((line) => line.trim() !== "") ?? firstLine(skill.description)).trim().replace(/\s+/g, " ");
  return raw.length > width ? `${raw.slice(0, width - 1)}…` : raw;
}

/** Расстояние Левенштейна — для подсказок по похожим именам. */
function distance(a, b) {
  const left = [...a];
  const right = [...b];
  // нулевая строка — цена вставки всех символов right; в строке right.length + 1 клетка
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      current.push(Math.min(previous[j + 1] + 1, current[j] + 1, previous[j] + (left[i] === right[j] ? 0 : 1)));
    }
    previous = current;
  }
  return previous[right.length];
}

/** Ближайшие имена: опечатка («camo» → camoufox-*), обрывок, часть имени. Если в бюджет
 *  правок ничего не влезло (совсем чужой запрос) — всё равно отдаём самые близкие: пустой
 *  выдачи без подсказок не бывает. */
export function suggestNames(skills, query, limit = 5) {
  const needle = tokenize(query).sort((a, b) => b.length - a.length)[0] ?? String(query ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (needle === "") return [];
  const scored = [];
  const rest = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    if (name.includes(needle)) {
      scored.push({ skill, rank: 0, distance: name.length - needle.length });
      continue;
    }
    let best = Infinity;
    for (const part of name.split(/[-_.]/)) best = Math.min(best, distance(part, needle));
    const budget = Math.max(2, Math.ceil(needle.length / 3));
    if (best <= budget) scored.push({ skill, rank: 1, distance: best });
    else rest.push({ skill, rank: 2, distance: Math.min(best, distance(name, needle)) });
  }
  if (scored.length === 0) scored.push(...rest);
  scored.sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.skill.name.localeCompare(b.skill.name));
  return scored.slice(0, limit).map(({ skill }) => ({ name: skill.name, layer: skill.layer }));
}

/**
 * Поиск по имени, описанию и телу. Многотокенный запрос: сначала И (все слова), потом ИЛИ —
 * совпадения по всем словам разом получают надбавку и встают выше совпадений по отдельным словам.
 * Пустой результат не оставляем пустым: рядом идут ближайшие похожие имена.
 * @returns {{query: string, mode: string, total: number, results: Array, suggestions: Array}}
 */
export function searchSkills(skills, query, limit = 10) {
  const raw = String(query ?? "").trim();
  const total = skills.length;
  const tokens = tokenize(raw).filter((token, index, all) => all.indexOf(token) === index);
  const byName = [...skills].sort((a, b) => a.name.localeCompare(b.name));

  const shape = (skill, score) => ({
    name: skill.name,
    layer: skill.layer,
    path: skill.path,
    description: skill.description,
    score,
    snippet: snippetOf(skill, tokens),
  });

  if (raw === "" || tokens.length === 0) {
    return {
      query: raw,
      mode: "all",
      total,
      results: byName.slice(0, limit).map((skill) => shape(skill, 0)),
      suggestions: [],
    };
  }

  const scored = skills
    .map((skill) => ({ skill, ...scoreSkill(skill, tokens) }))
    .filter((row) => row.matched > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  const strict = scored.filter((row) => row.matched === tokens.length);
  const chosen = scored;
  // «сначала И, потом ИЛИ»: слова разом уходят вверх счётчиком, отдельные слова — следом
  const mode = strict.length === 0 ? "or" : strict.length === scored.length ? "and" : "mixed";

  if (chosen.length === 0) {
    return { query: raw, mode: "none", total, results: [], suggestions: suggestNames(skills, raw) };
  }
  return {
    query: raw,
    mode,
    total,
    results: chosen.slice(0, limit).map((row) => shape(row.skill, row.score)),
    suggestions: [],
  };
}

/** Найти скилл по имени: точное, потом однозначная часть имени, иначе — подсказки. */
export function findSkill(skills, name) {
  const needle = String(name ?? "").trim().toLowerCase();
  const exact = skills.find((skill) => skill.name.toLowerCase() === needle);
  if (exact) return { skill: exact };
  const partial = skills.filter((skill) => skill.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { skill: partial[0] };
  if (partial.length > 1) {
    return { suggestions: partial.slice(0, 8).map((skill) => ({ name: skill.name, layer: skill.layer })) };
  }
  return { suggestions: suggestNames(skills, name) };
}

/** Первые строки тела для `show` — тем же движком, что и поиск. */
export function bodyHead(skill, lines = 40) {
  const body = String(skill.body ?? "").replace(/^\n+/, "").split("\n");
  return body.slice(0, lines).join("\n").trimEnd();
}
