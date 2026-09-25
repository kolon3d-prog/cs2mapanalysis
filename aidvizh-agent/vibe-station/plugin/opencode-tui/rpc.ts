const emptyObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const wallWorker = {
  type: "object",
  properties: {
    id: { type: "string" },
    cli: { type: "string", enum: ["fast", "good"] },
    state: { type: "string" },
    readOnly: { type: "boolean" },
    model: { type: "string" },
    turns: { type: "integer", minimum: 0 },
    queued: { type: "integer", minimum: 0 },
    currentTool: { type: "string" },
    currentToolArgs: { type: "string" },
    lastIntent: { type: "string" },
    trace: { type: "array", items: { type: "string" } },
    outputTail: { type: "array", items: { type: "string" } },
    lastActivityAt: { type: "number" },
    accessState: { type: "string", enum: ["audit", "coding", "promotion-switching", "promotion-failed"] },
    tokensPerSecond: { type: "number" },
    lastError: { type: "string" },
  },
  required: ["id", "cli", "state", "readOnly", "turns", "queued", "trace", "outputTail", "accessState"],
  additionalProperties: false,
} as const;

export const VibeWallDefinition = {
  id: "vibe-wall",
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["ok", "absent", "corrupt"] },
          sessionID: { type: "string" },
          revision: { type: "integer", minimum: 0 },
          text: { type: "string" },
          workers: { type: "array", items: wallWorker },
        },
        required: ["state", "sessionID", "revision", "text"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          revision: { type: "integer", minimum: 0 },
        },
        required: ["sessionID", "revision"],
        additionalProperties: false,
      },
    },
  },
} as const;

export type VibeWallState = "ok" | "absent" | "corrupt";

export type VibeWallWorker = {
  id: string;
  cli: "fast" | "good";
  state: string;
  readOnly: boolean;
  model?: string;
  turns: number;
  queued: number;
  currentTool?: string;
  currentToolArgs?: string;
  lastIntent?: string;
  trace: string[];
  outputTail: string[];
  lastActivityAt?: number;
  accessState: "audit" | "coding" | "promotion-switching" | "promotion-failed";
  tokensPerSecond?: number;
  lastError?: string;
};

export type VibeWallSnapshot = {
  state: VibeWallState;
  sessionID: string;
  revision: number;
  text: string;
  workers?: VibeWallWorker[];
};

export type VibeWallChanged = {
  sessionID: string;
  revision: number;
};
