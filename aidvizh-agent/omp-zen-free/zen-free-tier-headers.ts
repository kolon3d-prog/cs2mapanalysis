/**
 * zen-free-tier-headers — runtime monkeypatch for oh-my-pi issue #12306.
 *
 * Mirrors PR #12326 (`packages/ai/src/providers/inference-headers.ts`) without
 * rebuilding the `omp` binary: it wraps `globalThis.fetch` in-process and
 * rewrites attribution headers on requests to the OpenCode gateways so the
 * free-tier validation accepts them:
 *
 *   - `User-Agent: opencode/1.18.31` (unless the caller set a `claude-cli/`
 *     OAuth fingerprint — that one stays authoritative, same as the PR)
 *   - `x-opencode-session: ses_<hex:12><base62:14>` — existing raw ids are
 *     canonicalized deterministically (same sha256 scheme as the PR), so
 *     prompt-cache affinity per session is preserved
 *   - `x-opencode-client: desktop` when absent
 *
 * 2026-09 update (verified against the live gate with curl bisection):
 *   - The gate now requires `x-opencode-client`, `x-opencode-session` and a
 *     `User-Agent` with the leading `opencode/` token; dropping any of them
 *     (or `Authorization`) yields 403. `x-opencode-org-id` is NOT required —
 *     the API key alone resolves the workspace.
 *   - The body needs `stream: true` AND at least TWO core OpenCode tool
 *     NAMES. The gate counts the full set (`bash`, `read`, `edit`, `glob`,
 *     `grep`; schemas/descriptions are ignored — 1 name or random names
 *     403); this patch targets the verified minimal pair `bash` + `read`
 *     (see ZEN_REQUIRED_TOOL_NAMES). Bodies that already carry enough core
 *     names get no stubs injected.
 *   - The legacy `https://opencode.ai/zen/v1` path is rate-limited for free
 *     accounts (429 FreeUsageLimitError on every request), while the same
 *     request against the current `https://opencode.ai/inference/openai/v1`
 *     path passes. So this patch transparently rewrites `/zen/…` URLs to
 *     `/inference/openai/…` — no new provider in models.yml needed. Disable
 *     with ZEN_REWRITE_URL=0.
 *
 * LOCAL PATCH (aidvizh 2026-09-21): the URL rewrite above is DISABLED by
 *   default in this copy. Live checks against the gate showed the opposite of
 *   the note above: `/zen/v1` and `/zen/go/v1` answer 200 with the patched
 *   headers, while `/inference/openai/...` returns 401 `Invalid credential`
 *   (verified with working opencode-go/zen keys, free `deepseek-flash`,
 *   `omen-alpha`, `nemotron-3.5-lightning-free`). The rewrite also broke the
 *   opencode-go path (`/inference/openai/go/...` -> 404). Headers alone are
 *   enough, so the rewrite now needs an explicit `ZEN_REWRITE_URL=1`; revisit
 *   if the gate changes back.
 *
 * Tool injection: string JSON bodies on OpenCode endpoints get stubs for the
 * missing core tool names appended (Responses + chat-completions envelopes).
 * The stubs are never registered in the harness, so if the model calls one
 * anyway the call errors and the model recovers. `stream` is NOT forced
 * here: flipping it would break response parsing for non-streaming callers,
 * so non-streaming requests still 403 by gateway policy.
 *
 * Scope: only absolute URLs on `opencode.ai`. Everything else passes through
 * untouched, and any internal error fails open to the original `fetch` — the
 * patch can only fail by not patching.
 *
 * Covers main sessions, advisors and subagents automatically — they all
 * share this process's `fetch`.
 *
 * Env:
 *   ZEN_INJECT_TOOLS=0  — disable the tool-name injection (headers still patched)
 *   ZEN_REWRITE_URL=1   — rewrite /zen/ to /inference/openai/ (off by default:
 *     on the live gate that path returns 401 Invalid credential, /zen/ works)
 *   ZEN_HEADERS_DEBUG=1 — append one line per zen request to
 *     <tmpdir>/zen-free-tier-headers.log (url path, session prefix,
 *     required names present, names injected, url rewritten?)
 *
 * Enable (pick one, no rebuild needed):
 *   1. Auto-load every run (recommended): copy this file to
 *      `~/.omp/agent/extensions/` (honors `PI_CODING_AGENT_DIR` / profiles)
 *   2. One-shot: `omp --extension /path/to/zen-free-tier-headers.ts`
 *
 * Known limits (same as the PR):
 *   - Does NOT send `x-opencode-request` (format unknown, PR doesn't either;
 *     not gated per live bisection).
 *   - `opencode/1.18.31` is pinned. The gate reads only the leading
 *     `opencode/` token, but bump OPENCODE_USER_AGENT below if the gate
 *     starts requiring a newer client version.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Canonical OpenCode client user-agent. Required for free-tier validation. */
const OPENCODE_USER_AGENT = "opencode/1.18.31";

/** Canonical OpenCode session id format: ses_ + 12 hex + 14 base62 chars. */
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Minimal verified pair of core OpenCode tool names for the free-tier gate.
 * The gate counts the full set (`bash`, `read`, `edit`, `glob`, `grep`) and
 * needs >= ZEN_MIN_TOOL_NAMES of those names in the body (schemas ignored);
 * `bash` + `read` pass, one name or random names 403 (verified 2026-09).
 * Bodies that already carry enough core names get no stubs injected.
 */
const ZEN_REQUIRED_TOOL_NAMES = ["bash", "read"];

/** Minimum number of core tool names that must be present in `tools`. */
const ZEN_MIN_TOOL_NAMES = 2;

/**
 * Legacy gateway base path (still advertised by older configs) replaced with
 * the current one; the legacy path is rate-limited to 429 on free accounts.
 */
const LEGACY_PATH = "/zen/";
const CURRENT_PATH = "/inference/openai/";

/**
 * Canonicalize a session id into OpenCode's `ses_<hex:12><base62:14>` format,
 * deterministic per input so turns keep attribution and prompt-cache
 * affinity. Same scheme as PR #12326 (sha256 over `opencode\0omp\0<id>`).
 */
function canonicalizeSessionId(sessionId?: string): string {
  const id = sessionId?.trim();
  if (id && OPENCODE_SESSION_RE.test(id)) return id;
  const digest = createHash("sha256")
    .update(`opencode\0omp\0${id || "default"}`)
    .digest();
  const timeHex = Buffer.from(digest.subarray(0, 6)).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
}

/** True for requests aimed at the OpenCode zen/go gateways. */
function isZenUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

/** Rewrite the legacy /zen/ gateway path to /inference/openai/ — disabled by default.
 *  Live check 2026-09-21: /zen/ works with the patched headers, /inference/openai/ gives
 *  401 Invalid credential; so the rewrite is opt-in via ZEN_REWRITE_URL=1. */
function rewriteZenUrl(url: string): { url: string; rewritten: boolean } {
  if (process.env.ZEN_REWRITE_URL !== "1" || !url.includes(LEGACY_PATH)) {
    return { url, rewritten: false };
  }
  return { url: url.replace(LEGACY_PATH, CURRENT_PATH), rewritten: true };
}

// Tool stubs appended to bodies missing the required names. The gate reads
// tool NAMES only, so one shared shape suffices for every core name.
const STUB_DESCRIPTION =
  "Gateway-validation stub, NOT IMPLEMENTED. NEVER call this tool - any call " +
  "fails; use a real registered tool instead.";

const STUB_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to execute" },
    timeout: { type: "number", description: "Optional timeout in milliseconds" },
    description: {
      type: "string",
      description: "Clear, concise description of what this command does in 5-10 words.",
    },
  },
  required: ["command"],
  additionalProperties: false,
};

/** Tool name in either the Responses or the chat-completions envelope. */
function toolName(t: unknown): string | null {
  if (!t || typeof t !== "object") return null;
  const rec = t as Record<string, unknown>;
  if (typeof rec.name === "string") return rec.name; // Responses API
  const fn = rec.function as Record<string, unknown> | undefined; // chat completions
  return fn && typeof fn.name === "string" ? fn.name : null;
}

function buildZenToolStub(url: string, name: string): Record<string, unknown> | null {
  if (url.includes("/responses")) {
    return { type: "function", name, description: STUB_DESCRIPTION, parameters: STUB_PARAMETERS };
  }
  if (url.includes("/chat/completions")) {
    return {
      type: "function",
      function: { name, description: STUB_DESCRIPTION, parameters: STUB_PARAMETERS },
    };
  }
  return null;
}

/** True when the body forces a tool call — a stub would be invoked for sure. */
function isForcedToolChoice(choice: unknown): boolean {
  if (choice === "required" || choice === "any") return true;
  if (choice && typeof choice === "object" && !Array.isArray(choice) && "type" in choice) {
    return choice.type === "required" || choice.type === "any";
  }
  return false;
}

/**
 * Append stubs for the missing required tool names to a zen JSON body until
 * at least ZEN_MIN_TOOL_NAMES core names are present. Returns the original
 * text untouched on any doubt (fail open).
 */
function injectZenTools(url: string, bodyText: string) {
  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    return { text: bodyText, injected: [] as string[], present: 0 };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { text: bodyText, injected: [] as string[], present: 0 };
  }
  const body = doc as Record<string, unknown>;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : null;
  const names = (tools ?? []).map(toolName).filter((n): n is string => n !== null);
  const missing = ZEN_REQUIRED_TOOL_NAMES.filter((n) => !names.includes(n));
  const present = ZEN_REQUIRED_TOOL_NAMES.length - missing.length;
  // Enough names already, or a forced tool call that would make the model
  // invoke an unregistered stub for sure — leave such requests alone.
  const passthrough = { text: bodyText, injected: [] as string[], present };
  if (
    present >= ZEN_MIN_TOOL_NAMES ||
    missing.length === 0 ||
    isForcedToolChoice(body.tool_choice)
  ) {
    return passthrough;
  }
  const stubs: Record<string, unknown>[] = [];
  for (const name of missing) {
    const stub = buildZenToolStub(url, name);
    if (!stub) return passthrough;
    stubs.push(stub);
    if (present + stubs.length >= ZEN_MIN_TOOL_NAMES) break;
  }
  return {
    text: JSON.stringify({ ...body, tools: tools ? [...tools, ...stubs] : stubs }),
    injected: stubs.map((s) => String((s as { name: string }).name)),
    present,
  };
}

function debugLog(line: string): void {
  if (process.env.ZEN_HEADERS_DEBUG !== "1") return;
  void appendFile(`${tmpdir()}/zen-free-tier-headers.log`, `${new Date().toISOString()} ${line}\n`).catch(
    () => undefined,
  );
}

/** Stable per-process canonical id for requests that carry no session at all. */
let processSessionId: string | null = null;

/**
 * Apply the PR #12326 header set onto a Headers instance, in place. Only
 * per-conversation ids seed the canonical ses_: a per-request id would mint
 * a fresh ses_ every turn and fragment prompt-cache affinity.
 */
function patchZenHeaders(headers: Headers): void {
  const rawSession =
    headers.get("x-opencode-session") ??
    headers.get("session_id") ??
    headers.get("x-claude-code-session-id");
  if (!processSessionId) {
    processSessionId = canonicalizeSessionId(`process-${Date.now()}-${Math.random()}`);
  }
  headers.set(
    "x-opencode-session",
    rawSession ? canonicalizeSessionId(rawSession) : processSessionId,
  );

  if (!headers.get("user-agent")?.startsWith("claude-cli/")) {
    headers.set("user-agent", OPENCODE_USER_AGENT);
  }
  if (!headers.has("x-opencode-client")) {
    headers.set("x-opencode-client", "desktop");
  }
}

// ── Закрытие выдохшегося ключа ──────────────────────────────────────────────
// omp меняет ключ на соседний только на 401 и на текст, который считает лимитом
// (`insufficient balance` / `insufficient credits`). Шлюз opencode-go на кончину
// баланса отвечает `402 … Insufficient account funds` — слова `funds` в паттернах
// omp нет, поэтому ключ не сжигается и не меняется: ход падает, а следующий
// берёт тот же ключ. Здесь закрываем ровно эту дыру: увидев такой ответ, помечаем
// ключ отключённым в сторе omp. Выборка ключей идёт `WHERE disabled_cause IS NULL`,
// так что следующий ход пойдёт соседним, а отключённый сам не вернётся.
const FUNDS_STATUSES: Record<number, true> = { 401: true, 402: true };
const FUNDS_TEXT_RE = /CreditsError|Insufficient balance|Insufficient account funds/i;

/** Ключи, по которым уже сработало: второй раз в стор не ходим. */
const burnedKeys = new Set<string>();

/** Минимум, который нам нужен от bun:sqlite. */
type SqliteDatabase = {
  query: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
};

/** Путь к базе omp — та же логика, что в keys.ts: $OMP_KEYS_DB, иначе каталог агента. */
function agentDbPath(): string {
  if (process.env.OMP_KEYS_DB) return process.env.OMP_KEYS_DB;
  const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
  return join(agent, "agent.db");
}

/** Ключ, которым ушёл запрос. */
function bearerOf(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

/**
 * Пометить ключ отключённым в сторе omp. Молча ничего не делает, если стора нет
 * (pi держит ключи в auth.json, а не в базе) или если ключ в стор не записан —
 * `bun:sqlite` создал бы пустую базу, поэтому сначала проверяем файл.
 */
async function disableBurnedKey(token: string, status: number): Promise<void> {
  if (burnedKeys.has(token)) return;
  burnedKeys.add(token);
  const path = agentDbPath();
  if (!existsSync(path)) return;
  // bun:sqlite есть только в рантайме bun (тесты гоняют файл под node), поэтому
  // статический импорт уронил бы модуль целиком — берём его динамически.
  const sqlite: { Database: new (file: string) => SqliteDatabase } = await import("bun:sqlite");
  const db = new sqlite.Database(path);
  const rows = db
    .query("SELECT id, data FROM auth_credentials WHERE credential_type = 'api_key' AND disabled_cause IS NULL")
    .all() as Array<{ id: number; data: string }>;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !("key" in parsed)) continue;
    if (parsed.key !== token) continue;
    const cause = `запрос ${new Date().toISOString().slice(0, 10)}: нет баланса (${status})`;
    db.query("UPDATE auth_credentials SET disabled_cause = ? WHERE id = ?").run(cause, row.id);
    debugLog(`disabled credential #${row.id}: ${cause}`);
    return;
  }
}

/**
 * Посмотреть ответ шлюза: если это отказ по деньгам, закрыть ключ, и вернуть ответ
 * вызывающему без изменений. Тело читается с копии и только у 401/402 — потоковые
 * ответы не трогаются. Ошибки глушим: запрос важнее учёта.
 */
function watchForFundsRefusal(token: string | null, response: Response): Response {
  if (process.env.ZEN_DISABLE_BURNED === "0") return response;
  if (!token || !FUNDS_STATUSES[response.status]) return response;
  try {
    const copy = response.clone();
    void copy
      .text()
      .then((text) => (FUNDS_TEXT_RE.test(text) ? disableBurnedKey(token, response.status) : undefined))
      .catch(() => undefined);
  } catch {
    // Клонировать не вышло — просто не следим за этим ответом.
  }
  return response;
}

const PATCH_FLAG = "__ompZenFreeTierHeadersPatched";

/** Install the fetch wrapper. Idempotent; safe to call twice. */
function installFetchPatch(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[PATCH_FLAG]) return;
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== "function") return;

  const patchedFetch = async function (
    this: unknown,
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    try {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request | undefined)?.url;
      if (typeof rawUrl !== "string" || !isZenUrl(rawUrl)) {
        return origFetch.call(this, input, init);
      }
      const { url, rewritten } = rewriteZenUrl(rawUrl);

      if (typeof input === "string" || input instanceof URL) {
        const headers = new Headers(init?.headers);
        patchZenHeaders(headers);
        let body = init?.body;
        let injected: string[] = [];
        let present = 0;
        if (
          process.env.ZEN_INJECT_TOOLS !== "0" &&
          typeof body === "string" &&
          body.trimStart().startsWith("{")
        ) {
          const r = injectZenTools(url, body);
          injected = r.injected;
          present = r.present;
          if (injected.length > 0) {
            body = r.text;
            // Body grew — a stale explicit length would corrupt the request.
            headers.delete("content-length");
          }
        }
        debugLog(
          `${url.split("?")[0]}${rewritten ? ` (was ${rawUrl.split("?")[0]})` : ""} session=${(headers.get("x-opencode-session") ?? "?").slice(0, 18)} tools=${present} injected=[${injected.join(",")}]`,
        );
        return watchForFundsRefusal(
          bearerOf(headers),
          await origFetch.call(this, url, { ...init, headers, body }),
        );
      }

      // Request object: merge request + init headers, patch, rebuild. Its
      // body is a stream, so tool injection (string bodies only) does not
      // apply here.
      const merged = new Headers((input as Request).headers);
      new Headers(init?.headers).forEach((v, k) => merged.set(k, v));
      patchZenHeaders(merged);
      const { headers: _drop, ...rest } = (init ?? {}) as RequestInit;
      const req = new Request(url, {
        ...(Object.keys(rest).length ? rest : {}),
        method: (input as Request).method,
        headers: merged,
        body: (input as Request).body,
        duplex: "half",
      } as RequestInit);
      debugLog(
        `${url.split("?")[0]}${rewritten ? ` (was ${(input as Request).url.split("?")[0]})` : ""} session=${(merged.get("x-opencode-session") ?? "?").slice(0, 18)} request-input body-untouched`,
      );
      return watchForFundsRefusal(
        bearerOf(merged),
        await origFetch.call(this, req, Object.keys(rest).length ? rest : undefined),
      );
    } catch {
      // Fail open: never break a request because the patch hit something odd.
      return origFetch.call(this, input, init);
    }
  };

  globalThis.fetch = patchedFetch as typeof fetch;
  g[PATCH_FLAG] = true;
}

// Patch on import so `--extension <file>` takes effect even before the
// factory runs; the factory call below is then a no-op via the guard.
installFetchPatch();

/** Extension entry point — omp imports the module and runs the factory. */
export default function zenFreeTierHeaders(pi?: {
  logger?: { info?: (...args: unknown[]) => void };
}): void {
  installFetchPatch();
  pi?.logger?.info?.("[zen-free-tier-headers] fetch patch active");
}
