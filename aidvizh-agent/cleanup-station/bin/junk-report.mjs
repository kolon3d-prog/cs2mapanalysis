#!/usr/bin/env node
// junk-report — отчёт по мусору на диске данных: что занимает место, что можно снести
// безопасно, и нет ли «артефактов рядом с данными» (самая частая причина свалки:
// инструмент пишет отчёт рядом с собой, а не в рантайм-каталог).
//
// Почему это отдельный движок, а не часть cleanup.mjs: cleanup сносит агентов/скиллы,
// а здесь ТОЛЬКО чтение — ни одного удаления (правило станции: сначала смотрим, потом решаем).
//
// Запуск:
//   node bin/junk-report.mjs [диск] [--json] [--strict] [--all] [--top N]
//   --all    считать и внутри .venv/.git (по умолчанию пропускаем — это не мусор)
//   --strict ненулевой код возврата, если что-то найдено (для крона/CI)
//
// Кросс-платформенно: только stdlib Node, пути через join, никаких шеллов.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const DISK = resolve(process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2] : resolve(ROOT, ".."));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const FLAGS = {
  json: has("--json"),
  strict: has("--strict"),
  all: has("--all"),
};
const TOP = (() => {
  const i = argv.indexOf("--top");
  return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 10) : 10;
})();

// Классы мусора: regeneratable-кэши, сборка, дампы/свалки.
const JUNK_DIRS = [
  "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".cache",
  "node_modules", "dist", "build", ".parcel-cache", ".turbo",
];
const DUMP_NAMES = ["_dump", "dump", "dumps", "tmp", "temp", "trash", "junk", "scratch"];
const JUNK_FILE_EXT = [".pyc", ".pyo", ".tmp", ".temp", ".log", ".dump", ".orig", ".rej"];

const SKIP = new Set([".git", ".venv", "venv", ".hg", ".svn"]);
const ARTIFACT_EXT = [".json", ".log", ".csv", ".ndjson", ".dump", ".xlsx"];

function walk(dir, out, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;                       // нет прав/исчез — молча пропускаем
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) && !FLAGS.all) continue;
      out.push({ path: p, kind: "dir", name: e.name });
      if (depth < 8) walk(p, out, depth + 1);   // глубже не лезем: не плодим листинг
    } else if (e.isFile()) {
      out.push({ path: p, kind: "file", name: e.name });
    }
  }
}

function sizeOf(path) {
  try {
    const st = statSync(path);
    if (st.isFile()) return st.size;
    let total = 0;
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, e.name);
      total += e.isDirectory() ? sizeOf(p) : (statSync(p).size || 0);
    }
    return total;
  } catch {
    return 0;
  }
}

const mb = (bytes) => Number((bytes / 1048576).toFixed(1));

function main() {
  if (!existsSync(DISK)) {
    process.stderr.write(`junk-report: нет каталога ${DISK}\n`);
    process.exit(2);
  }
  const nodes = [];
  for (const e of readdirSync(DISK, { withFileTypes: true })) {
    nodes.push({ path: join(DISK, e.name), kind: e.isDirectory() ? "dir" : "file", name: e.name });
  }

  const dirsOfInterest = [];
  for (const n of nodes) {
    if (n.kind !== "dir") continue;
    if (SKIP.has(n.name) && !FLAGS.all) {
      dirsOfInterest.push({ ...n, size: sizeOf(n.path) });
      continue;
    }
    const inner = [];
    walk(n.path, inner);
    dirsOfInterest.push({ ...n, size: sizeOf(n.path), inner });
  }

  const found = { caches: [], dumps: [], looseArtifacts: [], innerJunk: [] };

  for (const d of dirsOfInterest) {
    const base = d.name.toLowerCase();
    if (DUMP_NAMES.includes(base) || /^_(dump|tmp|trash)$/i.test(d.name)) {
      found.dumps.push({ path: d.path, size: d.size });
    }
    // «артефакты рядом с данными»: JSON/лог прямо в корне диска (не в каталоге-станции)
    if (d.kind === "file") continue;
  }
  for (const n of nodes) {
    if (n.kind === "file" && ARTIFACT_EXT.some((x) => n.name.toLowerCase().endsWith(x))) {
      found.looseArtifacts.push({ path: n.path, size: sizeOf(n.path) });
    }
  }
  for (const d of dirsOfInterest) {
    if (!d.inner) continue;
    for (const item of d.inner) {
      const lower = item.name.toLowerCase();
      if (item.kind === "dir" && JUNK_DIRS.includes(lower)) {
        found.caches.push({ path: item.path, size: sizeOf(item.path), owner: d.name });
      } else if (item.kind === "file" && JUNK_FILE_EXT.some((x) => lower.endsWith(x))) {
        found.innerJunk.push({ path: item.path, size: sizeOf(item.path), owner: d.name });
      }
    }
  }

  const sum = (rows) => rows.reduce((acc, r) => acc + (r.size || 0), 0);
  // --strict считает НАХОДКИ, а не байты: пустой _dump в корне диска — уже нарушение,
  // даже если весит ноль (правило «артефактам тут не место»).
  const findings = found.caches.length + found.dumps.length
    + found.looseArtifacts.length + found.innerJunk.length;
  const totalJunk = sum(found.caches) + sum(found.dumps) + sum(found.looseArtifacts)
    + sum(found.innerJunk);
  const report = {
    disk: DISK,
    stations: nodes.filter((n) => n.kind === "dir").length,
    findings,
    junk: {
      caches_mb: mb(sum(found.caches)),
      dumps_mb: mb(sum(found.dumps)),
      loose_artifacts_mb: mb(sum(found.looseArtifacts)),
      file_junk_mb: mb(sum(found.innerJunk)),
      total_mb: mb(totalJunk),
    },
    caches: found.caches.sort((a, b) => b.size - a.size).slice(0, TOP),
    dumps: found.dumps,
    loose_artifacts: found.looseArtifacts,
    file_junk: found.innerJunk.sort((a, b) => b.size - a.size).slice(0, TOP),
    rule: "артефакты (отчёты/дампы/логи) — в рантайм-каталог: $XDG_STATE_HOME или ~/.cache; на диске данных их быть не должно",
  };

  if (FLAGS.json) {
    process.stdout.write(JSON.stringify(report, null, 1) + "\n");
  } else {
    const lines = [];
    lines.push(`диск: ${DISK} · каталогов: ${report.stations}`);
    lines.push(`находок: ${findings}`);
    lines.push(`мусор: ${report.junk.total_mb} МБ ` +
      `(кэши ${report.junk.caches_mb} · дампы ${report.junk.dumps_mb} · ` +
      `файлы-артефакты в корне ${report.junk.loose_artifacts_mb} · ` +
      `служебные файлы ${report.junk.file_junk_mb})`);
    if (report.dumps.length) {
      lines.push("свалки в данных:");
      for (const d of report.dumps) lines.push(`  ${mb(d.size)} МБ  ${d.path}`);
    }
    if (report.loose_artifacts.length) {
      lines.push("артефакты прямо в корне диска:");
      for (const f of report.loose_artifacts) lines.push(`  ${mb(f.size)} МБ  ${f.path}`);
    }
    if (report.caches.length) {
      lines.push("кэши/сборка (регенерируются, удалять безопасно):");
      for (const c of report.caches) lines.push(`  ${mb(c.size)} МБ  ${c.path}`);
    }
    if (report.file_junk.length) {
      lines.push("служебные файлы:");
      for (const f of report.file_junk) lines.push(`  ${mb(f.size)} МБ  ${f.path}`);
    }
    lines.push(`правило: ${report.rule}`);
    process.stdout.write(lines.join("\n") + "\n");
  }

  if (FLAGS.strict && findings > 0) process.exit(1);
}

main();
