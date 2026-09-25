/**
 * vibe-station — режим «директор» для opencode2: `/vibe` + постоянные воркер-сессии.
 *
 * Ported from OMP 18.1.21 (`src/vibe/runtime.ts`, `src/tools/vibe.ts`) to the
 * installed OpenCode V2 plugin API (dev-19846). The important V2 boundary is
 * `session.prompt({ id })` admission + `session.wait({ sessionID })`; a prompt
 * receipt is not a turn completion.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VibeWallDefinition, type VibeWallChanged, type VibeWallSnapshot, type VibeWallWorker } from "../opencode-tui/rpc.ts";

const VERSION = "0.4.0";
const DEBUG = process.env.VIBE_DEBUG !== "0";
const LOG = process.env.VIBE_LOG ?? "/tmp/opencode/vibe.log";
const TAG = Math.random().toString(36).slice(2, 7);
const log = (s: string): void => {
  if (!DEBUG) return;
  try {
    appendFileSync(LOG, `${new Date().toISOString()} [${TAG}] ${s}\n`);
  } catch {}
};

const STATE_DIR = process.env.VIBE_STATE_DIR ?? join(homedir(), ".local/state/vibe-station");
const DIRECTOR_AGENT = "vibe-director";
const WORKER_AGENT: Record<Cli, string> = { fast: "vibe-fast", good: "vibe-good" };
const AUDIT_AGENT: Record<Cli, string> = { fast: "vibe-audit-fast", good: "vibe-audit-good" };
const workerAgentID = (cli: Cli, readOnly: boolean): string => (readOnly ? AUDIT_AGENT[cli] : WORKER_AGENT[cli]);
const EVENT_RECONNECT_MS = 250;
const TURN_TRACE_CAP = 40;
const RESULT_MAX = 4000;
const DELIVERY_BASE_MS = 500;
const DELIVERY_MAX_MS = 30_000;
const DELIVERY_JITTER_MS = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DELIVER = process.env.VIBE_DELIVER === "queue" ? "queue" : "wake";

type Cli = "fast" | "good";
type WorkerState = "starting" | "running" | "idle" | "stopping" | "dead";
type JobPhase = "starting" | "running" | "retryable" | "settled";
type JobDelivery = "none" | "claimed" | "synthetic" | "delivered" | "delivery-unknown" | "failed" | "cancelled";

type Settle = {
  workerID: string;
  jobID: string;
  cli: Cli;
  turn: number;
  status: string;
  outcome?: string;
  reason?: string;
  text: string;
  tools: string[];
  toolCount: number;
  duration: number;
  /** Actual model from the fresh assistant message; never copied from requested worker.model. */
  model?: string;
};

type Baseline = {
  assistantIDs: string[];
  idleID?: string;
};

type JobClaim = { token: string; expiresAt: number };
type DurableJob = {
  id: string;
  workerID: string;
  cli: Cli;
  turn: number;
  /** Requested model snapshot; actual model lives in result.model. */
  model?: string;
  modelRole?: Cli;
  modelSource?: ModelSource;
  modelError?: string;
  directorGeneration?: number;
  workerGeneration?: number;
  messageID: string;
  startedAt: number;
  phase: JobPhase;
  delivery: JobDelivery;
  baseline: Baseline;
  claim?: JobClaim;
  consumedAt?: number;
  deliveryAttempts?: number;
  deliveryRetryAt?: number;
  /** Exact dev-19846 Session.synthetic id; SessionInbox.admit reconciles the first admission. */
  syntheticID?: string;
  result?: Settle;
  error?: string;
};

type QueueItem = { id: string; text: string };
type SteerReceipt = { id: string; text: string };
type SteerPending = { id: string; text: string };

type LifecycleScope = {
  version: 2;
  directorSessionID: string;
  directorAgent: string;
  cwd: string;
};

type WorkerRecovery = {
  state: "restored" | "interrupted" | "missing";
  at: number;
  reason?: string;
};

type RehydrateSummary = {
  restored: number;
  interrupted: number;
  missing: number;
};

type SkillPromptPlan = {
  text: string;
  skills: Array<{ id: string }>;
};

type Worker = {
  id: string;
  cli: Cli;
  readOnly: boolean;
  title: string;
  /** Requested model label; actual model is read from a fresh assistant message. */
  model?: string;
  modelRole?: Cli;
  modelSource?: ModelSource;
  modelError?: string;
  accessTransition?: AccessTransition;
  suspended?: boolean;
  recovery?: WorkerRecovery;
  lastActivityAt?: number;
  lastActivity?: string;
  lastTool?: string;
  lastToolArgs?: string;
  lastIntent?: string;
  toolCallCount?: number;
  traceTail?: string[];
  generation?: number;
  state: WorkerState;
  turns: number;
  queued: Array<string | QueueItem>;
  startedAt: number;
  lastStatus?: string;
  lastAt?: number;
  lastResult?: string;
  lastSettle?: Settle;
  currentJob?: DurableJob;
  lastJob?: DurableJob;
  steerPending?: SteerPending;
  acceptedSteers?: SteerReceipt[];
};

type Todo = {
  id?: string;
  text: string;
  done: boolean;
  phase?: string;
  blockedBy?: string[];
};
type Vibe = {
  sessionID: string;
  cwd: string;
  enabled: boolean;
  generation?: number;
  lifecycleScope?: LifecycleScope;
  previousAgent?: string;
  workers: Worker[];
  todos?: Todo[];
  startedAt: number;
  turnsDelivered: number;
  stopping?: boolean;
  stopError?: string;
  revision?: number;
};

type OrphanRecord = {
  version: 1;
  directorID: string;
  workerID: string;
  title: string;
  cwd: string;
  createdAt: number;
  lastError?: string;
};

type EffectiveLimit = { value: number; source: string };

const workerCapLimit = (): EffectiveLimit => {
  const raw = process.env.VIBE_MAX_WORKERS;
  if (raw === undefined) {
    return { value: 4, source: "station default VIBE_MAX_WORKERS=4; native cap unverified" };
  }
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) {
    return { value: Math.floor(value), source: "VIBE_MAX_WORKERS" };
  }
  const shown = String(raw).replace(/\s+/g, " ").slice(0, 80);
  return { value: 4, source: `invalid VIBE_MAX_WORKERS=${shown}; station fallback 4; native cap unverified` };
};

const TURN_TIMEOUT_MS = 30 * 60_000;
const turnTimeoutLimit = (): EffectiveLimit => {
  const raw = process.env.VIBE_TURN_TIMEOUT_MS;
  if (raw === undefined) {
    return { value: TURN_TIMEOUT_MS, source: `station default VIBE_TURN_TIMEOUT_MS=${TURN_TIMEOUT_MS}ms; native timeout unverified` };
  }
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) {
    return { value, source: "VIBE_TURN_TIMEOUT_MS" };
  }
  const shown = String(raw).replace(/\s+/g, " ").slice(0, 80);
  return { value: TURN_TIMEOUT_MS, source: `invalid VIBE_TURN_TIMEOUT_MS=${shown}; station fallback ${TURN_TIMEOUT_MS}ms; native timeout unverified` };
};

const turnTimeoutMs = (): number => turnTimeoutLimit().value;
/** OMP 18.1.21 uses a 5s teardown grace period; keep the same bound for truthful adapter teardown. */
const TEARDOWN_TIMEOUT_MS = 5_000;
const teardownTimeoutMs = (): number => {
  const raw = Number(process.env.VIBE_TEARDOWN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : TEARDOWN_TIMEOUT_MS;
};
const LOCK_TIMEOUT_MS = 5_000;
const lockTimeoutMs = (): number => {
  const raw = Number(process.env.VIBE_LOCK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : LOCK_TIMEOUT_MS;
};

// ---------------------------------------------------------------- state files

const safeID = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");
const statePath = (sessionID: string): string => join(STATE_DIR, `${safeID(sessionID)}.json`);
const lockPath = (sessionID: string): string => `${statePath(sessionID)}.lock`;
const wallRevisions = new Map<string, number>();
let wallRpcRegistration: WallRpcRegistration | undefined;

type StateRead =
  | { kind: "absent" }
  | { kind: "valid"; value: Vibe }
  | { kind: "corrupt"; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNonNegativeInteger = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const isOptionalNumber = (value: unknown): boolean => value === undefined || isFiniteNumber(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isModelSource = (value: unknown): value is ModelSource =>
  value === "agent" || value === "env" || value === "small-model" || value === "session" || value === "default";
const isCli = (value: unknown): value is Cli => value === "fast" || value === "good";
const isLifecycleScope = (value: unknown): value is LifecycleScope => {
  if (!isRecord(value)) return false;
  return (
    value.version === 2 &&
    typeof value.directorSessionID === "string" &&
    typeof value.directorAgent === "string" &&
    typeof value.cwd === "string"
  );
};
const isWorkerRecovery = (value: unknown): value is WorkerRecovery => {
  if (!isRecord(value)) return false;
  return (
    (value.state === "restored" || value.state === "interrupted" || value.state === "missing") &&
    isFiniteNumber(value.at) &&
    isOptionalString(value.reason)
  );
};
const isAccessTransition = (value: unknown): value is AccessTransition => {
  if (!isRecord(value)) return false;
  return (
    (value.from === "audit" || value.from === "coding") &&
    value.to === "coding" &&
    (value.phase === "switching" || value.phase === "failed") &&
    typeof value.targetAgent === "string" &&
    isOptionalString(value.targetModel) &&
    isFiniteNumber(value.startedAt) &&
    isOptionalString(value.error)
  );
};

function isSettleRecord(value: unknown): value is Settle {
  if (!isRecord(value)) return false;
  return (
    typeof value.workerID === "string" &&
    typeof value.jobID === "string" &&
    (value.cli === "fast" || value.cli === "good") &&
    isNonNegativeInteger(value.turn) &&
    typeof value.status === "string" &&
    isOptionalString(value.outcome) &&
    isOptionalString(value.reason) &&
    typeof value.text === "string" &&
    isStringArray(value.tools) &&
    isNonNegativeInteger(value.toolCount) &&
    isFiniteNumber(value.duration) &&
    isOptionalString(value.model)
  );
}

function isDurableJobRecord(value: unknown): value is DurableJob {
  if (!isRecord(value) || !isRecord(value.baseline)) return false;
  const phase = value.phase;
  const delivery = value.delivery;
  return (
    typeof value.id === "string" &&
    typeof value.workerID === "string" &&
    (value.cli === "fast" || value.cli === "good") &&
    isNonNegativeInteger(value.turn) &&
    isOptionalString(value.model) &&
    (value.modelRole === undefined || isCli(value.modelRole)) &&
    (value.modelSource === undefined || isModelSource(value.modelSource)) &&
    isOptionalString(value.modelError) &&
    isOptionalNumber(value.directorGeneration) &&
    isOptionalNumber(value.workerGeneration) &&
    typeof value.messageID === "string" &&
    isFiniteNumber(value.startedAt) &&
    (phase === "starting" || phase === "running" || phase === "retryable" || phase === "settled") &&
    (delivery === "none" || delivery === "claimed" || delivery === "synthetic" || delivery === "delivered" || delivery === "delivery-unknown" || delivery === "failed" || delivery === "cancelled") &&
    isStringArray(value.baseline.assistantIDs) &&
    isOptionalString(value.baseline.idleID) &&
    (value.claim === undefined || (isRecord(value.claim) && typeof value.claim.token === "string" && isFiniteNumber(value.claim.expiresAt))) &&
    isOptionalNumber(value.consumedAt) &&
    isOptionalNumber(value.deliveryAttempts) &&
    isOptionalNumber(value.deliveryRetryAt) &&
    isOptionalString(value.syntheticID) &&
    (value.result === undefined || isSettleRecord(value.result)) &&
    isOptionalString(value.error)
  );
}

function isWorkerRecord(value: unknown): value is Worker {
  if (!isRecord(value)) return false;
  const state = value.state;
  const queued = value.queued;
  const validQueued =
    Array.isArray(queued) &&
    queued.every(
      (item) =>
        typeof item === "string" ||
        (isRecord(item) && typeof item.id === "string" && typeof item.text === "string"),
    );
  return (
    typeof value.id === "string" &&
    (value.cli === "fast" || value.cli === "good") &&
    (value.readOnly === undefined || typeof value.readOnly === "boolean") &&
    typeof value.title === "string" &&
    (state === "starting" || state === "running" || state === "idle" || state === "stopping" || state === "dead") &&
    isNonNegativeInteger(value.turns) &&
    validQueued &&
    isFiniteNumber(value.startedAt) &&
    isOptionalString(value.model) &&
    (value.modelRole === undefined || isCli(value.modelRole)) &&
    (value.modelSource === undefined || isModelSource(value.modelSource)) &&
    isOptionalString(value.modelError) &&
    (value.accessTransition === undefined || isAccessTransition(value.accessTransition)) &&
    (value.suspended === undefined || typeof value.suspended === "boolean") &&
    (value.recovery === undefined || isWorkerRecovery(value.recovery)) &&
    isOptionalNumber(value.lastActivityAt) &&
    isOptionalString(value.lastActivity) &&
    isOptionalString(value.lastTool) &&
    isOptionalString(value.lastToolArgs) &&
    isOptionalString(value.lastIntent) &&
    isOptionalNumber(value.toolCallCount) &&
    (value.traceTail === undefined || isStringArray(value.traceTail)) &&
    isOptionalNumber(value.generation) &&
    (value.currentJob === undefined || isDurableJobRecord(value.currentJob)) &&
    (value.lastJob === undefined || isDurableJobRecord(value.lastJob)) &&
    (value.steerPending === undefined || (isRecord(value.steerPending) && typeof value.steerPending.id === "string" && typeof value.steerPending.text === "string")) &&
    (value.acceptedSteers === undefined ||
      (Array.isArray(value.acceptedSteers) &&
        value.acceptedSteers.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.text === "string"))) &&
    isOptionalString(value.lastStatus) &&
    isOptionalNumber(value.lastAt) &&
    isOptionalString(value.lastResult) &&
    (value.lastSettle === undefined || isSettleRecord(value.lastSettle))
  );
}

function isVibeState(value: unknown): value is Vibe {
  if (!isRecord(value)) return false;
  const validTodos =
    value.todos === undefined ||
    (Array.isArray(value.todos) &&
      value.todos.every(
        (item) =>
          isRecord(item) &&
          (item.id === undefined || typeof item.id === "string") &&
          typeof item.text === "string" &&
          typeof item.done === "boolean" &&
          (item.phase === undefined || typeof item.phase === "string") &&
          (item.blockedBy === undefined ||
            (Array.isArray(item.blockedBy) && item.blockedBy.every((id) => typeof id === "string"))),
      ));
  return (
    typeof value.sessionID === "string" &&
    typeof value.cwd === "string" &&
    typeof value.enabled === "boolean" &&
    (value.lifecycleScope === undefined || isLifecycleScope(value.lifecycleScope)) &&
    Array.isArray(value.workers) &&
    value.workers.every(isWorkerRecord) &&
    typeof value.startedAt === "number" &&
    isFiniteNumber(value.turnsDelivered) &&
    isOptionalString(value.previousAgent) &&
    isOptionalNumber(value.generation) &&
    (value.stopping === undefined || typeof value.stopping === "boolean") &&
    isOptionalString(value.stopError) &&
    isOptionalNumber(value.revision) &&
    validTodos
  );
}

function readStateResult(sessionID: string): StateRead {
  let raw: string;
  try {
    raw = readFileSync(statePath(sessionID), "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "corrupt", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isVibeState(value)) return { kind: "corrupt", reason: "state shape is invalid" };
    return { kind: "valid", value };
  } catch (error: unknown) {
    return { kind: "corrupt", reason: error instanceof Error ? error.message : String(error) };
  }
}

function readAnyState(sessionID: string): Vibe | undefined {
  const result = readStateResult(sessionID);
  return result.kind === "valid" ? result.value : undefined;
}

function readState(sessionID: string): Vibe | undefined {
  const result = readStateResult(sessionID);
  return result.kind === "valid" && result.value.enabled ? result.value : undefined;
}

let atomicWriteSequence = 0;
function atomicJson(target: string, value: unknown): boolean {
  const temporary = `${target}.tmp-${process.pid}-${++atomicWriteSequence}`;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, target);
    return true;
  } catch (err: unknown) {
    log(`atomicJson ${target} err: ${err instanceof Error ? err.message : String(err)}`);
    try {
      rmSync(temporary, { force: true });
    } catch {}
    return false;
  }
}

function publishWallChanged(sessionID: string, revision: number): void {
  const registration = wallRpcRegistration;
  if (!registration) return;
  try {
    void registration.events.emit("changed", { sessionID, revision }).catch((err: unknown) => {
      log(`wall rpc emit err: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err: unknown) {
    log(`wall rpc emit err: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The caller must hold the director's inter-process lock. */
function writeStateUnlocked(vibe: Vibe): boolean {
  const next = { ...vibe, revision: (vibe.revision ?? 0) + 1 };
  if (!atomicJson(statePath(vibe.sessionID), next)) return false;
  vibe.revision = next.revision;
  wallRevisions.set(vibe.sessionID, vibe.revision);
  publishWallChanged(vibe.sessionID, vibe.revision);
  return true;
}

function clearState(sessionID: string): boolean {
  const before = readStateResult(sessionID);
  const previous = before.kind === "valid" ? before.value.revision ?? 0 : wallRevisions.get(sessionID) ?? 0;
  try {
    rmSync(statePath(sessionID), { force: true });
    if (before.kind !== "absent") {
      const revision = previous + 1;
      wallRevisions.set(sessionID, revision);
      publishWallChanged(sessionID, revision);
    }
    return true;
  } catch (err: unknown) {
    log(`clearState err: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

type LockInfo = { pid: number; token: string; acquiredAt: number };
function readLockInfo(path: string): LockInfo | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    return typeof value.pid === "number" && typeof value.token === "string" && typeof value.acquiredAt === "number"
      ? { pid: value.pid, token: value.token, acquiredAt: value.acquiredAt }
      : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function waitForLockChange(path: string, observed: LockInfo | undefined, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveWait) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchers: Array<ReturnType<typeof watch>> = [];
    const finish = (changed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const active of watchers.splice(0)) active.close();
      resolveWait(changed);
    };
    try {
      watchers.push(watch(path, { persistent: true }, () => finish(true)));
    } catch {}
    try {
      watchers.push(watch(STATE_DIR, { persistent: true }, () => finish(true)));
    } catch {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    const current = readLockInfo(path);
    if (!existsSync(path) || (current && observed && current.token !== observed.token)) finish(true);
  });
}

async function acquireStateLock(sessionID: string): Promise<() => void> {
  const path = lockPath(sessionID);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  mkdirSync(STATE_DIR, { recursive: true });
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      const info: LockInfo = { pid: process.pid, token, acquiredAt: Date.now() };
      writeFileSync(fd, JSON.stringify(info), { mode: 0o600 });
      closeSync(fd);
      fd = undefined;
      return () => {
        const current = readLockInfo(path);
        if (!current || current.token === token) {
          try {
            rmSync(path, { force: true });
          } catch (err: unknown) {
            log(`release lock ${sessionID}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      };
    } catch (error: unknown) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const observed = readLockInfo(path);
      if (observed?.pid === process.pid) {
        try {
          rmSync(path, { force: true });
          continue;
        } catch (removeError: unknown) {
          throw removeError;
        }
      }
      if (observed && !processAlive(observed.pid)) {
        try {
          rmSync(path, { force: true });
        } catch {}
        continue;
      }
      const changed = await waitForLockChange(path, observed, lockTimeoutMs());
      if (!changed) throw new Error(`state lock timeout ${sessionID}`);
    }
  }
}

const admissionTails = new Map<string, Promise<void>>();

/** Process-local queue plus an on-disk lock: all state read/modify/write transactions are serialized. */
async function withDirectorAdmission<T>(director: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = admissionTails.get(director) ?? Promise.resolve();
  const gate = Promise.withResolvers<void>();
  const current = predecessor.then(() => gate.promise);
  admissionTails.set(director, current);
  await predecessor;
  let releaseFile: (() => void) | undefined;
  try {
    releaseFile = await acquireStateLock(director);
    return await operation();
  } finally {
    releaseFile?.();
    gate.resolve();
    if (admissionTails.get(director) === current) admissionTails.delete(director);
  }
}

type LifecycleTarget = {
  directorID: string;
  directorGeneration: number;
  workerID?: string;
  workerGeneration?: number;
};

const lifecycleTails = new Map<string, Promise<void>>();

/** Serializes external calls with teardown inside this plugin process. */
async function withLifecycleGate<T>(director: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = lifecycleTails.get(director) ?? Promise.resolve();
  const gate = Promise.withResolvers<void>();
  const current = predecessor.then(() => gate.promise);
  lifecycleTails.set(director, current);
  await predecessor;
  try {
    return await operation();
  } finally {
    gate.resolve();
    if (lifecycleTails.get(director) === current) lifecycleTails.delete(director);
  }
}

function lifecycleLive(target: LifecycleTarget): boolean {
  const vibe = readState(target.directorID);
  if (!vibe || vibe.stopping || (vibe.generation ?? 0) !== target.directorGeneration) return false;
  if (!target.workerID) return true;
  const worker = workerOf(vibe, target.workerID);
  return Boolean(worker && worker.state !== "stopping" && worker.state !== "dead" && (worker.generation ?? 0) === (target.workerGeneration ?? 0));
}

async function withLifecycleCall<T>(
  target: LifecycleTarget,
  operation: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  return withLifecycleGate(target.directorID, async () => {
    if (!lifecycleLive(target)) return { ok: false, why: "lifecycle завершён или сменился" };
    return { ok: true, value: await operation() };
  });
}

// ---------------------------------------------------------------- durable orphan journal

function orphanPath(directorID: string, workerID: string): string {
  return join(STATE_DIR, `${safeID(directorID)}.orphan-${safeID(workerID)}.json`);
}

function writeOrphan(record: OrphanRecord): boolean {
  return atomicJson(orphanPath(record.directorID, record.workerID), record);
}

function orphanRecords(): Array<{ path: string; record: OrphanRecord }> {
  let names: string[];
  try {
    names = readdirSync(STATE_DIR);
  } catch {
    return [];
  }
  const result: Array<{ path: string; record: OrphanRecord }> = [];
  for (const name of names) {
    if (!name.includes(".orphan-") || !name.endsWith(".json")) continue;
    const path = join(STATE_DIR, name);
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as OrphanRecord;
      if (
        record?.version === 1 &&
        typeof record.directorID === "string" &&
        typeof record.workerID === "string" &&
        typeof record.cwd === "string"
      ) {
        result.push({ path, record });
      }
    } catch {}
  }
  return result;
}

function removeOrphan(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function cleanupSessionAPI(ctx: PluginCtx, record: OrphanRecord): Promise<string[]> {
  const errors: string[] = [];
  let interrupted = false;
  try {
    await ctx.session.interrupt({ sessionID: record.workerID });
    interrupted = true;
  } catch (err: unknown) {
    errors.push(`interrupt: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (interrupted) {
    const idle = await confirmTeardown(ctx, record.workerID);
    if (!idle.ok) errors.push(`idle: ${idle.why}`);
  }
  if (errors.length > 0) return errors;
  try {
    await ctx.session.update({ sessionID: record.workerID, title: `${record.title} (не зачислен)` });
  } catch (err: unknown) {
    errors.push(`rename: ${err instanceof Error ? err.message : String(err)}`);
  }
  return errors;
}

/** Must run under the director lock. Cleanup failures remain durable for setup/recovery. */
async function cleanupCreatedSession(ctx: PluginCtx, record: OrphanRecord): Promise<string[]> {
  const path = orphanPath(record.directorID, record.workerID);
  const journalOK = writeOrphan(record);
  const errors = await cleanupSessionAPI(ctx, record);
  if (errors.length === 0) {
    if (journalOK && !removeOrphan(path)) errors.push("cleanup journal: не удалось удалить");
  } else {
    if (!journalOK) errors.push("cleanup journal: не удалось сохранить");
    else {
      const durable = { ...record, lastError: errors.join("; ") };
      if (!writeOrphan(durable)) errors.push("cleanup journal: не удалось обновить ошибку");
    }
  }
  for (const error of errors) log(`cleanup orphan ${record.workerID}: ${error}`);
  return errors;
}

// ---------------------------------------------------------------- OpenCode V2 API types

type Model = { id: string; providerID: string; variant?: string };
type ModelSource = "agent" | "env" | "small-model" | "session" | "default";
type ModelResolution = { model?: Model; role: Cli; source: ModelSource; error?: string };
type AccessTransition = {
  from: "audit" | "coding";
  to: "coding";
  phase: "switching" | "failed";
  targetAgent: string;
  targetModel?: string;
  startedAt: number;
  error?: string;
};
type Message = {
  id?: string;
  type?: string;
  time?: { created?: number; completed?: number };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  model?: Model;
  outcome?: string;
  content?: unknown[];
  text?: string;
  error?: { name?: string; message?: string } | string;
};
type ToolResult = { content: { type: "text"; text: string }[] };

type SessionAPI = {
  hook(event: string, handler: (payload: unknown) => unknown): Promise<unknown>;
  create(input: Record<string, unknown>): Promise<unknown>;
  get(input: Record<string, unknown>): Promise<unknown>;
  context(input: Record<string, unknown>): Promise<unknown>;
  prompt(input: Record<string, unknown>): Promise<unknown>;
  synthetic(input: Record<string, unknown>): Promise<unknown>;
  interrupt(input: Record<string, unknown>): Promise<unknown>;
  switchAgent(input: Record<string, unknown>): Promise<unknown>;
  switchModel(input: Record<string, unknown>): Promise<unknown>;
  update(input: Record<string, unknown>): Promise<unknown>;
  wait(input: Record<string, unknown>): Promise<unknown>;
  active?(): Promise<unknown>;
};
type AgentEditor = {
  update(id: string, patch: (agent: { permissions: PermissionRule[] } & Record<string, unknown>) => void): void;
};
type ToolEditor = { add(definition: Record<string, unknown>): void };
type ToolHook = (event: string, handler: (payload: unknown) => unknown) => Promise<unknown>;
type CommandEditor = { add(definition: Record<string, unknown>): void };
type WallRpcRegistration = {
  events: { emit: (name: "changed", data: VibeWallChanged) => Promise<void> };
  dispose: () => Promise<void>;
};
type WallRpcContext = {
  register: (
    definition: typeof VibeWallDefinition,
    handlers: { snapshot: (input: { sessionID?: unknown }) => Promise<VibeWallSnapshot> },
  ) => Promise<WallRpcRegistration>;
};
type PluginCtx = {
  session: SessionAPI;
  agent?: {
    get(input: { agentID: string }): Promise<unknown>;
    transform(cb: (editor: AgentEditor) => void): Promise<unknown> | unknown;
  };
  skill?: {
    list(): Promise<unknown>;
  };
  model?: {
    list(): Promise<unknown>;
    default(): Promise<unknown>;
  };
  tool?: {
    transform(cb: (editor: ToolEditor) => void): Promise<unknown> | unknown;
    hook?: ToolHook;
  };
  command: { transform(cb: (editor: CommandEditor) => void): Promise<unknown> | unknown };
  location?: { directory?: string };
  event?: { subscribe?: (input?: { signal?: AbortSignal }) => AsyncIterable<unknown> };
  rpc?: WallRpcContext;
};
type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };

const dataOf = (res: unknown): Record<string, unknown> | undefined => {
  if (typeof res !== "object" || res === null) return undefined;
  const holder = res as { data?: unknown };
  const data = Object.prototype.hasOwnProperty.call(holder, "data") ? holder.data : holder;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
};

async function planSkillPrompt(ctx: PluginCtx, text: string): Promise<SkillPromptPlan> {
  const trimmed = text.trim();
  const match = /^\/skill:([A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s+|$)/.exec(trimmed);
  if (!match) {
    if (trimmed.startsWith("/skill:")) throw new Error("skill token malformed");
    return { text: trimmed, skills: [] };
  }
  const id = match[1];
  const list = ctx.skill?.list;
  if (typeof list !== "function") throw new Error("skill registry unavailable");
  const payload = dataOf(await list.call(ctx.skill));
  const skills = Array.isArray(payload) ? payload : [];
  if (!skills.some((skill) => isRecord(skill) && skill.id === id)) throw new Error(`skill not found: ${id}`);
  const remaining = trimmed.slice(match[0].length).trim();
  if (!remaining) throw new Error("skill prompt text is empty");
  return { text: remaining, skills: [{ id }] };
}

const messagesOf = (res: unknown): Message[] => {
  const data = dataOf(res);
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { messages?: unknown })?.messages)
      ? ((data as { messages: unknown[] }).messages as unknown[])
      : [];
  return list.filter((message): message is Message => typeof message === "object" && message !== null);
};

const textOf = (message: Message | undefined): string => {
  if (!message) return "";
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
};

const toolNamesOf = (messages: Message[]): string[] => {
  const names: string[] = [];
  for (const message of messages) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;
      const typed = part as { type?: unknown; name?: unknown };
      if (typed.type === "tool" && typeof typed.name === "string") names.push(typed.name);
    }
  }
  return names;
};

type WorkerActivity = {
  lastActivityAt?: number;
  lastActivity?: string;
  lastTool?: string;
  lastToolArgs?: string;
  lastIntent?: string;
  toolCallCount: number;
  traceTail: string[];
};

const activityLine = (value: unknown, limit = 120): string | undefined => {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, limit) : undefined;
};

const activityTime = (value: unknown, now: number): number | undefined => {
  if (!isRecord(value)) return undefined;
  for (const candidate of [value.completed, value.ran, value.created]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 && candidate <= now) return candidate;
  }
  return undefined;
};

const activityInput = (part: Record<string, unknown>): string | undefined => {
  const state = isRecord(part.state) ? part.state : undefined;
  const input = isRecord(part.input) ? part.input : isRecord(state?.input) ? state.input : undefined;
  if (!input) return undefined;
  for (const key of ["path", "filePath", "command", "pattern", "query"]) {
    const line = activityLine(input[key]);
    if (line) return line;
  }
  return undefined;
};

function activityFromMessages(messages: Message[], now: number, baselineAssistantIDs: string[] = []): WorkerActivity {
  const baseline = new Set(baselineAssistantIDs);
  const trace: string[] = [];
  let toolCallCount = 0;
  let lastActivityAt: number | undefined;
  let lastActivity: string | undefined;
  let lastTool: string | undefined;
  let lastToolArgs: string | undefined;
  let lastIntent: string | undefined;

  const note = (at: number | undefined, activity: string | undefined): void => {
    if (!activity || (at !== undefined && lastActivityAt !== undefined && at < lastActivityAt)) return;
    if (at !== undefined) lastActivityAt = at;
    lastActivity = activity;
  };

  for (const message of messages) {
    if (message.type !== "assistant" || (message.id !== undefined && baseline.has(message.id))) continue;
    const messageTime = activityTime(message.time, now);
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const raw of parts) {
      if (!isRecord(raw)) continue;
      const type = raw.type;
      if (type === "tool") {
        toolCallCount += 1;
        const name = activityLine(raw.name, 60);
        const args = activityInput(raw);
        const at = activityTime(raw.time, now) ?? activityTime(isRecord(raw.state) ? raw.state.time : undefined, now) ?? messageTime;
        const line = name ? `${name}${args ? `(${args})` : ""}` : activityLine(raw.id, 60);
        if (line) trace.push(line);
        if (name && (at === undefined || lastActivityAt === undefined || at >= lastActivityAt)) {
          lastTool = name;
          lastToolArgs = args;
        }
        note(at, line);
        continue;
      }
      if (type === "text" || type === "reasoning") {
        const line = activityLine(raw.text, 120);
        if (line) lastIntent = line;
        note(messageTime, line);
      }
    }
    if (parts.length === 0 && typeof message.text === "string") {
      const line = activityLine(message.text, 120);
      if (line) lastIntent = line;
      note(messageTime, line);
    }
  }

  return {
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(lastActivity !== undefined ? { lastActivity } : {}),
    ...(lastTool !== undefined ? { lastTool } : {}),
    ...(lastToolArgs !== undefined ? { lastToolArgs } : {}),
    ...(lastIntent !== undefined ? { lastIntent } : {}),
    toolCallCount,
    traceTail: trace.slice(-6),
  };
}

async function refreshWorkerActivity(ctx: PluginCtx, sessionID: string, worker: Worker): Promise<WorkerActivity | undefined> {
  const snap = await snapshot(ctx, sessionID);
  if (snap.error) return undefined;
  const baseline = worker.currentJob?.baseline.assistantIDs ?? worker.lastJob?.baseline.assistantIDs ?? [];
  return activityFromMessages(snap.assistants, Date.now(), baseline);
}

async function refreshWorkerActivities(ctx: PluginCtx, sessionID: string, workerIDs?: string[]): Promise<void> {
  await withDirectorAdmission(sessionID, async () => {
    const vibe = readState(sessionID);
    if (!vibe) return;
    const wanted = workerIDs ? new Set(workerIDs) : undefined;
    let changed = false;
    for (const worker of vibe.workers) {
      if (wanted && !wanted.has(worker.id)) continue;
      const before = JSON.stringify([
        worker.lastActivityAt,
        worker.lastActivity,
        worker.lastTool,
        worker.lastToolArgs,
        worker.lastIntent,
        worker.toolCallCount,
        worker.traceTail,
      ]);
      const activity = await refreshWorkerActivity(ctx, worker.id, worker);
      if (activity) applyWorkerActivity(worker, activity);
      const after = JSON.stringify([
        worker.lastActivityAt,
        worker.lastActivity,
        worker.lastTool,
        worker.lastToolArgs,
        worker.lastIntent,
        worker.toolCallCount,
        worker.traceTail,
      ]);
      if (before !== after) changed = true;
    }
    if (changed) writeStateUnlocked(vibe);
  });
}

async function refreshAndDescribeJobs(ctx: PluginCtx, sessionID: string, jobs: DurableJob[]): Promise<string> {
  const workerIDs = jobs.map((job) => job.workerID);
  await refreshWorkerActivities(ctx, sessionID, workerIDs);
  const vibe = readState(sessionID);
  if (!vibe) return "Последняя активность недоступна: state исчез.";
  const now = Date.now();
  return vibe.workers
    .filter((worker) => workerIDs.includes(worker.id))
    .map((worker) => {
      const job = worker.currentJob ?? worker.lastJob;
      const bits = [`\`${worker.id}\``, "stillRunning=true"];
      if (job) bits.push(`elapsed=${fmtDuration(Math.max(0, now - job.startedAt))}`);
      if (worker.lastActivityAt !== undefined) bits.push(`lastActivityAt=${worker.lastActivityAt}`);
      if (worker.lastActivity) bits.push(`lastActivity=${worker.lastActivity}`);
      if (worker.lastTool) bits.push(`lastTool=${worker.lastTool}`);
      if (worker.toolCallCount !== undefined) bits.push(`toolCallCount=${worker.toolCallCount}`);
      if (worker.traceTail?.length) bits.push(`traceTail=${worker.traceTail.join(" | ")}`);
      if (worker.lastActivityAt !== undefined) bits.push(`age=${fmtDuration(Math.max(0, now - worker.lastActivityAt))}`);
      if (job) bits.push(`job=${job.phase}`);
      return bits.join(" · ");
    })
    .join("\n");
}

function sameLocation(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return resolve(left) === resolve(right);
}

function contextLocation(ctx: PluginCtx): string | undefined {
  const directory = ctx.location?.directory;
  return typeof directory === "string" && directory ? resolve(directory) : undefined;
}

function scopeMatches(
  vibe: Vibe,
  sessionID: string,
  authoritativeAgent: string,
  location: string | undefined,
): boolean {
  const scope = vibe.lifecycleScope;
  if (!scope) return true;
  return (
    scope.directorSessionID === sessionID &&
    scope.directorAgent === authoritativeAgent &&
    sameLocation(location, scope.cwd)
  );
}

async function activeDirectorIDs(ctx: PluginCtx, location: string | undefined): Promise<Set<string> | undefined> {
  const active = ctx.session.active;
  if (typeof active !== "function" || !location) return undefined;
  const activeData = dataOf(await active.call(ctx.session).catch(() => undefined));
  if (!activeData) return undefined;
  const activeSessionIDs = Object.keys(activeData);
  if (activeSessionIDs.length === 0) return new Set();

  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter((name) => name.endsWith(".json") && !name.includes(".orphan-"));
  } catch {
    return new Set();
  }
  const states = files
    .map((file) => readAnyState(file.slice(0, -".json".length)))
    .filter((state): state is Vibe => Boolean(state?.enabled && state.lifecycleScope?.version === 2 && sameLocation(state.cwd, location)));
  const directorIDs = new Set<string>();
  for (const sessionID of activeSessionIDs) {
    const parent = states.find((state) => state.sessionID === sessionID || state.workers.some((worker) => worker.id === sessionID));
    if (parent) {
      directorIDs.add(parent.sessionID);
      continue;
    }
    const info = dataOf(await ctx.session.get({ sessionID }).catch(() => undefined));
    const agent = typeof info?.agent === "string" ? info.agent : undefined;
    const activeLocation = isRecord(info?.location) && typeof info.location.directory === "string" ? info.location.directory : undefined;
    if (agent === DIRECTOR_AGENT && sameLocation(activeLocation, location)) directorIDs.add(sessionID);
  }
  return directorIDs;
}

async function scopeViolation(ctx: PluginCtx, sessionID: string): Promise<string | undefined> {
  const vibe = readState(sessionID);
  if (!vibe?.lifecycleScope) return undefined;
  const info = dataOf(await ctx.session.get({ sessionID }).catch(() => undefined));
  const agent = typeof info?.agent === "string" ? info.agent : undefined;
  const location = isRecord(info?.location) && typeof info.location.directory === "string" ? info.location.directory : undefined;
  if (!agent || !scopeMatches(vibe, sessionID, agent, location)) {
    return `vibe scope mismatch для ${sessionID}: требуется ${vibe.lifecycleScope.directorAgent}`;
  }
  const activeIDs = await activeDirectorIDs(ctx, vibe.cwd);
  if (!activeIDs || activeIDs.size === 0) return `vibe scope status unavailable для ${sessionID}`;
  if (activeIDs.size > 1) return `vibe scope ambiguous для ${sessionID}`;
  if (!activeIDs.has(sessionID)) return `vibe scope inactive для ${sessionID}`;
  return undefined;
}

async function coordinatorScopeViolation(ctx: PluginCtx, sessionID: string): Promise<string | undefined> {
  await reconcileDirectorScope(ctx, sessionID);
  return scopeViolation(ctx, sessionID);
}

async function reconcileDirectorScope(ctx: PluginCtx, _currentSessionID: string): Promise<void> {
  const location = contextLocation(ctx);
  if (!location) return;
  const activeIDs = await activeDirectorIDs(ctx, location);
  if (!activeIDs || activeIDs.size !== 1) return;
  const [activeDirectorID] = activeIDs;
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter((name) => name.endsWith(".json") && !name.includes(".orphan-"));
  } catch {
    return;
  }
  for (const file of files) {
    const directorID = file.slice(0, -".json".length);
    const state = readAnyState(directorID);
    if (!state?.enabled || state.lifecycleScope?.version !== 2 || !sameLocation(state.cwd, location)) continue;
    await withDirectorAdmission(directorID, async () => {
      const current = readState(directorID);
      if (!current?.enabled) return;
      let changed = false;
      for (const worker of current.workers) {
        if (current.sessionID === activeDirectorID) {
          if (worker.suspended === true) {
            worker.suspended = false;
            changed = true;
          }
        } else if (worker.suspended !== true) {
          worker.suspended = true;
          changed = true;
        }
      }
      if (changed && !writeStateUnlocked(current)) {
        log(`scope ${directorID}: suspension state не записан`);
      }
    });
  }
}

async function sessionModel(ctx: PluginCtx, sessionID: string): Promise<Model | undefined> {
  try {
    const model = dataOf(await ctx.session.get({ sessionID }))?.model;
    if (typeof model !== "object" || model === null) return undefined;
    const typed = model as { id?: unknown; providerID?: unknown; variant?: unknown };
    return typeof typed.id === "string" && typeof typed.providerID === "string"
      ? { id: typed.id, providerID: typed.providerID, ...(typeof typed.variant === "string" && typed.variant ? { variant: typed.variant } : {}) }
      : undefined;
  } catch (err: unknown) {
    log(`sessionModel err: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function sessionDirectory(ctx: PluginCtx, sessionID: string): Promise<string | undefined> {
  try {
    const location = dataOf(await ctx.session.get({ sessionID }))?.location;
    if (typeof location !== "object" || location === null) return undefined;
    const directory = (location as { directory?: unknown }).directory;
    return typeof directory === "string" && directory ? directory : undefined;
  } catch (err: unknown) {
    log(`sessionDirectory err: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function parseModel(text: string | undefined): Model | undefined {
  if (!text) return undefined;
  const slash = text.indexOf("/");
  if (slash <= 0) return undefined;
  const hash = text.lastIndexOf("#");
  const hasVariant = hash > slash + 1 && hash < text.length - 1;
  const ref = hasVariant ? text.slice(0, hash) : text;
  const variant = hasVariant ? text.slice(hash + 1) : undefined;
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) };
}

function modelLabel(model: Model | undefined): string | undefined {
  return model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : undefined;
}

function modelFromMessage(message: Message | undefined): string | undefined {
  const model = message?.model;
  if (typeof model !== "object" || model === null) return undefined;
  const typed = model as { id?: unknown; providerID?: unknown; variant?: unknown };
  if (typeof typed.id !== "string" || typeof typed.providerID !== "string") return undefined;
  return modelLabel({
    id: typed.id,
    providerID: typed.providerID,
    ...(typeof typed.variant === "string" && typed.variant ? { variant: typed.variant } : {}),
  });
}

function outputTailFromMessages(messages: readonly Message[]): string[] {
  return messages
    .flatMap((message) => {
      if (message.type !== "assistant" && message.type !== "synthetic") return [];
      const line = activityLine(textOf(message), 240);
      return line ? [line] : [];
    })
    .slice(-3);
}

function tokenRateFromMessages(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const output = message.tokens?.output;
    const created = message.time?.created;
    const completed = message.time?.completed;
    if (message.type !== "assistant" || !isFiniteNumber(output) || output <= 0 || !isFiniteNumber(created) || !isFiniteNumber(completed)) continue;
    const duration = completed - created;
    if (duration < 100) return undefined;
    const rate = (output * 1000) / duration;
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
  }
  return undefined;
}

function smallModelFromConfig(): Model | undefined {
  const dir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, "opencode", name), "utf8")) as { small_model?: unknown };
      if (typeof raw.small_model === "string") return parseModel(raw.small_model);
    } catch {}
  }
  return undefined;
}

type AgentInfo = { id?: unknown; model?: unknown; system?: unknown };
type AgentInfoResult = { info?: AgentInfo; error?: string };

async function agentInfoResult(ctx: PluginCtx, agentID: string): Promise<AgentInfoResult> {
  const get = ctx.agent?.get?.bind(ctx.agent);
  if (typeof get !== "function") return { error: "agent API unavailable" };
  try {
    return { info: dataOf(await get({ agentID })) as AgentInfo | undefined };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function agentInfo(ctx: PluginCtx, agentID: string): Promise<AgentInfo | undefined> {
  return (await agentInfoResult(ctx, agentID)).info;
}

function modelFromAgentInfo(info: AgentInfo | undefined): Model | undefined {
  const model = info?.model;
  if (typeof model === "object" && model !== null) {
    const typed = model as { id?: unknown; providerID?: unknown; variant?: unknown };
    if (typeof typed.id === "string" && typeof typed.providerID === "string") {
      return { id: typed.id, providerID: typed.providerID, ...(typeof typed.variant === "string" && typed.variant ? { variant: typed.variant } : {}) };
    }
  }
  if (typeof info?.system !== "string") return undefined;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(info.system)?.[1];
  if (!frontmatter) return undefined;
  const value = frontmatter.match(/^model:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return value ? parseModel(value) : undefined;
}

async function resolveWorkerModel(ctx: PluginCtx, _director: string, cli: Cli, readOnly: boolean): Promise<ModelResolution> {
  const agentID = workerAgentID(cli, readOnly);
  const result = await agentInfoResult(ctx, agentID);
  if (result.error) {
    return { role: cli, source: "agent", error: `agent lookup failed: ${result.error}` };
  }

  const pinned = modelFromAgentInfo(result.info);
  if (pinned) return { model: pinned, role: cli, source: "agent" };

  if (cli === "fast") {
    const envModel = parseModel(process.env.VIBE_FAST_MODEL);
    if (envModel) return { model: envModel, role: cli, source: "env" };
    const smallModel = smallModelFromConfig();
    if (smallModel) return { model: smallModel, role: cli, source: "small-model" };
  } else {
    const envModel = parseModel(process.env.VIBE_GOOD_MODEL);
    if (envModel) return { model: envModel, role: cli, source: "env" };
  }

  if (process.env.VIBE_MODEL_FALLBACK === "default") {
    const defaultModel = ctx.model?.default;
    if (typeof defaultModel === "function") {
      try {
        const raw = dataOf(await defaultModel.call(ctx.model));
        const providerID = raw?.providerID;
        const id = raw?.modelID ?? raw?.id;
        if (typeof providerID === "string" && typeof id === "string") {
          return { model: { providerID, id }, role: cli, source: "default" };
        }
      } catch (error: unknown) {
        return { role: cli, source: "default", error: `model default failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }

  return { role: cli, source: "agent", error: `agent ${agentID} has no usable model` };
}

async function missingAgents(ctx: PluginCtx): Promise<string[]> {
  const missing: string[] = [];
  for (const id of [DIRECTOR_AGENT, WORKER_AGENT.fast, WORKER_AGENT.good]) {
    const info = await agentInfo(ctx, id);
    if (typeof info?.id !== "string") missing.push(id);
  }
  return missing;
}

// ---------------------------------------------------------------- event bus

type ExecEvent = {
  seq: number;
  at: number;
  type: "delivered" | "started" | "succeeded" | "failed" | "interrupted";
  sessionID: string;
  inboxID?: string;
  reason?: string;
};

const execEvents = new Map<string, ExecEvent[]>();
const execWaiters = new Map<string, Set<() => void>>();
let eventSequence = 0;
let eventsBound = false;
let eventBinding: { ctx: PluginCtx; token: symbol; abort: AbortController } | undefined;

function wakeExecWaiters(sessionID?: string): void {
  const waiters = sessionID ? execWaiters.get(sessionID) : undefined;
  if (sessionID && waiters) for (const wake of [...waiters]) wake();
  else if (!sessionID) for (const set of execWaiters.values()) for (const wake of [...set]) wake();
}

function noteExec(event: Omit<ExecEvent, "seq" | "at">): void {
  const value: ExecEvent = { ...event, seq: ++eventSequence, at: Date.now() };
  const list = execEvents.get(event.sessionID) ?? [];
  list.push(value);
  if (list.length > 64) list.splice(0, list.length - 64);
  execEvents.set(event.sessionID, list);
  wakeExecWaiters(event.sessionID);
}

function execEventsSince(sessionID: string, afterSeq: number): ExecEvent[] {
  return (execEvents.get(sessionID) ?? []).filter((event) => event.seq > afterSeq);
}

function waitForExecEvent(sessionID: string, afterSeq: number, signal?: AbortSignal): Promise<void> {
  if (execEventsSince(sessionID, afterSeq).length > 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    const set = execWaiters.get(sessionID) ?? new Set<() => void>();
    execWaiters.set(sessionID, set);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      set.delete(finish);
      if (set.size === 0) execWaiters.delete(sessionID);
      signal?.removeEventListener("abort", finish);
      resolveWait();
    };
    set.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function waitForExecEventBounded(sessionID: string, afterSeq: number, signal: AbortSignal, timeoutMs: number): Promise<"event" | "timeout"> {
  const deadline = waitDeadline(Math.max(1, timeoutMs));
  try {
    return await Promise.race([
      waitForExecEvent(sessionID, afterSeq, signal).then(() => "event" as const),
      deadline.promise.then(() => "timeout" as const),
    ]);
  } finally {
    deadline.cancel();
  }
}

const reconnectDelay = (): Promise<void> =>
  new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, EVENT_RECONNECT_MS);
    timer.unref?.();
  });

function directorIDForWorker(workerID: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter((name) => name.endsWith(".json") && !name.includes(".orphan-"));
  } catch {
    return undefined;
  }
  for (const file of files) {
    const directorID = file.slice(0, -".json".length);
    const state = readAnyState(directorID);
    if (state?.workers.some((worker) => worker.id === workerID)) return directorID;
  }
  return undefined;
}

async function refreshWallForWorkerEvent(ctx: PluginCtx, workerID: string): Promise<void> {
  const directorID = directorIDForWorker(workerID);
  if (!directorID) return;
  try {
    await refreshWorkerActivities(ctx, directorID, [workerID]);
    const state = readState(directorID);
    if (state) publishWallChanged(directorID, state.revision ?? 0);
  } catch (error: unknown) {
    log(`wall event ${workerID}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function bindEvents(ctx: PluginCtx): void {
  const subscribe = ctx.event?.subscribe?.bind(ctx.event);
  if (typeof subscribe !== "function") {
    log("ctx.event.subscribe недоступен — completion ждёт public session.wait или остаётся retryable");
    return;
  }
  if (eventsBound && eventBinding?.ctx === ctx) return;
  eventBinding?.abort.abort();
  const token = Symbol("vibe-events");
  const abort = new AbortController();
  eventBinding = { ctx, token, abort };
  eventsBound = true;

  void (async () => {
    try {
      while (eventBinding?.token === token && !abort.signal.aborted) {
        try {
          const stream = await subscribe({ signal: abort.signal });
          for await (const raw of stream) {
            if (typeof raw !== "object" || raw === null) continue;
            const envelope: unknown =
              "event" in raw && typeof (raw as { event?: unknown }).event === "object"
                ? (raw as { event: unknown }).event
                : raw;
            if (typeof envelope !== "object" || envelope === null) continue;
            const event = envelope as { type?: unknown; data?: unknown };
            if (typeof event.type !== "string") continue;
            const data = typeof event.data === "object" && event.data !== null ? (event.data as Record<string, unknown>) : undefined;
            const sessionID = data?.sessionID;
            if (typeof sessionID !== "string") continue;
            if (event.type === "session.inbox.delivered") {
              const inboxID = data.inboxID;
              noteExec({
                sessionID,
                type: "delivered",
                inboxID: typeof inboxID === "string" ? inboxID : undefined,
              });
              void refreshWallForWorkerEvent(ctx, sessionID);
              continue;
            }
            if (!event.type.startsWith("session.execution.")) continue;
            const suffix = event.type.slice("session.execution.".length);
            if (suffix !== "started" && suffix !== "succeeded" && suffix !== "failed" && suffix !== "interrupted") continue;
            const error = data.error;
            const reason =
              typeof data.reason === "string"
                ? data.reason
                : typeof error === "string"
                  ? error
                  : typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
                    ? (error as { message: string }).message
                    : undefined;
            noteExec({ sessionID, type: suffix, reason });
            void refreshWallForWorkerEvent(ctx, sessionID);
          }
          log("поток событий закрылся — reconnect");
        } catch (err: unknown) {
          log(`подписка на события не удалась: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (eventBinding?.token !== token || abort.signal.aborted) return;
        wakeExecWaiters();
        await reconnectDelay();
      }
    } finally {
      if (eventBinding?.token === token) {
        eventsBound = false;
        eventBinding = undefined;
      }
    }
  })();
}

// ---------------------------------------------------------------- snapshots and IDs

type Snapshot = {
  idleID?: string;
  idleOutcome?: string;
  assistants: Message[];
  assistantIDs: string[];
  last?: Message;
  hasMessage: (id: string) => boolean;
  error?: string;
};

async function snapshot(ctx: PluginCtx, sessionID: string): Promise<Snapshot> {
  try {
    const list = messagesOf(await ctx.session.context({ sessionID }));
    const assistants = list.filter((message) => message.type === "assistant");
    const idle = [...list].reverse().find((message) => message.type === "idle");
    const ids = new Set(list.map((message) => message.id).filter((id): id is string => typeof id === "string"));
    return {
      idleID: idle?.id,
      idleOutcome: idle?.outcome,
      assistants,
      assistantIDs: assistants.map((message) => message.id).filter((id): id is string => typeof id === "string"),
      last: assistants[assistants.length - 1],
      hasMessage: (id) => ids.has(id),
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    log(`context err: ${err instanceof Error ? err.message : String(err)}`);
    return { assistants: [], assistantIDs: [], hasMessage: () => false, error };
  }
}

let lastMessageTimestamp = 0;
let messageCounter = 0;
const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Installed OpenCode Identifier.create("msg") algorithm: 12 time/counter hex + 14 base62 chars. */
function createMessageID(): string {
  const now = Date.now();
  if (now !== lastMessageTimestamp) {
    lastMessageTimestamp = now;
    messageCounter = 0;
  }
  messageCounter += 1;
  let value = BigInt(now) * 0x1000n + BigInt(messageCounter);
  value = ~value;
  const bytes = Array.from({ length: 6 }, (_, index) => Number((value >> BigInt(40 - index * 8)) & 0xffn))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const random = randomBytes(14);
  const suffix = Array.from(random, (byte) => base62[byte % base62.length]).join("");
  return `msg_${bytes}${suffix}`;
}

// ---------------------------------------------------------------- workers and jobs

function workerOf(vibe: Vibe, id: string): Worker | undefined {
  return vibe.workers.find((worker) => worker.id === id);
}

function queueItems(worker: Worker): QueueItem[] {
  return (worker.queued ?? []).map((item) =>
    typeof item === "string" ? { id: createMessageID(), text: item } : item,
  );
}

function fmtDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}с` : `${Math.floor(seconds / 60)}м ${seconds % 60}с`;
}

function effectiveLimitsText(): string {
  const workers = workerCapLimit();
  const timeout = turnTimeoutLimit();
  return `limits: cap=${workers.value} (${workers.source}); turnTimeout=${fmtDuration(timeout.value)} (${timeout.source}); native cap/timeout: unverified`;
}

function xmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resultBlock(worker: Worker, settle: Settle | undefined, preview = true): string {
  if (!settle) {
    return `<vibe-turn session="${xmlAttr(worker.id)}" cli="${worker.cli}" turn="${worker.turns}" status="unknown" model="unknown">\nход не дождался подтверждённого конца за ${fmtDuration(turnTimeoutMs())} — job остаётся retryable\n</vibe-turn>`;
  }
  const truncated = preview && settle.text.length > RESULT_MAX;
  const text = preview ? settle.text.slice(0, RESULT_MAX) : settle.text;
  const trace = settle.tools.slice(-TURN_TRACE_CAP);
  const overflow = Math.max(0, settle.toolCount - trace.length);
  const traceLines = trace.map((tool) => `- ${xmlAttr(tool)}`);
  if (overflow > 0) traceLines.push(`- … ${overflow} earlier tool call(s) not shown`);
  const activity = `<activity tool-calls="${settle.toolCount}">\n${traceLines.join("\n")}\n</activity>`;
  const model = settle.model ?? "unknown";
  const attrs = [
    `session="${xmlAttr(worker.id)}"`,
    `cli="${xmlAttr(settle.cli)}"`,
    `turn="${settle.turn}"`,
    `status="${xmlAttr(settle.status)}"`,
    `duration="${fmtDuration(settle.duration)}"`,
    `model="${xmlAttr(model)}"`,
  ].join(" ");
  const alive = worker.state === "dead" || worker.state === "stopping" || worker.state === "starting" ? "" : `\nСессия \`${worker.id}\` жива и помнит разговор — продолжай через vibe_send.`;
  const responseTag = truncated ? `<response truncated="true">` : "<response>";
  const truncationNote = truncated ? "\n[truncated=true; полный ответ доступен через vibe_wait]" : "";
  return `<vibe-turn ${attrs}>${activity}\n${responseTag}\n${xmlText(text || "(пустой ответ)")}${truncationNote}\n</response>${settle.reason ? `\n<error>${xmlAttr(settle.reason)}</error>` : ""}${alive}\n</vibe-turn>`;
}

function errorSettle(worker: Worker, job: DurableJob, status: string, reason: string, text: string, ms: number): Settle {
  return {
    workerID: worker.id,
    jobID: job.id,
    cli: worker.cli,
    turn: job.turn,
    status,
    reason,
    text,
    tools: [],
    toolCount: 0,
    duration: ms,
    model: "unknown",
  };
}

function messageErrorText(message: Message | undefined): string | undefined {
  const error = message?.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && typeof error.message === "string") return error.message;
  return undefined;
}

function isDefiniteSteerRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    _tag?: unknown;
  };
  const status = typeof value.status === "number" ? value.status : typeof value.statusCode === "number" ? value.statusCode : undefined;
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 425 && status !== 429) {
    return true;
  }
  const label = [value.code, value.name, value._tag]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  return /bad.?request|invalid|unsupported|rejected|not.?allowed/i.test(label);
}

type JobOutcome = { kind: "settled"; settle: Settle } | { kind: "retryable"; message: string } | { kind: "aborted" };
type Pending = {
  directorID: string;
  directorGeneration: number;
  workerGeneration: number;
  cwd: string;
  jobID: string;
  workerID: string;
  promise: Promise<JobOutcome>;
  resolve: (outcome: JobOutcome) => void;
  controller: AbortController;
  state: "running" | "retryable" | "settled";
  result?: Settle;
};
const pending = new Map<string, Pending>();

function abortPendingForDirector(directorID: string): void {
  for (const entry of pending.values()) if (entry.directorID === directorID) entry.controller.abort();
}

function abortPendingForWorker(directorID: string, workerID: string): void {
  for (const entry of pending.values()) if (entry.directorID === directorID && entry.workerID === workerID) entry.controller.abort();
}

function makeJob(worker: Worker, turn: number, baseline: Baseline, startedAt: number, directorGeneration = 0): DurableJob {
  return {
    id: `${worker.id}:t${turn}:${createMessageID()}`,
    workerID: worker.id,
    cli: worker.cli,
    turn,
    model: worker.model,
    modelRole: worker.modelRole,
    modelSource: worker.modelSource,
    modelError: worker.modelError,
    directorGeneration,
    workerGeneration: worker.generation ?? 0,
    messageID: createMessageID(),
    startedAt,
    phase: "starting",
    delivery: "none",
    baseline,
  };
}

function hasActiveJob(worker: Worker): boolean {
  return worker.currentJob !== undefined && worker.currentJob.phase !== "settled";
}

function hasUnconfirmedDelivery(worker: Worker): boolean {
  const job = worker.lastJob;
  return Boolean(
    job &&
      job.consumedAt === undefined &&
      (job.delivery === "failed" || job.delivery === "synthetic" || job.delivery === "delivery-unknown"),
  );
}

const deliveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const deliveryStateUnknown = new Set<string>();

function deliveryBackoff(attempt: number): number {
  const exponential = Math.min(DELIVERY_MAX_MS, DELIVERY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return exponential + Math.floor(Math.random() * DELIVERY_JITTER_MS);
}

function cancelDeliveryRetry(jobID: string): void {
  const timer = deliveryRetryTimers.get(jobID);
  if (timer) clearTimeout(timer);
  deliveryRetryTimers.delete(jobID);
}

async function retrySyntheticDelivery(ctx: PluginCtx, directorID: string, jobID: string): Promise<void> {
  const prepared = await withDirectorAdmission(directorID, async () => {
    const vibe = readState(directorID);
    const worker = vibe?.workers.find((candidate) => candidate.lastJob?.id === jobID);
    const job = worker?.lastJob?.id === jobID ? worker.lastJob : undefined;
    if (!vibe || vibe.stopping || !worker || !job || (job.delivery !== "failed" && job.delivery !== "synthetic") || job.consumedAt !== undefined || job.claim || !job.result) return undefined;
    job.syntheticID ??= createMessageID();
    if (!writeStateUnlocked(vibe)) return undefined;
    return {
      text: resultBlock(worker, job.result, true),
      syntheticID: job.syntheticID,
      target: {
        directorID,
        directorGeneration: vibe.generation ?? 0,
        workerID: worker.id,
        workerGeneration: worker.generation ?? 0,
      },
      workerID: worker.id,
    };
  });
  if (!prepared) return;
  try {
    const call = await withLifecycleCall(prepared.target, () =>
      ctx.session.synthetic({ sessionID: directorID, id: prepared.syntheticID, text: prepared.text, resume: DELIVER === "wake" }),
    );
    if (!call.ok) {
      await withDirectorAdmission(directorID, async () => {
        const vibe = readState(directorID);
        const worker = vibe?.workers.find((candidate) => candidate.lastJob?.id === jobID);
        const job = worker?.lastJob?.id === jobID ? worker.lastJob : undefined;
        if (!vibe || !worker || !job || (job.delivery !== "failed" && job.delivery !== "synthetic")) return false;
        job.delivery = "cancelled";
        job.deliveryRetryAt = undefined;
        return writeStateUnlocked(vibe);
      });
      cancelDeliveryRetry(jobID);
      return;
    }
    const saved = await withDirectorAdmission(directorID, async () => {
      const vibe = readState(directorID);
      const worker = vibe?.workers.find((candidate) => candidate.lastJob?.id === jobID);
      const job = worker?.lastJob?.id === jobID ? worker.lastJob : undefined;
      if (!vibe || !worker || !job || (job.delivery !== "failed" && job.delivery !== "synthetic") || job.syntheticID !== prepared.syntheticID) return false;
      job.delivery = "delivered";
      vibe.turnsDelivered += 1;
      job.deliveryAttempts = 0;
      job.deliveryRetryAt = undefined;
      return writeStateUnlocked(vibe);
    });
    if (saved) {
      deliveryStateUnknown.delete(jobID);
      cancelDeliveryRetry(jobID);
      await startQueuedTurn(ctx, directorID, prepared.workerID);
    } else {
      deliveryStateUnknown.add(jobID);
      log(`job ${jobID}: synthetic retry delivered, but acknowledgement state write failed`);
    }
  } catch (error: unknown) {
    const retry = await withDirectorAdmission(directorID, async () => {
      const vibe = readState(directorID);
      const worker = vibe?.workers.find((candidate) => candidate.lastJob?.id === jobID);
      const job = worker?.lastJob?.id === jobID ? worker.lastJob : undefined;
      if (!vibe || vibe.stopping || !worker || !job || (job.delivery !== "failed" && job.delivery !== "synthetic")) return undefined;
      job.deliveryAttempts = (job.deliveryAttempts ?? 1) + 1;
      job.deliveryRetryAt = Date.now() + deliveryBackoff(job.deliveryAttempts);
      return writeStateUnlocked(vibe) ? job.deliveryAttempts : undefined;
    });
    if (retry) scheduleDeliveryRetry(ctx, directorID, jobID, retry);
    log(`synthetic delivery retry ${jobID}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleDeliveryRetry(ctx: PluginCtx, directorID: string, jobID: string, attempt: number): void {
  cancelDeliveryRetry(jobID);
  const timer = setTimeout(() => {
    deliveryRetryTimers.delete(jobID);
    void retrySyntheticDelivery(ctx, directorID, jobID);
  }, deliveryBackoff(attempt));
  timer.unref?.();
  deliveryRetryTimers.set(jobID, timer);
}

function waitDeadline(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  const deferred = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => deferred.resolve("timeout"), ms);
  timer.unref?.();
  return { promise: deferred.promise, cancel: () => clearTimeout(timer) };
}

async function waitForPublicIdle(
  ctx: PluginCtx,
  workerID: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ kind: "idle" } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error"; error: unknown }> {
  const deadline = waitDeadline(timeoutMs);
  const aborted = Promise.withResolvers<"aborted">();
  const onAbort = (): void => aborted.resolve("aborted");
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    const request = Promise.resolve(ctx.session.wait({ sessionID: workerID }));
    return await Promise.race([
      request.then(() => ({ kind: "idle" as const })),
      deadline.promise.then(() => ({ kind: "timeout" as const })),
      aborted.promise.then(() => ({ kind: "aborted" as const })),
    ]);
  } catch (error: unknown) {
    return { kind: "error", error };
  } finally {
    deadline.cancel();
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForDelivery(
  ctx: PluginCtx,
  entry: Pending,
  job: DurableJob,
  deadline: number,
): Promise<{ deliveredSeq: number } | { retryable: string } | { aborted: true }> {
  let cursor = 0;
  for (;;) {
    const exactEvent = execEventsSince(job.workerID, cursor).find(
      (event) => event.type === "delivered" && event.inboxID === job.messageID,
    );
    if (exactEvent) return { deliveredSeq: exactEvent.seq };
    if (entry.controller.signal.aborted) return { aborted: true };
    if (typeof ctx.event?.subscribe !== "function") {
      return { retryable: `prompt ${job.messageID} принят, но public session.wait доступен без подтверждённой доставки; повтори vibe_wait` };
    }
    const next = execEventsSince(job.workerID, cursor).at(-1);
    cursor = next?.seq ?? cursor;
    const eventResult = await waitForExecEventBounded(job.workerID, cursor, entry.controller.signal, deadline - Date.now());
    if (eventResult === "timeout") {
      return { retryable: `prompt ${job.messageID} принят, но public session.wait не подтвердил доставку за ${fmtDuration(turnTimeoutMs())}; повтори vibe_wait` };
    }
    // The event that woke this wait may be the exact delivery; rescan before advancing past it.
  }
}

async function observeAcceptedJob(ctx: PluginCtx, entry: Pending, job: DurableJob): Promise<JobOutcome> {
  const started = Date.now();
  const deadline = started + turnTimeoutMs();
  const delivery = await waitForDelivery(ctx, entry, job, deadline);
  if ("aborted" in delivery) return { kind: "aborted" };
  if ("retryable" in delivery) {
    await persistRetryable(entry, job, delivery.retryable);
    return { kind: "retryable", message: delivery.retryable };
  }

  const firstWait = await waitForPublicIdle(ctx, job.workerID, entry.controller.signal, Math.max(1, deadline - Date.now()));
  if (firstWait.kind === "aborted") return { kind: "aborted" };
  if (firstWait.kind === "error") {
    const message = `public session.wait не подтвердил конец: ${firstWait.error instanceof Error ? firstWait.error.message : String(firstWait.error)}`;
    await persistRetryable(entry, job, message);
    return { kind: "retryable", message };
  }

  if (firstWait.kind === "timeout") {
    try {
      await ctx.session.interrupt({ sessionID: job.workerID });
    } catch (error: unknown) {
      const message = `timeout не подтверждён interrupt: ${error instanceof Error ? error.message : String(error)}`;
      await persistRetryable(entry, job, message);
      return { kind: "retryable", message };
    }
    const confirmed = await waitForPublicIdle(ctx, job.workerID, entry.controller.signal, turnTimeoutMs());
    if (confirmed.kind === "aborted") return { kind: "aborted" };
    if (confirmed.kind === "error" || confirmed.kind === "timeout") {
      const message = "timeout после interrupt не подтверждён public session.wait; job retryable";
      await persistRetryable(entry, job, message);
      return { kind: "retryable", message };
    }
    const worker = workerOf(readState(entry.directorID) ?? { workers: [] } as Vibe, job.workerID) ?? {
      id: job.workerID,
      cli: job.cli,
      title: job.workerID,
      model: job.model,
      state: "running" as const,
      turns: job.turn,
      queued: [],
      startedAt: job.startedAt,
    };
    return {
      kind: "settled",
      settle: errorSettle(
        worker,
        job,
        "timeout",
        `ход не дождался конца за ${fmtDuration(turnTimeoutMs())}`,
        "ход не дождался конца",
        Date.now() - started,
      ),
    };
  }

  let cursor = delivery.deliveredSeq;
  for (;;) {
    if (entry.controller.signal.aborted) return { kind: "aborted" };
    const snap = await snapshot(ctx, job.workerID);
    if (snap.error) {
      const message = `контекст worker недоступен после public session.wait: ${snap.error}`;
      await persistRetryable(entry, job, message);
      return { kind: "retryable", message };
    }
    const baseline = new Set(job.baseline.assistantIDs);
    const fresh = snap.assistants.filter((message) => typeof message.id === "string" && !baseline.has(message.id));
    const events = execEventsSince(job.workerID, cursor);
    cursor = events.at(-1)?.seq ?? cursor;
    const terminal = events
      .filter((event) => event.type === "failed" || event.type === "interrupted" || event.type === "succeeded")
      .at(-1);
    const freshIdle = snap.idleID !== undefined && snap.idleID !== job.baseline.idleID;
    if (fresh.length > 0) {
      const assistant = fresh.at(-1) as Message;
      const assistantError = messageErrorText(assistant);
      const tools = toolNamesOf(fresh);
      const status = terminal?.type === "failed" ? "error" : terminal?.type === "interrupted" ? "interrupted" : assistantError ? "error" : snap.idleOutcome ?? "succeeded";
      return {
        kind: "settled",
        settle: {
          workerID: job.workerID,
          jobID: job.id,
          cli: job.cli,
          turn: job.turn,
          status,
          outcome: snap.idleOutcome,
          reason: terminal?.reason ?? assistantError,
          text: textOf(assistant),
          tools,
          toolCount: tools.length,
          duration: Math.max(0, Date.now() - started),
          model: modelFromMessage(assistant) ?? "unknown",
        },
      };
    }
    if (freshIdle) {
      const message = "fresh idle без assistant evidence; correlation текущего job не подтверждена";
      await persistRetryable(entry, job, message);
      return { kind: "retryable", message };
    }
    if (Date.now() >= deadline) {
      try {
        await ctx.session.interrupt({ sessionID: job.workerID });
        const confirmed = await waitForPublicIdle(ctx, job.workerID, entry.controller.signal, turnTimeoutMs());
        if (confirmed.kind === "idle") {
          const worker = workerOf(readState(entry.directorID) ?? { workers: [] } as Vibe, job.workerID);
          return {
            kind: "settled",
            settle: errorSettle(
              worker ?? ({ id: job.workerID, cli: job.cli, title: job.workerID, model: job.model, state: "running", turns: job.turn, queued: [], startedAt: job.startedAt } as Worker),
              job,
              "timeout",
              `ход не дождался конца за ${fmtDuration(turnTimeoutMs())}`,
              "ход не дождался конца",
              Date.now() - started,
            ),
          };
        }
      } catch {}
      const message = "подтверждение конца не получено; job retryable";
      await persistRetryable(entry, job, message);
      return { kind: "retryable", message };
    }
    const next = execEventsSince(job.workerID, cursor).at(-1);
    cursor = next?.seq ?? cursor;
    await waitForExecEvent(job.workerID, cursor, entry.controller.signal);
    cursor = execEventsSince(job.workerID, cursor).at(-1)?.seq ?? cursor;
  }
}

async function persistRetryable(entry: Pending, job: DurableJob, message: string): Promise<void> {
  const saved = await withDirectorAdmission(entry.directorID, async () => {
    const vibe = readState(entry.directorID);
    const worker = vibe ? workerOf(vibe, job.workerID) : undefined;
    const durable = worker?.currentJob?.id === job.id ? worker.currentJob : worker?.lastJob?.id === job.id ? worker.lastJob : undefined;
    if (!vibe || vibe.stopping || !worker || worker.state === "stopping" || worker.state === "dead" || !durable || durable.phase === "settled") return false;
    durable.phase = "retryable";
    durable.error = message;
    worker.state = "running";
    return writeStateUnlocked(vibe);
  });
  entry.state = "retryable";
  log(`job ${job.id} retryable: ${message}${saved ? "" : " (state write failed)"}`);
}

function startObserver(
  ctx: PluginCtx,
  directorID: string,
  cwd: string,
  job: DurableJob,
  text: string | undefined,
  sendPrompt: boolean,
): Pending {
  const existing = pending.get(job.id);
  if (existing) return existing;
  const directorGeneration = readState(directorID)?.generation ?? 0;
  const workerGeneration = workerOf(readState(directorID) ?? ({ workers: [] } as Vibe), job.workerID)?.generation ?? job.workerGeneration ?? 0;
  const deferred = Promise.withResolvers<JobOutcome>();
  const entry: Pending = {
    directorID,
    directorGeneration,
    workerGeneration,
    cwd,
    jobID: job.id,
    workerID: job.workerID,
    promise: deferred.promise,
    resolve: deferred.resolve,
    controller: new AbortController(),
    state: "running",
  };
  pending.set(job.id, entry);

  void (async () => {
    let outcome: JobOutcome;
    try {
      if (sendPrompt) {
        let receipt: unknown;
        try {
          const call = await withLifecycleCall(
            { directorID, directorGeneration: entry.directorGeneration, workerID: job.workerID, workerGeneration: entry.workerGeneration },
            () => ctx.session.prompt({ sessionID: job.workerID, id: job.messageID, text: text ?? "" }),
          );
          if (!call.ok) {
            entry.state = "retryable";
            entry.resolve({ kind: "aborted" });
            if (pending.get(job.id) === entry) pending.delete(job.id);
            return;
          }
          receipt = call.value;
        } catch (error: unknown) {
          const worker = workerOf(readState(directorID) ?? { workers: [] } as Vibe, job.workerID) ?? ({
            id: job.workerID,
            cli: job.cli,
            title: job.workerID,
            model: job.model,
            state: "running",
            turns: job.turn,
            queued: [],
            startedAt: job.startedAt,
          } as Worker);
          receipt = undefined;
          outcome = {
            kind: "settled",
            settle: errorSettle(
              worker,
              job,
              "error",
              error instanceof Error ? error.message : String(error),
              `prompt отклонён: ${error instanceof Error ? error.message : String(error)}`,
              Date.now() - job.startedAt,
            ),
          };
          const saved = await startDelivery(ctx, directorID, entry, outcome.kind === "settled" ? outcome.settle : undefined);
          if (!saved) {
            const message = "ошибка prompt не записана в durable state";
            await persistRetryable(entry, job, message);
            entry.resolve({ kind: "retryable", message });
          } else {
            entry.resolve(outcome);
          }
          if (pending.get(job.id) === entry) pending.delete(job.id);
          return;
        }
        if (receipt === false) {
          const worker = workerOf(readState(directorID) ?? { workers: [] } as Vibe, job.workerID) ?? ({
            id: job.workerID,
            cli: job.cli,
            title: job.workerID,
            model: job.model,
            state: "running",
            turns: job.turn,
            queued: [],
            startedAt: job.startedAt,
          } as Worker);
          outcome = {
            kind: "settled",
            settle: errorSettle(worker, job, "error", "session.prompt вернул false", "prompt не принят", Date.now() - job.startedAt),
          };
          const saved = await startDelivery(ctx, directorID, entry, outcome.kind === "settled" ? outcome.settle : undefined);
          if (!saved) {
            const message = "ошибка prompt не записана в durable state";
            await persistRetryable(entry, job, message);
            entry.resolve({ kind: "retryable", message });
          } else {
            entry.resolve(outcome);
          }
          if (pending.get(job.id) === entry) pending.delete(job.id);
          return;
        }
        const phaseSaved = await withDirectorAdmission(directorID, async () => {
          const vibe = readState(directorID);
          const worker = vibe ? workerOf(vibe, job.workerID) : undefined;
          const durable = worker?.currentJob?.id === job.id ? worker.currentJob : undefined;
          if (!vibe || !worker || !durable || durable.phase === "settled") return false;
          durable.phase = "running";
          durable.error = undefined;
          return writeStateUnlocked(vibe);
        });
        if (!phaseSaved) {
          const message = "phase running не записана в durable state; job retryable";
          await persistRetryable(entry, job, message);
          outcome = { kind: "retryable", message };
        } else {
          outcome = await observeAcceptedJob(ctx, entry, job);
        }
      } else {
        outcome = await observeAcceptedJob(ctx, entry, job);
      }
    } catch (error: unknown) {
      outcome = {
        kind: "retryable",
        message: `job observer: ${error instanceof Error ? error.message : String(error)}`,
      };
      await persistRetryable(entry, job, outcome.message);
    }
    if (outcome.kind === "settled") {
      entry.result = outcome.settle;
      entry.state = "settled";
      const delivered = await startDelivery(ctx, directorID, entry, outcome.settle);
      if (!delivered) {
        const message = "результат не записан в durable state; повтори vibe_wait";
        await persistRetryable(entry, job, message);
        outcome = { kind: "retryable", message };
      }
    } else if (outcome.kind === "retryable") {
      entry.state = "retryable";
    }
    entry.resolve(outcome);
    if (pending.get(job.id) === entry) pending.delete(job.id);
  })().catch((error: unknown) => {
    entry.state = "retryable";
    entry.resolve({ kind: "retryable", message: error instanceof Error ? error.message : String(error) });
    if (pending.get(job.id) === entry) pending.delete(job.id);
  });

  return entry;
}

async function startDelivery(ctx: PluginCtx, directorID: string, entry: Pending, settle: Settle | undefined): Promise<boolean> {
  let syntheticText: string | undefined;
  let syntheticID: string | undefined;
  let delivery: JobDelivery = "cancelled";
  let workerSnapshot: Worker | undefined;
  const committed = await withDirectorAdmission(directorID, async () => {
    const vibe = readState(directorID);
    const worker = vibe ? workerOf(vibe, entry.workerID) : undefined;
    const job = worker?.currentJob?.id === entry.jobID ? worker.currentJob : worker?.lastJob?.id === entry.jobID ? worker.lastJob : undefined;
    if (!vibe || !worker || !job || !settle) return false;
    if (job.phase === "settled" && job.result) {
      delivery = job.delivery;
      workerSnapshot = worker;
      return true;
    }
    workerSnapshot = worker;
    job.phase = "settled";
    job.result = settle;
    job.error = undefined;
    if (job.claim && job.claim.expiresAt <= Date.now()) job.claim = undefined;
    if (vibe.stopping || worker.state === "dead" || worker.state === "stopping") {
      job.delivery = "cancelled";
      delivery = "cancelled";
    } else {
      worker.state = "idle";
      worker.lastStatus = settle.status;
      worker.lastAt = Date.now();
      worker.lastResult = settle.text.slice(0, RESULT_MAX);
      worker.lastSettle = settle;
      worker.currentJob = undefined;
      worker.lastJob = job;
      if (job.claim) {
        job.delivery = "claimed";
        job.deliveryAttempts = 0;
        job.deliveryRetryAt = undefined;
        delivery = "claimed";
      } else {
        job.delivery = "synthetic";
        job.deliveryAttempts = 0;
        job.deliveryRetryAt = undefined;
        job.syntheticID ??= createMessageID();
        delivery = "synthetic";
        syntheticText = resultBlock(worker, settle, true);
        syntheticID = job.syntheticID;
      }
    }
    return writeStateUnlocked(vibe);
  });
  if (!committed || !settle) {
    log(`job ${entry.jobID}: settlement state write failed; synthetic suppressed`);
    return false;
  }

  if (syntheticText && workerSnapshot) {
    let call: { ok: true; value: unknown } | { ok: false; why: string } | undefined;
    let externalError: unknown;
    let externalFailed = false;
    try {
      call = await withLifecycleCall(
        { directorID, directorGeneration: entry.directorGeneration, workerID: entry.workerID, workerGeneration: entry.workerGeneration },
        () =>
          ctx.session.synthetic({
            sessionID: directorID,
            id: syntheticID,
            text: syntheticText as string,
            resume: DELIVER === "wake",
          }),
      );
    } catch (error: unknown) {
      externalFailed = true;
      externalError = error;
    }
    if (externalFailed) {
      log(`synthetic delivery failed: ${externalError instanceof Error ? externalError.message : String(externalError)}`);
      const saved = await withDirectorAdmission(directorID, async () => {
        const vibe = readState(directorID);
        const worker = vibe ? workerOf(vibe, entry.workerID) : undefined;
        const job = worker?.lastJob?.id === entry.jobID ? worker.lastJob : undefined;
        if (!vibe || !worker || !job || job.delivery !== "synthetic") return false;
        job.delivery = "failed";
        job.deliveryAttempts = (job.deliveryAttempts ?? 0) + 1;
        job.deliveryRetryAt = Date.now() + deliveryBackoff(job.deliveryAttempts);
        return writeStateUnlocked(vibe);
      });
      if (!saved) {
        deliveryStateUnknown.add(entry.jobID);
        scheduleDeliveryRetry(ctx, directorID, entry.jobID, 1);
        log(`job ${entry.jobID}: synthetic failed, but failed-delivery state write also failed`);
      } else {
        scheduleDeliveryRetry(ctx, directorID, entry.jobID, 1);
      }
    } else if (!call?.ok) {
      const cancelled = await withDirectorAdmission(directorID, async () => {
        const vibe = readState(directorID);
        const worker = vibe ? workerOf(vibe, entry.workerID) : undefined;
        const job = worker?.lastJob?.id === entry.jobID ? worker.lastJob : undefined;
        if (!vibe || !worker || !job || job.delivery !== "synthetic") return false;
        job.delivery = "cancelled";
        job.deliveryRetryAt = undefined;
        return writeStateUnlocked(vibe);
      });
      if (!cancelled) log(`job ${entry.jobID}: synthetic suppressed by lifecycle teardown`);
    } else {
      try {
        const saved = await withDirectorAdmission(directorID, async () => {
          const vibe = readState(directorID);
          const worker = vibe ? workerOf(vibe, entry.workerID) : undefined;
          const job = worker?.lastJob?.id === entry.jobID ? worker.lastJob : undefined;
          if (!vibe || !worker || !job || job.delivery !== "synthetic" || job.syntheticID !== syntheticID) return false;
          job.delivery = "delivered";
          vibe.turnsDelivered += 1;
          job.deliveryAttempts = 0;
          job.deliveryRetryAt = undefined;
          return writeStateUnlocked(vibe);
        });
        if (saved) {
          deliveryStateUnknown.delete(entry.jobID);
        } else {
          deliveryStateUnknown.add(entry.jobID);
          scheduleDeliveryRetry(ctx, directorID, entry.jobID, 1);
          log(`job ${entry.jobID}: synthetic delivered, but delivery state write failed`);
        }
      } catch (err: unknown) {
        deliveryStateUnknown.add(entry.jobID);
        scheduleDeliveryRetry(ctx, directorID, entry.jobID, 1);
        log(`synthetic delivery state failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await startQueuedTurn(ctx, directorID, entry.workerID);
  return true;
}

type PreparedTurn = { ok: true; job: DurableJob; text: string } | { ok: false; why: string };

async function prepareTurn(
  ctx: PluginCtx,
  directorID: string,
  workerID: string,
  text: string,
): Promise<PreparedTurn> {
  return withDirectorAdmission(directorID, async () => {
    const vibe = readState(directorID);
    if (!vibe) return { ok: false, why: "vibe не включён — /vibe" };
    if (vibe.stopping) return { ok: false, why: "vibe выключается — дождись teardown" };
    const worker = workerOf(vibe, workerID);
    if (!worker) return { ok: false, why: `нет воркера \`${workerID}\` — роспись в vibe_list` };
    if (worker.state === "dead" || worker.state === "stopping") return { ok: false, why: `воркер \`${workerID}\` снят` };
    if (hasUnconfirmedDelivery(worker)) {
      return { ok: false, why: "доставка предыдущего результата ещё не подтверждена; повтори vibe_wait" };
    }
    if (hasActiveJob(worker)) return { ok: false, why: `воркер \`${workerID}\` уже выполняет job` };
    const queued = queueItems(worker);
    const combined = [...queued.map((item) => item.text), text].join("\n\n");
    const before = await snapshot(ctx, workerID);
    const turn = worker.turns + 1;
    const job = makeJob(worker, turn, { assistantIDs: before.assistantIDs, idleID: before.idleID }, Date.now(), vibe.generation ?? 0);
    worker.turns = turn;
    worker.queued = [];
    worker.state = "running";
    worker.steerPending = undefined;
    worker.acceptedSteers = [];
    worker.currentJob = job;
    if (!writeStateUnlocked(vibe)) return { ok: false, why: "не удалось сохранить новый job в state" };
    return { ok: true, job, text: combined };
  });
}

async function startQueuedTurn(ctx: PluginCtx, directorID: string, workerID: string): Promise<void> {
  const prepared = await withDirectorAdmission(directorID, async () => {
    const vibe = readState(directorID);
    if (!vibe || vibe.stopping) return { ok: false, why: "state изменился" } satisfies PreparedTurn;
    const worker = workerOf(vibe, workerID);
    if (!worker || worker.state === "dead" || worker.state === "stopping" || hasActiveJob(worker)) {
      return { ok: false, why: "queued turn не нужен" } satisfies PreparedTurn;
    }
    if (hasUnconfirmedDelivery(worker)) {
      return { ok: false, why: "delivery retry pending" } satisfies PreparedTurn;
    }
    const items = queueItems(worker);
    if (items.length === 0) return { ok: false, why: "очередь пуста" } satisfies PreparedTurn;
    const before = await snapshot(ctx, workerID);
    const turn = worker.turns + 1;
    const job = makeJob(worker, turn, { assistantIDs: before.assistantIDs, idleID: before.idleID }, Date.now(), vibe.generation ?? 0);
    worker.turns = turn;
    worker.queued = [];
    worker.state = "running";
    worker.steerPending = undefined;
    worker.acceptedSteers = [];
    worker.currentJob = job;
    if (!writeStateUnlocked(vibe)) return { ok: false, why: "очередь не записана; сообщения остаются на диске" } satisfies PreparedTurn;
    return { ok: true, job, text: items.map((item) => item.text).join("\n\n") } satisfies PreparedTurn;
  });
  if (!prepared.ok) {
    if (!prepared.why.includes("не нуж") && !prepared.why.includes("очередь пуста")) {
      log(`queued turn ${directorID}/${workerID}: ${prepared.why}`);
    }
    return;
  }
  startObserver(ctx, directorID, readState(directorID)?.cwd ?? "", prepared.job, prepared.text, true);
}

async function steerAccepted(
  ctx: PluginCtx,
  directorID: string,
  workerID: string,
  pendingSteer: SteerPending,
): Promise<{ ok: boolean; why?: string }> {
  return withDirectorAdmission(directorID, async () => {
    const vibe = readState(directorID);
    const worker = vibe ? workerOf(vibe, workerID) : undefined;
    if (!vibe || vibe.stopping || !worker || worker.state === "stopping" || worker.state === "dead") {
      return { ok: false, why: "steer отменён teardown; сообщение не объявляется доставленным" };
    }
    if (worker.steerPending?.id !== pendingSteer.id) {
      return { ok: false, why: "steer state уже закрыт teardown; повтор не отправляю" };
    }
    worker.acceptedSteers = [...(worker.acceptedSteers ?? []), pendingSteer];
    worker.steerPending = undefined;
    if (!writeStateUnlocked(vibe)) {
      return { ok: false, why: "steer принят, но подтверждение не записано; повтори без нового сообщения" };
    }
    return { ok: true };
  });
}

async function steerRejected(
  ctx: PluginCtx,
  directorID: string,
  workerID: string,
  pendingSteer: SteerPending,
  queue: boolean,
): Promise<{ ok: boolean; why?: string; queued: boolean }> {
  return withDirectorAdmission(directorID, async () => {
    const vibe = readState(directorID);
    const worker = vibe ? workerOf(vibe, workerID) : undefined;
    if (!vibe || vibe.stopping || !worker || worker.state === "stopping" || worker.state === "dead") {
      return { ok: false, why: "steer отменён teardown; сообщение не объявляется доставленным", queued: false };
    }
    if (worker.steerPending?.id !== pendingSteer.id) {
      return { ok: false, why: "steer state уже закрыт teardown; повтор не отправляю", queued: false };
    }
    const snap = await snapshot(ctx, workerID);
    if (snap.hasMessage(pendingSteer.id)) {
      worker.acceptedSteers = [...(worker.acceptedSteers ?? []), pendingSteer];
      worker.steerPending = undefined;
      if (!writeStateUnlocked(vibe)) return { ok: false, why: "steer уже доставлен, но state не записан", queued: false };
      return { ok: true, queued: false };
    }
    if (!queue) {
      return {
        ok: false,
        why: "steer receipt неоднозначен: сообщение не отправлено повторно и не добавлено в очередь; повтори тот же вызов позже",
        queued: false,
      };
    }
    worker.queued = [...queueItems(worker), pendingSteer];
    worker.steerPending = undefined;
    if (!writeStateUnlocked(vibe)) {
      worker.steerPending = pendingSteer;
      return { ok: false, why: "steer отклонён, но очередь не записана; сообщение не потеряно и не объявлено сохранённым", queued: false };
    }
    return { ok: true, queued: true };
  });
}

// ---------------------------------------------------------------- spawn

async function spawnWorker(
  ctx: PluginCtx,
  director: string,
  cli: Cli,
  prompt: string,
  name?: string,
  readOnly = false,
): Promise<{ ok: true; worker: Worker; job: DurableJob } | { ok: false; why: string }> {
  const result = await withDirectorAdmission(director, async () => {
    const initial = readState(director);
    if (!initial) return { ok: false, why: "vibe не включён — /vibe" } as const;
    const scopeError = await scopeViolation(ctx, director);
    if (scopeError) return { ok: false, why: scopeError } as const;
    if (initial.stopping) return { ok: false, why: "vibe выключается; повтори /vibe off после завершения teardown" } as const;
    const capInfo = workerCapLimit();
    const cap = capInfo.value;
    const alive = initial.workers.filter((worker) => worker.state !== "dead").length;
    if (alive >= cap) {
      return { ok: false, why: `воркеров уже ${alive} (потолок ${cap}; ${capInfo.source}) — сначала vibe_kill ненужных` } as const;
    }
    const resolution = await resolveWorkerModel(ctx, director, cli, readOnly);
    if (!resolution.model) {
      const reason = resolution.error ?? "unknown reason";
      log(`model-unresolved: agent=${workerAgentID(cli, readOnly)} role=${resolution.role} source=${resolution.source} error=${reason}`);
      return {
        ok: false,
        why: `model-unresolved: ${cli} worker model could not be resolved (${resolution.source}): ${reason}`,
      } as const;
    }
    const model = resolution.model;
    const directory = await sessionDirectory(ctx, director);
    if (!directory) return { ok: false, why: "каталог родительской сессии не найден в session.get().location.directory" } as const;
    const index = initial.workers.filter((worker) => worker.cli === cli).length + 1;
    const title = `vibe:${cli}#${index}${name ? ` ${name}` : ""}`;
    let created: Record<string, unknown> | undefined;
    try {
      const payload: Record<string, unknown> = { title, agent: workerAgentID(cli, readOnly), location: { directory } };
      if (model) payload.model = model;
      created = dataOf(await ctx.session.create(payload));
    } catch (err: unknown) {
      return { ok: false, why: `сессию воркера не создать: ${err instanceof Error ? err.message : String(err)}` } as const;
    }
    const id = typeof created?.id === "string" ? created.id : undefined;
    if (!id) return { ok: false, why: "сессию воркера не создать: сервер не вернул id" } as const;

    const orphan: OrphanRecord = { version: 1, directorID: director, workerID: id, title, cwd: directory, createdAt: Date.now() };
    const journalOK = writeOrphan(orphan);
    if (!journalOK) {
      const errors = await cleanupCreatedSession(ctx, orphan);
      const note = errors.length > 0 ? `; cleanup: ${errors.join("; ")}` : "; session cleanup выполнен";
      return { ok: false, why: `не удалось сохранить orphan journal до commit${note}` } as const;
    }
    const before = await snapshot(ctx, id);
    const worker: Worker = {
      id,
      cli,
      readOnly,
      title,
      model: modelLabel(model),
      modelRole: resolution.role,
      modelSource: resolution.source,
      generation: 1,
      state: "running",
      turns: 1,
      queued: [],
      startedAt: Date.now(),
    };
    const job = makeJob(worker, 1, { assistantIDs: before.assistantIDs, idleID: before.idleID }, Date.now(), initial.generation ?? 0);
    worker.currentJob = job;

    const current = readState(director);
    if (!current?.enabled || current.stopping) {
      const errors = await cleanupCreatedSession(ctx, orphan);
      const note = errors.length > 0 ? `; cleanup: ${errors.join("; ")}` : "; session cleanup выполнен";
      return { ok: false, why: `воркер не зачислен: состояние директора изменилось до commit${note}` } as const;
    }
    if (current.workers.some((item) => item.id === id)) {
      const errors = await cleanupCreatedSession(ctx, orphan);
      const note = errors.length > 0 ? `; cleanup: ${errors.join("; ")}` : "; session cleanup выполнен";
      return { ok: false, why: `воркер не зачислен: id ${id} уже принадлежит другому worker${note}` } as const;
    }
    const currentAlive = current.workers.filter((item) => item.state !== "dead").length;
    if (currentAlive >= cap) {
      const errors = await cleanupCreatedSession(ctx, orphan);
      const note = errors.length > 0 ? `; cleanup: ${errors.join("; ")}` : "; session cleanup выполнен";
      return { ok: false, why: `воркер не зачислен: воркеров уже ${currentAlive} (потолок ${cap}, VIBE_MAX_WORKERS)${note}` } as const;
    }
    const committedTitle = `vibe:${cli}#${current.workers.filter((item) => item.cli === cli).length + 1}${name ? ` ${name}` : ""}`;
    const candidate: Vibe = {
      ...current,
      cwd: directory,
      workers: [...current.workers, { ...worker, title: committedTitle, currentJob: { ...job } }],
    };
    if (!writeStateUnlocked(candidate)) {
      const errors = await cleanupCreatedSession(ctx, orphan);
      const note = errors.length > 0 ? `; cleanup: ${errors.join("; ")}` : "; session cleanup выполнен";
      return { ok: false, why: `воркер не зачислен: запись state не удалась${note}` } as const;
    }
    if (!removeOrphan(orphanPath(director, id))) {
      log(`spawn ${id}: committed, stale orphan journal will be reconciled by location-scoped recovery`);
    }
    const committedWorker = workerOf(candidate, id);
    if (!committedWorker?.currentJob) {
      const errors = await cleanupCreatedSession(ctx, orphan);
      return { ok: false, why: `воркер потерян после commit; cleanup: ${errors.join("; ")}` } as const;
    }
    return { ok: true, worker: committedWorker, job: committedWorker.currentJob } as const;
  });
  if (result.ok) startObserver(ctx, director, readState(director)?.cwd ?? "", result.job, prompt, true);
  return result;
}

// ---------------------------------------------------------------- mode

function modesGuard(sessionID: string): string | undefined {
  const dir = process.env.MODES_STATE_DIR ?? join(homedir(), ".local/state/modes-station");
  const path = join(dir, `${safeID(sessionID)}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return `state modes повреждён (${path}): ${error instanceof Error ? error.message : String(error)}; переход заблокирован.`;
  }
  if (typeof raw !== "object" || raw === null) {
    return `state modes повреждён (${path}): ожидался object; переход заблокирован.`;
  }
  const value = raw as Record<string, unknown>;
  const goal = value.goal;
  if (goal !== undefined && goal !== null) {
    if (typeof goal !== "object") return `state modes повреждён (${path}): goal имеет неверную форму; переход заблокирован.`;
    const status = (goal as Record<string, unknown>).status;
    if (typeof status !== "string") return `state modes повреждён (${path}): goal.status отсутствует; переход заблокирован.`;
    return ["complete", "dropped"].includes(status)
      ? undefined
      : "сначала выйди из режима цели (modes-station), потом /vibe — как в omp («Exit goal mode first»).";
  }
  if (value.kind === "goal") {
    const finished = value.closed === true || /^(GOAL: DONE|закрыта инструментом goal|вручную)$/i.test(String(value.reason ?? ""));
    return finished ? undefined : "сначала выйди из режима цели (modes-station), потом /vibe — как в omp («Exit goal mode first»).";
  }
  return undefined;
}

function jobStatusBits(job: DurableJob | undefined): string[] {
  if (!job) return [];
  const bits = [`job ${job.phase}`, `delivery=${job.delivery}`];
  if (job.deliveryAttempts !== undefined) bits.push(`attempts=${job.deliveryAttempts}`);
  if (job.deliveryRetryAt !== undefined) bits.push(`retryAt=${job.deliveryRetryAt}`);
  if (job.consumedAt !== undefined) bits.push("consumed");
  bits.push(`actualModel=${job.result?.model ?? "unknown"}`);
  if (job.error) bits.push(job.error.replace(/\s+/g, " ").slice(0, 120));
  return bits;
}

function resultReady(job: DurableJob | undefined): boolean {
  return Boolean(job && job.phase === "settled" && job.result !== undefined);
}

function unreadJob(job: DurableJob | undefined): boolean {
  return Boolean(resultReady(job) && job?.consumedAt === undefined);
}

function applyWorkerActivity(worker: Worker, activity: WorkerActivity): void {
  worker.lastActivityAt = activity.lastActivityAt;
  worker.lastActivity = activity.lastActivity;
  worker.lastTool = activity.lastTool;
  worker.lastToolArgs = activity.lastToolArgs;
  worker.lastIntent = activity.lastIntent;
  worker.toolCallCount = activity.toolCallCount;
  worker.traceTail = activity.traceTail;
}

function activityBits(worker: Worker, now: number): string[] {
  const bits: string[] = [];
  if (worker.lastTool) bits.push(`lastTool=${worker.lastTool}`);
  if (worker.lastToolArgs) bits.push(`lastToolArgs=${worker.lastToolArgs}`);
  if (worker.lastActivity) bits.push(`lastActivity=${worker.lastActivity}`);
  if (worker.lastIntent) bits.push(`lastIntent=${worker.lastIntent}`);
  if (worker.lastActivityAt !== undefined) bits.push(`lastActivityAt=${worker.lastActivityAt}`);
  if (worker.toolCallCount !== undefined) bits.push(`toolCallCount=${worker.toolCallCount}`);
  if (worker.traceTail?.length) bits.push(`trace=${worker.traceTail.join(" | ")}`);
  if (worker.lastActivityAt !== undefined) bits.push(`activityAge=${fmtDuration(Math.max(0, now - worker.lastActivityAt))}`);
  return bits;
}

function lifecycleBits(vibe: Vibe): string[] {
  return vibe.lifecycleScope ? [`lifecycle=v${vibe.lifecycleScope.version}`] : [];
}

function progressBits(worker: Worker, now: number): string[] {
  const job = worker.currentJob ?? worker.lastJob;
  const bits = [`activeJob=${hasActiveJob(worker)}`, `queuedCount=${worker.queued?.length ?? 0}`, `readOnly=${worker.readOnly === true}`];
  const access = worker.accessTransition
    ? worker.accessTransition.phase === "failed"
      ? "promotion-failed"
      : "promotion-switching"
    : worker.readOnly === true
      ? "audit"
      : "coding";
  bits.push(`access=${access}`);
  if (worker.accessTransition) {
    bits.push(`targetAgent=${worker.accessTransition.targetAgent}`);
    if (worker.accessTransition.targetModel) bits.push(`targetModel=${worker.accessTransition.targetModel}`);
    if (worker.accessTransition.error) bits.push(`accessError=${worker.accessTransition.error}`);
  }
  bits.push(`suspended=${worker.suspended === true}`);
  if (worker.recovery) {
    bits.push(`recovery=${worker.recovery.state}`);
    if (worker.recovery.reason) bits.push(`recoveryReason=${worker.recovery.reason}`);
  }
  bits.push(`resultReady=${resultReady(job)}`);
  bits.push(`unreadResult=${unreadJob(job)}`);
  if (hasActiveJob(worker) && job) bits.push(`elapsed=${fmtDuration(Math.max(0, now - job.startedAt))}`);
  if (job?.result) bits.push(`lastDuration=${fmtDuration(job.result.duration)}`);
  bits.push(`steerPending=${worker.steerPending !== undefined}`);
  bits.push(...activityBits(worker, now));
  return bits;
}

function todoProgressText(vibe: Vibe): string {
  const todos = vibe.todos ?? [];
  const done = todos.filter((todo) => todo.done).length;
  return `${done}/${todos.length}`;
}

function formatWallState(vibe: Vibe): string | undefined {
  if (!vibe.enabled) return undefined;
  const active = vibe.workers.filter((worker) => hasActiveJob(worker)).length;
  const unread = vibe.workers.filter((worker) => unreadJob(worker.currentJob ?? worker.lastJob)).length;
  const live = vibe.workers
    .filter((worker) => hasActiveJob(worker))
    .map((worker) => {
      const tool = worker.lastTool ? `tool=${worker.lastTool}` : "tool=unknown";
      const at = worker.lastActivityAt !== undefined ? `lastActivityAt=${worker.lastActivityAt}` : "lastActivityAt=unknown";
      return `${worker.id}(${tool},${at})`;
    })
    .join(" ");
  return `VIBE ON · workers ${vibe.workers.length} · active ${active} · unread ${unread} · read/delivered ${vibe.turnsDelivered}${live ? ` · activity ${live}` : ""}`;
}

async function wallWorker(ctx: PluginCtx, worker: Worker): Promise<VibeWallWorker> {
  const messages = messagesOf(await ctx.session.context({ sessionID: worker.id }).catch(() => undefined));
  const accessState = worker.accessTransition
    ? worker.accessTransition.phase === "failed"
      ? "promotion-failed"
      : "promotion-switching"
    : worker.readOnly === true
      ? "audit"
      : "coding";
  return {
    id: worker.id,
    cli: worker.cli,
    state: worker.suspended ? "suspended" : worker.state,
    readOnly: worker.readOnly === true,
    model: worker.model,
    turns: worker.turns,
    queued: (worker.queued?.length ?? 0) + (worker.steerPending ? 1 : 0),
    currentTool: worker.lastTool,
    currentToolArgs: worker.lastToolArgs,
    lastIntent: worker.lastIntent,
    trace: worker.traceTail ?? [],
    outputTail: outputTailFromMessages(messages),
    lastActivityAt: worker.lastActivityAt,
    accessState,
    tokensPerSecond: tokenRateFromMessages(messages),
    lastError:
      worker.accessTransition?.error ??
      (worker.lastStatus && /(failed|error|stop-failed|needs-reaccept)/i.test(worker.lastStatus)
        ? worker.lastStatus
        : undefined),
  };
}

async function wallSnapshot(ctx: PluginCtx, sessionID: string): Promise<VibeWallSnapshot> {
  const initial = readStateResult(sessionID);
  if (initial.kind === "valid" && initial.value.enabled) await refreshWorkerActivities(ctx, sessionID);
  const state = readStateResult(sessionID);
  const revision = state.kind === "valid" ? state.value.revision ?? 0 : wallRevisions.get(sessionID) ?? 0;
  if (state.kind === "corrupt") return { state: "corrupt", sessionID, revision, text: "" };
  if (state.kind === "absent" || !state.value.enabled) return { state: "absent", sessionID, revision, text: "" };
  return {
    state: "ok",
    sessionID,
    revision,
    text: formatWallState(state.value) ?? "",
    workers: await Promise.all(state.value.workers.map((worker) => wallWorker(ctx, worker))),
  };
}

async function registerWallRpc(ctx: PluginCtx): Promise<() => Promise<void>> {
  if (!ctx.rpc) {
    log("wall rpc: ctx.rpc unavailable; TUI will use no snapshot");
    return async () => {};
  }
  try {
    if (wallRpcRegistration) await wallRpcRegistration.dispose().catch(() => {});
    const registration = await ctx.rpc.register(VibeWallDefinition, {
      snapshot: async (input) => {
        const sessionID = typeof input?.sessionID === "string" ? input.sessionID.trim() : "";
        if (!sessionID) throw new Error("sessionID обязателен");
        return wallSnapshot(ctx, sessionID);
      },
    });
    wallRpcRegistration = registration;
    return async () => {
      if (wallRpcRegistration !== registration) return;
      wallRpcRegistration = undefined;
      await registration.dispose();
    };
  } catch (err: unknown) {
    wallRpcRegistration = undefined;
    log(`wall rpc registration failed: ${err instanceof Error ? err.message : String(err)}`);
    return async () => {};
  }
}

function normalizeTodoIds(vibe: Vibe): boolean {
  let changed = false;
  const used = new Set(vibe.todos?.map((todo) => todo.id).filter((id): id is string => typeof id === "string") ?? []);
  for (const [index, todo] of (vibe.todos ?? []).entries()) {
    if (todo.id) continue;
    let id = `legacy-${index + 1}`;
    let suffix = index + 1;
    while (used.has(id)) id = `legacy-${++suffix}`;
    todo.id = id;
    used.add(id);
    changed = true;
  }
  return changed;
}

function nextTodoId(todos: readonly Todo[]): string {
  const max = todos.reduce((current, todo) => {
    const match = /^todo-(\d+)$/.exec(todo.id ?? "");
    return Math.max(current, match ? Number(match[1]) : 0);
  }, 0);
  return `todo-${max + 1}`;
}

function todoLines(vibe: Vibe): string {
  const todos = vibe.todos ?? [];
  if (todos.length === 0) return "список пуст";
  return todos
    .map((todo, index) => {
      const id = todo.id ? ` id=${todo.id}` : "";
      const phase = todo.phase ? ` phase=${todo.phase}` : "";
      const blocked = todo.blockedBy?.length ? ` blockedBy=${todo.blockedBy.join(",")}` : "";
      return `${todo.done ? "[x]" : "[ ]"} ${index + 1}.${id} ${todo.text}${phase}${blocked}`;
    })
    .join("; ");
}

function rosterBlock(vibe: Vibe): string {
  const now = Date.now();
  const lines =
    vibe.workers.length === 0
      ? ["- воркеров нет: запусти vibe_spawn"]
      : vibe.workers.map((worker) => {
          const bits = [`\`${worker.id}\` [${worker.cli}] ${worker.state}`, `ходов ${worker.turns}`];
          if (worker.queued?.length) bits.push(`в очереди ${worker.queued.length}`);
          if (worker.steerPending) bits.push("steer ожидает подтверждения");
          bits.push(...jobStatusBits(worker.currentJob ?? worker.lastJob));
          bits.push(...progressBits(worker, now));
          bits.push(`requested=${worker.model ?? "unknown"}`);
          if (worker.lastStatus) bits.push(`последний: ${worker.lastStatus}`);
          return `- ${bits.join(" · ")}`;
        });
  return [
    "<vibe-roster>",
    ...lines,
    `read/delivered=${vibe.turnsDelivered}`,
    `todos=${todoProgressText(vibe)}`,
    ...lifecycleBits(vibe),
    effectiveLimitsText(),
    `прогресс (vibe_todo): ${todoLines(vibe)}`,
    "</vibe-roster>",
  ].join("\n");
}

async function enable(ctx: PluginCtx, sessionID: string, prompt?: string): Promise<string> {
  return withDirectorAdmission(sessionID, async () => {
    const existing = readStateResult(sessionID);
    if (existing.kind === "corrupt") {
      return `modes: state директора повреждён (${statePath(sessionID)}): ${existing.reason}. Переход заблокирован; исправь или удали state явно.`;
    }
    if (existing.kind === "valid" && existing.value.enabled) return "modes: режим уже включён. Роспись — /vibe status, выключить — /vibe off.";
    if (!toolGuardReady(ctx)) return "modes: защита director tool guard недоступна; режим не включаю.";
    const modesReason = modesGuard(sessionID);
    if (modesReason) return `modes: ${modesReason}`;
    const missing = await missingAgents(ctx);
    if (missing.length > 0) return `modes: агентов режима нет в конфиге (${missing.join(", ")}) — поставь их: bin/vibe-station.sh install (файлы agent/*.md).`;
    const info = dataOf(await ctx.session.get({ sessionID }).catch(() => undefined));
    const previousAgent = typeof info?.agent === "string" ? info.agent : undefined;
    const sessionMode = typeof info?.mode === "string" ? info.mode.toLowerCase() : "";
    const planBlocked = previousAgent === "plan" || ["plan", "plan_paused", "paused_plan"].includes(sessionMode) || info?.planMode === true || info?.planModePaused === true || info?.planPaused === true;
    if (planBlocked) return "modes: сначала выйди из plan mode, потом /vibe — как в omp.";
    const location = info?.location;
    const directory =
      typeof location === "object" && location !== null && typeof (location as { directory?: unknown }).directory === "string"
        ? (location as { directory: string }).directory
        : undefined;
    if (!directory) return "modes: session.get() не вернул location.directory — воркера не создаю.";
    let promptPlan: SkillPromptPlan | undefined;
    if (prompt !== undefined) {
      try {
        promptPlan = await planSkillPrompt(ctx, prompt);
      } catch (error: unknown) {
        return `Ошибка: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const vibe: Vibe = {
      sessionID,
      cwd: directory,
      enabled: true,
      generation: 1,
      previousAgent,
      workers: [],
      startedAt: Date.now(),
      turnsDelivered: 0,
    };
    if (!writeStateUnlocked(vibe)) return "modes: state директора не записан — режим не включаю";
    try {
      await ctx.session.switchAgent({ sessionID, agent: DIRECTOR_AGENT });
    } catch (err: unknown) {
      const cleared = clearState(sessionID);
      const suffix = cleared ? "" : "; state не удалось удалить — нужен retry";
      return `modes: агента ${DIRECTOR_AGENT} не подключить: ${err instanceof Error ? err.message : String(err)}${suffix}`;
    }
    const confirmedAgent = await authoritativeAgent(ctx, sessionID);
    if (confirmedAgent !== DIRECTOR_AGENT) {
      const cleared = clearState(sessionID);
      const suffix = cleared ? "" : "; state не удалось удалить — нужен retry";
      return `modes: роль ${DIRECTOR_AGENT} не подтверждена server-side (получено ${confirmedAgent ?? "unknown"}); включение отменено${suffix}`;
    }
    vibe.lifecycleScope = {
      version: 2,
      directorSessionID: sessionID,
      directorAgent: confirmedAgent,
      cwd: directory,
    };
    if (!writeStateUnlocked(vibe)) {
      const cleared = clearState(sessionID);
      return `modes: scope не записать — режим не включаю${cleared ? "" : "; state не удалось удалить — нужен retry"}`;
    }
    log(`режим включён: ${sessionID}, агент был ${previousAgent ?? "неизвестен"}`);
    if (prompt && promptPlan) {
      void Promise.resolve(ctx.session.prompt({
        sessionID,
        text: promptPlan.text,
        ...(promptPlan.skills.length > 0 ? { skills: promptPlan.skills } : {}),
      })).catch((err: unknown) => {
        log(`первый промпт директора: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return `modes: vibe включён — ты директор, правки и запуск отобраны (read + vibe_*). Воркеры: vibe_spawn с cli=fast|good. Выключить — /vibe (или /vibe off).`;
  });
}

async function disable(ctx: PluginCtx, sessionID: string, why: string): Promise<string> {
  return withLifecycleGate(sessionID, () => withDirectorAdmission(sessionID, async () => {
    const stateRead = readStateResult(sessionID);
    if (stateRead.kind === "corrupt") {
      return `modes: state директора повреждён (${statePath(sessionID)}): ${stateRead.reason}. /vibe off заблокирован; исправь state явно.`;
    }
    if (stateRead.kind !== "valid" || !stateRead.value.enabled) return "modes: режим не включён.";
    const vibe = stateRead.value;
    const errors: string[] = [];
    vibe.stopping = true;
    vibe.generation = (vibe.generation ?? 0) + 1;
    vibe.stopError = undefined;
    abortPendingForDirector(sessionID);
    const workers = vibe.workers.filter((worker) => worker.state !== "dead");
    for (const worker of workers) {
      worker.generation = (worker.generation ?? 0) + 1;
      worker.state = "stopping";
      worker.queued = [];
      worker.steerPending = undefined;
      if (worker.currentJob && worker.currentJob.phase !== "settled") worker.currentJob.delivery = "cancelled";
      if (worker.currentJob) {
        cancelDeliveryRetry(worker.currentJob.id);
        deliveryStateUnknown.delete(worker.currentJob.id);
      }
      if (worker.lastJob && (worker.lastJob.delivery === "synthetic" || worker.lastJob.delivery === "failed" || worker.lastJob.delivery === "delivery-unknown")) worker.lastJob.delivery = "cancelled";
      if (worker.lastJob) {
        cancelDeliveryRetry(worker.lastJob.id);
        deliveryStateUnknown.delete(worker.lastJob.id);
      }
    }
    if (!writeStateUnlocked(vibe)) errors.push("не удалось записать stopping state");

    let directorInterrupted = false;
    let directorIdle = false;
    try {
      await ctx.session.interrupt({ sessionID });
      directorInterrupted = true;
    } catch (err: unknown) {
      errors.push(`аборт директора: ${err instanceof Error ? err.message : String(err)}`);
    }
    const directorWait = await confirmTeardown(ctx, sessionID);
    if (directorWait.ok) directorIdle = true;
    else errors.push(`директор: ${directorWait.why}`);

    let killed = 0;
    for (const worker of workers) {
      let interruptOK = false;
      let idleOK = false;
      try {
        await ctx.session.interrupt({ sessionID: worker.id });
        interruptOK = true;
      } catch (err: unknown) {
        errors.push(`воркер ${worker.id}: interrupt: ${err instanceof Error ? err.message : String(err)}`);
      }
      const workerWait = await confirmTeardown(ctx, worker.id);
      if (workerWait.ok) idleOK = true;
      else errors.push(`воркер ${worker.id}: ${workerWait.why}`);

      let renameOK = false;
      if (interruptOK && idleOK) {
        try {
          await ctx.session.update({ sessionID: worker.id, title: `${worker.title} (снят)` });
          renameOK = true;
        } catch (err: unknown) {
          errors.push(`воркер ${worker.id}: rename: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (interruptOK && idleOK && renameOK) {
        worker.state = "dead";
        worker.lastStatus = "mode-exit";
        worker.lastAt = Date.now();
        if (worker.currentJob && worker.currentJob.phase !== "settled") {
          worker.currentJob.phase = "settled";
          worker.currentJob.delivery = "cancelled";
        }
        killed += 1;
      } else {
        worker.state = "stopping";
        worker.lastStatus = "stop-failed";
      }
      if (!writeStateUnlocked(vibe)) errors.push(`воркер ${worker.id}: запись state не удалась`);
    }

    let agentRestored = false;
    let agentNote = "Прежний агент не был записан; станция не переключала агента обратно.";
    if (directorInterrupted && directorIdle && workers.every((worker) => worker.state === "dead")) {
      if (vibe.previousAgent) {
        try {
          await ctx.session.switchAgent({ sessionID, agent: vibe.previousAgent });
          agentRestored = true;
          agentNote = `Агент возвращён (${vibe.previousAgent}).`;
        } catch (err: unknown) {
          errors.push(`возврат агента: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        const info = dataOf(await ctx.session.get({ sessionID }).catch(() => undefined));
        const currentAgent = typeof info?.agent === "string" ? info.agent : undefined;
        if (currentAgent && currentAgent !== DIRECTOR_AGENT) {
          agentRestored = true;
          agentNote = `Прежний агент не был записан; текущий агент ${currentAgent} оставлен вручную.`;
        } else {
          errors.push("прежний агент неизвестен, а сессия всё ещё на vibe-director; переключи агента вручную и повтори /vibe off");
        }
      }
    } else if (!directorInterrupted || !directorIdle || workers.some((worker) => worker.state !== "dead")) {
      errors.push("director или workers не подтвердили остановку");
    }

    if (errors.length === 0 && agentRestored) {
      if (clearState(sessionID)) {
        log(`режим выключен: ${sessionID} (${why}), воркеров снято ${killed}`);
        return killed > 0
          ? `modes: vibe выключен (${why}), воркеров снято: ${killed}. ${agentNote}`
          : `modes: vibe выключен (${why}). ${agentNote}`;
      }
      errors.push("не удалось удалить state после успешного teardown");
    }

    vibe.stopping = true;
    vibe.stopError = errors.join("; ");
    if (!writeStateUnlocked(vibe)) {
      errors.push("финальная запись retryable state не удалась");
      vibe.stopError = errors.join("; ");
    }
    return `modes: vibe НЕ выключен (${why}): ${errors.join("; ")}. State сохранён для retry; повтори /vibe off.`;
  }));
}

async function vibeCommand(ctx: PluginCtx, input: unknown): Promise<void> {
  const payload = (typeof input === "object" && input !== null ? input : {}) as {
    sessionID?: unknown;
    prompt?: { text?: unknown };
    arguments?: unknown;
  };
  const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : "";
  if (!sessionID) return;
  const text = String(payload.prompt?.text ?? payload.arguments ?? "").trim();
  const say = async (message: string): Promise<void> => {
    try {
      await ctx.session.synthetic({ sessionID, text: message, resume: false });
    } catch (err: unknown) {
      log(`say err: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (/^(off|stop|clear|disable)$/i.test(text)) {
    const stateRead = readStateResult(sessionID);
    const retryingTeardown = stateRead.kind === "valid" && stateRead.value.enabled && stateRead.value.stopping === true;
    if (!retryingTeardown) {
      const scopeError = await coordinatorScopeViolation(ctx, sessionID);
      if (scopeError) return say(`Ошибка: ${scopeError}`);
    }
    return say(await disable(ctx, sessionID, "по команде"));
  }
  if (/^(status|list|show|wall|progress|tv)$/i.test(text)) {
    await reconcileDirectorScope(ctx, sessionID);
    const stateRead = readStateResult(sessionID);
    if (stateRead.kind === "corrupt") {
      return say(`modes: state директора повреждён (${statePath(sessionID)}): ${stateRead.reason}. Status заблокирован; исправь state явно.`);
    }
    if (stateRead.kind === "valid" && stateRead.value.enabled) await refreshWorkerActivities(ctx, sessionID);
    const fresh = readStateResult(sessionID);
    return say(rosterText(fresh.kind === "valid" && fresh.value.enabled ? fresh.value : undefined));
  }
  if (readState(sessionID)) {
    const scopeError = await coordinatorScopeViolation(ctx, sessionID);
    if (scopeError) return say(`Ошибка: ${scopeError}`);
    return say(await disable(ctx, sessionID, "повторный /vibe (как в omp)"));
  }
  return say(await enable(ctx, sessionID, text || undefined));
}

function rosterText(vibe: Vibe | undefined): string {
  if (!vibe) return "modes: vibe не включён. Включить — /vibe [промпт].";
  const now = Date.now();
  const todo = (vibe.todos ?? []).length > 0 ? `\nпрогресс: ${todoLines(vibe)}` : "";
  const limits = effectiveLimitsText();
  const summary = `read/delivered=${vibe.turnsDelivered} · todos=${todoProgressText(vibe)}${lifecycleBits(vibe).length ? ` · ${lifecycleBits(vibe).join(" · ")}` : ""}`;
  if (vibe.workers.length === 0) return `modes: vibe включён, воркеров нет. Запустить — vibe_spawn (cli=fast|good).\n${summary}${todo}\n${limits}`;
  const lines = vibe.workers.map((worker) => {
    const bits = [`\`${worker.id}\` [${worker.cli}] ${worker.state}`, `ходов ${worker.turns}`];
    if (worker.queued?.length) bits.push(`в очереди ${worker.queued.length}`);
    if (worker.currentJob || worker.lastJob) bits.push(...jobStatusBits(worker.currentJob ?? worker.lastJob));
    bits.push(...progressBits(worker, now));
    bits.push(`requested=${worker.model ?? "unknown"}`);
    if (worker.lastStatus) bits.push(`последний: ${worker.lastStatus}`);
    return `- ${bits.join(" · ")}`;
  });
  return `modes: vibe включён, воркеров ${vibe.workers.length}, доставлено результатов ${vibe.turnsDelivered}\n${summary}\n${limits}\n${lines.join("\n")}${todo}`;
}

// ---------------------------------------------------------------- tools

const toolText = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const toolError = (text: string): ToolResult => ({ content: [{ type: "text", text: `Ошибка: ${text}` }] });

async function vibePromoteTool(ctx: PluginCtx, args: Record<string, unknown>, toolCtx: unknown): Promise<ToolResult> {
  const directorID = String((toolCtx as { sessionID?: unknown })?.sessionID ?? "");
  const workerID = typeof args.session === "string" ? args.session.trim() : "";
  if (args.profile !== "coding") return toolError("profile должен быть coding");
  if (!workerID) return toolError("session обязателен");
  const scopeError = await coordinatorScopeViolation(ctx, directorID);
  if (scopeError) return toolError(scopeError);

  try {
    return await withLifecycleGate(directorID, () => withDirectorAdmission(directorID, async () => {
      const vibe = readState(directorID);
      if (!vibe) return toolError("vibe не включён — /vibe");
      const scopeError = await scopeViolation(ctx, directorID);
      if (scopeError) return toolError(scopeError);
      if (vibe.stopping) return toolError("vibe выключается — дождись teardown");
      const worker = workerOf(vibe, workerID);
      if (!worker) return toolError(`нет воркера \`${workerID}\` — роспись в vibe_list`);
      if (worker.accessTransition) return toolError(`promotion уже не подтверждена: ${worker.accessTransition.error ?? worker.accessTransition.phase}`);
      if (worker.readOnly !== true) {
        return toolText(`Воркер \`${workerID}\` уже в coding-профиле; session ID не меняется.`);
      }
      if (worker.state !== "idle" || worker.currentJob !== undefined || (worker.queued?.length ?? 0) > 0 || worker.steerPending) {
        return toolError(`promotion доступна только idle worker без currentJob/queue/steer: \`${workerID}\``);
      }

      const coding = await resolveWorkerModel(ctx, directorID, worker.cli, false);
      if (!coding.model) return toolError(`model-unresolved: ${worker.cli} coding model: ${coding.error ?? "unknown"}`);
      const audit = await resolveWorkerModel(ctx, directorID, worker.cli, true);
      if (!audit.model) return toolError(`model-unresolved: ${worker.cli} audit rollback model: ${audit.error ?? "unknown"}`);

      const targetAgent = WORKER_AGENT[worker.cli];
      const auditAgent = AUDIT_AGENT[worker.cli];
      const transition: AccessTransition = {
        from: "audit",
        to: "coding",
        phase: "switching",
        targetAgent,
        targetModel: modelLabel(coding.model),
        startedAt: Date.now(),
      };
      worker.accessTransition = transition;
      if (!writeStateUnlocked(vibe)) {
        worker.accessTransition = undefined;
        return toolError("promotion transition не записан в state; session не менялась");
      }

      const originalModel = worker.model;
      const originalRole = worker.modelRole;
      const originalSource = worker.modelSource;
      let modelChanged = false;
      let agentChanged = false;
      const fail = (error: unknown): ToolResult => {
        const message = error instanceof Error ? error.message : String(error);
        worker.readOnly = true;
        worker.model = modelLabel(audit.model);
        worker.modelRole = audit.role;
        worker.modelSource = audit.source;
        worker.lastStatus = "promotion-failed";
        worker.accessTransition = { ...transition, phase: "failed", error: message };
        if (!writeStateUnlocked(vibe)) return toolError(`promotion-failed: ${message}; state не записан`);
        return toolError(`promotion-failed: ${message}`);
      };

      try {
        await ctx.session.switchModel({ sessionID: workerID, model: coding.model });
        modelChanged = true;
        await ctx.session.switchAgent({ sessionID: workerID, agent: targetAgent });
        agentChanged = true;
        const authoritative = await authoritativeAgent(ctx, workerID);
        if (authoritative !== targetAgent) throw new Error("authoritative agent mismatch");

        worker.readOnly = false;
        worker.model = modelLabel(coding.model);
        worker.modelRole = coding.role;
        worker.modelSource = coding.source;
        worker.accessTransition = undefined;
        worker.lastStatus = "promoted";
        worker.lastAt = Date.now();
        if (!writeStateUnlocked(vibe)) {
          return toolError("promotion подтверждена API, но state не записан; нужен reconciliation");
        }
        return toolText(`Воркер \`${workerID}\` переведён в coding-профиль через ${targetAgent}; session ID сохранён. Модель: ${modelLabel(coding.model) ?? "unknown"}.`);
      } catch (error: unknown) {
        if (modelChanged) {
          try {
            await ctx.session.switchModel({ sessionID: workerID, model: audit.model });
          } catch {}
        }
        if (agentChanged) {
          try {
            await ctx.session.switchAgent({ sessionID: workerID, agent: auditAgent });
          } catch {}
        }
        const rollbackAuthoritative = await authoritativeAgent(ctx, workerID).catch(() => undefined);
        if (rollbackAuthoritative !== auditAgent) {
          worker.lastStatus = "promotion-failed";
          worker.accessTransition = { ...transition, phase: "failed", error: error instanceof Error ? error.message : String(error) };
          if (!writeStateUnlocked(vibe)) return toolError("promotion-failed: rollback не подтверждён и state не записан");
          return toolError(`promotion-failed: ${error instanceof Error ? error.message : String(error)}; rollback не подтверждён`);
        }
        worker.readOnly = true;
        worker.model = modelLabel(audit.model) ?? originalModel;
        worker.modelRole = audit.role ?? originalRole;
        worker.modelSource = audit.source ?? originalSource;
        return fail(error);
      }
    }));
  } catch (error: unknown) {
    return toolError(`promotion durable state недоступен: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function vibeSpawnTool(ctx: PluginCtx, args: Record<string, unknown>, toolCtx: unknown): Promise<ToolResult> {
  const sessionID = String((toolCtx as { sessionID?: unknown })?.sessionID ?? "");
  if (!readState(sessionID)) return toolError("vibe не включён — /vibe");
  const violation = await coordinatorScopeViolation(ctx, sessionID);
  if (violation) return toolError(violation);
  const cli = args.cli === "good" ? "good" : args.cli === "fast" ? "fast" : undefined;
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const readOnly = args.readOnly === true;
  if (!cli) return toolError("cli обязателен: fast или good");
  if (args.readOnly !== undefined && typeof args.readOnly !== "boolean") return toolError("readOnly должен быть boolean");
  if (!prompt) return toolError("prompt обязателен: воркер стартует без другого контекста");
  const result = await spawnWorker(ctx, sessionID, cli, prompt, typeof args.name === "string" ? args.name.trim() : undefined, readOnly);
  if (result.ok === false) return toolError(result.why);
  return toolText(
    `Воркер ${result.worker.cli} \`${result.worker.id}\` запущен (ход 1, job \`${result.job.id}\`). Результат придёт сам, когда public session.wait подтвердит конец. Продолжить — vibe_send \`${result.worker.id}\`.`,
  );
}

async function vibeSendTool(ctx: PluginCtx, args: Record<string, unknown>, toolCtx: unknown): Promise<ToolResult> {
  const sessionID = String((toolCtx as { sessionID?: unknown })?.sessionID ?? "");
  const workerID = typeof args.session === "string" ? args.session.trim() : "";
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return toolError("message обязателен");
  const scopeError = await coordinatorScopeViolation(ctx, sessionID);
  if (scopeError) return toolError(scopeError);

  let steer: SteerPending | undefined;
  let steerTarget: LifecycleTarget | undefined;
  let acceptedDuplicate = false;
  const decision = await withDirectorAdmission(sessionID, async () => {
    const vibe = readState(sessionID);
    if (!vibe) return { kind: "error", text: "vibe не включён — /vibe" } as const;
    const scopeError = await scopeViolation(ctx, sessionID);
    if (scopeError) return { kind: "error", text: scopeError } as const;
    if (vibe.stopping) return { kind: "error", text: "vibe выключается — дождись teardown" } as const;
    const worker = workerOf(vibe, workerID);
    if (!worker) return { kind: "error", text: `нет воркера \`${workerID}\` — роспись в vibe_list` } as const;
    if (worker.state === "dead" || worker.state === "stopping") return { kind: "error", text: `воркер \`${workerID}\` снят` } as const;
    if (worker.accessTransition) return { kind: "error", text: `promotion не подтверждена: ${worker.accessTransition.error ?? worker.accessTransition.phase}` } as const;

    if ((worker.acceptedSteers ?? []).some((receipt) => receipt.text === message)) {
      acceptedDuplicate = true;
      return { kind: "accepted" } as const;
    }
    if (worker.steerPending) {
      if (worker.steerPending.text !== message) {
        return { kind: "error", text: "предыдущий steer ещё не подтверждён; не отправляй другое сообщение" } as const;
      }
      const snap = await snapshot(ctx, workerID);
      if (snap.hasMessage(worker.steerPending.id)) {
        worker.acceptedSteers = [...(worker.acceptedSteers ?? []), worker.steerPending];
        worker.steerPending = undefined;
        if (!writeStateUnlocked(vibe)) return { kind: "error", text: "steer уже доставлен, но state не записан" } as const;
        acceptedDuplicate = true;
        return { kind: "accepted" } as const;
      }
      return { kind: "error", text: "steer принят с неясным receipt; тот же message не отправляй второй раз" } as const;
    }

    if (hasActiveJob(worker) || worker.state === "running" || worker.state === "starting") {
      const pendingSteer = { id: createMessageID(), text: message };
      worker.steerPending = pendingSteer;
      if (!writeStateUnlocked(vibe)) return { kind: "error", text: "steer не отправлен: durable outbox state не записан" } as const;
      steer = pendingSteer;
      steerTarget = { directorID: sessionID, directorGeneration: vibe.generation ?? 0, workerID, workerGeneration: worker.generation ?? 0 };
      return { kind: "steer" } as const;
    }
    return { kind: "turn" } as const;
  }).catch((error: unknown) => ({
    kind: "error",
    text: `durable state недоступен: ${error instanceof Error ? error.message : String(error)}`,
  }));

  if (decision.kind === "error") return toolError(decision.text);
  if (decision.kind === "accepted") {
    return toolText(acceptedDuplicate ? `Steer \`${workerID}\` уже доставлен; повторный вызов не отправляет дубль.` : "Steer подтверждён.");
  }
  if (decision.kind === "turn") {
    const prepared = await prepareTurn(ctx, sessionID, workerID, message);
    if (prepared.ok === false) return toolError(prepared.why);
    startObserver(ctx, sessionID, readState(sessionID)?.cwd ?? "", prepared.job, prepared.text, true);
    return toolText(`Ход на \`${workerID}\` запущен (ход ${prepared.job.turn}, job \`${prepared.job.id}\`). Результат придёт сам.`);
  }
  if (!steer) return toolError("steer state race");

  try {
    if (!steerTarget) return toolError("steer lifecycle state не найден");
    const call = await withLifecycleCall(steerTarget, () => ctx.session.prompt({ sessionID: workerID, id: steer.id, text: steer.text, delivery: "steer" }));
    if (!call.ok) {
      const rejected = await steerRejected(ctx, sessionID, workerID, steer, false);
      return toolError(rejected.why ?? call.why);
    }
    const saved = await steerAccepted(ctx, sessionID, workerID, steer);
    if (!saved.ok) return toolError(saved.why ?? "steer подтверждение не записано");
    return toolText(`Сообщение ушло в \`${workerID}\` как steer — живой ход увидит его на ближайшем шаге.`);
  } catch (error: unknown) {
    const definiteRejection = isDefiniteSteerRejection(error);
    const saved = await steerRejected(ctx, sessionID, workerID, steer, definiteRejection);
    if (!saved.ok) return toolError(saved.why ?? "steer receipt не разрешён");
    if (saved.queued) {
      return toolText(`Steer отклонён — сообщение durable-saved в очередь для \`${workerID}\` и пойдёт одним следующим ходом.`);
    }
    log(`steer ${workerID}: ambiguous receipt reconciled as delivered: ${error instanceof Error ? error.message : String(error)}`);
    return toolText(`Steer \`${workerID}\` уже присутствует в session.context; повторная отправка не выполнялась.`);
  }
}

function jobForWait(worker: Worker, named: boolean): DurableJob | undefined {
  if (named) return worker.currentJob ?? worker.lastJob;
  return worker.currentJob;
}

function claimable(job: DurableJob | undefined, now: number): boolean {
  if (!job || job.consumedAt !== undefined) return false;
  if (job.delivery === "cancelled") return false;
  if (job.delivery === "synthetic" && !(job.phase === "settled" && job.result && deliveryStateUnknown.has(job.id))) return false;
  if (job.claim && job.claim.expiresAt > now) return false;
  return true;
}

function waitForClaimedState(
  sessionID: string,
  claimToken: string,
  jobIDs: string[],
  timeoutMs: number,
): Promise<{ kind: "state" } | { kind: "timeout" } | { kind: "retryable"; message: string }> {
  return new Promise((resolveWait) => {
    const path = statePath(sessionID);
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { kind: "state" } | { kind: "timeout" } | { kind: "aborted" } | { kind: "retryable"; message: string }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      resolveWait(value);
    };
    const inspect = (): boolean => {
      const vibe = readState(sessionID);
      if (!vibe) {
        finish({ kind: "state" });
        return true;
      }
      for (const jobID of jobIDs) {
        const worker = vibe.workers.find(
          (candidate) => candidate.currentJob?.id === jobID || candidate.lastJob?.id === jobID,
        );
        const job = worker?.currentJob?.id === jobID ? worker.currentJob : worker?.lastJob?.id === jobID ? worker.lastJob : undefined;
        if (!job || job.claim?.token !== claimToken) {
          finish({ kind: "state" });
          return true;
        }
        if (job.phase === "retryable") {
          finish({ kind: "retryable", message: job.error ?? "job retryable" });
          return true;
        }
        if (job.phase === "settled") {
          finish({ kind: "state" });
          return true;
        }
      }
      return false;
    };
    try {
      watcher = watch(path, { persistent: true }, () => inspect());
    } catch {
      finish({ kind: "state" });
      return;
    }
    if (!inspect()) timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
  });
}

async function releaseWaitClaims(sessionID: string, token: string, jobIDs: string[]): Promise<boolean> {
  return withDirectorAdmission(sessionID, async () => {
    const vibe = readState(sessionID);
    if (!vibe) return false;
    let changed = false;
    for (const worker of vibe.workers) {
      for (const job of [worker.currentJob, worker.lastJob]) {
        if (job?.id && jobIDs.includes(job.id) && job.claim?.token === token) {
          job.claim = undefined;
          changed = true;
        }
      }
    }
    return changed ? writeStateUnlocked(vibe) : true;
  });
}

async function consumeWaitClaims(
  sessionID: string,
  token: string,
  selected: DurableJob[],
): Promise<{ ok: true; jobs: DurableJob[] } | { ok: false; why: string }> {
  return withDirectorAdmission(sessionID, async () => {
    const vibe = readState(sessionID);
    if (!vibe) return { ok: false, why: "vibe state исчез, доставка не подтверждена" };
    const jobs: DurableJob[] = [];
    for (const selectedJob of selected) {
      const worker = vibe.workers.find(
        (candidate) => candidate.currentJob?.id === selectedJob.id || candidate.lastJob?.id === selectedJob.id,
      );
      const job = worker?.currentJob?.id === selectedJob.id ? worker.currentJob : worker?.lastJob?.id === selectedJob.id ? worker.lastJob : undefined;
      if (!job || job.claim?.token !== token) continue;
      if (job.phase === "settled" && job.result) jobs.push(job);
    }
    if (jobs.length === 0) return { ok: true, jobs: [] };
    for (const job of jobs) {
      const deliveryWasConfirmed = job.delivery === "delivered";
      if (job.delivery === "failed" || job.delivery === "synthetic" || job.delivery === "delivery-unknown") {
        job.delivery = "delivery-unknown";
        job.error = "delivery-unknown: synthetic acknowledgement не подтверждён; результат прочитан явно";
        job.deliveryRetryAt = undefined;
        cancelDeliveryRetry(job.id);
      }
      if (!deliveryWasConfirmed) vibe.turnsDelivered += 1;
      deliveryStateUnknown.delete(job.id);
      job.consumedAt = Date.now();
      job.claim = undefined;
    }
    if (!writeStateUnlocked(vibe)) return { ok: false, why: "claim не записан; результат не возвращён повторно synthetic" };
    return { ok: true, jobs };
  });
}

async function vibeWaitTool(ctx: PluginCtx, args: Record<string, unknown>, toolCtx: unknown): Promise<ToolResult> {
  const sessionID = String((toolCtx as { sessionID?: unknown })?.sessionID ?? "");
  if (!readState(sessionID)) return toolError("vibe не включён — /vibe");
  const asked = Array.isArray(args.sessions) ? args.sessions.filter((value): value is string => typeof value === "string") : [];
  const requestedTimeout = typeof args.timeout === "number" ? args.timeout : undefined;
  const timeoutMs =
    requestedTimeout !== undefined && Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.max(1, Math.trunc(requestedTimeout * 1000))
      : DEFAULT_WAIT_TIMEOUT_MS;
  const claimToken = createMessageID();
  let blocked = false;
  let scopeError: string | undefined;
  const claimResult = await withDirectorAdmission(sessionID, async () => {
    scopeError = await scopeViolation(ctx, sessionID);
    if (scopeError) return { jobs: [] as DurableJob[], writeFailed: false };
    const vibe = readState(sessionID);
    if (!vibe) return { jobs: [] as DurableJob[], writeFailed: false };
    const workerIDs = asked.length > 0 ? [...new Set(asked)] : vibe.workers.filter((worker) => worker.currentJob).map((worker) => worker.id);
    const jobs: DurableJob[] = [];
    const now = Date.now();
    for (const workerID of workerIDs) {
      const worker = workerOf(vibe, workerID);
      if (!worker) continue;
      const job = jobForWait(worker, asked.length > 0);
      if (!job) continue;
      if (!claimable(job, now)) {
        if (job.claim && job.claim.expiresAt > now) blocked = true;
        continue;
      }
      job.claim = { token: claimToken, expiresAt: now + timeoutMs };
      jobs.push(structuredClone(job));
    }
    if (jobs.length === 0) return { jobs, writeFailed: false };
    return { jobs, writeFailed: !writeStateUnlocked(vibe) };
  });
  if (scopeError) return toolError(scopeError);
  if (claimResult.writeFailed) return toolError("wait claim не записан в durable state");
  const selected = claimResult.jobs;
  if (selected.length === 0) {
    if (blocked) return toolText("Job уже забирает другой vibe_wait; дождись его или повтори после истечения claim.");
    return toolText("Нет ходов в полёте — ждать нечего.");
  }

  const local = selected.map((job) => {
    if (job.phase === "settled") return undefined;
    const durable = readState(sessionID)?.workers
      .flatMap((worker) => [worker.currentJob, worker.lastJob])
      .find((candidate) => candidate?.id === job.id);
    if (!durable) return undefined;
    if (durable.phase === "retryable") {
      return startObserver(ctx, sessionID, readState(sessionID)?.cwd ?? "", durable, undefined, false);
    }
    return pending.get(job.id);
  });

  const alreadySettled = selected.some((job) => job.phase === "settled");
  if (!alreadySettled) {
    const runningSelected = selected.filter((job) => job.phase !== "settled");
    const localEntries = local.filter((entry): entry is Pending => entry !== undefined);
    if (localEntries.length === runningSelected.length) {
      const deadline = waitDeadline(timeoutMs);
      let outcome: { kind: "entry"; value: JobOutcome } | { kind: "timeout"; value: undefined };
      try {
        outcome = await Promise.race([
          ...localEntries.map((entry) => entry.promise.then((value) => ({ kind: "entry" as const, value }))),
          deadline.promise.then(() => ({ kind: "timeout" as const, value: undefined as never })),
        ]);
      } finally {
        deadline.cancel();
      }
      if (outcome.kind === "timeout") {
        const evidence = await refreshAndDescribeJobs(ctx, sessionID, selected);
        if (!(await releaseWaitClaims(sessionID, claimToken, selected.map((job) => job.id)))) {
          return toolError("окно ожидания вышло, но wait claim не снят в state");
        }
        return toolText(`Окно ожидания вышло. Job остаётся в полёте; повтори vibe_wait. Отмена ожидания не поддерживается: exact OpenCode2 ToolContext не предоставляет signal/abort.\n${evidence}`);
      }
      if (outcome.kind === "entry" && outcome.value.kind === "retryable") {
        if (!(await releaseWaitClaims(sessionID, claimToken, selected.map((job) => job.id)))) {
          return toolError("не удалось снять wait claim после retryable state");
        }
        return toolText(`Job не подтверждён как завершённый: ${outcome.value.message}. Результат не доставлен; состояние retryable, повтори vibe_wait.`);
      }
      if (outcome.kind === "entry" && outcome.value.kind === "aborted") {
        if (!(await releaseWaitClaims(sessionID, claimToken, selected.map((job) => job.id)))) {
          return toolError("не удалось снять wait claim после отмены job");
        }
        return toolText("Job отменён; результат не доставлен.");
      }
    } else {
      const outcome = await waitForClaimedState(sessionID, claimToken, selected.map((job) => job.id), timeoutMs);
      if (outcome.kind === "timeout") {
        const evidence = await refreshAndDescribeJobs(ctx, sessionID, selected);
        if (!(await releaseWaitClaims(sessionID, claimToken, selected.map((job) => job.id)))) {
          return toolError("окно ожидания вышло, но wait claim не снят в state");
        }
        return toolText(`Окно ожидания вышло. Job остаётся в полёте; повтори vibe_wait. Отмена ожидания не поддерживается: exact OpenCode2 ToolContext не предоставляет signal/abort.\n${evidence}`);
      }
      if (outcome.kind === "retryable") {
        if (!(await releaseWaitClaims(sessionID, claimToken, selected.map((job) => job.id)))) {
          return toolError("не удалось снять wait claim после retryable state");
        }
        return toolText(`Job не подтверждён как завершённый: ${outcome.message}. Результат не доставлен; состояние retryable, повтори vibe_wait.`);
      }
    }
  }

  const consumed = await consumeWaitClaims(sessionID, claimToken, selected);
  if (consumed.ok === false) return toolError(consumed.why);
  if (consumed.jobs.length === 0) {
    const fresh = readState(sessionID);
    const still = fresh?.workers.filter((worker) => worker.currentJob && selected.some((job) => job.id === worker.currentJob?.id));
    const stillText = still?.length ? ` В полёте: ${still.map((worker) => `\`${worker.id}\``).join(", ")}.` : "";
    return toolText(`Нет подтверждённого результата для claim.${stillText}`);
  }
  for (const job of consumed.jobs) await startQueuedTurn(ctx, sessionID, job.workerID);
  const fresh = readState(sessionID) ?? ({} as Vibe);
  const blocks = consumed.jobs.map((job) => {
    const worker = fresh.workers?.find((candidate) => candidate.id === job.workerID) ?? {
      id: job.workerID,
      cli: job.cli,
      title: job.workerID,
      state: "idle" as const,
      turns: job.turn,
      queued: [],
      startedAt: job.startedAt,
      model: job.model,
    };
    return resultBlock(worker, job.result, false);
  });
  const selectedIDs = new Set(consumed.jobs.map((job) => job.id));
  const stillRunning = (fresh.workers ?? [])
    .filter((worker) => worker.currentJob && !selectedIDs.has(worker.currentJob.id))
    .map((worker) => `\`${worker.id}\` (ход ${worker.currentJob?.turn})`);
  const tail = stillRunning.length > 0 ? `\n\nЕщё в полёте: ${stillRunning.join(", ")}.` : "";
  const unknown = consumed.jobs.filter((job) => job.delivery === "delivery-unknown");
  const deliveryNote = unknown.length > 0
    ? `\n\nDelivery acknowledgement: delivery-unknown; full result прочитан явно, synthetic повторно не отправлялся.`
    : "";
  return toolText(`Первое завершение (vibe_wait):\n\n${blocks.join("\n\n")}${tail}${deliveryNote}`);
}

async function confirmTeardown(ctx: PluginCtx, sessionID: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const result = await waitForPublicIdle(ctx, sessionID, new AbortController().signal, teardownTimeoutMs());
  if (result.kind === "idle") return { ok: true };
  if (result.kind === "timeout") return { ok: false, why: `public session.wait: idle не подтверждён за ${fmtDuration(teardownTimeoutMs())}` };
  if (result.kind === "aborted") return { ok: false, why: "public session.wait: teardown прерван" };
  return {
    ok: false,
    why: `public session.wait: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
  };
}

async function vibeKillTool(ctx: PluginCtx, args: Record<string, unknown>, toolCtx: unknown): Promise<ToolResult> {
  const sessionID = String((toolCtx as { sessionID?: unknown })?.sessionID ?? "");
  const scopeError = await coordinatorScopeViolation(ctx, sessionID);
  if (scopeError) return toolError(scopeError);
  return withLifecycleGate(sessionID, () => withDirectorAdmission(sessionID, async () => {
    const vibe = readState(sessionID);
    if (!vibe) return toolError("vibe не включён — /vibe");
    const scopeError = await scopeViolation(ctx, sessionID);
    if (scopeError) return toolError(scopeError);
    const workerID = typeof args.session === "string" ? args.session.trim() : "";
    const worker = workerOf(vibe, workerID);
    if (!worker) return toolError(`нет воркера \`${workerID}\` — роспись в vibe_list`);
    const jobID = worker.currentJob?.id;
    const cancelled = jobID !== undefined;
    if (jobID) {
      cancelDeliveryRetry(jobID);
      deliveryStateUnknown.delete(jobID);
    }
    if (worker.lastJob) {
      cancelDeliveryRetry(worker.lastJob.id);
      deliveryStateUnknown.delete(worker.lastJob.id);
    }
    worker.generation = (worker.generation ?? 0) + 1;
    worker.state = "stopping";
    worker.queued = [];
    worker.steerPending = undefined;
    abortPendingForWorker(sessionID, workerID);
    if (jobID) pending.get(jobID)?.controller.abort();
    if (!writeStateUnlocked(vibe)) return toolError(`не удалось записать stopping state для \`${workerID}\``);

    const failures: string[] = [];
    try {
      await ctx.session.interrupt({ sessionID: workerID });
    } catch (err: unknown) {
      failures.push(`interrupt: ${err instanceof Error ? err.message : String(err)}`);
    }

    const idle = await confirmTeardown(ctx, workerID);
    if (!idle.ok) failures.push(idle.why);
    if (failures.length > 0) {
      worker.state = "stopping";
      worker.lastStatus = "stop-failed";
      worker.lastAt = Date.now();
      if (!writeStateUnlocked(vibe)) failures.push("state: write failed");
      return toolError(`воркер \`${workerID}\` не снят (${failures.join("; ")}); state сохранён, повтори vibe_kill`);
    }

    try {
      await ctx.session.update({ sessionID: workerID, title: `${worker.title} (снят)` });
    } catch (err: unknown) {
      worker.state = "stopping";
      worker.lastStatus = "stop-failed";
      worker.lastAt = Date.now();
      if (!writeStateUnlocked(vibe)) {
        return toolError(`rename не удался и state не записан для \`${workerID}\`; повтори vibe_kill`);
      }
      return toolError(`воркер \`${workerID}\` не снят (rename: ${err instanceof Error ? err.message : String(err)}); state сохранён, повтори vibe_kill`);
    }

    worker.state = "dead";
    worker.lastStatus = "cancelled";
    worker.lastAt = Date.now();
    if (worker.currentJob && worker.currentJob.phase !== "settled") {
      worker.currentJob.phase = "settled";
      worker.currentJob.delivery = "cancelled";
      worker.lastJob = worker.currentJob;
      worker.currentJob = undefined;
    }
    if (!writeStateUnlocked(vibe)) return toolError(`воркер снят API, но state не записан для \`${workerID}\`; повтори vibe_kill`);
    return toolText(`Воркер \`${workerID}\` снят.${cancelled ? " Ход в полёте прерван." : ""} Сессия осталась в списке клиента (переименована «снят»).`);
  }));
}

async function vibeListTool(ctx: PluginCtx, _args: Record<string, unknown>, toolCtx: unknown): Promise<ToolResult> {
  const sessionID = String((toolCtx as { sessionID?: unknown })?.sessionID ?? "");
  await reconcileDirectorScope(ctx, sessionID);
  const stateRead = readStateResult(sessionID);
  if (stateRead.kind === "corrupt") {
    return toolError(`state директора повреждён (${statePath(sessionID)}): ${stateRead.reason}. Status заблокирован; исправь state явно.`);
  }
  const initialVibe = stateRead.kind === "valid" && stateRead.value.enabled ? stateRead.value : undefined;
  if (!initialVibe) return toolError("vibe не включён — /vibe");
  await refreshWorkerActivities(ctx, sessionID);
  const vibe = readState(sessionID);
  if (!vibe) return toolError("vibe state исчез, статус недоступен");
  const now = Date.now();
  const limits = effectiveLimitsText();
  const summary = `read/delivered=${vibe.turnsDelivered} · todos=${todoProgressText(vibe)}${lifecycleBits(vibe).length ? ` · ${lifecycleBits(vibe).join(" · ")}` : ""}`;
  if (vibe.workers.length === 0) return toolText(`Воркеров нет. Запусти vibe_spawn.\n${summary}\n${limits}`);
  const lines = vibe.workers.map((worker) => {
    const bits = [`\`${worker.id}\` [${worker.cli}] ${worker.state}`, `ходов ${worker.turns}`];
    if (worker.queued?.length) bits.push(`в очереди ${worker.queued.length}`);
    if (worker.steerPending) bits.push("steer не подтверждён");
    bits.push(...jobStatusBits(worker.currentJob ?? worker.lastJob));
    bits.push(...progressBits(worker, now));
    bits.push(`requested=${worker.model ?? "unknown"}`);
    if (worker.lastStatus) bits.push(`последний: ${worker.lastStatus}`);
    if (worker.lastResult) bits.push(`ответ: ${worker.lastResult.replace(/\s+/g, " ").slice(0, 70)}`);
    return `- ${bits.join(" · ")}`;
  });
  return toolText(`${summary}\n${limits}\n${lines.join("\n")}`);
}

async function vibeTodoTool(ctx: PluginCtx, args: Record<string, unknown>, toolCtx: unknown): Promise<ToolResult> {
  const sessionID = String((toolCtx as { sessionID?: unknown })?.sessionID ?? "");
  const scopeError = await coordinatorScopeViolation(ctx, sessionID);
  if (scopeError) return toolError(scopeError);
  return withDirectorAdmission(sessionID, async () => {
    const vibe = readState(sessionID);
    if (!vibe) return toolError("vibe не включён — /vibe");
    const scopeError = await scopeViolation(ctx, sessionID);
    if (scopeError) return toolError(scopeError);
    const op = typeof args.op === "string" ? args.op : "list";
    if (op === "list") {
      const display: Vibe = {
        ...vibe,
        todos: (vibe.todos ?? []).map((todo, index) => todo.id ? todo : { ...todo, id: `legacy-${index + 1}` }),
      };
      return toolText(`Прогресс (${display.todos.length}): ${todoLines(display)}`);
    }
    normalizeTodoIds(vibe);
    if (op === "add") {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return toolError("text обязателен для op=add");
      const phase = args.phase === undefined ? undefined : typeof args.phase === "string" ? args.phase.trim() : undefined;
      if (args.phase !== undefined && !phase) return toolError("phase должен быть непустой строкой");
      let blockedBy: string[] | undefined;
      if (args.blockedBy !== undefined) {
        if (!Array.isArray(args.blockedBy) || args.blockedBy.some((value) => typeof value !== "string")) {
          return toolError("blockedBy должен содержать только todo ID");
        }
        blockedBy = [...new Set(args.blockedBy as string[])];
        const known = new Set((vibe.todos ?? []).map((todo) => todo.id));
        if (blockedBy.some((id) => !known.has(id))) return toolError(`blockedBy содержит неизвестный todo ID: ${blockedBy.join(",")}`);
      }
      vibe.todos = [...(vibe.todos ?? []), { id: nextTodoId(vibe.todos ?? []), text, done: false, phase, blockedBy }];
      if (!writeStateUnlocked(vibe)) return toolError("не удалось записать прогресс");
      return toolText(`Добавлено. Прогресс: ${todoLines(vibe)}`);
    }
    if (op === "done") {
      const index = typeof args.index === "number" ? args.index - 1 : -1;
      const todos = vibe.todos ?? [];
      if (index < 0 || index >= todos.length) return toolError(`нет пункта ${String(args.index)} (в списке ${todos.length})`);
      todos[index].done = true;
      if (!writeStateUnlocked(vibe)) return toolError("не удалось записать прогресс");
      return toolText(`Пункт закрыт. Прогресс: ${todoLines(vibe)}`);
    }
    if (op === "clear") {
      vibe.todos = [];
      if (!writeStateUnlocked(vibe)) return toolError("не удалось записать прогресс");
      return toolText("Список прогресса очищен.");
    }
    return toolText(`Прогресс (${(vibe.todos ?? []).length}): ${todoLines(vibe)}`);
  });
}

// ---------------------------------------------------------------- startup and recovery

async function recoverOrphans(ctx: PluginCtx, location: string | undefined): Promise<boolean> {
  if (!location) {
    log("recovery: location неизвестен — чужие state не трогаю");
    return true;
  }
  let complete = true;
  for (const { path, record } of orphanRecords()) {
    if (!sameLocation(record.cwd, location)) continue;
    const state = readAnyState(record.directorID);
    if (state?.workers.some((worker) => worker.id === record.workerID)) {
      if (!removeOrphan(path)) complete = false;
      continue;
    }
    const errors = await withDirectorAdmission(record.directorID, async () => {
      const errorsNow = await cleanupSessionAPI(ctx, record);
      if (errorsNow.length === 0) {
        if (!removeOrphan(path)) errorsNow.push("cleanup journal: remove failed");
      } else {
        if (!writeOrphan({ ...record, lastError: errorsNow.join("; ") })) {
          errorsNow.push("cleanup journal: update failed");
        }
      }
      return errorsNow;
    });
    if (errors.length > 0) {
      complete = false;
      log(`orphan recovery ${record.workerID}: ${errors.join("; ")}`);
    }
  }
  return complete;
}

function hasUnreadResult(vibe: Vibe): boolean {
  return vibe.workers.some((worker) =>
    [worker.currentJob, worker.lastJob].some(
      (job) => job?.phase === "settled" && job.result !== undefined && job.consumedAt === undefined,
    ),
  );
}

async function preserveRestartedResults(sessionID: string): Promise<boolean> {
  return withDirectorAdmission(sessionID, async () => {
    const current = readState(sessionID);
    if (!current || !hasUnreadResult(current)) return false;
    for (const worker of current.workers) {
      for (const job of [worker.currentJob, worker.lastJob]) {
        if (!job || job.phase !== "settled" || !job.result || job.consumedAt !== undefined) continue;
        if (job.delivery !== "delivered") job.delivery = "delivery-unknown";
        job.error = "needs-reaccept: restart before explicit result consumption; native delivery recovery не подтверждён";
        job.deliveryRetryAt = undefined;
        worker.lastStatus = "needs-reaccept";
        worker.lastAt = Date.now();
      }
    }
    return writeStateUnlocked(current);
  });
}

async function reconcileAccessTransitions(ctx: PluginCtx, directorID: string, vibe: Vibe): Promise<boolean> {
  return withDirectorAdmission(directorID, async () => {
    const current = readState(directorID);
    if (!current) return false;
    let changed = false;
    for (const worker of current.workers) {
      const transition = worker.accessTransition;
      if (!transition) continue;
      let info: Record<string, unknown> | undefined;
      try {
        info = dataOf(await ctx.session.get({ sessionID: worker.id }));
      } catch (error: unknown) {
        worker.accessTransition = {
          ...transition,
          phase: "failed",
          error: `authoritative session unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
        worker.lastStatus = "promotion-failed";
        changed = true;
        continue;
      }
      const agent = typeof info?.agent === "string" ? info.agent : undefined;
      const currentModel = modelLabel(info?.model as Model | undefined);
      const targetModel = transition.targetModel;
      const targetMatches = agent === transition.targetAgent && (!targetModel || !currentModel || currentModel === targetModel);
      const auditAgent = AUDIT_AGENT[worker.cli];
      if (targetMatches) {
        worker.readOnly = false;
        worker.model = targetModel ?? worker.model;
        worker.modelRole = worker.cli;
        worker.modelSource = "agent";
        worker.accessTransition = undefined;
        worker.lastStatus = "promoted";
        changed = true;
        continue;
      }
      if (agent === auditAgent) {
        worker.readOnly = true;
        worker.accessTransition = undefined;
        worker.lastStatus = "promotion-rolled-back";
        changed = true;
        continue;
      }
      worker.accessTransition = {
        ...transition,
        phase: "failed",
        error: `authoritative agent mismatch: ${agent ?? "unknown"}`,
      };
      worker.lastStatus = "promotion-failed";
      changed = true;
    }
    if (changed && !writeStateUnlocked(current)) return false;
    return true;
  });
}

async function rehydrateWorkers(
  ctx: PluginCtx,
  directorID: string,
  initial: Vibe,
): Promise<RehydrateSummary> {
  const observerJobs: DurableJob[] = [];
  let statePersisted = false;
  const summary = await withDirectorAdmission(directorID, async () => {
    const vibe = readState(directorID);
    if (!vibe) return { restored: 0, interrupted: 0, missing: 0 } satisfies RehydrateSummary;
    const scope = vibe.lifecycleScope;
    const director = scope
      ? dataOf(await ctx.session.get({ sessionID: directorID }).catch(() => undefined))
      : undefined;
    const directorLocation = isRecord(director?.location) ? director.location.directory : undefined;
    const scopeMatches =
      !scope ||
      (director?.agent === scope.directorAgent && sameLocation(typeof directorLocation === "string" ? directorLocation : undefined, scope.cwd));
    if (!scopeMatches) {
      const reason = "director scope unavailable or changed";
      for (const worker of vibe.workers) {
        worker.suspended = true;
        worker.recovery = { state: "interrupted", at: Date.now(), reason };
      }
      if (!writeStateUnlocked(vibe)) log(`recovery ${directorID}: scope suspension state could not be persisted`);
      return { restored: 0, interrupted: vibe.workers.length, missing: 0 } satisfies RehydrateSummary;
    }

    const result: RehydrateSummary = { restored: 0, interrupted: 0, missing: 0 };
    for (const worker of vibe.workers) {
      const info = dataOf(await ctx.session.get({ sessionID: worker.id }).catch(() => undefined));
      if (!info) {
        worker.state = "dead";
        worker.suspended = false;
        worker.recovery = { state: "missing", at: Date.now(), reason: "session.get returned no session" };
        if (worker.currentJob && worker.currentJob.phase !== "settled") {
          worker.currentJob.phase = "settled";
          worker.currentJob.delivery = "cancelled";
          worker.lastJob = worker.currentJob;
          worker.currentJob = undefined;
        }
        result.missing += 1;
        continue;
      }

      const activeJob = worker.currentJob && worker.currentJob.phase !== "settled" ? worker.currentJob : undefined;
      if (activeJob) {
        worker.state = "running";
        worker.recovery = { state: "interrupted", at: Date.now(), reason: "process restarted before turn settlement" };
        observerJobs.push(activeJob);
        result.interrupted += 1;
        continue;
      }

      worker.state = "idle";
      worker.recovery = { state: "restored", at: Date.now() };
      result.restored += 1;
    }
    if (!writeStateUnlocked(vibe)) {
      log(`recovery ${directorID}: rehydrated state could not be persisted`);
      return { restored: 0, interrupted: 0, missing: 0 } satisfies RehydrateSummary;
    }
    statePersisted = true;
    return result;
  });
  if (!statePersisted) return summary;
  for (const job of observerJobs) {
    startObserver(ctx, directorID, initial.cwd, job, undefined, false);
  }
  return summary;
}

async function recoverStates(ctx: PluginCtx): Promise<void> {
  const location = contextLocation(ctx);
  if (!location) {
    log("recovery: location неизвестен — state не сканирую");
    return;
  }
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter((name) => name.endsWith(".json") && !name.includes(".orphan-"));
  } catch {
    return;
  }
  await recoverOrphans(ctx, location);
  for (const file of files) {
    const sessionID = file.slice(0, -".json".length);
    const vibe = readAnyState(sessionID);
    if (!vibe?.enabled) continue;
    if (location && !sameLocation(vibe.cwd, location)) continue;
    const hadAccessTransition = vibe.workers.some((worker) => worker.accessTransition !== undefined);
    if (!(await reconcileAccessTransitions(ctx, sessionID, vibe))) {
      log(`recovery ${sessionID}: access transition не подтверждён; state оставлен retryable`);
      continue;
    }
    const refreshed = readAnyState(sessionID);
    if (!refreshed?.enabled) continue;
    if (vibe.lifecycleScope?.version === 2) {
      const summary = await rehydrateWorkers(ctx, sessionID, vibe);
      const recovered = readState(sessionID);
      if (recovered?.enabled) publishWallChanged(sessionID, recovered.revision ?? 0);
      log(`recovery ${sessionID}: native rehydrate ${JSON.stringify(summary)}`);
      continue;
    }
    if (hadAccessTransition) {
      log(`recovery ${sessionID}: access transition reconciled; state сохранён для продолжения`);
      continue;
    }
    if (hasUnreadResult(refreshed)) {
      const preserved = await preserveRestartedResults(sessionID);
      log(`recovery ${sessionID}: ${preserved ? "непрочитанный результат сохранён как needs-reaccept" : "непрочитанный результат не удалось сохранить; state оставлен"}`);
      continue;
    }
    await disable(ctx, sessionID, "восстановление после restart");
    if (readAnyState(sessionID)?.enabled) {
      log(`recovery ${sessionID}: teardown не подтверждён, state оставлен retryable`);
    } else {
      log(`recovery ${sessionID}: незакрытый режим свернут`);
    }
  }
}

const guardedToolContexts = new WeakSet<object>();

async function authoritativeAgent(ctx: PluginCtx, sessionID: string): Promise<string | undefined> {
  try {
    const info = dataOf(await ctx.session.get({ sessionID }));
    return typeof info?.agent === "string" ? info.agent : undefined;
  } catch (error: unknown) {
    log(`authoritative agent read ${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function isVibeAllowedTool(tool: string): boolean {
  return tool === "read" || tool === "question" || tool === "skill" || tool.startsWith("vibe_");
}

async function installVibeToolGuard(ctx: PluginCtx): Promise<boolean> {
  const toolDomain = ctx.tool;
  if (!toolDomain?.hook || typeof toolDomain.hook !== "function") return false;
  if (guardedToolContexts.has(toolDomain as object)) return true;
  try {
    await toolDomain.hook("execute.before", async (payload: unknown) => {
      const typed = payload as { sessionID?: unknown; tool?: unknown; agent?: unknown } | undefined;
      const sessionID = typeof typed?.sessionID === "string" ? typed.sessionID : "";
      const tool = typeof typed?.tool === "string" ? typed.tool : "";
      if (!sessionID || !tool) return;
      const state = readStateResult(sessionID);
      if (state.kind === "corrupt") throw new Error(`vibe: state ${sessionID} повреждён; coordinator actions заблокированы`);
      if (state.kind !== "valid" || !state.value.enabled) return;
      if (tool.startsWith("vibe_")) {
        const reportedAgent = typeof typed?.agent === "string" ? typed.agent : undefined;
        const serverAgent = await authoritativeAgent(ctx, sessionID);
        if (reportedAgent !== DIRECTOR_AGENT || serverAgent !== DIRECTOR_AGENT) {
          throw new Error(`vibe: coordinator tool ${tool} requires authoritative ${DIRECTOR_AGENT} role`);
        }
      }
      if (isVibeAllowedTool(tool)) return;
      const agent = typeof typed?.agent === "string" ? typed.agent : "unknown";
      throw new Error(`vibe: ${agent} не может вызывать ${tool}; разрешены read, question, skill и vibe_*`);
    });
    guardedToolContexts.add(toolDomain as object);
    return true;
  } catch (error: unknown) {
    log(`tool guard registration failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function toolGuardReady(ctx: PluginCtx): boolean {
  const toolDomain = ctx.tool;
  return Boolean(toolDomain && guardedToolContexts.has(toolDomain as object));
}

export default {
  id: "vibe-station",
  setup: async (ctx: PluginCtx) => {
    log(`setup vibe-station ${VERSION} keys=${JSON.stringify(Object.keys(ctx))}`);
    await recoverStates(ctx);
    await installVibeToolGuard(ctx);
    bindEvents(ctx);
    const disposeWallRpc = await registerWallRpc(ctx);
    const inject = (payload: unknown): void => {
      const typed = payload as { sessionID?: unknown; system?: unknown } | undefined;
      const sessionID = typeof typed?.sessionID === "string" ? typed.sessionID : "";
      if (!sessionID) return;
      const vibe = readState(sessionID);
      if (!vibe) return;
      try {
        (typed?.system as { type: string; text: string }[]).push({ type: "text", text: rosterBlock(vibe) });
      } catch (err: unknown) {
        log(`inject err: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    for (const event of ["context", "generate"]) {
      await ctx.session
        .hook(event, inject)
        .catch((err: unknown) => log(`hook ${event}: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (ctx.tool?.transform) {
      try {
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "vibe_spawn",
            description:
              "Запустить постоянного воркер-агента (cli: fast — быстрая модель, good — сильная модель). prompt — полный самодостаточный бриф.",
            input: {
              type: "object",
              properties: {
                cli: { type: "string", enum: ["fast", "good"], description: "модель воркера" },
                readOnly: { type: "boolean", description: "аудит без mutating tools; по умолчанию false" },
                name: { type: "string", description: "метка сессии (необязательно)" },
                prompt: { type: "string", description: "первая задача" },
              },
              required: ["cli", "prompt"],
              additionalProperties: false,
            },
            options: { codemode: false },
            execute: (args: Record<string, unknown>, toolCtx: unknown) => vibeSpawnTool(ctx, args, toolCtx),
          });
          editor.add({
            name: "vibe_promote",
            description: "Перевести idle read-only worker в coding-профиль через native OpenCode2 switchAgent; session ID сохраняется.",
            input: {
              type: "object",
              properties: {
                session: { type: "string", description: "id worker-а" },
                profile: { type: "string", enum: ["coding"], description: "явная цель promotion" },
              },
              required: ["session", "profile"],
              additionalProperties: false,
            },
            options: { codemode: false },
            execute: (args: Record<string, unknown>, toolCtx: unknown) => vibePromoteTool(ctx, args, toolCtx),
          });
          editor.add({
            name: "vibe_send",
            description:
              "Сообщение воркеру. Живой ход получает steer; durable outbox не допускает дубль при потерянном receipt. Idle-воркер получает новый turn.",
            input: {
              type: "object",
              properties: {
                session: { type: "string", description: "id воркера" },
                message: { type: "string", description: "сообщение" },
              },
              required: ["session", "message"],
              additionalProperties: false,
            },
            options: { codemode: false },
            execute: (args: Record<string, unknown>, toolCtx: unknown) => vibeSendTool(ctx, args, toolCtx),
          });
          editor.add({
            name: "vibe_wait",
            description:
              "Атомарно забрать конкретный job одного owner. Completion подтверждает public session.wait; durable claim не допускает дубль synthetic.",
            input: {
              type: "object",
              properties: {
                sessions: { type: "array", items: { type: "string" }, description: "кого ждать" },
                timeout: { type: "number", description: "секунды ожидания (по умолчанию 30)" },
              },
              additionalProperties: false,
            },
            options: { codemode: false },
            execute: (args: Record<string, unknown>, toolCtx: unknown) => vibeWaitTool(ctx, args, toolCtx),
          });
          editor.add({
            name: "vibe_kill",
            description: "Снять воркер: прервать ход и закрыть workstream.",
            input: {
              type: "object",
              properties: { session: { type: "string", description: "id воркера" } },
              required: ["session"],
              additionalProperties: false,
            },
            options: { codemode: false },
            execute: (args: Record<string, unknown>, toolCtx: unknown) => vibeKillTool(ctx, args, toolCtx),
          });
          editor.add({
            name: "vibe_todo",
            description: "Список прогресса директора: op=add|done|clear или список.",
            input: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["list", "add", "done", "clear"] },
                text: { type: "string", description: "пункт для op=add" },
                phase: { type: "string", description: "фаза пункта" },
                blockedBy: { type: "array", items: { type: "string" }, description: "ID пунктов-предшественников" },
                index: { type: "number", description: "номер пункта с единицы" },
              },
              additionalProperties: false,
            },
            options: { codemode: false },
            execute: (args: Record<string, unknown>, toolCtx: unknown) => vibeTodoTool(ctx, args, toolCtx),
          });
          editor.add({
            name: "vibe_list",
            description: "Роспись воркеров, job, очереди, model и последнего результата.",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: (args: Record<string, unknown>, toolCtx: unknown) => vibeListTool(ctx, args, toolCtx),
          });
        });
      } catch (err: unknown) {
        log(`tool.transform err: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await ctx.command.transform((editor) => {
      editor.add({
        name: "vibe",
        description: "[промпт] — включить режим директора; status — роспись, off/повторный /vibe — выключить",
        execute: (input: unknown) => vibeCommand(ctx, input),
      });
    });
    return disposeWallRpc;
  },
};
