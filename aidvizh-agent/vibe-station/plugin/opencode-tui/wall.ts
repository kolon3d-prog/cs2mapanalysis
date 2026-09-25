import type { VibeWallChanged, VibeWallSnapshot, VibeWallWorker } from "./rpc.ts";

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isOptionalString = (value: unknown): value is string | undefined => value === undefined || isString(value);
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function parseWorker(value: unknown): VibeWallWorker | undefined {
  if (!isRecord(value)) return undefined;
  if (!isString(value.id) || (value.cli !== "fast" && value.cli !== "good") || !isString(value.state)) return undefined;
  if (typeof value.readOnly !== "boolean" || !isInteger(value.turns) || value.turns < 0) return undefined;
  if (!isInteger(value.queued) || value.queued < 0) return undefined;
  if (!Array.isArray(value.trace) || !value.trace.every(isString)) return undefined;
  if (!Array.isArray(value.outputTail) || !value.outputTail.every(isString)) return undefined;
  if (!isOptionalString(value.model) || !isOptionalString(value.currentTool) || !isOptionalString(value.currentToolArgs)) return undefined;
  if (!isOptionalString(value.lastIntent) || !isOptionalString(value.lastError)) return undefined;
  if (value.lastActivityAt !== undefined && (typeof value.lastActivityAt !== "number" || !Number.isFinite(value.lastActivityAt))) return undefined;
  if (value.tokensPerSecond !== undefined && (typeof value.tokensPerSecond !== "number" || !Number.isFinite(value.tokensPerSecond) || value.tokensPerSecond < 0)) return undefined;
  if (!["audit", "coding", "promotion-switching", "promotion-failed"].includes(String(value.accessState))) return undefined;
  return {
    id: value.id,
    cli: value.cli,
    state: value.state,
    readOnly: value.readOnly,
    model: value.model,
    turns: value.turns,
    queued: value.queued,
    currentTool: value.currentTool,
    currentToolArgs: value.currentToolArgs,
    lastIntent: value.lastIntent,
    trace: value.trace,
    outputTail: value.outputTail,
    lastActivityAt: value.lastActivityAt,
    accessState: value.accessState as VibeWallWorker["accessState"],
    tokensPerSecond: value.tokensPerSecond,
    lastError: value.lastError,
  };
}

export function parseWallSnapshot(value: unknown, expectedSessionID: string): VibeWallSnapshot | undefined {
  if (!isRecord(value) || value.sessionID !== expectedSessionID) return undefined;
  if (value.state !== "ok" && value.state !== "absent" && value.state !== "corrupt") return undefined;
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) return undefined;
  if (typeof value.text !== "string") return undefined;
  let workers: VibeWallWorker[] | undefined;
  if (value.workers !== undefined) {
    if (!Array.isArray(value.workers)) return undefined;
    const parsed = value.workers.map(parseWorker);
    if (parsed.some((worker) => worker === undefined)) return undefined;
    workers = parsed as VibeWallWorker[];
  }
  return { state: value.state, sessionID: value.sessionID, revision: value.revision, text: value.text, workers };
}

export function parseWallChanged(value: unknown): VibeWallChanged | undefined {
  if (!isRecord(value) || typeof value.sessionID !== "string" || !value.sessionID) return undefined;
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) return undefined;
  return { sessionID: value.sessionID, revision: value.revision };
}
