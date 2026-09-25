/**
 * zen-keys — мультиключи omp: одна команда, чтобы складывать ключи в хранилище omp и видеть, что с ними.
 *
 * omp умеет несколько api_key на провайдера и сам перебирает их (таблица auth_credentials в
 * agent.db). Штатно ключ добавляется через `/login`; это расширение даёт `/keys` для того же плюс
 * проверку ключей против шлюза и отключение мёртвых.
 *
 *   /keys                       список ключей (маскированно) и их состояние
 *   /keys add <provider> <key>  проверить ключ (для opencode-go/zen) и положить в хранилище
 *   /keys check [provider]      прогнать включённые ключи бесплатной моделью: ok / funds / invalid
 *   /keys check --prune         то же, но мёртвые (401/402) сразу отключить
 *   /keys disable <id> [причина] / /keys enable <id>
 *   /keys remove <id>           удалить запись (ключ пропадёт из хранилища)
 *
 * То же из терминала (нужен bun, он же рантайм omp):
 *   bun keys.ts list
 *   bun keys.ts add opencode-go sk-...
 *
 * Путь к базе: $OMP_KEYS_DB или ${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/agent.db.
 * OMP_KEYS_SKIP_PROBE=1 — не проверять ключ при add (нужно тестам и офлайну).
 */
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const UA = "opencode/1.18.31";

/** Шлюзы, которые умеем проверять: адрес + бесплатная модель для пробы. */
const GATES: Record<string, { url: string; model: string }> = {
  "opencode-go": { url: "https://opencode.ai/zen/go/v1/chat/completions", model: "deepseek-flash" },
  "opencode-zen": { url: "https://opencode.ai/zen/v1/chat/completions", model: "nemotron-3.5-lightning-free" },
};

const STUB_TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "stub",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "stub",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
];

export type KeyRow = { id: number; provider: string; data: string; disabled_cause: string | null };

type Statement = {
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes?: number };
};

type Db = { query: (sql: string) => Statement };

/** Канонический вид session-id шлюза: ses_ + 12 hex + 14 base62. */
function sessionId(): string {
  const digest = createHash("sha256").update(`opencode\0zen-keys\0${randomBytes(16).toString("hex")}`).digest();
  let rest = "";
  for (let i = 6; i < 20; i += 1) rest += BASE62[digest[i] % 62];
  return `ses_${Buffer.from(digest.subarray(0, 6)).toString("hex")}${rest}`;
}

export function dbPath(): string {
  if (process.env.OMP_KEYS_DB) return process.env.OMP_KEYS_DB;
  const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
  return join(agent, "agent.db");
}

async function openDb(readonly = false): Promise<Db> {
  const mod = (await import("bun:sqlite")) as {
    Database: new (path: string, opts?: { readonly?: boolean }) => unknown;
  };
  return new mod.Database(dbPath(), readonly ? { readonly: true } : undefined) as Db;
}

export function maskKey(key: string): string {
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length})`;
}

function parseData(data: string): { key: string } {
  try {
    const parsed = JSON.parse(data) as { key?: unknown };
    return { key: typeof parsed.key === "string" ? parsed.key : "" };
  } catch {
    return { key: "" };
  }
}

/** Проба ключа бесплатной моделью шлюза. Сеть — только к opencode.ai. */
export async function probeKey(
  provider: string,
  key: string,
): Promise<{ ok: boolean; status: number | null; verdict: string }> {
  const gate = GATES[provider];
  if (!gate) return { ok: true, status: null, verdict: "проверка не поддержана — сохранён как есть" };
  try {
    const response = await fetch(gate.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "user-agent": UA,
        "x-opencode-client": "desktop",
        "x-opencode-session": sessionId(),
      },
      body: JSON.stringify({
        model: gate.model,
        messages: [{ role: "user", content: "ok" }],
        stream: true,
        max_tokens: 1,
        tools: STUB_TOOLS,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (response.ok) return { ok: true, status: response.status, verdict: "ok" };
    const text = await response.text().catch(() => "");
    const credits = /CreditsError|Insufficient balance|Insufficient account funds/i.test(text);
    const auth = /AuthError|Invalid API key/i.test(text);
    const verdict = credits ? "нет баланса (401/402)" : auth ? "неверный ключ (401)" : `ошибка ${response.status}`;
    return { ok: false, status: response.status, verdict };
  } catch (error) {
    return { ok: false, status: null, verdict: `сеть: ${(error as Error).message}` };
  }
}

export async function listKeysAsync(provider?: string): Promise<KeyRow[]> {
  const db = await openDb(true);
  const rows = provider
    ? db
        .query(
          "SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE credential_type = 'api_key' AND provider = ? ORDER BY id",
        )
        .all(provider)
    : db
        .query(
          "SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE credential_type = 'api_key' ORDER BY provider, id",
        )
        .all();
  return rows as KeyRow[];
}

export async function addKey(
  provider: string,
  key: string,
  options: { probe?: boolean } = {},
): Promise<{ id: number; verdict: string }> {
  const verdict =
    options.probe === false || process.env.OMP_KEYS_SKIP_PROBE === "1"
      ? { verdict: "проба пропущена" }
      : await probeKey(provider, key);
  const db = await openDb();
  const inserted = db
    .query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'api_key', ?) RETURNING id")
    .all(provider, JSON.stringify({ key, source: "login" })) as Array<{ id: number }>;
  return { id: inserted[0]?.id ?? -1, verdict: verdict.verdict };
}

export async function setDisabled(id: number, cause: string | null): Promise<number> {
  const db = await openDb();
  const result = db.query("UPDATE auth_credentials SET disabled_cause = ? WHERE id = ?").run(cause, id);
  return result.changes ?? 0;
}

export async function removeKey(id: number): Promise<number> {
  const db = await openDb();
  const result = db.query("DELETE FROM auth_credentials WHERE id = ?").run(id);
  return result.changes ?? 0;
}

function describe(rows: KeyRow[]): string[] {
  if (rows.length === 0) return ["ключей нет"];
  return rows.map((row) => {
    const { key } = parseData(row.data);
    const state = row.disabled_cause ? `ОТКЛЮЧЁН (${row.disabled_cause})` : "активен";
    return `#${row.id} ${row.provider} ${maskKey(key)} — ${state}`;
  });
}

async function runCheck(provider: string | undefined, prune: boolean): Promise<string[]> {
  const rows = (await listKeysAsync(provider)).filter((row) => !row.disabled_cause);
  const lines: string[] = [];
  for (const row of rows) {
    const { key } = parseData(row.data);
    const result = await probeKey(row.provider, key);
    lines.push(`#${row.id} ${row.provider} — ${result.verdict}`);
    if (prune && (result.status === 401 || result.status === 402)) {
      await setDisabled(row.id, `проверка ${new Date().toISOString().slice(0, 10)}: ${result.verdict}`);
      lines[lines.length - 1] += " → отключён";
    }
  }
  return lines.length ? lines : ["нечего проверять"];
}

export async function runKeysCommand(args: string): Promise<string[]> {
  const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (sub === "list" || sub === "ls") return describe(await listKeysAsync(rest[0]));
  if (sub === "check") return runCheck(rest.find((arg) => !arg.startsWith("--")), rest.includes("--prune"));
  if (sub === "add") {
    const [provider, key] = rest;
    if (!provider || !key) return ["формат: /keys add <provider> <key>"];
    const result = await addKey(provider, key);
    return [`добавлен #${result.id} (${provider}), проба: ${result.verdict}`];
  }
  if (sub === "disable" || sub === "enable") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) return [`формат: /keys ${sub} <id> [причина]`];
    const cause = sub === "disable" ? rest.slice(1).join(" ") || "отключён вручную" : null;
    const changed = await setDisabled(id, cause);
    return [changed ? `#${id}: ${sub === "disable" ? `отключён (${cause})` : "включён"}` : `#${id} не найден`];
  }
  if (sub === "remove" || sub === "rm") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) return ["формат: /keys remove <id>"];
    const changed = await removeKey(id);
    return [changed ? `#${id} удалён` : `#${id} не найден`];
  }
  return [
    "команды: list | add <provider> <key> | check [provider] [--prune] | disable <id> [причина] | enable <id> | remove <id>",
  ];
}

// ---------------------------------------------------------------- CLI (bun keys.ts ...)
if ((import.meta as { main?: boolean }).main) {
  const lines = await runKeysCommand(process.argv.slice(2).join(" "));
  for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------- расширение omp
type Ui = { notify(text: string, level?: string): void };
type ExtensionApi = {
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: { ui: Ui }) => Promise<void> | void },
  ): void;
};

export default function zenKeys(pi: ExtensionApi): void {
  pi.registerCommand("keys", {
    description: "Мультиключи omp: /keys list | add <provider> <key> | check [--prune] | disable/enable/remove <id>",
    handler: async (args, ctx) => {
      try {
        const lines = await runKeysCommand(args ?? "");
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(`keys: ${(error as Error).message}`, "warn");
      }
    },
  });
}
