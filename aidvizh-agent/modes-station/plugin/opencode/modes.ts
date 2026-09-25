/**
 * modes-station — autonomous /goal and /loop modes for opencode2.
 *
 * The parser and state semantics follow the installed OMP 18.1.21 sources:
 *   src/modes/loop-limit.ts:75-90, 200-235
 *   src/modes/loop-condition.ts:24-159
 *   src/modes/interactive-mode.ts:1928-1968, 2008-2163
 *   src/goals/runtime.ts:61-93, 148-178, 312-367, 473-509
 *
 * OpenCode V2 does not expose OMP's TUI runtime or a session-scoped shell.
 * The adapter therefore uses the public V2 session/event/hook/transform APIs
 * only.  The one-shot `bash -lc` condition is a documented fallback, not a
 * pretend persistent shell.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const VERSION = "2.1.0-review";
const DEBUG = process.env.MODES_DEBUG !== "0";
const LOG = process.env.MODES_LOG ?? "/tmp/opencode/modes.log";
const TAG = Math.random().toString(36).slice(2, 7);
const STATE_DIR = process.env.MODES_STATE_DIR ?? join(homedir(), ".local/state/modes-station");
const VIBE_STATE_DIR = process.env.VIBE_STATE_DIR ?? join(homedir(), ".local/state/vibe-station");
const CONDITION_OUTPUT_LIMIT = 64 * 1024;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_NO_OWNER_STALE_MS = 30_000;
const PROCESS_OWNER_KEY = Symbol.for("modes-station.process-owner");

const log = (message: string): void => {
  if (!DEBUG) return;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} [${TAG}] ${message}\n`);
  } catch {
    // Logging is deliberately best-effort; it is not state or command success.
  }
};

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const conditionTimeoutMs = (): number => {
  if (process.env.MODES_CONDITION_TIMEOUT_MS !== undefined) return envNumber("MODES_CONDITION_TIMEOUT_MS", 30_000);
  return envNumber("MODES_CONDITION_TIMEOUT", 30) * 1_000;
};
const startTimeoutMs = (): number => envNumber("MODES_START_TIMEOUT", 60) * 1_000;
const waitTimeoutMs = (): number => envNumber("MODES_WAIT_TIMEOUT", 24 * 3600) * 1_000;
const pollMs = (): number => envNumber("MODES_POLL_MS", 100);
const iterationPauseMs = (): number => envNumber("MODES_ITERATION_PAUSE_MS", 800);
const TURN_TIMEOUT_MS = 30 * 60_000;

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    const ms = pollMs();
    if (ms <= 0) setImmediate(resolve);
    else setTimeout(resolve, ms);
  });

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      setImmediate(resolve);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

type Json = Record<string, any>;
type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
type Condition = { command: string; until: boolean };
type LoopLimit =
  | { kind: "iterations"; initial: number; remaining: number }
  | { kind: "duration"; durationMs: number; deadlineMs: number };
type Todo = { text: string; done: boolean };
type GoalStatus = "active" | "paused" | "complete" | "dropped" | "budget-limited";
type LoopStatus = "active" | "paused" | "off";
type Owner = { ownerPid?: number; ownerProcessStart?: string; ownerInstance?: string };
type ModeClaim = { token: string; generation: number };

type GoalState = Owner & {
  token: string;
  generation: number;
  status: GoalStatus;
  objective: string;
  prompt: string;
  startedAt: number;
  updatedAt: number;
  turns: number;
  turnLimit?: number;
  tokenBudget?: number;
  tokensUsed: number;
  usageBaseline: Usage;
  usageInitialized: boolean;
  timeUsedSeconds: number;
  lastAccountedAt: number;
  todos: Todo[];
  waitingUser?: boolean;
  lastTurnHadTools?: boolean;
  lastTurnWasHidden?: boolean;
  userSeen?: number;
  pendingFirst?: boolean;
  manualTurnPending?: boolean;
  turnInFlight?: boolean;
  turnKind?: "first" | "hidden" | "manual";
  finalFlushPending?: boolean;
  budgetNoticeGeneration?: number;
  reason?: string;
  closed?: boolean;
};

type LoopState = Owner & {
  token: string;
  generation: number;
  status: LoopStatus;
  prompt: string;
  objective: string;
  startedAt: number;
  updatedAt: number;
  limit?: LoopLimit;
  condition?: Condition;
  compact: boolean;
  awaitingBody: boolean;
  used: number;
  userSeen: number;
  manualTurnPending?: boolean;
  lastTurnHadTools?: boolean;
  pausedReason?: string;
  reason?: string;
};

type InterviewState = { draft: string; startedAt: number; expiresAt: number };

type Envelope = Owner & {
  version: 2;
  sessionID: string;
  cwd?: string;
  goal?: GoalState;
  loop?: LoopState;
  interview?: InterviewState;
  updatedAt: number;
  revision: number;
};

type CompatMode = {
  kind: "goal" | "loop";
  active: boolean;
  sessionID: string;
  cwd: string;
  prompt: string;
  objective: string;
  maxIterations?: number;
  turnsLimited?: boolean;
  paused?: boolean;
  deadline?: number;
  condition?: Condition;
  used: number;
  startedAt: number;
  token: string;
  pid?: number;
  waitingUser?: boolean;
  tokensBaseline?: number;
  tokenBudget?: number;
  tokensUsed?: number;
  budgetLimited?: boolean;
  closed?: boolean;
  awaitingBody?: boolean;
  compact?: boolean;
  todos?: Todo[];
  reason?: string;
  timeUsedSeconds?: number;
};

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const finiteNumber = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const safeToken = (): string => `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const statePath = (sessionID: string): string => join(STATE_DIR, `${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
const lockPath = (sessionID: string): string => `${statePath(sessionID)}.lock`;

const processStart = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? undefined;
  } catch {
    return undefined;
  }
};
type ProcessOwner = { id: string; start?: string };
const processOwner = ((): ProcessOwner => {
  const globalState = globalThis as typeof globalThis & { [PROCESS_OWNER_KEY]?: ProcessOwner };
  return (globalState[PROCESS_OWNER_KEY] ??= { id: safeToken(), start: processStart(process.pid) });
})();
const PLUGIN_INSTANCE = safeToken();
const ownerPatch = (): Owner => ({ ownerPid: process.pid, ownerProcessStart: processOwner.start, ownerInstance: PLUGIN_INSTANCE });

const processAlive = (pid: number | undefined, start: string | undefined): boolean => {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (start !== undefined) {
    const current = processStart(pid);
    if (current !== undefined && current !== start) return false;
  }
  return true;
};
const ownerAlive = (owner: Owner | undefined): boolean => {
  if (!owner?.ownerPid) return false;
  return processAlive(owner.ownerPid, owner.ownerProcessStart);
};
const ownerMatchesCurrentProcess = (owner: Owner | undefined): boolean => {
  return owner?.ownerPid === process.pid && ownerAlive(owner);
};

const escapeXmlText = (input: string): string => input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// ---------------------------------------------------------------- OMP parser

const TIME_UNITS_MS = new Map<string, number>([
  ["s", 1_000], ["sec", 1_000], ["secs", 1_000], ["second", 1_000], ["seconds", 1_000],
  ["m", 60_000], ["min", 60_000], ["mins", 60_000], ["minute", 60_000], ["minutes", 60_000],
  ["h", 3_600_000], ["hr", 3_600_000], ["hrs", 3_600_000], ["hour", 3_600_000], ["hours", 3_600_000],
]);
const LOOP_USAGE = "Usage: /loop [count|duration] [--while|--until '<command>'] [prompt]. Examples: /loop 10, /loop 10m, /loop 20 --until 'bun test' fix the failing tests.";
const GOAL_HINT = "[objective]";
const GUIDED_GOAL_HINT = "[rough objective]";
const LOOP_PALETTE_HINT = "[count|duration: 10, 10m, 1h30m] [--while|--until '<cmd>'] [prompt]";
const GOAL_USAGE = `Формат: /goal ${GOAL_HINT} [--turns N] [--tokens N]; формы: budget <N|off>, set <цель>, show, pause, resume, drop, todo <текст>, guided`;

export type LoopLimitConfig =
  | { kind: "iterations"; iterations: number }
  | { kind: "duration"; durationMs: number };
export type ParsedLoopArgs = {
  limit?: LoopLimitConfig;
  condition?: Condition;
  prompt?: string;
  compact?: boolean;
};

/** Exact OMP readShellWord semantics, including escapes and concatenated quotes. */
export function readShellWord(text: string): { value: string; rest: string } | "unterminated" | undefined {
  let i = 0;
  while (i < text.length && /[ \t\n\r]/.test(text[i])) i += 1;
  if (i >= text.length) return undefined;
  let value = "";
  let inSingle = false;
  let inDouble = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      value += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") { value += next; i += 1; continue; }
      }
      if (ch === '"') { inDouble = false; continue; }
      value += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "\\" && i + 1 < text.length) { value += text[i + 1]; i += 1; continue; }
    if (/[ \t\n\r]/.test(ch)) break;
    value += ch;
  }
  if (inSingle || inDouble) return "unterminated";
  return { value, rest: text.slice(i).trim() };
}

function makeIterations(text: string): LoopLimitConfig | string {
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop count must be a positive integer.";
  return { kind: "iterations", iterations: amount };
}
function makeDuration(text: string, unitMs: number): LoopLimitConfig | string {
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop duration must be positive.";
  const durationMs = amount * unitMs;
  if (!Number.isSafeInteger(durationMs)) return "Loop duration must be positive.";
  return { kind: "duration", durationMs };
}
function parseCompoundDuration(token: string): LoopLimitConfig | string | undefined {
  if (!/^(?:\d+[a-z]+)+$/.test(token)) return undefined;
  const segments = token.match(/\d+[a-z]+/g);
  if (!segments) return undefined;
  let totalMs = 0;
  for (const segment of segments) {
    const match = /^(\d+)([a-z]+)$/.exec(segment);
    if (!match) return LOOP_USAGE;
    const unitMs = TIME_UNITS_MS.get(match[2]);
    if (unitMs === undefined) return "Loop duration unit must be seconds, minutes, or hours.";
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop duration must be positive.";
    const part = amount * unitMs;
    if (!Number.isSafeInteger(part)) return "Loop duration must be positive.";
    totalMs += part;
    if (!Number.isSafeInteger(totalMs)) return "Loop duration must be positive.";
  }
  if (totalMs <= 0) return "Loop duration must be positive.";
  return { kind: "duration", durationMs: totalMs };
}
function takeLoopLimit(input: string): { limit?: LoopLimitConfig; rest: string } | string {
  const firstSpace = input.search(/\s/);
  const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
  const token = firstToken.toLowerCase();
  if (!/^[+-]?\d/.test(token)) return { rest: input };
  if (/^\d+$/.test(token)) {
    if (rest) {
      const unitToken = /^\S+/.exec(rest)?.[0] ?? "";
      const unitMs = TIME_UNITS_MS.get(unitToken.toLowerCase());
      if (unitMs !== undefined) {
        const limit = makeDuration(token, unitMs);
        if (typeof limit === "string") return limit;
        return { limit, rest: rest.slice(unitToken.length).trim() };
      }
    }
    const limit = makeIterations(token);
    if (typeof limit === "string") return limit;
    return { limit, rest };
  }
  const duration = parseCompoundDuration(token);
  if (duration !== undefined) {
    if (typeof duration === "string") return duration;
    return { limit: duration, rest };
  }
  return LOOP_USAGE;
}
function takeLoopCondition(input: string): { condition?: Condition; rest: string } | string {
  let rest = input.trim();
  let condition: Condition | undefined;
  const flags: Record<string, boolean> = { "--while": false, "--until": true };
  while (rest.startsWith("--")) {
    const name = /^(--[a-z][a-z-]*)(?=[\s=]|$)/.exec(rest)?.[1];
    const until = name === undefined ? undefined : flags[name];
    if (name === undefined || until === undefined) return `Unknown /loop flag ${name ?? rest.split(/\s+/, 1)[0]}. ${LOOP_USAGE}`;
    if (condition) return "Use only one of --while or --until.";
    const afterName = rest.slice(name.length);
    const valueText = afterName.startsWith("=") ? afterName.slice(1) : afterName;
    const value = readShellWord(valueText);
    if (value === "unterminated") return `${name} has an unterminated quote.`;
    if (value === undefined || !value.value.trim() || valueText.trim().startsWith("-")) return `${name} needs a shell command. Quote it when it contains spaces: /loop ${name} 'bun test'.`;
    condition = { command: value.value.trim(), until };
    rest = value.rest;
  }
  return { condition, rest };
}
export function parseLoopArgs(args: string): ParsedLoopArgs | string {
  let input = args.trim();
  let compact = false;
  const compactMatch = /(^|\s)--compact(?=\s|$)/.exec(input);
  if (compactMatch) {
    compact = true;
    input = input.replace(compactMatch[0], " ").trim();
  }
  if (/(^|\s)--reset(?=\s|$)/.test(input)) return "--reset is not supported by the opencode2 adapter; use --compact";
  if (!input) return { compact };
  const limitResult = takeLoopLimit(input);
  if (typeof limitResult === "string") return limitResult;
  const conditionResult = takeLoopCondition(limitResult.rest);
  if (typeof conditionResult === "string") return conditionResult;
  return { limit: limitResult.limit, condition: conditionResult.condition, prompt: conditionResult.rest || undefined, compact };
}

// ---------------------------------------------------------------- state model

const NO_WRITE = Symbol("no-write");
class StateError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
    this.name = "StateError";
  }
}
function emptyEnvelope(sessionID: string): Envelope {
  return { version: 2, sessionID, updatedAt: Date.now(), revision: 0 };
}
function normalizeUsage(value: any): Usage {
  const t = value ?? {};
  return {
    input: Math.max(0, finiteNumber(t.input ?? t.inputTokens ?? t.input_tokens)),
    output: Math.max(0, finiteNumber(t.output ?? t.outputTokens ?? t.output_tokens)),
    cacheWrite: Math.max(0, finiteNumber(t.cacheWrite ?? t.cacheWriteTokens ?? t.cache?.write ?? t.cache_write)),
    cacheRead: Math.max(0, finiteNumber(t.cacheRead ?? t.cacheReadTokens ?? t.cache?.read ?? t.cache_read)),
  };
}
function normalizeGoal(raw: any, sessionID: string): GoalState {
  const now = Date.now();
  const reason = String(raw?.reason ?? "");
  const markerOnly = /^GOAL:\s*DONE$/i.test(reason);
  const explicitComplete = raw?.status === "complete" || /^(completed|закрыта инструментом goal|вручную)$/i.test(reason);
  const status: GoalStatus = explicitComplete
    ? "complete"
    : markerOnly
      ? "paused"
      : raw?.status === "dropped" || /^(drop|снята|по команде)/i.test(reason)
        ? "dropped"
        : raw?.status === "budget-limited" || raw?.budgetLimited === true
          ? "budget-limited"
          : raw?.status === "active" || raw?.active === true
            ? "active"
            : "paused";
  const used = Math.max(0, Math.floor(finiteNumber(raw?.used ?? raw?.turns)));
  const turnLimit = raw?.turnsLimited === false && raw?.turnLimit === undefined
    ? undefined
    : raw?.turnLimit === undefined && raw?.maxIterations === undefined
      ? undefined
      : Math.max(1, Math.floor(finiteNumber(raw?.turnLimit ?? raw?.maxIterations, 1)));
  const baselineRaw = raw?.usageBaseline;
  return {
    token: String(raw?.token ?? safeToken()),
    generation: Math.max(0, Math.floor(finiteNumber(raw?.generation))),
    status,
    objective: String(raw?.objective ?? raw?.prompt ?? ""),
    prompt: String(raw?.prompt ?? raw?.objective ?? ""),
    startedAt: finiteNumber(raw?.startedAt, now),
    updatedAt: finiteNumber(raw?.updatedAt, now),
    turns: used,
    turnLimit,
    tokenBudget: raw?.tokenBudget === undefined ? undefined : Math.max(1, Math.floor(finiteNumber(raw.tokenBudget, 1))),
    tokensUsed: Math.max(0, finiteNumber(raw?.tokensUsed)),
    usageBaseline: baselineRaw ? normalizeUsage(baselineRaw) : emptyUsage(),
    usageInitialized: baselineRaw !== undefined || raw?.usageInitialized === true,
    timeUsedSeconds: Math.max(0, finiteNumber(raw?.timeUsedSeconds)),
    lastAccountedAt: finiteNumber(raw?.lastAccountedAt, now),
    todos: Array.isArray(raw?.todos) ? raw.todos.filter((t: any) => typeof t?.text === "string").map((t: any) => ({ text: String(t.text), done: t.done === true })) : [],
    waitingUser: raw?.waitingUser === true,
    lastTurnHadTools: raw?.lastTurnHadTools === undefined ? undefined : raw.lastTurnHadTools === true,
    lastTurnWasHidden: raw?.lastTurnWasHidden === true,
    userSeen: raw?.userSeen === undefined ? undefined : Math.max(0, Math.floor(finiteNumber(raw.userSeen))),
    pendingFirst: raw?.pendingFirst === true,
    manualTurnPending: raw?.manualTurnPending === true,
    turnInFlight: raw?.turnInFlight === true,
    turnKind: raw?.turnKind === "first" || raw?.turnKind === "hidden" || raw?.turnKind === "manual" ? raw.turnKind : undefined,
    finalFlushPending: raw?.finalFlushPending === true,
    budgetNoticeGeneration: raw?.budgetNoticeGeneration === undefined ? undefined : Math.max(0, Math.floor(finiteNumber(raw.budgetNoticeGeneration))),
    ownerPid: raw?.ownerPid ?? raw?.pid,
    ownerProcessStart: raw?.ownerProcessStart,
    ownerInstance: raw?.ownerInstance,
    reason: raw?.reason === undefined ? undefined: String(raw.reason),
    closed: status === "complete" || status === "dropped",
  };
}
function normalizeLoop(raw: any): LoopState {
  const now = Date.now();
  let limit: LoopLimit | undefined;
  if (raw?.limit?.kind === "iterations") {
    limit = { kind: "iterations", initial: Math.max(1, finiteNumber(raw.limit.initial, 1)), remaining: Math.max(0, finiteNumber(raw.limit.remaining, 0)) };
  } else if (raw?.limit?.kind === "duration") {
    limit = { kind: "duration", durationMs: Math.max(1, finiteNumber(raw.limit.durationMs, 1)), deadlineMs: finiteNumber(raw.limit.deadlineMs, now + 3_600_000) };
  } else if (raw?.turnsLimited === true || (raw?.maxIterations !== undefined && raw?.turnsLimited !== false)) {
    const total = Math.max(1, Math.floor(finiteNumber(raw.maxIterations, 1)));
    limit = { kind: "iterations", initial: Math.max(1, total - 1), remaining: Math.max(0, total - 1 - Math.max(0, finiteNumber(raw.used))) };
  }
  const status: LoopStatus = raw?.status === "paused" || raw?.paused === true ? "paused" : raw?.active === true || raw?.status === "active" ? "active" : "off";
  return {
    token: String(raw?.token ?? safeToken()),
    generation: Math.max(0, Math.floor(finiteNumber(raw?.generation))),
    status,
    prompt: String(raw?.prompt ?? raw?.objective ?? ""),
    objective: String(raw?.objective ?? raw?.prompt ?? ""),
    startedAt: finiteNumber(raw?.startedAt, now),
    updatedAt: finiteNumber(raw?.updatedAt, now),
    limit,
    condition: raw?.condition?.command ? { command: String(raw.condition.command), until: raw.condition.until === true } : undefined,
    compact: raw?.compact === true,
    awaitingBody: raw?.awaitingBody === true || !String(raw?.prompt ?? "").trim(),
    used: Math.max(0, Math.floor(finiteNumber(raw?.used))),
    userSeen: Math.max(0, Math.floor(finiteNumber(raw?.userSeen))),
    manualTurnPending: raw?.manualTurnPending === true,
    lastTurnHadTools: raw?.lastTurnHadTools === undefined ? undefined : raw.lastTurnHadTools === true,
    pausedReason: raw?.pausedReason === undefined ? undefined : String(raw.pausedReason),
    ownerPid: raw?.ownerPid ?? raw?.pid,
    ownerProcessStart: raw?.ownerProcessStart,
    ownerInstance: raw?.ownerInstance,
    reason: raw?.reason === undefined ? undefined : String(raw.reason),
  };
}
function normalizeInterview(raw: any): InterviewState | undefined {
  if (!raw || (raw.active !== true && typeof raw.draft !== "string") || typeof raw.draft !== "string") return undefined;
  const startedAt = finiteNumber(raw.startedAt, Date.now());
  return { draft: raw.draft, startedAt, expiresAt: finiteNumber(raw.expiresAt, startedAt + waitTimeoutMs()) };
}
function normalizeEnvelope(raw: any, sessionID: string): Envelope | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.version === 2 && (raw.goal !== undefined || raw.loop !== undefined || raw.interview !== undefined || raw.sessionID)) {
    return {
      version: 2,
      sessionID: String(raw.sessionID ?? sessionID),
      cwd: raw.cwd === undefined ? undefined : String(raw.cwd),
      goal: raw.goal ? normalizeGoal(raw.goal, String(raw.sessionID ?? sessionID)) : undefined,
      loop: raw.loop ? normalizeLoop(raw.loop) : undefined,
      interview: normalizeInterview(raw.interview),
      updatedAt: finiteNumber(raw.updatedAt, Date.now()),
      revision: Math.max(0, finiteNumber(raw.revision)),
      ownerPid: raw.ownerPid,
      ownerProcessStart: raw.ownerProcessStart,
      ownerInstance: raw.ownerInstance,
    };
  }
  if (raw.kind === "goal") return { ...emptyEnvelope(String(raw.sessionID ?? sessionID)), cwd: raw.cwd, goal: normalizeGoal(raw, String(raw.sessionID ?? sessionID)), updatedAt: finiteNumber(raw.updatedAt, finiteNumber(raw.startedAt, Date.now())) };
  if (raw.kind === "loop") return { ...emptyEnvelope(String(raw.sessionID ?? sessionID)), cwd: raw.cwd, loop: normalizeLoop(raw), updatedAt: finiteNumber(raw.updatedAt, finiteNumber(raw.startedAt, Date.now())) };
  return undefined;
}
function primaryForCompat(env: Envelope): CompatMode | undefined {
  const goal = env.goal;
  const loop = env.loop;
  const goalBlocks = goal !== undefined && !["complete", "dropped"].includes(goal.status);
  const selected = goalBlocks ? goal : loop && loop.status !== "off" ? loop : goal ?? loop;
  if (!selected) return undefined;
  if (goal && (goalBlocks || !loop || loop.status === "off")) {
    return {
      kind: "goal", active: goal.status === "active", sessionID: env.sessionID, cwd: env.cwd ?? process.cwd(), prompt: goal.prompt, objective: goal.objective, maxIterations: goal.turnLimit, turnsLimited: goal.turnLimit !== undefined, used: goal.turns, startedAt: goal.startedAt, token: goal.token, pid: goal.ownerPid, waitingUser: goal.waitingUser, tokensBaseline: goal.usageBaseline.input + goal.usageBaseline.cacheWrite + goal.usageBaseline.output, tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed, budgetLimited: goal.status === "budget-limited", closed: goal.closed, todos: goal.todos, reason: goal.reason, timeUsedSeconds: goal.timeUsedSeconds,
    };
  }
  return {
    kind: "loop", active: loop.status !== "off", sessionID: env.sessionID, cwd: env.cwd ?? process.cwd(), prompt: loop.prompt, objective: loop.objective, deadline: loop.limit?.kind === "duration" ? loop.limit.deadlineMs : undefined, condition: loop.condition, used: loop.used, startedAt: loop.startedAt, token: loop.token, pid: loop.ownerPid, paused: loop.status === "paused", turnsLimited: loop.limit?.kind === "iterations", maxIterations: loop.limit?.kind === "iterations" ? loop.limit.initial + 1 : undefined, awaitingBody: loop.awaitingBody, compact: loop.compact, reason: loop.reason,
  };
}
function serializeEnvelope(env: Envelope): Json {
  const compat = primaryForCompat(env);
  return {
    version: 2,
    sessionID: env.sessionID,
    cwd: env.cwd,
    goal: env.goal,
    loop: env.loop,
    interview: env.interview,
    updatedAt: env.updatedAt,
    revision: env.revision,
    ownerPid: env.ownerPid,
    ownerProcessStart: env.ownerProcessStart,
    ownerInstance: env.ownerInstance,
    ...(compat ?? {}),
  };
}

// ---------------------------------------------------------------- durable state lock

function writeEnvelopeUnlocked(env: Envelope): void {
  const target = statePath(env.sessionID);
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temp, JSON.stringify(serializeEnvelope(env)), { mode: 0o600 });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, target);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* preserve the original error */ }
    throw new StateError(`state write failed for ${target}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}
function readRawUnlocked(sessionID: string): any | undefined {
  const path = statePath(sessionID);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new StateError(`state read failed for ${path}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}
function readEnvelopeUnlocked(sessionID: string): Envelope | undefined {
  const raw = readRawUnlocked(sessionID);
  return raw === undefined ? undefined : normalizeEnvelope(raw, sessionID);
}
function writeLockOwner(path: string): void {
  writeFileSync(join(path, LOCK_OWNER_FILE), JSON.stringify({ pid: process.pid, processStart: processOwner.start, instance: PLUGIN_INSTANCE, at: Date.now() }), { mode: 0o600 });
}
function staleLock(path: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(path, LOCK_OWNER_FILE), "utf8"));
    return !processAlive(Number(owner.pid), owner.processStart === undefined ? undefined : String(owner.processStart));
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs > LOCK_NO_OWNER_STALE_MS;
    } catch {
      return true;
    }
  }
}
function acquireStateLock(sessionID: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = lockPath(sessionID);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try { writeLockOwner(path); } catch (error) { try { rmSync(path, { recursive: true, force: true }); } catch {} throw new StateError(`state lock owner write failed: ${error instanceof Error ? error.message : String(error)}`, error); }
      return path;
    } catch (error) {
      if (!existsSync(path) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new StateError(`state lock unavailable for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`, error);
      }
      if (!staleLock(path)) throw new StateError(`state lock is held for ${sessionID}`, error);
      try { rmSync(path, { recursive: true, force: true }); } catch (removeError) { throw new StateError(`stale state lock could not be recovered for ${sessionID}: ${removeError instanceof Error ? removeError.message : String(removeError)}`, removeError); }
    }
  }
  throw new StateError(`state lock retry limit reached for ${sessionID}`);
}
function releaseStateLock(path: string): void {
  try {
    const owner = JSON.parse(readFileSync(join(path, LOCK_OWNER_FILE), "utf8"));
    if (owner.pid !== process.pid || owner.instance !== PLUGIN_INSTANCE) return;
  } catch {
    return;
  }
  try { rmSync(path, { recursive: true, force: true }); } catch (error) { throw new StateError(`state lock release failed: ${error instanceof Error ? error.message : String(error)}`, error); }
}
function withStateLock<T>(sessionID: string, fn: (env: Envelope | undefined) => T): T {
  const path = acquireStateLock(sessionID);
  let result: T;
  try {
    result = fn(readEnvelopeUnlocked(sessionID));
  } finally {
    releaseStateLock(path);
  }
  return result;
}
function reconcileEnvelope(env: Envelope): boolean {
  let changed = false;
  if (env.goal?.status === "active" && !ownerAlive(env.goal)) {
    env.goal.status = "paused";
    env.goal.turnInFlight = false;
    env.goal.pendingFirst = false;
    env.goal.manualTurnPending = false;
    env.goal.reason = "восстановление после restart — продолжить: /goal resume";
    env.goal.generation += 1;
    env.goal.updatedAt = Date.now();
    changed = true;
  }
  if (env.loop && env.loop.status !== "off" && !ownerAlive(env.loop)) {
    env.loop = undefined;
    changed = true;
  }
  if (env.goal && ["complete", "dropped"].includes(env.goal.status) && env.interview) {
    env.interview = undefined;
    changed = true;
  }
  if (env.interview && env.interview.expiresAt <= Date.now()) {
    env.interview = undefined;
    changed = true;
  }
  return changed;
}
function readEnvelope(sessionID: string): Envelope | undefined {
  return withStateLock(sessionID, (env) => {
    if (!env) return undefined;
    let changed = reconcileEnvelope(env);
    const raw = readRawUnlocked(sessionID);
    if (raw?.version !== 2) changed = true;
    if (changed) {
      env.revision += 1;
      env.updatedAt = Date.now();
      writeEnvelopeUnlocked(env);
    }
    return clone(env);
  });
}
function mutateEnvelope<T>(sessionID: string, fn: (env: Envelope) => T | typeof NO_WRITE, expectedRevision?: number): T | undefined {
  return withStateLock(sessionID, (existing) => {
    const env = existing ?? emptyEnvelope(sessionID);
    if (expectedRevision !== undefined && env.revision !== expectedRevision) return NO_WRITE;
    const result = fn(env);
    if (result === NO_WRITE) return undefined;
    env.revision += 1;
    env.updatedAt = Date.now();
    writeEnvelopeUnlocked(env);
    return result;
  }) as T | undefined;
}
function patchMode(sessionID: string, kind: "goal" | "loop", token: string, patch: Partial<GoalState & LoopState>, expected?: Partial<Pick<GoalState & LoopState, "generation" | "status">>): boolean {
  return withStateLock(sessionID, (existing) => {
    const env = existing ?? emptyEnvelope(sessionID);
    const mode = env[kind];
    if (!mode || mode.token !== token) return false;
    if (expected?.generation !== undefined && mode.generation !== expected.generation) return false;
    if (expected?.status !== undefined && mode.status !== expected.status) return false;
    Object.assign(mode, patch);
    mode.updatedAt = Date.now();
    env.revision += 1;
    env.updatedAt = Date.now();
    writeEnvelopeUnlocked(env);
    return true;
  });
}
function transitionGoal(sessionID: string, token: string, statuses: GoalStatus[], patch: Partial<GoalState>, expectedGeneration?: number): boolean {
  return withStateLock(sessionID, (existing) => {
    const env = existing ?? emptyEnvelope(sessionID);
    const goal = env.goal;
    if (!goal || goal.token !== token || !statuses.includes(goal.status) || (expectedGeneration !== undefined && goal.generation !== expectedGeneration)) return false;
    Object.assign(goal, patch);
    goal.generation += 1;
    goal.updatedAt = Date.now();
    if (["complete", "dropped", "paused"].includes(goal.status)) env.interview = undefined;
    env.revision += 1;
    env.updatedAt = Date.now();
    writeEnvelopeUnlocked(env);
    return true;
  });
}
function transitionLoop(sessionID: string, token: string, statuses: LoopStatus[], patch: Partial<LoopState>): boolean {
  return withStateLock(sessionID, (existing) => {
    const env = existing ?? emptyEnvelope(sessionID);
    const loop = env.loop;
    if (!loop || loop.token !== token || !statuses.includes(loop.status)) return false;
    Object.assign(loop, patch);
    loop.generation += 1;
    loop.updatedAt = Date.now();
    env.revision += 1;
    env.updatedAt = Date.now();
    writeEnvelopeUnlocked(env);
    return true;
  });
}
function updateGoalTodos(sessionID: string, token: string, update: (todos: Todo[]) => Todo[]): GoalState | undefined {
  return withStateLock(sessionID, (existing) => {
    const env = existing ?? emptyEnvelope(sessionID);
    const goal = env.goal;
    if (!goal || goal.token !== token) return undefined;
    goal.todos = update(goal.todos);
    goal.updatedAt = Date.now();
    env.revision += 1;
    env.updatedAt = Date.now();
    writeEnvelopeUnlocked(env);
    return clone(goal);
  });
}
function setCwd(sessionID: string, cwd: string): void {
  mutateEnvelope(sessionID, (env) => { if (env.cwd === cwd) return NO_WRITE; env.cwd = cwd; });
}
function removeLoop(sessionID: string): boolean {
  const result = withStateLock(sessionID, (existing) => {
    const env = existing ?? emptyEnvelope(sessionID);
    if (!env.loop) return false;
    env.loop = undefined;
    env.revision += 1;
    env.updatedAt = Date.now();
    writeEnvelopeUnlocked(env);
    return true;
  });
  if (result) conditionControllers.get(sessionID)?.abort();
  return result;
}
function goalTerminal(goal: GoalState | undefined): boolean { return goal?.status === "complete" || goal?.status === "dropped"; }
function goalEnabled(env: Envelope): boolean { return env.goal?.status === "active"; }
function loopEnabled(env: Envelope): boolean { return env.loop !== undefined && env.loop.status !== "off"; }
function anyModeActive(env: Envelope | undefined): boolean { return Boolean(env && (goalEnabled(env) || loopEnabled(env) || (env.goal?.status === "active" && env.goal.pendingFirst))); }
function interviewActive(env: Envelope | undefined, sessionID: string): boolean {
  return Boolean(env?.sessionID === sessionID && env.interview && env.interview.expiresAt > Date.now());
}

// ---------------------------------------------------------------- session API

type SessionAPI = {
  hook(event: string, handler: (payload: any) => unknown): Promise<any> | any;
  synthetic(input: Record<string, unknown>): Promise<unknown> | unknown;
  prompt(input: Record<string, unknown>): Promise<unknown> | unknown;
  context(input: Record<string, unknown>): Promise<any> | unknown;
  get(input: Record<string, unknown>): Promise<any> | unknown;
  wait?(input: Record<string, unknown>): Promise<unknown> | unknown;
  interrupt?(input: Record<string, unknown>): Promise<unknown> | unknown;
};
type Registration = { dispose?: () => Promise<void> | void };
type ToolHook = (event: string, handler: (payload: any) => unknown) => Promise<Registration | undefined> | Registration | undefined;
type PluginCtx = {
  session: SessionAPI;
  command: { transform(cb: (editor: any) => unknown): Promise<Registration> | Registration };
  tool?: { transform(cb: (editor: any) => unknown): Promise<Registration> | Registration; hook?: ToolHook };
  location?: { directory?: string };
  event?: { subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown> };
};
type Message = Record<string, any>;
type Snapshot = { idleID?: string; idleOutcome?: string; assistants: Message[]; all: Message[]; last?: Message };
type TurnResult = { last?: Message; tools: boolean; outcome?: string; reason?: string };

const dataOf = (res: any): any => res && typeof res === "object" && "data" in res ? (res as any).data : res;
const messagesOf = (res: any): Message[] => {
  const data = dataOf(res);
  if (Array.isArray(data)) return data.filter((m): m is Message => Boolean(m && typeof m === "object"));
  if (Array.isArray(data?.messages)) return data.messages.filter((m: Message) => Boolean(m && typeof m === "object"));
  return [];
};
const contentParts = (message: Message | undefined): any[] => Array.isArray(message?.content) ? message.content : Array.isArray(message?.parts) ? message.parts : [];
const isAssistant = (m: Message): boolean => (m.type ?? m.role ?? m.info?.role) === "assistant";
const isIdle = (m: Message): boolean => (m.type ?? m.role) === "idle";
const isUser = (m: Message): boolean => (m.type ?? m.role) === "user";
const isInternalUser = (m: Message): boolean => isUser(m) && (m.metadata?.modesStation === "loop" || m.metadata?.modesStation === "goal-first");
const userText = (m: Message): string => String(m.text ?? m.payload?.text ?? m.content?.find?.((p: any) => p?.type === "text")?.text ?? m.parts?.find?.((p: any) => p?.type === "text")?.text ?? "").trim();
const hadToolCall = (m: Message): boolean => contentParts(m).some((p: any) => typeof p?.type === "string" && p.type.startsWith("tool"));
async function snapshot(ctx: SessionAPI, sessionID: string): Promise<Snapshot> {
  try {
    const all = messagesOf(await ctx.context({ sessionID }));
    const assistants = all.filter(isAssistant);
    const idle = [...all].reverse().find(isIdle);
    return { idleID: idle?.id, idleOutcome: idle?.outcome, assistants, all, last: assistants.at(-1) };
  } catch (error) {
    throw new StateError(`session context failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}
async function sessionInfo(ctx: SessionAPI, sessionID: string): Promise<Json> {
  const value = dataOf(await ctx.get({ sessionID }));
  return value && typeof value === "object" ? value as Json : {};
}
async function sessionDirectory(ctx: SessionAPI, sessionID: string): Promise<string | undefined> {
  const info = await sessionInfo(ctx, sessionID);
  const directory = info.location?.directory;
  return typeof directory === "string" && directory.length > 0 ? directory : undefined;
}
async function currentUsage(ctx: SessionAPI, sessionID: string): Promise<Usage> {
  const info = await sessionInfo(ctx, sessionID);
  return normalizeUsage(info.tokens ?? info.usage ?? info.tokenUsage);
}
const usageDelta = (current: Usage, baseline: Usage): Usage => ({
  input: Math.max(0, current.input - baseline.input),
  output: Math.max(0, current.output - baseline.output),
  cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
  cacheRead: 0,
});
const usageTotal = (value: Usage): number => value.input + value.output + value.cacheWrite;
function agentText(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (value && typeof value === "object") {
    const id = (value as any).id ?? (value as any).name ?? (value as any).agent;
    return typeof id === "string" ? id.toLowerCase() : "";
  }
  return "";
}
function modeText(info: Json): string {
  const value = info.mode ?? info.modeName ?? info.state?.mode ?? info.sessionMode;
  return (typeof value === "string" ? value : agentText(value)).toLowerCase();
}
function objectModeEnabled(value: any): boolean { return Boolean(value && typeof value === "object" && (value.enabled === true || value.active === true || value.paused === true)); }
function planGuard(info: Json): string | undefined {
  const agent = agentText(info.agent ?? info.agentID);
  const mode = modeText(info);
  if (agent === "plan" || mode === "plan" || mode === "plan_paused" || mode === "paused_plan" || info.planMode === true || info.planModePaused === true || info.planPaused === true || objectModeEnabled(info.plan) || objectModeEnabled(info.planMode)) return "сначала выйди из plan mode — /goal заблокирован";
  return undefined;
}
function vibeGuard(info: Json, sessionID: string): string | undefined {
  const agent = agentText(info.agent ?? info.agentID);
  const mode = modeText(info);
  if (agent === "vibe" || agent === "vibe-director" || mode === "vibe" || info.vibeMode === true || objectModeEnabled(info.vibe)) return "сначала выйди из vibe mode — /goal заблокирован";
  try {
    const raw = JSON.parse(readFileSync(join(VIBE_STATE_DIR, `${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`), "utf8"));
    if (raw?.enabled === true || raw?.active === true) return "сначала выйди из vibe mode — /goal заблокирован";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`vibe state read ${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}
async function goalGuard(ctx: SessionAPI, sessionID: string): Promise<string | undefined> {
  // V2 has no verified public settings/config getter.  Do not invent
  // session.info.settings or session.info.config: those fields are not public.
  const info = await sessionInfo(ctx, sessionID);
  return planGuard(info) ?? vibeGuard(info, sessionID);
}

// ---------------------------------------------------------------- execution events

type ExecTick = { type: "started" | "succeeded" | "failed" | "interrupted"; reason?: string; at: number };
const execTicks = new Map<string, ExecTick[]>();
const idleTicks = new Map<string, number>();
const eventWaiters = new Map<string, Set<() => void>>();
const conditionControllers = new Map<string, AbortController>();
const loopActivities = new Map<string, AbortController>();
const eventBindings = new WeakMap<object, { controller: AbortController; stop: () => Promise<void> }>();
const toolContexts = new Set<PluginCtx>();
const sessionContexts = new Map<string, PluginCtx>();
const drivers = new Map<string, Driver>();
type Driver = { ctx: PluginCtx; promise: Promise<void> };

function noteExec(sessionID: string, type: ExecTick["type"], reason?: string): void {
  const list = execTicks.get(sessionID) ?? [];
  list.push({ type, reason, at: Date.now() });
  if (list.length > 64) list.shift();
  execTicks.set(sessionID, list);
}
function noteIdle(sessionID: string): void {
  idleTicks.set(sessionID, Date.now());
  const waiters = eventWaiters.get(sessionID);
  if (waiters) {
    for (const resolve of [...waiters]) resolve();
    eventWaiters.delete(sessionID);
  }
}
function waitForEvent(sessionID: string, signal?: AbortSignal): Promise<void> {
  const waiters = eventWaiters.get(sessionID) ?? new Set<() => void>();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(10, pollMs()));
    waiters.add(finish);
    eventWaiters.set(sessionID, waiters);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
function terminalSince(sessionID: string, since: number): ExecTick | undefined {
  const events = (execTicks.get(sessionID) ?? []).filter((entry) => entry.at >= since);
  for (let index = events.length - 1; index >= 0; index -= 1) if (events[index].type !== "started") return events[index];
  return undefined;
}
function processEvent(raw: unknown): void {
  const envelope: any = raw && typeof raw === "object" && "event" in raw && raw.event && typeof raw.event === "object" ? raw.event : raw;
  const type = typeof envelope?.type === "string" ? envelope.type : "";
  const data = envelope?.data;
  if (!type.startsWith("session.") || typeof data?.sessionID !== "string") return;
  if (type.startsWith("session.execution.")) noteExec(data.sessionID, type.slice("session.execution.".length) as ExecTick["type"], typeof data.reason === "string" ? data.reason : undefined);
  if (type === "session.idle") noteIdle(data.sessionID);
}
function bindEvents(ctx: PluginCtx): { stop: () => Promise<void> } {
  const old = eventBindings.get(ctx as object);
  if (old) return old;
  const controller = new AbortController();
  const promise = (async () => {
    while (!controller.signal.aborted) {
      try {
        const subscribe = ctx.event?.subscribe;
        if (typeof subscribe !== "function") return;
        for await (const raw of subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break;
          processEvent(raw);
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`event subscription: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!controller.signal.aborted) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
  const stop = async (): Promise<void> => {
    controller.abort();
    for (const waiters of eventWaiters.values()) for (const resolve of waiters) resolve();
    eventWaiters.clear();
    await promise.catch((error) => log(`event subscription shutdown: ${error instanceof Error ? error.message : String(error)}`));
  };
  const binding = { controller, stop };
  eventBindings.set(ctx as object, binding);
  return binding;
}

// ---------------------------------------------------------------- bounded child process / conditions

type RunResult = { status: number | null; stdout: string; stderr: string; error?: string; timedOut?: boolean; aborted?: boolean; truncated?: boolean };
type Bounded = { value: string; bytes: number; truncated: boolean };
function appendBounded(current: Bounded, chunk: Buffer, limit = CONDITION_OUTPUT_LIMIT): Bounded {
  const text = chunk.toString();
  const combined = current.value + text;
  if (Buffer.byteLength(combined, "utf8") <= limit) return { value: combined, bytes: current.bytes + Buffer.byteLength(text, "utf8"), truncated: current.truncated };
  const bytes = Buffer.byteLength(combined, "utf8");
  const kept = combined.slice(-limit);
  return { value: kept, bytes: current.bytes + Buffer.byteLength(text, "utf8"), truncated: true };
}
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}
function runAsync(bin: string, args: string[], options: { timeout: number; cwd?: string; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(bin, args, { cwd: options.cwd || undefined, detached: process.platform !== "win32" }); } catch (error) { resolve({ status: null, stdout: "", stderr: "", error: String(error) }); return; }
    let stdout: Bounded = { value: "", bytes: 0, truncated: false };
    let stderr: Bounded = { value: "", bytes: 0, truncated: false };
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { status: number | null; error?: string; timedOut?: boolean; aborted?: boolean }) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (options.signal && typeof options.signal.removeEventListener === "function") options.signal.removeEventListener("abort", onAbort);
      resolve({ ...result, stdout: stdout.value, stderr: stderr.value, truncated: stdout.truncated || stderr.truncated });
    };
    const onAbort = (): void => { killProcessTree(child); finish({ status: null, aborted: true }); };
    if (options.signal?.aborted) { onAbort(); return; }
    if (options.signal && typeof options.signal.addEventListener === "function") options.signal.addEventListener("abort", onAbort, { once: true });
    timer = options.timeout > 0 ? setTimeout(() => { killProcessTree(child); finish({ status: null, timedOut: true, error: `timeout ${options.timeout}ms` }); }, options.timeout) : undefined;
    child.stdout?.on("data", (data: Buffer) => { stdout = appendBounded(stdout, data); });
    child.stderr?.on("data", (data: Buffer) => { stderr = appendBounded(stderr, data); });
    child.on("error", (error) => finish({ status: null, error: String(error) }));
    child.on("close", (code) => finish({ status: code }));
  });
}
async function evaluateCondition(ctx: SessionAPI, condition: Condition, cwd: string, sessionID: string, signalOrTimeout?: AbortSignal | number, timeout = conditionTimeoutMs()): Promise<{ kind: "continue" | "halt" | "error" | "aborted"; code: number | null; out: string }> {
  const signal = typeof signalOrTimeout === "object" ? signalOrTimeout : undefined;
  const effectiveTimeout = typeof signalOrTimeout === "number" ? signalOrTimeout : timeout;
  // OMP 18.1.21 uses a session-keyed persistent shell.  V2 exposes shell
  // creation hooks, but no public execute/session-shell API, so this is an
  // explicitly one-shot fallback and cannot preserve cd/export state.
  const result = await runAsync("bash", ["-lc", condition.command], { timeout: effectiveTimeout, cwd, signal });
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const out = combined.split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).map((line) => line.slice(-300)).join(" | ").slice(-900);
  if (result.aborted) return { kind: "aborted", code: null, out };
  if (result.timedOut) return { kind: "error", code: null, out: `condition timed out after ${effectiveTimeout}ms${out ? `: ${out}` : ""}` };
  if (result.error) return { kind: "error", code: null, out: result.error };
  if (result.status === 0) return { kind: condition.until ? "halt" : "continue", code: 0, out };
  if (result.status === 1) return { kind: condition.until ? "continue" : "halt", code: 1, out };
  return { kind: "error", code: result.status, out: out || `exit ${result.status}` };
}
async function compactSession(sessionID: string, signal?: AbortSignal): Promise<{ ok: boolean; out: string }> {
  const payload = JSON.stringify({ id: `msg_modes_${Math.random().toString(36).slice(2, 10)}` });
  let last = "";
  for (const bin of [process.env.MODES_OPENCODE_BIN ?? "opencode2", "opencode"]) {
    const result = await runAsync(bin, ["api", "POST", `/api/session/${sessionID}/compact`, "-d", payload], { timeout: 120_000, signal });
    if (!result.error && !result.timedOut && !result.aborted) return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim().slice(0, 200) };
    if (result.aborted) return { ok: false, out: "compact aborted" };
    last = result.error ?? result.stderr ?? `exit ${result.status}`;
  }
  return { ok: false, out: last };
}

// ---------------------------------------------------------------- context / state helpers

const fmt = (n: number | undefined): string => n === undefined ? "—" : String(Math.round(n));
function todosText(goal: GoalState): string {
  if (goal.todos.length === 0) return "Список todo пуст. Добавить — /goal todo <текст> или goal({op:\"todo\", action:\"add\", text}).";
  const done = goal.todos.filter((todo) => todo.done).length;
  return [`Todo: ${done}/${goal.todos.length} закрыто, ${goal.todos.length - done} открыто.`, ...goal.todos.map((todo, i) => `- [${todo.done ? "x" : " "}] ${i + 1}. ${escapeXmlText(todo.text)}`)].join("\n");
}
function remainingTokens(goal: GoalState): string { return goal.tokenBudget === undefined ? "unbounded" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed)); }
function goalContext(goal: GoalState): string {
  const left = goal.turnLimit === undefined ? "без лимита ходов" : `ход ${goal.turns + 1} из ${goal.turnLimit}`;
  const budget = goal.tokenBudget === undefined ? "не задан" : `${fmt(goal.tokensUsed)} из ${fmt(goal.tokenBudget)} (осталось ${remainingTokens(goal)})`;
  return [
    "<system-reminder>", "<goal_context>", `${left}.`, `<objective>${escapeXmlText(goal.objective)}</objective>`,
    `Токенов израсходовано: ${fmt(goal.tokensUsed)}; бюджет: ${budget}.`, `Время: ${Math.floor(goal.timeUsedSeconds)}с.`,
    ...(goal.todos.length ? ["<todo_context>", ...goal.todos.map((todo, i) => `- [${todo.done ? "x" : " "}] ${i + 1}. ${escapeXmlText(todo.text)}`), "</todo_context>"] : []),
    "Не меняй цель на более лёгкую. Перед complete сверь каждый deliverable с текущим состоянием и доказательствами.", "Заверши только вызовом goal({op:\"complete\"}); текст GOAL: DONE не завершает цель.", "</goal_context>", "</system-reminder>",
  ].join("\n");
}
function loopTurns(loop: LoopState): string {
  const total = loop.limit?.kind === "iterations" ? loop.limit.initial : undefined;
  if (loop.status === "off") {
    const sent = Math.max(0, loop.used - 1);
    return total === undefined ? `переотправок сделано ${sent}, лимита нет` : `переотправок сделано ${sent} из ${total}`;
  }
  if (loop.used <= 0) return total === undefined ? "первый ход, лимита нет" : `первый ход; переотправок всего ${total}`;
  const sent = loop.used;
  return total === undefined ? `переотправка ${sent}, лимита нет` : `переотправка ${sent} из ${total} (осталось ${Math.max(0, total - sent)})`;
}
function loopContext(loop: LoopState): string {
  return ["<system-reminder>", "<loop_context>", `Цикл активен: ${loopTurns(loop)}.`, loop.prompt.trim() ? `<task>${escapeXmlText(loop.prompt)}</task>` : "<task>(ждём следующий промпт; он станет первым ходом)</task>", "Продолжай с последнего места; не повторяй сделанное.", "</loop_context>", "</system-reminder>"].join("\n");
}
function humanTime(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}м ${Math.floor(seconds % 60)}с`;
  return `${Math.floor(seconds / 3600)}ч ${Math.floor((seconds % 3600) / 60)}м`;
}
function statusText(sessionID: string): string {
  const env = readEnvelope(sessionID);
  const parts: string[] = [];
  if (env?.goal) {
    const goal = env.goal;
    const status = goal.status === "active" ? "активна" : goal.status;
    const budget = goal.tokenBudget === undefined ? "" : `, токены ${fmt(goal.tokensUsed)}/${fmt(goal.tokenBudget)}`;
    parts.push(`goal ${status}${goal.reason ? ` (${goal.reason})` : ""}, ход ${goal.turns}${goal.turnLimit === undefined ? ", лимита нет" : `/${goal.turnLimit}`}${budget}, время ${humanTime(goal.timeUsedSeconds)}`);
  }
  if (env?.loop && env.loop.status !== "off") {
    const loop = env.loop;
    const condition = loop.condition ? `, условие ${loop.condition.until ? "until" : "while"} '${escapeXmlText(loop.condition.command)}'` : "";
    parts.push(`loop ${loop.status === "paused" ? "на паузе" : "активен"}, ${loopTurns(loop)}${condition}`);
  }
  return parts.length ? `modes: ${parts.join("; ")}` : "modes: ничего не активно. /goal <цель> | /loop <задача>";
}
function isTokenCurrent(sessionID: string, kind: "goal" | "loop", token: string, generation?: number): boolean {
  const mode = readEnvelope(sessionID)?.[kind];
  return Boolean(mode && mode.token === token && (generation === undefined || mode.generation === generation));
}
function ownerIsCurrent(owner: Owner | undefined): boolean { return ownerMatchesCurrentProcess(owner); }

// ---------------------------------------------------------------- goal accounting

const flushTails = new Map<string, Promise<unknown>>();
function goalBudgetReached(goal: GoalState): boolean { return goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget; }
async function flushGoalUsage(ctx: SessionAPI, sessionID: string, goal: GoalState, final = false, expectedGeneration = goal.generation): Promise<GoalState | undefined> {
  const key = `${sessionID}:${goal.token}`;
  const previous = flushTails.get(key) ?? Promise.resolve();
  let resolveTask: (value: GoalState | undefined) => void = () => {};
  let rejectTask: (error: unknown) => void = () => {};
  const task = new Promise<GoalState | undefined>((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
  flushTails.set(key, task);
  await previous.catch(() => undefined);
  try {
    const current = await currentUsage(ctx, sessionID);
    const result = mutateEnvelope(sessionID, (env) => {
      const live = env.goal;
      if (!live || live.token !== goal.token || live.generation !== expectedGeneration) return NO_WRITE;
      const now = Date.now();
      const delta = live.usageInitialized ? usageDelta(current, live.usageBaseline) : emptyUsage();
      const wallSeconds = Math.max(0, Math.floor((now - live.lastAccountedAt) / 1000));
      const tokens = usageTotal(delta);
      if (!live.usageInitialized) {
        live.usageBaseline = current;
        live.usageInitialized = true;
        live.lastAccountedAt = now;
        live.finalFlushPending = final ? false : live.finalFlushPending;
        return clone(live);
      }
      if (tokens === 0 && wallSeconds === 0 && !final) return clone(live);
      live.tokensUsed += tokens;
      live.timeUsedSeconds += wallSeconds;
      live.usageBaseline = current;
      live.lastAccountedAt = now;
      live.finalFlushPending = final ? false : live.finalFlushPending;
      if (goalBudgetReached(live) && live.status === "active") {
        live.status = "budget-limited";
        live.reason = "бюджет токенов исчерпан";
        live.generation += 1;
        live.turnInFlight = false;
        live.pendingFirst = false;
        live.manualTurnPending = false;
      }
      return clone(live);
    });
    resolveTask(result);
    return result;
  } catch (error) {
    rejectTask(error);
    throw error;
  } finally {
    if (flushTails.get(key) === task) flushTails.delete(key);
  }
}
async function flushGoalFromState(ctx: SessionAPI, sessionID: string, token: string, final = false): Promise<GoalState | undefined> {
  const goal = readEnvelope(sessionID)?.goal;
  if (!goal || goal.token !== token) return undefined;
  return flushGoalUsage(ctx, sessionID, goal, final);
}

async function flushGoalForCommand(ctx: SessionAPI, sessionID: string, goal: GoalState): Promise<GoalState | undefined> {
  let candidate = goal;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const flushed = await flushGoalUsage(ctx, sessionID, candidate, true, candidate.generation);
    if (flushed) return flushed;
    const latest = readEnvelope(sessionID)?.goal;
    if (!latest || latest.token !== candidate.token || goalTerminal(latest) || latest.status !== candidate.status) return undefined;
    candidate = latest;
  }
  return undefined;
}

// ---------------------------------------------------------------- message/manual helpers

async function userMessages(ctx: SessionAPI, sessionID: string): Promise<Message[]> {
  return (await snapshot(ctx, sessionID)).all.filter((m) => isUser(m) && !isInternalUser(m));
}
async function userCount(ctx: SessionAPI, sessionID: string): Promise<number> { return (await userMessages(ctx, sessionID)).length; }
async function waitForNewUser(ctx: SessionAPI, sessionID: string, after: number, isAlive: () => boolean): Promise<{ text: string; count: number } | undefined> {
  const deadline = Date.now() + waitTimeoutMs();
  while (Date.now() < deadline) {
    if (!isAlive()) return undefined;
    const users = await userMessages(ctx, sessionID);
    if (users.length > after) {
      const message = users.at(-1);
      const text = message ? userText(message) : "";
      if (text) return { text, count: users.length };
    }
    await tick();
  }
  return undefined;
}
async function waitForTurn(ctx: SessionAPI, sessionID: string, before: Snapshot, since: number, isAlive: () => boolean): Promise<TurnResult | undefined> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  const startLimit = startTimeoutMs();
  const seen = new Set(before.assistants.map((m) => m.id).filter(Boolean));
  let started = false;
  const initialIdle = idleTicks.get(sessionID) ?? 0;
  while (Date.now() < deadline) {
    if (!isAlive()) return { outcome: "cancelled" };
    const snap = await snapshot(ctx, sessionID);
    const fresh = snap.assistants.filter((m) => m.id && !seen.has(m.id));
    const hasStarted = fresh.length > 0 || (snap.idleID !== undefined && snap.idleID !== before.idleID) || terminalSince(sessionID, since) !== undefined;
    if (hasStarted) started = true;
    if (!started && startLimit > 0 && Date.now() - since >= startLimit) return { outcome: "not-started" };
    // A terminal execution event is not enough.  The public session can still
    // be doing post-turn work, and dev-19846 can publish terminal before idle.
    // The only settlement boundary accepted here is a new idle message/event.
    const eventIdle = (idleTicks.get(sessionID) ?? 0) > initialIdle;
    if (snap.idleID !== undefined && snap.idleID !== before.idleID && (eventIdle || snap.idleID !== undefined)) {
      return { last: snap.last, tools: fresh.some(hadToolCall) || snap.assistants.at(-1) === snap.last && hadToolCall(snap.last), outcome: snap.idleOutcome ?? terminalSince(sessionID, since)?.type, reason: terminalSince(sessionID, since)?.reason };
    }
    if (eventIdle) {
      const afterEvent = await snapshot(ctx, sessionID);
      if (afterEvent.idleID !== undefined && afterEvent.idleID !== before.idleID) return { last: afterEvent.last, tools: afterEvent.assistants.some((m) => m.id && !seen.has(m.id) && hadToolCall(m)), outcome: afterEvent.idleOutcome ?? "succeeded" };
    }
    await waitForEvent(sessionID).then(() => undefined).catch(() => undefined);
    if (pollMs() === 0) await immediateForCompatibility();
  }
  return { outcome: "not-settled", last: (await snapshot(ctx, sessionID)).last, tools: false };
}
const immediateForCompatibility = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
async function submitVisible(ctx: SessionAPI, sessionID: string, text: string, delivery?: "steer" | "queue", metadata?: Record<string, unknown>): Promise<unknown> {
  return await ctx.prompt({ sessionID, text, ...(delivery ? { delivery } : {}), ...(metadata ? { metadata } : {}) });
}
async function submitHidden(ctx: SessionAPI, sessionID: string, text: string): Promise<unknown> {
  return await ctx.synthetic({ sessionID, text, resume: true });
}
async function say(ctx: SessionAPI, sessionID: string, text: string): Promise<void> {
  await ctx.synthetic({ sessionID, text, description: "modes", resume: false });
}

// ---------------------------------------------------------------- driver / coordinator

function failCoordinatorState(sessionID: string, error: unknown): void {
  const reason = `coordinator error: ${error instanceof Error ? error.message : String(error)}`;
  const env = readEnvelope(sessionID);
  if (env?.goal?.status === "active") transitionGoal(sessionID, env.goal.token, ["active"], { status: "paused", reason, turnInFlight: false, pendingFirst: false, manualTurnPending: false });
  if (env?.loop && env.loop.status !== "off") transitionLoop(sessionID, env.loop.token, ["active", "paused"], { status: "off", reason });
  log(reason);
}
function ensureDriver(ctx: PluginCtx, sessionID: string): void {
  sessionContexts.set(sessionID, ctx);
  const old = drivers.get(sessionID);
  if (old) return;
  const driver: Driver = { ctx, promise: Promise.resolve() };
  drivers.set(sessionID, driver);
  driver.promise = Promise.resolve().then(() => runCoordinator(ctx, sessionID, driver)).catch((error) => failCoordinatorState(sessionID, error)).finally(() => { if (drivers.get(sessionID) === driver) drivers.delete(sessionID); });
}
function driverIsCurrent(driver: Driver, sessionID: string): boolean { return drivers.get(sessionID) === driver; }

async function pauseGoalForGuard(ctx: PluginCtx, sessionID: string, goal: GoalState): Promise<boolean> {
  const guard = await goalGuard(ctx.session, sessionID);
  if (!guard) return false;
  if (isTokenCurrent(sessionID, "goal", goal.token, goal.generation)) {
    transitionGoal(sessionID, goal.token, ["active"], { status: "paused", reason: guard, turnInFlight: false, pendingFirst: false, manualTurnPending: false });
    await say(ctx.session, sessionID, `modes: ${guard}; goal continuation остановлена.`);
  }
  return true;
}

async function runCoordinator(ctx: PluginCtx, sessionID: string, driver: Driver): Promise<void> {
  while (driverIsCurrent(driver, sessionID)) {
    const env = readEnvelope(sessionID);
    if (!env || !anyModeActive(env)) return;
    if (env.goal?.status === "active") {
      if (env.goal.pendingFirst) await coordinateGoalFirst(ctx, sessionID, env.goal, driver);
      else await coordinateGoal(ctx, sessionID, env.goal, driver);
      continue;
    }
    if (loopEnabled(env)) {
      await coordinateLoop(ctx, sessionID, env.loop as LoopState, driver);
      continue;
    }
    return;
  }
}

async function claimGoal(sessionID: string, goal: GoalState, kind: "first" | "hidden"): Promise<ModeClaim | undefined> {
  const result = mutateEnvelope(sessionID, (env) => {
    const live = env.goal;
    if (!live || live.token !== goal.token || live.generation !== goal.generation || live.status !== "active" || live.turnInFlight) return NO_WRITE;
    live.generation += 1;
    live.turnInFlight = true;
    live.manualTurnPending = false;
    live.pendingFirst = kind === "first" ? false : live.pendingFirst;
    live.turnKind = kind;
    Object.assign(live, ownerPatch());
    return { token: live.token, generation: live.generation };
  });
  return result === NO_WRITE ? undefined : result as ModeClaim | undefined;
}
function patchGoalClaim(sessionID: string, claim: ModeClaim, patch: Partial<GoalState>, statuses: GoalStatus[] = ["active"]): boolean {
  return patchMode(sessionID, "goal", claim.token, patch, { generation: claim.generation, status: statuses[0] }) && (statuses.length === 1 || statuses.every((status) => status === statuses[0]));
}
function patchGoalClaimAny(sessionID: string, claim: ModeClaim, patch: Partial<GoalState>, statuses: GoalStatus[]): boolean {
  return withStateLock(sessionID, (existing) => {
    const goal = existing?.goal;
    if (!goal || goal.token !== claim.token || goal.generation !== claim.generation || !statuses.includes(goal.status)) return false;
    Object.assign(goal, patch);
    goal.updatedAt = Date.now();
    existing.revision += 1;
    existing.updatedAt = Date.now();
    writeEnvelopeUnlocked(existing);
    return true;
  });
}
async function coordinateGoalFirst(ctx: PluginCtx, sessionID: string, goal: GoalState, driver: Driver): Promise<void> {
  if (await pauseGoalForGuard(ctx, sessionID, goal)) return;
  const claim = await claimGoal(sessionID, goal, "first");
  if (!claim) return;
  const before = await snapshot(ctx.session, sessionID);
  const since = Date.now();
  if (await pauseGoalForGuard(ctx, sessionID, { ...goal, generation: claim.generation })) return;
  try {
    await submitVisible(ctx.session, sessionID, goal.objective, undefined, { modesStation: "goal-first" });
  } catch (error) {
    patchGoalClaimAny(sessionID, claim, { status: "paused", pendingFirst: true, turnInFlight: false, reason: `первый prompt не принят: ${error instanceof Error ? error.message : String(error)}` }, ["active"]);
    return;
  }
  const turn = await waitForTurn(ctx.session, sessionID, before, since, () => driverIsCurrent(driver, sessionID) && isTokenCurrent(sessionID, "goal", claim.token, claim.generation));
  if (!turn || turn.outcome === "cancelled" || turn.outcome === "not-started" || turn.outcome === "not-settled") {
    patchGoalClaimAny(sessionID, claim, { status: "paused", turnInFlight: false, pendingFirst: turn?.outcome === "not-started", manualTurnPending: false, reason: turn?.outcome === "not-started" ? "ход не поднялся" : turn?.outcome === "not-settled" ? "ход не дошёл до idle" : "первый ход прерван или снят" }, ["active"]);
    return;
  }
  await finishGoalTurn(ctx, sessionID, claim, turn, "first");
}
async function coordinateGoal(ctx: PluginCtx, sessionID: string, goal: GoalState, driver: Driver): Promise<void> {
  if (await pauseGoalForGuard(ctx, sessionID, goal)) return;
  if (goal.manualTurnPending) {
    const before = await snapshot(ctx.session, sessionID);
    const since = Date.now();
    const turn = await waitForTurn(ctx.session, sessionID, before, since, () => driverIsCurrent(driver, sessionID) && isTokenCurrent(sessionID, "goal", goal.token, goal.generation));
    if (turn && !["cancelled", "not-started", "not-settled"].includes(turn.outcome ?? "")) {
      const claim = { token: goal.token, generation: goal.generation };
      patchGoalClaimAny(sessionID, claim, { manualTurnPending: false }, ["active"]);
      await finishGoalTurn(ctx, sessionID, claim, turn, "manual");
    } else if (turn?.outcome === "not-started" || turn?.outcome === "not-settled") {
      patchGoalClaimAny(sessionID, goal, { status: "paused", manualTurnPending: false, reason: "ручной ход не дошёл до idle" }, ["active"]);
    }
    return;
  }
  if (goal.waitingUser) {
    const deadline = Date.now() + waitTimeoutMs();
    while (Date.now() < deadline && driverIsCurrent(driver, sessionID) && isTokenCurrent(sessionID, "goal", goal.token, goal.generation)) {
      const snap = await snapshot(ctx.session, sessionID);
      const users = snap.all.filter((m) => isUser(m) && !isInternalUser(m));
      if (users.length > (goal.userSeen ?? 0)) {
        const newest = users.at(-1);
        const text = newest ? userText(newest) : "";
        if (text) {
          const index = snap.all.lastIndexOf(newest);
          const after = snap.all.slice(index + 1);
          if (after.some(isAssistant) && after.some(isIdle)) {
            const claim = { token: goal.token, generation: goal.generation };
            if (patchGoalClaimAny(sessionID, claim, { waitingUser: false, lastTurnWasHidden: false, userSeen: users.length, turnKind: "manual" }, ["active"])) await finishGoalTurn(ctx, sessionID, claim, { last: snap.last, tools: snap.last ? hadToolCall(snap.last) : false, outcome: snap.idleOutcome }, "manual");
            return;
          }
        }
      }
      await tick();
    }
    if (isTokenCurrent(sessionID, "goal", goal.token, goal.generation)) transitionGoal(sessionID, goal.token, ["active"], { status: "paused", reason: "ожидание человека истекло" });
    return;
  }
  if (goal.turnLimit !== undefined && goal.turns >= goal.turnLimit) {
    transitionGoal(sessionID, goal.token, ["active"], { status: "paused", reason: `лимит ${goal.turnLimit} ходов` });
    return;
  }
  const flushed = await flushGoalFromState(ctx.session, sessionID, goal.token);
  if (!flushed) return;
  const current = readEnvelope(sessionID)?.goal;
  if (!current || current.status !== "active") return;
  // Goal has priority over loop.  Loop remains persisted and resumes after
  // complete/drop/pause; it can never steal the goal objective as its body.
  if (goalBudgetReached(current)) {
    transitionGoal(sessionID, current.token, ["active"], { status: "budget-limited", reason: "бюджет токенов исчерпан" });
    const limited = readEnvelope(sessionID)?.goal;
    if (limited) await notifyGoalBudget(ctx, sessionID, limited);
    return;
  }
  const claim = await claimGoal(sessionID, current, "hidden");
  if (!claim) return;
  if (await pauseGoalForGuard(ctx, sessionID, { ...current, generation: claim.generation })) return;
  const before = await snapshot(ctx.session, sessionID);
  const since = Date.now();
  try {
    await submitHidden(ctx.session, sessionID, goalTurnText(current));
  } catch (error) {
    patchGoalClaimAny(sessionID, claim, { status: "paused", turnInFlight: false, reason: `continuation не принят: ${error instanceof Error ? error.message : String(error)}` }, ["active"]);
    return;
  }
  const turn = await waitForTurn(ctx.session, sessionID, before, since, () => driverIsCurrent(driver, sessionID) && isTokenCurrent(sessionID, "goal", claim.token, claim.generation));
  if (!turn || ["cancelled", "not-started", "not-settled"].includes(turn.outcome ?? "")) {
    patchGoalClaimAny(sessionID, claim, { status: "paused", turnInFlight: false, reason: turn?.outcome === "not-started" ? "ход не поднялся" : turn?.outcome === "not-settled" ? "ход не дошёл до idle" : "continuation прерван" }, ["active"]);
    return;
  }
  await finishGoalTurn(ctx, sessionID, claim, turn, "hidden");
}
function goalTurnText(goal: GoalState): string {
  return [
    "Продолжай активную цель.",
    `<objective>\n${escapeXmlText(goal.objective)}\n</objective>`,
    goal.turnLimit === undefined ? "Лимита ходов нет." : `Ход ${goal.turns + 1} из ${goal.turnLimit}.`,
    `Токены: ${fmt(goal.tokensUsed)}; бюджет: ${goal.tokenBudget === undefined ? "без лимита" : `${fmt(goal.tokenBudget)}`}; remaining tokens: ${remainingTokens(goal)}.`,
    `Время: ${goal.timeUsedSeconds} секунд.`,
    "Не меняй цель на меньшую. Перед complete проверь objective → deliverables → authoritative evidence.",
    "Прочитай текущие файлы и запусти релевантные проверки; verification scope должна совпадать с claim scope.",
    "Неполное доказательство означает «продолжать», не «готово». Budget exhaustion ≠ completion.",
    "Заверши только через goal({op:\"complete\"}); GOAL: DONE не завершает цель.",
  ].join("\n");
}
function budgetSteerText(goal: GoalState): string {
  return [
    "BUDGET LIMIT: лимит токенов цели исчерпан.",
    `Токены: ${fmt(goal.tokensUsed)}; бюджет: ${goal.tokenBudget === undefined ? "без лимита" : fmt(goal.tokenBudget)}.`,
    "Не продолжай автоматически и не выдавай частичный результат за completion.",
    "Сделай только финальную проверку. Если objective доказан, вызови goal({op:\"complete\"}); иначе остановись и сообщи, чего не хватило.",
  ].join("\n");
}

async function notifyGoalBudget(ctx: PluginCtx, sessionID: string, goal: GoalState): Promise<void> {
  if (goal.status !== "budget-limited" || !goalBudgetReached(goal) || goal.budgetNoticeGeneration === goal.generation) return;
  const generation = goal.generation;
  const claimed = mutateEnvelope(sessionID, (fresh) => {
    const live = fresh.goal;
    if (!live || live.token !== goal.token || live.generation !== generation || live.status !== "budget-limited") return NO_WRITE;
    live.budgetNoticeGeneration = generation;
    return true;
  });
  if (!claimed) return;
  try {
    await ctx.session.synthetic({ sessionID, text: budgetSteerText(goal), description: "modes", resume: true });
    const latest = readEnvelope(sessionID)?.goal;
    if (latest) await flushGoalUsage(ctx.session, sessionID, latest);
  } catch (error) {
    log(`budget steer failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function installGoalAccounting(ctx: PluginCtx): Promise<Registration | undefined> {
  const hook = ctx.tool?.hook;
  if (typeof hook !== "function") return undefined;
  try {
    return await hook("execute.after", async (payload: any) => {
      const sessionID = String(payload?.sessionID ?? "");
      const tool = String(payload?.tool ?? "");
      if (!sessionID || !tool || tool === "goal") return;
      const before = readEnvelope(sessionID)?.goal;
      if (!before || before.status !== "active") return;
      const flushed = await flushGoalUsage(ctx.session, sessionID, before);
      const current = flushed ?? readEnvelope(sessionID)?.goal;
      if (current) await notifyGoalBudget(ctx, sessionID, current);
    });
  } catch (error) {
    log(`goal accounting hook failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function finishGoalTurn(ctx: PluginCtx, sessionID: string, claim: ModeClaim, turn: TurnResult, kind: "first" | "hidden" | "manual"): Promise<void> {
  const current = readEnvelope(sessionID)?.goal;
  if (!current || current.token !== claim.token || current.generation !== claim.generation) return;
  const flushed = await flushGoalUsage(ctx.session, sessionID, current, current.finalFlushPending === true);
  if (!flushed || flushed.token !== claim.token) return;
  if (flushed.generation !== claim.generation) {
    if (goalBudgetReached(flushed)) await notifyGoalBudget(ctx, sessionID, flushed);
    return;
  }
  if (flushed.status === "complete" || flushed.status === "dropped") return;
  if (turn.outcome === "interrupted" || turn.outcome === "cancelled") {
    patchGoalClaimAny(sessionID, claim, { status: "paused", turnInFlight: false, lastTurnHadTools: turn.tools, lastTurnWasHidden: kind === "hidden", reason: "ход прерван — цель на паузе" }, ["active"]);
    await say(ctx.session, sessionID, "modes: ход прерван; цель на паузе. Продолжить: /goal resume.");
    return;
  }
  const users = await userCount(ctx.session, sessionID);
  const patch: Partial<GoalState> = { turns: flushed.turns + 1, turnInFlight: false, lastTurnHadTools: turn.tools, lastTurnWasHidden: kind === "hidden", waitingUser: false, manualTurnPending: false, finalFlushPending: false, userSeen: users };
  if (kind === "hidden" && !turn.tools) {
    patch.waitingUser = true;
    patch.userSeen = users;
  }
  patchGoalClaimAny(sessionID, claim, patch, ["active"]);
  if (patch.waitingUser) await say(ctx.session, sessionID, "modes: скрытый continuation без инструментов; жду ручной prompt. Цель не завершена.");
  const after = readEnvelope(sessionID)?.goal;
  if (after && goalBudgetReached(after)) {
    transitionGoal(sessionID, after.token, ["active"], { status: "budget-limited", reason: "бюджет токенов исчерпан" });
    const limited = readEnvelope(sessionID)?.goal;
    if (limited) await notifyGoalBudget(ctx, sessionID, limited);
  }
}

// ---------------------------------------------------------------- loop coordinator

function beginLoopActivity(sessionID: string, token: string): AbortController {
  conditionControllers.get(sessionID)?.abort();
  loopActivities.get(sessionID)?.abort();
  const controller = new AbortController();
  conditionControllers.set(sessionID, controller);
  loopActivities.set(sessionID, controller);
  void token;
  return controller;
}
function endLoopActivity(sessionID: string, controller: AbortController): void {
  if (conditionControllers.get(sessionID) === controller) conditionControllers.delete(sessionID);
  if (loopActivities.get(sessionID) === controller) loopActivities.delete(sessionID);
}
function cancelLoopActivity(sessionID: string): void {
  conditionControllers.get(sessionID)?.abort();
  loopActivities.get(sessionID)?.abort();
  conditionControllers.delete(sessionID);
  loopActivities.delete(sessionID);
}
function loopClaimCurrent(sessionID: string, loop: LoopState): boolean { return isTokenCurrent(sessionID, "loop", loop.token, loop.generation); }
function claimLoopSubmit(sessionID: string, loop: LoopState, first: boolean): LoopState | undefined {
  return mutateEnvelope(sessionID, (env) => {
    if (env.goal?.status === "active") return NO_WRITE;
    const live = env.loop;
    if (!live || live.token !== loop.token || live.generation !== loop.generation || live.status !== "active" || live.manualTurnPending) return NO_WRITE;
    if (live.limit?.kind === "iterations" && !first && live.limit.remaining <= 0) return NO_WRITE;
    if (!first && live.limit?.kind === "iterations") live.limit = { ...live.limit, remaining: live.limit.remaining - 1 };
    live.generation += 1;
    live.manualTurnPending = false;
    Object.assign(live, ownerPatch());
    return clone(live);
  });
}
async function finishLoopTurn(ctx: PluginCtx, sessionID: string, claim: LoopState, turn: TurnResult): Promise<void> {
  const loop = readEnvelope(sessionID)?.loop;
  if (!loop || loop.token !== claim.token || loop.generation !== claim.generation) return;
  if (turn.outcome === "interrupted" || turn.outcome === "cancelled") {
    patchMode(sessionID, "loop", claim.token, { status: "paused", awaitingBody: true, pausedReason: "streaming aborted; loop remains enabled", userSeen: await userCount(ctx.session, sessionID), lastTurnHadTools: turn.tools }, { generation: claim.generation, status: "active" });
    await say(ctx.session, sessionID, "modes: streaming прерван; loop остаётся включён. Следующий ручной prompt заменит тело.");
    return;
  }
  const users = await userCount(ctx.session, sessionID);
  patchMode(sessionID, "loop", claim.token, { used: loop.used + 1, userSeen: users, status: "active", awaitingBody: false, manualTurnPending: false, lastTurnHadTools: turn.tools }, { generation: claim.generation, status: "active" });
}
async function coordinateLoop(ctx: PluginCtx, sessionID: string, loop: LoopState, driver: Driver): Promise<void> {
  if (loop.status === "off" || !driverIsCurrent(driver, sessionID)) return;
  const envNow = readEnvelope(sessionID);
  if (envNow?.goal?.status === "active") return;
  if (loop.manualTurnPending) {
    const before = await snapshot(ctx.session, sessionID);
    const since = Date.now();
    const turn = await waitForTurn(ctx.session, sessionID, before, since, () => driverIsCurrent(driver, sessionID) && loopClaimCurrent(sessionID, loop));
    if (turn && !["cancelled", "not-started", "not-settled"].includes(turn.outcome ?? "")) {
      const latest = readEnvelope(sessionID)?.loop;
      if (latest && latest.token === loop.token) await finishLoopTurn(ctx, sessionID, latest, turn);
    } else if (turn?.outcome === "not-started" || turn?.outcome === "not-settled") {
      transitionLoop(sessionID, loop.token, ["active"], { status: "paused", awaitingBody: true, reason: "ручной prompt не дал idle" });
    }
    return;
  }
  if (loop.status === "paused" || loop.awaitingBody) {
    const before = await snapshot(ctx.session, sessionID);
    const arrived = await waitForNewUser(ctx.session, sessionID, loop.userSeen, () => driverIsCurrent(driver, sessionID) && loopClaimCurrent(sessionID, loop));
    if (!arrived) {
      if (loopClaimCurrent(sessionID, loop)) transitionLoop(sessionID, loop.token, ["active", "paused"], { status: "off", reason: "ожидание промпта истекло" });
      return;
    }
    const current = readEnvelope(sessionID)?.loop;
    if (!current || current.token !== loop.token || readEnvelope(sessionID)?.goal?.status === "active") return;
    const arrivedSnapshot = await snapshot(ctx.session, sessionID);
    const arrivedUser = arrivedSnapshot.all.filter((m) => isUser(m) && !isInternalUser(m)).at(-1);
    const arrivedIndex = arrivedUser ? arrivedSnapshot.all.lastIndexOf(arrivedUser) : -1;
    const arrivedDone = arrivedIndex >= 0 && arrivedSnapshot.all.slice(arrivedIndex + 1).some(isAssistant) && arrivedSnapshot.all.slice(arrivedIndex + 1).some(isIdle);
    if (!transitionLoop(sessionID, loop.token, ["active", "paused"], { prompt: arrived.text, objective: arrived.text, status: "active", awaitingBody: false, userSeen: arrived.count, manualTurnPending: false, pausedReason: undefined, ...ownerPatch() })) return;
    const updated = readEnvelope(sessionID)?.loop;
    if (arrivedDone) {
      if (updated) {
        const turn: TurnResult = { last: arrivedSnapshot.last, tools: arrivedSnapshot.last ? hadToolCall(arrivedSnapshot.last) : false, outcome: arrivedSnapshot.idleOutcome };
        await finishLoopTurn(ctx, sessionID, updated, turn);
      }
      return;
    }
    const beforeTurn = await snapshot(ctx.session, sessionID);
    const since = Date.now();
    const turn = await waitForTurn(ctx.session, sessionID, beforeTurn, since, () => driverIsCurrent(driver, sessionID) && loopClaimCurrent(sessionID, updated as LoopState));
    if (turn && !["cancelled", "not-started", "not-settled"].includes(turn.outcome ?? "")) await finishLoopTurn(ctx, sessionID, readEnvelope(sessionID)?.loop as LoopState, turn);
    return;
  }
  const currentSnapshot = await snapshot(ctx.session, sessionID);
  const users = currentSnapshot.all.filter((m) => isUser(m) && !isInternalUser(m));
  if (users.length > loop.userSeen) {
    const newestUser = users.at(-1);
    const manual = newestUser ? userText(newestUser) : "";
    if (manual) {
      const userIndex = currentSnapshot.all.lastIndexOf(newestUser);
      const afterUser = currentSnapshot.all.slice(userIndex + 1);
      const completed = afterUser.some(isAssistant) && afterUser.some(isIdle);
      transitionLoop(sessionID, loop.token, ["active"], completed ? { prompt: manual, objective: manual, userSeen: users.length, used: loop.used + 1, status: "active", awaitingBody: false } : { prompt: manual, objective: manual, userSeen: Math.max(0, users.length - 1), status: "active", awaitingBody: true });
      return;
    }
  }
  const before = await snapshot(ctx.session, sessionID);
  const now = Date.now();
  if (loop.limit?.kind === "duration" && now >= loop.limit.deadlineMs) {
    transitionLoop(sessionID, loop.token, ["active"], { status: "off", reason: "Loop time limit reached. Loop mode disabled." });
    return;
  }
  if (loop.limit?.kind === "iterations" && loop.used > 0 && loop.limit.remaining <= 0) {
    transitionLoop(sessionID, loop.token, ["active"], { status: "off", reason: "Loop limit reached. Loop mode disabled." });
    return;
  }
  if (loop.condition && loop.used > 0) {
    const liveDirectory = await sessionDirectory(ctx.session, sessionID).catch(() => undefined);
    if (liveDirectory) setCwd(sessionID, liveDirectory);
    const activity = beginLoopActivity(sessionID, loop.token);
    let verdict: Awaited<ReturnType<typeof evaluateCondition>>;
    try {
      verdict = await evaluateCondition(ctx.session, loop.condition, readEnvelope(sessionID)?.cwd ?? process.cwd(), sessionID, activity.signal);
    } finally {
      endLoopActivity(sessionID, activity);
    }
    if (!driverIsCurrent(driver, sessionID) || !loopClaimCurrent(sessionID, loop)) return;
    const latest = readEnvelope(sessionID)?.loop;
    if (!latest || latest.status === "off" || readEnvelope(sessionID)?.goal?.status === "active") return;
    if (verdict.kind === "aborted") return;
    if (verdict.kind === "halt") {
      transitionLoop(sessionID, loop.token, ["active"], { status: "off", reason: `Loop condition '${escapeXmlText(latest.condition?.command ?? "")}' is now satisfied. Loop mode disabled.` });
      return;
    }
    if (verdict.kind === "error") {
      transitionLoop(sessionID, loop.token, ["active"], { status: "off", reason: `Loop condition '${escapeXmlText(latest.condition?.command ?? "")}' failed${verdict.code === null ? "" : ` (exit ${verdict.code})`}. ${verdict.out} Loop mode disabled.` });
      return;
    }
  }
  const afterCondition = readEnvelope(sessionID)?.loop;
  if (!afterCondition || !loopClaimCurrent(sessionID, afterCondition) || readEnvelope(sessionID)?.goal?.status === "active") return;
  if (afterCondition.limit?.kind === "duration" && Date.now() >= afterCondition.limit.deadlineMs) {
    transitionLoop(sessionID, loop.token, ["active"], { status: "off", reason: "Loop time limit reached. Loop mode disabled." });
    return;
  }
  if (afterCondition.used > 0 && afterCondition.compact) {
    const activity = beginLoopActivity(sessionID, loop.token);
    const compacted = await compactSession(sessionID, activity.signal);
    endLoopActivity(sessionID, activity);
    const afterCompact = readEnvelope(sessionID)?.loop;
    if (!afterCompact || !loopClaimCurrent(sessionID, afterCompact) || readEnvelope(sessionID)?.goal?.status === "active") return;
    if (!compacted.ok) {
      transitionLoop(sessionID, loop.token, ["active"], { status: "off", reason: `compact failed: ${compacted.out}` });
      return;
    }
  }
  if (afterCondition.used > 0) {
    const activity = beginLoopActivity(sessionID, loop.token);
    await delay(iterationPauseMs(), activity.signal);
    endLoopActivity(sessionID, activity);
  }
  const beforeSubmit = readEnvelope(sessionID)?.loop;
  if (!beforeSubmit || !loopClaimCurrent(sessionID, beforeSubmit) || beforeSubmit.status !== "active" || readEnvelope(sessionID)?.goal?.status === "active") return;
  if (beforeSubmit.limit?.kind === "duration" && Date.now() >= beforeSubmit.limit.deadlineMs) {
    transitionLoop(sessionID, loop.token, ["active"], { status: "off", reason: "Loop time limit reached. Loop mode disabled." });
    return;
  }
  const claimed = claimLoopSubmit(sessionID, beforeSubmit, beforeSubmit.used === 0);
  if (!claimed) {
    const latest = readEnvelope(sessionID)?.loop;
    if (latest?.status === "active" && latest.limit?.kind === "iterations" && latest.used > 0 && latest.limit.remaining <= 0) transitionLoop(sessionID, latest.token, ["active"], { status: "off", reason: "Loop limit reached. Loop mode disabled." });
    return;
  }
  const beforeTurn = await snapshot(ctx.session, sessionID);
  const since = Date.now();
  try {
    await submitVisible(ctx.session, sessionID, claimed.prompt, "steer", { modesStation: "loop" });
  } catch (error) {
    transitionLoop(sessionID, claimed.token, ["active"], { status: "off", reason: `prompt rejected: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  const turn = await waitForTurn(ctx.session, sessionID, beforeTurn, since, () => driverIsCurrent(driver, sessionID) && loopClaimCurrent(sessionID, claimed));
  if (!turn || turn.outcome === "not-started" || turn.outcome === "not-settled") {
    transitionLoop(sessionID, claimed.token, ["active"], { status: "off", reason: turn?.outcome === "not-settled" ? "turn did not settle" : "prompt did not start a turn" });
    return;
  }
  if (turn.outcome === "cancelled") return;
  await finishLoopTurn(ctx, sessionID, claimed, turn);
}

// ---------------------------------------------------------------- goal tool / dynamic registration

type ToolResult = { content: { type: "text"; text: string }[] };
const toolText = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const toolError = (text: string): ToolResult => toolText(`Ошибка: ${text}`);
const toolCtxID = (toolCtx: any): string => String(toolCtx?.sessionID ?? "");
const toolOp = (args: any): string => String(args?.op ?? "get").toLowerCase();
function goalToolDescription(goal: GoalState | undefined): string { return `Goal: ${goal?.objective ?? "none"}; status=${goal?.status ?? "none"}; tokens=${goal?.tokensUsed ?? 0}`; }
async function goalTool(ctx: PluginCtx, args: any, toolCtx: any): Promise<ToolResult> {
  const sessionID = toolCtxID(toolCtx);
  if (!sessionID) return toolError("sessionID is required");
  const op = toolOp(args);
  try {
    const env = readEnvelope(sessionID);
    const goal = env?.goal;
    if (op === "create") {
      const guard = await goalGuard(ctx.session, sessionID);
      if (guard) return toolError(guard);
      if (goal && !goalTerminal(goal)) return toolError("cannot create a new goal because this session already has a goal");
      if (!interviewActive(env, sessionID)) return toolError("goal create is available only during /guided-goal interview in this session; V2 tool registration is global");
      const objective = String(args?.objective ?? "").trim();
      if (!objective) return toolError("objective is required when op=create");
      const budgetRaw = args?.token_budget ?? args?.tokenBudget;
      const budget = budgetRaw === undefined ? undefined : Number(budgetRaw);
      if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) return toolError("token_budget must be a positive integer when provided");
      const directory = await sessionDirectory(ctx.session, sessionID);
      if (!directory) return toolError("session.get().location.directory is required");
      const usage = await currentUsage(ctx.session, sessionID);
      const token = safeToken();
      const created = mutateEnvelope(sessionID, (fresh) => {
        if (fresh.goal && !goalTerminal(fresh.goal)) return NO_WRITE;
        fresh.cwd = directory;
        fresh.goal = { token, generation: 0, status: "active", objective, prompt: objective, startedAt: Date.now(), updatedAt: Date.now(), turns: 0, tokenBudget: budget, tokensUsed: 0, usageBaseline: usage, usageInitialized: true, timeUsedSeconds: 0, lastAccountedAt: Date.now(), todos: [], waitingUser: false, pendingFirst: false, manualTurnPending: false, ...ownerPatch() };
        fresh.interview = undefined;
        return clone(fresh.goal);
      });
      if (!created) return toolError("goal changed while creating; retry from /guided-goal");
      await markGoalSession(ctx, sessionID, true);
      ensureDriver(ctx, sessionID);
      return toolText(`Goal created: ${objective}. Call get/complete/resume/drop as needed.`);
    }
    if (!goal) return toolError("Goal mode is not active.");
    if (op === "get") return toolText(`${goalToolDescription(goal)}\nStatus: ${goal.status}\nTurns: ${goal.turns}\nTime: ${humanTime(goal.timeUsedSeconds)}`);
    if (op === "complete") {
      if (goal.status === "complete") return toolError("goal is already complete");
      if (goal.status === "dropped") return toolError("cannot complete a dropped goal");
      if (!(["active", "paused", "budget-limited"] as GoalStatus[]).includes(goal.status)) return toolError("cannot complete goal because it is not completable");
      const flushed = await flushGoalForCommand(ctx.session, sessionID, goal);
      if (!flushed) return toolError("goal changed while completing");
      if (!transitionGoal(sessionID, goal.token, ["active", "paused", "budget-limited"], { status: "complete", finalFlushPending: flushed.turnInFlight === true, turnInFlight: flushed.turnInFlight, closed: true, reason: "completed" }, flushed.generation)) return toolError("goal changed while completing; completion was not persisted");
      await markGoalSession(ctx, sessionID, false);
      const fresh = readEnvelope(sessionID)?.goal;
      return toolText(`Goal completed. Tokens: ${fresh?.tokensUsed ?? flushed.tokensUsed}${fresh?.tokenBudget === undefined ? "" : `/${fresh.tokenBudget}`}. Time: ${humanTime(fresh?.timeUsedSeconds ?? flushed.timeUsedSeconds)}.`);
    }
    if (op === "resume") {
      if (goal.status === "complete") return toolError("Goal is already complete.");
      if (goal.status === "dropped") return toolError("cannot resume a dropped goal");
      if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) return toolError("budget exhausted; raise it before resume");
      const usage = await currentUsage(ctx.session, sessionID);
      const token = safeToken();
      if (!transitionGoal(sessionID, goal.token, ["paused", "budget-limited"], { token, status: "active", reason: undefined, usageBaseline: usage, usageInitialized: true, budgetNoticeGeneration: undefined, lastAccountedAt: Date.now(), waitingUser: false, manualTurnPending: false, ...ownerPatch() }, goal.generation)) return toolError("goal changed while resuming");
      await markGoalSession(ctx, sessionID, true);
      ensureDriver(ctx, sessionID);
      return toolText("Goal resumed.");
    }
    if (op === "drop") {
      if (goal.status === "complete") return toolError("goal is already complete");
      if (goal.status === "dropped") return toolError("goal is already dropped");
      const flushed = await flushGoalForCommand(ctx.session, sessionID, goal);
      if (!flushed) return toolError("goal changed while dropping");
      if (!transitionGoal(sessionID, goal.token, ["active", "paused", "budget-limited"], { status: "dropped", finalFlushPending: false, turnInFlight: false, reason: "dropped", closed: true }, flushed.generation)) return toolError("goal changed while dropping; drop was not persisted");
      await markGoalSession(ctx, sessionID, false);
      return toolText("Goal dropped; usage, time, and todos were preserved.");
    }
    if (op === "todo") {
      const action = String(args?.action ?? "list").toLowerCase();
      if (action === "list") return toolText(todosText(goal));
      if (action === "clear") {
        const updated = updateGoalTodos(sessionID, goal.token, () => []);
        return updated ? toolText("Todo list cleared.") : toolError("goal changed");
      }
      if (action === "add") {
        const text = String(args?.text ?? "").trim();
        if (!text) return toolError("text is required for action=add");
        const updated = updateGoalTodos(sessionID, goal.token, (todos) => [...todos, { text, done: false }]);
        return updated ? toolText(`Added.\n${todosText(updated)}`) : toolError("goal changed");
      }
      if (action === "done") {
        const index = Number(args?.index) - 1;
        if (!Number.isSafeInteger(index) || index < 0 || index >= goal.todos.length) return toolError(`todo index is out of range: ${args?.index}`);
        const updated = updateGoalTodos(sessionID, goal.token, (todos) => todos.map((todo, i) => i === index ? { ...todo, done: true } : todo));
        return updated ? toolText(`Todo ${index + 1} completed.\n${todosText(updated)}`) : toolError("goal changed");
      }
      return toolError(`unknown todo action ${action}`);
    }
    return toolError(`unknown goal operation ${op}; use create/get/complete/resume/drop`);
  } catch (error) {
    if (error instanceof StateError) return toolError(`${error.message}; no state transition was reported`);
    throw error;
  }
}

const activeGoalSessions = new Set<string>();
type ToolState = { registered: boolean; registration?: Registration };
const toolStates = new WeakMap<object, ToolState>();
function toolState(ctx: PluginCtx): ToolState {
  let state = toolStates.get(ctx as object);
  if (!state) { state = { registered: false }; toolStates.set(ctx as object, state); toolContexts.add(ctx); }
  return state;
}
function syncActiveGoalSessions(): void {
  activeGoalSessions.clear();
  let files: string[] = [];
  try { files = readdirSync(STATE_DIR).filter((name) => name.endsWith(".json")); } catch (error) { log(`state directory scan: ${error instanceof Error ? error.message : String(error)}`); return; }
  for (const file of files) {
    try {
      const env = readEnvelope(file.slice(0, -5));
      if (env?.goal && ["active", "budget-limited"].includes(env.goal.status)) activeGoalSessions.add(env.sessionID);
      if (interviewActive(env, env?.sessionID ?? "")) activeGoalSessions.add(env?.sessionID ?? "");
    } catch (error) { log(`state scan ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
function goalToolDefinition(ctx: PluginCtx): Json {
  return {
    name: "goal",
    description: "Goal state adapter. op=create is allowed only during this session's /guided-goal interview; complete only with this tool.",
    input: { type: "object", properties: { op: { type: "string", enum: ["create", "get", "complete", "resume", "drop", "todo"] }, objective: { type: "string" }, token_budget: { type: "number" }, action: { type: "string" }, text: { type: "string" }, index: { type: "number" } }, required: ["op"], additionalProperties: false },
    options: { codemode: false },
    execute: (args: any, toolCtx: any) => goalTool(ctx, args, toolCtx),
  };
}
async function refreshGoalTool(ctx: PluginCtx): Promise<void> {
  syncActiveGoalSessions();
  const state = toolState(ctx);
  const shouldBeRegistered = activeGoalSessions.size > 0;
  if (state.registered === shouldBeRegistered || !ctx.tool?.transform) return;
  try {
    if (state.registration?.dispose) await state.registration.dispose();
    const registration = await ctx.tool.transform((editor: any) => {
      if (shouldBeRegistered) editor.add(goalToolDefinition(ctx));
      else if (typeof editor.remove === "function") editor.remove("goal");
      else throw new Error("V2 tool editor has no remove(); dynamic removal is unavailable");
    });
    state.registration = registration;
    state.registered = shouldBeRegistered;
  } catch (error) {
    log(`goal tool visibility: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
async function refreshAllGoalTools(ctx: PluginCtx): Promise<void> {
  await refreshGoalTool(ctx);
  for (const other of toolContexts) if (other !== ctx) await refreshGoalTool(other);
}
async function markGoalSession(ctx: PluginCtx, _sessionID: string, _enabled: boolean): Promise<void> { await refreshAllGoalTools(ctx); }

const INTERVIEW = [
  "Интервью для цели. Это model-driven interview: задай ровно один вопрос за turn и дождись ответа.",
  "Собери пять обязательных полей: objective, success criteria, verification, limits/boundaries, stop conditions.",
  "Не вызывай goal({op:\"create\"}) до заполнения всех полей. После финального ответа вызови goal({op:\"create\"}) с полным objective.",
  "Черновик пользователя:",
].join("\n");
async function interview(ctx: PluginCtx, sessionID: string, draft: string): Promise<void> {
  const guard = await goalGuard(ctx.session, sessionID);
  if (guard) return say(ctx.session, sessionID, `modes: ${guard}`);
  const env = readEnvelope(sessionID);
  if (env?.goal && !goalTerminal(env.goal)) return say(ctx.session, sessionID, "modes: цель уже активна; сначала заверши или сними её.");
  const now = Date.now();
  const result = mutateEnvelope(sessionID, (fresh) => {
    if (fresh.goal && !goalTerminal(fresh.goal)) return NO_WRITE;
    fresh.interview = { draft, startedAt: now, expiresAt: now + waitTimeoutMs() };
    return true;
  });
  if (!result) return say(ctx.session, sessionID, "modes: интервью не запущено: состояние изменилось.");
  await markGoalSession(ctx, sessionID, true);
  await ctx.session.synthetic({ sessionID, text: `${INTERVIEW}\n\nЧерновик: ${draft}`, description: "modes", resume: true });
}

// ---------------------------------------------------------------- goal/loop commands

function parseGoalInput(text: string): { objective: string; turns?: number; tokens?: number } | string {
  let rest = text.trim();
  if (/^set\b/i.test(rest)) rest = rest.replace(/^set\s+/i, "").trim();
  const turnsMatch = /(?:^|\s)--turns(?:\s+|=)([^\s]+)/i.exec(rest);
  const tokensMatch = /(?:^|\s)--tokens(?:\s+|=)([^\s]+)/i.exec(rest);
  let turns: number | undefined;
  let tokens: number | undefined;
  if (turnsMatch) {
    turns = Number(turnsMatch[1]);
    if (!/^\d+$/.test(turnsMatch[1]) || !Number.isSafeInteger(turns) || turns <= 0) return "goal turns must be a positive safe integer";
    rest = rest.replace(turnsMatch[0], " ").trim();
  }
  if (tokensMatch) {
    tokens = Number(tokensMatch[1]);
    if (!/^\d+$/.test(tokensMatch[1]) || !Number.isSafeInteger(tokens) || tokens <= 0) return "goal tokens must be a positive safe integer";
    rest = rest.replace(tokensMatch[0], " ").trim();
  }
  return { objective: rest, turns, tokens };
}
function makeGoalState(objective: string, usage: Usage, turns?: number, tokens?: number): GoalState {
  const now = Date.now();
  return { token: safeToken(), generation: 0, status: "active", objective, prompt: objective, startedAt: now, updatedAt: now, turns: 0, turnLimit: turns, tokenBudget: tokens, tokensUsed: 0, usageBaseline: usage, usageInitialized: true, timeUsedSeconds: 0, lastAccountedAt: now, todos: [], waitingUser: false, pendingFirst: true, manualTurnPending: false, ...ownerPatch() };
}
function makeLoopState(prompt: string, parsed: ParsedLoopArgs, cwd: string, userSeen: number): LoopState {
  const now = Date.now();
  let limit: LoopLimit | undefined;
  if (parsed.limit?.kind === "iterations") limit = { kind: "iterations", initial: parsed.limit.iterations, remaining: parsed.limit.iterations };
  if (parsed.limit?.kind === "duration") limit = { kind: "duration", durationMs: parsed.limit.durationMs, deadlineMs: now + parsed.limit.durationMs };
  return { token: safeToken(), generation: 0, status: "active", prompt, objective: prompt, startedAt: now, updatedAt: now, limit, condition: parsed.condition, compact: parsed.compact === true, awaitingBody: !prompt.trim(), used: 0, userSeen, manualTurnPending: false, ...ownerPatch() };
}
function reportStateFailure(error: unknown): string { return error instanceof StateError ? `modes: ${error.message}; изменение не сохранено.` : `modes: ${error instanceof Error ? error.message : String(error)}`; }
async function goalCommand(ctx: PluginCtx, input: any): Promise<void> {
  const sessionID = String(input?.sessionID ?? "");
  if (!sessionID) return;
  const text = String(input?.prompt?.text ?? input?.arguments ?? "").trim();
  try {
    const guard = await goalGuard(ctx.session, sessionID);
    if (guard) return say(ctx.session, sessionID, `modes: ${guard}`);
    if (!text) return say(ctx.session, sessionID, `modes: нужен objective. Введите /goal <objective> или используйте /goal guided. ${GOAL_USAGE}`);
    if (/^(show|status)$/i.test(text)) return say(ctx.session, sessionID, statusText(sessionID));
    if (/^done$/i.test(text)) return say(ctx.session, sessionID, "modes: завершение цели делает только goal({op:\"complete\"}); /goal done не закрывает цель.");
    if (/^set(?:\s|$)/i.test(text) && !text.replace(/^set\s*/i, "").trim()) return say(ctx.session, sessionID, `modes: /goal set требует objective. ${GOAL_USAGE}`);
    if (/^budget(?:\s|$)/i.test(text) && !text.replace(/^budget\s*/i, "").trim()) return say(ctx.session, sessionID, "modes: /goal budget требует N или off. Введите /goal budget 80000.");
    const guided = /^guided\b\s*([\s\S]*)$/i.exec(text);
    if (guided) return interview(ctx, sessionID, guided[1].trim());
    const todo = /^todo\b\s*([\s\S]*)$/i.exec(text);
    if (todo) {
      const goal = readEnvelope(sessionID)?.goal;
      if (!goal) return say(ctx.session, sessionID, "modes: цели нет — сначала /goal <цель>");
      const arg = todo[1].trim();
      if (!arg || /^list$/i.test(arg)) return say(ctx.session, sessionID, todosText(goal));
      if (/^clear$/i.test(arg)) {
        const updated = updateGoalTodos(sessionID, goal.token, () => []);
        return say(ctx.session, sessionID, updated ? "modes: todo очищен." : "modes: todo не изменён: состояние цели изменилось.");
      }
      const done = /^done\s+(\d+)$/i.exec(arg);
      if (done) {
        const index = Number(done[1]) - 1;
        if (!Number.isSafeInteger(index) || index < 0 || index >= goal.todos.length) return say(ctx.session, sessionID, "modes: неверный номер todo.");
        const updated = updateGoalTodos(sessionID, goal.token, (todos) => todos.map((item, i) => i === index ? { ...item, done: true } : item));
        return say(ctx.session, sessionID, updated ? todosText(updated) : "modes: todo не изменён: состояние цели изменилось.");
      }
      const updated = updateGoalTodos(sessionID, goal.token, (todos) => [...todos, { text: arg, done: false }]);
      return say(ctx.session, sessionID, updated ? "modes: todo добавлен." : "modes: todo не добавлен: состояние цели изменилось.");
    }
    const env = readEnvelope(sessionID);
    const existing = env?.goal;
    if (/^(off|stop|clear|drop)$/i.test(text)) {
      if (!existing) {
        if (env?.interview) {
          mutateEnvelope(sessionID, (fresh) => { fresh.interview = undefined; });
          await markGoalSession(ctx, sessionID, false);
          return say(ctx.session, sessionID, "modes: интервью очищено.");
        }
        return say(ctx.session, sessionID, "modes: цели нет.");
      }
      if (goalTerminal(existing)) return say(ctx.session, sessionID, `modes: ${existing.status} цель уже закрыта.`);
      const flushed = await flushGoalForCommand(ctx.session, sessionID, existing);
      if (!flushed) return say(ctx.session, sessionID, "modes: цель изменилась; drop не выполнен.");
      if (!transitionGoal(sessionID, existing.token, ["active", "paused", "budget-limited"], { status: "dropped", reason: "dropped", closed: true, finalFlushPending: false, turnInFlight: false }, flushed.generation)) return say(ctx.session, sessionID, "modes: состояние изменилось; drop не выполнен.");
      await markGoalSession(ctx, sessionID, false);
      return say(ctx.session, sessionID, "modes: цель снята; usage/time/todos сохранены.");
    }
    if (/^pause$/i.test(text)) {
      if (!existing) return say(ctx.session, sessionID, "modes: цели нет.");
      if (existing.status !== "active" && existing.status !== "budget-limited") return say(ctx.session, sessionID, `modes: цель уже ${existing.status}.`);
      const flushed = await flushGoalForCommand(ctx.session, sessionID, existing);
      if (!flushed) return say(ctx.session, sessionID, "modes: цель изменилась; pause не выполнен.");
      if (!transitionGoal(sessionID, existing.token, ["active", "budget-limited"], { status: "paused", reason: "paused", turnInFlight: false, finalFlushPending: false }, flushed.generation)) return say(ctx.session, sessionID, "modes: состояние изменилось; pause не выполнен.");
      await markGoalSession(ctx, sessionID, false);
      return say(ctx.session, sessionID, "modes: цель на паузе. /goal resume — продолжить.");
    }
    if (/^resume$/i.test(text)) {
      if (!existing) return say(ctx.session, sessionID, "modes: цели нет.");
      if (goalTerminal(existing)) return say(ctx.session, sessionID, `modes: ${existing.status} цель нельзя resume.`);
      if (existing.status === "budget-limited" && existing.tokenBudget !== undefined && existing.tokensUsed >= existing.tokenBudget) return say(ctx.session, sessionID, "modes: сначала подними бюджет.");
      const usage = await currentUsage(ctx.session, sessionID);
      if (!transitionGoal(sessionID, existing.token, ["paused", "budget-limited"], { token: safeToken(), status: "active", reason: undefined, usageBaseline: usage, usageInitialized: true, budgetNoticeGeneration: undefined, waitingUser: false, manualTurnPending: false, lastAccountedAt: Date.now(), ...ownerPatch() }, existing.generation)) return say(ctx.session, sessionID, "modes: состояние изменилось; resume не выполнен.");
      await markGoalSession(ctx, sessionID, true);
      ensureDriver(ctx, sessionID);
      return say(ctx.session, sessionID, "modes: цель продолжена.");
    }
    const budget = /^budget\s+(\S+)$/i.exec(text);
    if (budget) {
      if (!existing) return say(ctx.session, sessionID, "modes: активной цели нет.");
      if (existing.status === "paused") return say(ctx.session, sessionID, "modes: сначала /goal resume.");
      if (goalTerminal(existing)) return say(ctx.session, sessionID, `modes: ${existing.status} цель нельзя изменить.`);
      const arg = budget[1].toLowerCase();
      let next: number | undefined;
      if (arg !== "off" && arg !== "none") {
        next = Number(arg);
        if (!/^\d+$/.test(arg) || !Number.isSafeInteger(next) || next <= 0) return say(ctx.session, sessionID, "modes: бюджет должен быть положительным safe integer или off.");
      }
      const flushed = await flushGoalForCommand(ctx.session, sessionID, existing);
      if (!flushed) return say(ctx.session, sessionID, "modes: состояние изменилось; budget не изменён.");
      const reached = next !== undefined && flushed.tokensUsed >= next;
      const latest = readEnvelope(sessionID)?.goal;
      if (!latest || !transitionGoal(sessionID, existing.token, ["active", "budget-limited"], { tokenBudget: next, tokensUsed: flushed.tokensUsed, usageBaseline: flushed.usageBaseline, usageInitialized: true, budgetNoticeGeneration: undefined, lastAccountedAt: Date.now(), status: reached ? "budget-limited" : "active", reason: reached ? "бюджет токенов исчерпан" : undefined }, flushed.generation)) return say(ctx.session, sessionID, "modes: состояние изменилось; budget не изменён.");
      if (!reached) ensureDriver(ctx, sessionID);
      else {
        const limited = readEnvelope(sessionID)?.goal;
        if (limited) await notifyGoalBudget(ctx, sessionID, limited);
      }
      return say(ctx.session, sessionID, reached ? "modes: бюджет исчерпан." : `modes: бюджет ${next ?? "снят"}.`);
    }
    const parsed = parseGoalInput(text);
    if (typeof parsed === "string") return say(ctx.session, sessionID, `modes: ${parsed}. ${GOAL_USAGE}`);
    if (!parsed.objective) return say(ctx.session, sessionID, `modes: нужна цель. ${GOAL_USAGE}`);
    if (existing?.status === "paused" || existing?.status === "budget-limited") return say(ctx.session, sessionID, "modes: resume или drop текущей цели перед новой.");
    if (existing && !goalTerminal(existing) && !/^set\b/i.test(text)) return say(ctx.session, sessionID, "modes: цель уже активна; используй /goal set <цель>.");
    const directory = await sessionDirectory(ctx.session, sessionID);
    if (!directory) return say(ctx.session, sessionID, "modes: session.get().location.directory не найден.");
    const usage = await currentUsage(ctx.session, sessionID);
    const goal = makeGoalState(parsed.objective, usage, parsed.turns, parsed.tokens);
    const created = mutateEnvelope(sessionID, (fresh) => {
      if (fresh.goal && !goalTerminal(fresh.goal) && !/^set\b/i.test(text)) return NO_WRITE;
      fresh.cwd = directory;
      fresh.goal = goal;
      fresh.interview = undefined;
      return true;
    });
    if (!created) return say(ctx.session, sessionID, "modes: состояние изменилось; цель не создана.");
    await markGoalSession(ctx, sessionID, true);
    ensureDriver(ctx, sessionID);
    return say(ctx.session, sessionID, `modes: цель принята${parsed.turns === undefined ? " без лимита ходов" : `; лимит ${parsed.turns} ходов`}. Первый objective будет обычным user prompt.`);
  } catch (error) {
    if (error instanceof StateError) return say(ctx.session, sessionID, reportStateFailure(error));
    throw error;
  }
}
async function loopCommand(ctx: PluginCtx, input: any): Promise<void> {
  const sessionID = String(input?.sessionID ?? "");
  if (!sessionID) return;
  const text = String(input?.prompt?.text ?? input?.arguments ?? "").trim();
  try {
    const current = readEnvelope(sessionID);
    if (current?.loop && current.loop.status !== "off") {
      const removed = removeLoop(sessionID);
      return say(ctx.session, sessionID, removed ? "modes: цикл выключен; аргументы не разбирались (OMP /loop again)." : "modes: цикл уже изменился; состояние не снято.");
    }
    if (/^(off|stop|clear)$/i.test(text)) return say(ctx.session, sessionID, "modes: цикл не запущен — снимать нечего.");
    const parsed = parseLoopArgs(text);
    if (typeof parsed === "string") return say(ctx.session, sessionID, `modes: ${parsed}`);
    const directory = await sessionDirectory(ctx.session, sessionID);
    if (!directory) return say(ctx.session, sessionID, "modes: session.get().location.directory не найден; цикл не запущен.");
    const userSeen = await userCount(ctx.session, sessionID);
    const loop = makeLoopState(parsed.prompt?.trim() ?? "", parsed, directory, userSeen);
    const created = mutateEnvelope(sessionID, (env) => { env.cwd = directory; env.loop = loop; return true; });
    if (!created) return say(ctx.session, sessionID, "modes: состояние изменилось; цикл не запущен.");
    ensureDriver(ctx, sessionID);
    const tail = loop.awaitingBody ? "Следующий prompt станет телом и первым ходом." : "Esc оставляет loop включённым; следующий ручной prompt заменит тело.";
    return say(ctx.session, sessionID, `modes: цикл запущен. ${tail}`);
  } catch (error) {
    if (error instanceof StateError) return say(ctx.session, sessionID, reportStateFailure(error));
    throw error;
  }
}

// ---------------------------------------------------------------- setup/recovery

async function recoverStates(): Promise<void> {
  let files: string[] = [];
  try { files = readdirSync(STATE_DIR).filter((name) => name.endsWith(".json")); } catch (error) { log(`state recovery scan: ${error instanceof Error ? error.message : String(error)}`); return; }
  for (const file of files) {
    const sid = file.slice(0, -5);
    withStateLock(sid, (existing) => {
      if (!existing) return;
      let changed = reconcileEnvelope(existing);
      if (changed) {
        existing.revision += 1;
        existing.updatedAt = Date.now();
        writeEnvelopeUnlocked(existing);
      }
    });
  }
}
function stopDriversForContext(ctx: PluginCtx): void {
  for (const [sessionID, driver] of drivers) if (driver.ctx === ctx) drivers.delete(sessionID);
}
const HOOK_INJECT = (payload: any): void => {
  const sessionID = String(payload?.sessionID ?? "");
  if (!sessionID) return;
  const env = readEnvelope(sessionID);
  if (!env || !Array.isArray(payload.system)) return;
  if (env.goal?.status === "active") payload.system.push({ type: "text", text: goalContext(env.goal) });
  if (env.loop && env.loop.status !== "off") payload.system.push({ type: "text", text: loopContext(env.loop) });
};
const HOOK_PROMPT = (payload: any): void => {
  const sessionID = String(payload?.sessionID ?? "");
  const text = String(payload?.prompt?.text ?? "").trim();
  const metadata = payload?.prompt?.metadata;
  if (!sessionID || !text || (metadata && (metadata.modesStation === "loop" || metadata.modesStation === "goal-first"))) return;
  const env = readEnvelope(sessionID);
  if (!env) return;
  if (env.goal?.status === "active" && env.goal.waitingUser) {
    const token = safeToken();
    const changed = mutateEnvelope(sessionID, (fresh) => {
      const goal = fresh.goal;
      if (!goal || goal.status !== "active" || !goal.waitingUser) return NO_WRITE;
      goal.token = token;
      goal.generation += 1;
      goal.waitingUser = false;
      goal.manualTurnPending = true;
      goal.turnKind = "manual";
      goal.userSeen = (goal.userSeen ?? 0) + 1;
      Object.assign(goal, ownerPatch());
      return true;
    });
    if (changed) {
      const context = sessionContexts.get(sessionID);
      if (context) ensureDriver(context, sessionID);
    }
    return;
  }
  if (env.loop && env.loop.status !== "off") {
    const token = safeToken();
    cancelLoopActivity(sessionID);
    mutateEnvelope(sessionID, (fresh) => {
      const loop = fresh.loop;
      if (!loop || loop.status === "off") return NO_WRITE;
      loop.token = token;
      loop.generation += 1;
      loop.prompt = text;
      loop.objective = text;
      loop.status = "active";
      loop.awaitingBody = false;
      loop.manualTurnPending = true;
      loop.userSeen += 1;
      Object.assign(loop, ownerPatch());
      return true;
    });
    const context = sessionContexts.get(sessionID);
    if (context) ensureDriver(context, sessionID);
  }
};

export const __testing = {
  evaluateCondition: (condition: Condition, cwd: string, sessionID: string, timeout?: number) => evaluateCondition(undefined as unknown as SessionAPI, condition, cwd, sessionID, timeout),
  runAsync,
  flushGoalUsage,
  readEnvelope,
  mutateEnvelope,
  statePath,
  lockPath,
};

export default {
  id: "modes-station",
  setup: async (ctx: PluginCtx): Promise<() => Promise<void>> => {
    log(`setup modes-station ${VERSION} instance=${PLUGIN_INSTANCE} process=${processOwner.id}`);
    const registrations: Registration[] = [];
    await recoverStates();
    const events = bindEvents(ctx);
    for (const event of ["context", "generate", "prompt"]) {
      const handler = event === "prompt" ? HOOK_PROMPT : HOOK_INJECT;
      const registration = await ctx.session.hook(event, handler);
      if (registration) registrations.push(registration);
    }
    const accountingRegistration = await installGoalAccounting(ctx);
    if (accountingRegistration) registrations.push(accountingRegistration);
    await refreshGoalTool(ctx);
    const commandRegistration = await ctx.command.transform((editor: any) => {
      editor.add({ name: "goal", description: `${GOAL_HINT} [--turns N] [--tokens N] — objective is a visible user prompt; complete only with goal tool`, execute: (input: any) => goalCommand(ctx, input) });
      editor.add({ name: "guided-goal", description: `${GUIDED_GOAL_HINT} — five-question goal interview`, execute: (input: any) => interview(ctx, String(input?.sessionID ?? ""), String(input?.prompt?.text ?? "").trim()) });
      editor.add({ name: "loop", description: `${LOOP_PALETTE_HINT} — N resubmits plus the first turn; repeat /loop or off disables`, execute: (input: any) => loopCommand(ctx, input) });
    });
    if (commandRegistration) registrations.push(commandRegistration);
    // A reload gets a fresh driver only for state owned by this live process.
    for (const file of (() => { try { return readdirSync(STATE_DIR).filter((name) => name.endsWith(".json")); } catch { return []; } })()) {
      const env = readEnvelope(file.slice(0, -5));
      if (env && anyModeActive(env) && (ownerIsCurrent(env.goal) || ownerIsCurrent(env.loop))) ensureDriver(ctx, env.sessionID);
    }
    return async () => {
      stopDriversForContext(ctx);
      for (const [sessionID, context] of sessionContexts) if (context === ctx) sessionContexts.delete(sessionID);
      for (const sessionID of conditionControllers.keys()) cancelLoopActivity(sessionID);
      await events.stop();
      for (const registration of registrations) await registration.dispose?.();
      const state = toolStates.get(ctx as object);
      await state?.registration?.dispose?.();
      toolContexts.delete(ctx);
      eventBindings.delete(ctx as object);
    };
  },
};
