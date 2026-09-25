import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "vibe-parity-"));
const MODES_STATE = mkdtempSync(join(tmpdir(), "vibe-parity-modes-"));
process.env.VIBE_STATE_DIR = STATE;
process.env.VIBE_LOG = join(STATE, "vibe.log");
process.env.MODES_STATE_DIR = MODES_STATE;
delete process.env.VIBE_FAST_MODEL;
delete process.env.VIBE_GOOD_MODEL;
delete process.env.VIBE_MAX_WORKERS;
delete process.env.VIBE_TURN_TIMEOUT_MS;
process.env.VIBE_DEBUG = "0";

const plugin = await import("../plugin/opencode/vibe.ts");
const selected = process.env.VIBE_PARITY_CASE ?? "all";
const shouldRun = (name) => selected === "all" || selected === name;
let failed = 0;

const ok = (name, condition, detail = "") => {
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failed += 1;
};

const never = () => new Promise(() => {});

function makeStand(options = {}) {
  const {
    directorID = `ses_director_${Math.random().toString(36).slice(2, 8)}`,
    agentModels = {
      "vibe-fast": { id: "deepseek-v4.1-flash", providerID: "opencode-go" },
      "vibe-good": { id: "space-bunny-free", providerID: "opencode-go" },
      "vibe-audit-fast": { id: "deepseek-v4.1-flash", providerID: "opencode-go" },
      "vibe-audit-good": { id: "space-bunny-free", providerID: "opencode-go" },
    },
    agentGetError,
    agentUsesSystemModel = false,
    activityMessages = [],
    failSwitchModel,
    failSwitchAgent,
    sessionGetAgent,
    activeSessions = [directorID],
    skills = [{ id: "known", name: "Known", path: "/tmp/known.md", content: "known skill" }],
    defaultModel,
    modelList = [],
    waitResolvesIdle = false,
  } = options;
  const calls = {
    create: [],
    prompt: [],
    context: [],
    sessionGet: [],
    interrupt: [],
    update: [],
    synthetic: [],
    switchModel: [],
    switchAgent: [],
  };
  const failureForWorker = (control, input) => {
    if (input.sessionID === directorID) return undefined;
    return typeof control === "function" ? control(input) : control;
  };
  const agentForSession = (sessionID, currentAgent) => {
    if (sessionID === directorID) return currentAgent;
    return typeof sessionGetAgent === "function"
      ? sessionGetAgent({ sessionID, currentAgent })
      : sessionGetAgent ?? currentAgent;
  };
  let apiSequence = 0;
  let fastAgentGets = 0;
  const sessions = new Map([
    [
      directorID,
      {
        id: "ses_director",
        agent: "build",
        model: { id: "space-bunny-free", providerID: "opencode-go", variant: "max" },
        location: { directory: "/tmp/vibe-parity" },
        messages: [],
      },
    ],
  ]);
  const handlers = new Map();
  const tools = new Map();
  const hooks = new Map();
  let contextError = false;
  const waitFor = () => ({ [Symbol.asyncIterator]: () => ({ next: never }) });

  const session = {
    hook: async (event, handler) => hooks.set(event, handler),
    create: async (input) => {
      calls.create.push({ ...input });
      const id = `ses_worker_${sessions.size}`;
      sessions.set(id, {
        id,
        agent: input.agent,
        model: input.model ?? { id: "session-model", providerID: "session-provider" },
        location: input.location,
        messages: activityMessages,
      });
      return { data: { id, ...input } };
    },
    get: async (input) => {
      const { sessionID } = input;
      const current = sessions.get(sessionID);
      const returnedAgent = current ? agentForSession(sessionID, current.agent) : undefined;
      calls.sessionGet.push({
        ...input,
        ...(returnedAgent === undefined ? {} : { returnedAgent }),
        sequence: ++apiSequence,
      });
      if (!current) return { data: undefined };
      const returnedModel = returnedAgent && agentModels[returnedAgent] ? agentModels[returnedAgent] : current.model;
      return { data: { ...current, agent: returnedAgent, model: returnedModel } };
    },
    active: async () => ({
      data: Object.fromEntries(activeSessions.map((id) => [id, { id }])),
    }),
    context: async (input) => {
      calls.context.push({ ...input });
      if (contextError) throw new Error("context unavailable");
      return { data: sessions.get(input.sessionID)?.messages ?? [] };
    },
    prompt: async (input) => {
      calls.prompt.push({ ...input });
      return { data: { ok: true } };
    },
    synthetic: async (input) => {
      calls.synthetic.push({ ...input });
      return { data: { ok: true } };
    },
    interrupt: async ({ sessionID }) => {
      calls.interrupt.push(sessionID);
      return { data: { ok: true } };
    },
    update: async ({ sessionID, title }) => {
      calls.update.push({ sessionID, title });
      return { data: { ok: true } };
    },
    switchModel: async (input) => {
      calls.switchModel.push({ ...input, sequence: ++apiSequence });
      const failure = failureForWorker(failSwitchModel, input);
      if (failure) throw failure;
      const current = sessions.get(input.sessionID);
      if (current && input.model !== undefined) current.model = input.model;
      return { data: { ok: true } };
    },
    switchAgent: async (input) => {
      calls.switchAgent.push({ ...input, sequence: ++apiSequence });
      const failure = failureForWorker(failSwitchAgent, input);
      if (failure) throw failure;
      const current = sessions.get(input.sessionID);
      if (current) current.agent = input.agent;
      return { data: { ok: true } };
    },
    wait: async () => (waitResolvesIdle ? undefined : never()),
  };

  const ctx = {
    session,
    agent: {
      get: async ({ agentID }) => {
        if (agentID === "vibe-fast") fastAgentGets += 1;
        if (agentGetError && agentID === "vibe-fast" && fastAgentGets > 1) throw agentGetError;
        const model = agentModels[agentID];
        if (!model) return { data: { id: agentID } };
        if (agentUsesSystemModel) {
          const ref = `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
          return { data: { id: agentID, system: `---\nmodel: ${ref}\n---\n` } };
        }
        return { data: { id: agentID, model } };
      },
    },
    skill: {
      list: async () => ({ data: skills }),
    },
    model: {
      list: async () => ({ data: modelList }),
      default: async () => ({ data: defaultModel }),
    },
    tool: {
      transform: (callback) => callback({ add: (definition) => tools.set(definition.name, definition) }),
      hook: async () => {},
    },
    command: {
      transform: (callback) => callback({ add: (definition) => handlers.set(definition.name, definition) }),
    },
    location: { directory: "/tmp/vibe-parity" },
    event: { subscribe: waitFor },
    rpc: {
      register: async (_definition, _handlers) => ({
        events: { emit: async () => {} },
        dispose: async () => {},
      }),
    },
  };
  return {
    ctx,
    calls,
    sessions,
    tools,
    handlers,
    directorID,
    agentModels,
    setContextError: (value) => { contextError = value; },
  };
}

const textOf = (result) => result?.content?.[0]?.text ?? "";
const modelKey = (model) => {
  if (typeof model === "string") return model;
  if (typeof model !== "object" || model === null) return "";
  const providerID = model.providerID;
  const id = model.id;
  if (typeof providerID !== "string" || typeof id !== "string") return "";
  return `${providerID}/${id}${typeof model.variant === "string" && model.variant ? `#${model.variant}` : ""}`;
};
const stateOf = (sessionID) => JSON.parse(readFileSync(join(STATE, `${sessionID}.json`), "utf8"));
const readStateSafe = (sessionID) => {
  try {
    return stateOf(sessionID);
  } catch {
    return undefined;
  }
};
const resetStationState = () => {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
};
const run = async (stand, sessionID = "ses_director") => {
  resetStationState();
  await plugin.default.setup(stand.ctx);
  await stand.handlers.get("vibe").execute({ sessionID, prompt: { text: "" } });
};

const stateFile = (sessionID) => join(STATE, `${sessionID}.json`);
const patchWorkerState = (sessionID, workerID, patch) => {
  const state = stateOf(sessionID);
  const worker = state.workers.find((candidate) => candidate.id === workerID);
  if (!worker) throw new Error(`unknown test worker ${workerID}`);
  Object.assign(worker, patch);
  writeFileSync(stateFile(sessionID), JSON.stringify(state));
  return worker;
};
const patchVibeState = (sessionID, patch) => {
  const state = stateOf(sessionID);
  Object.assign(state, patch);
  writeFileSync(stateFile(sessionID), JSON.stringify(state));
  return state;
};
const makeWorkerIdle = (sessionID, workerID) =>
  patchWorkerState(sessionID, workerID, {
    state: "idle",
    currentJob: undefined,
    queued: [],
    steerPending: undefined,
    acceptedSteers: [],
  });
const clearPromotionCalls = (stand) => {
  stand.calls.switchModel.length = 0;
  stand.calls.switchAgent.length = 0;
  stand.calls.sessionGet.length = 0;
  stand.calls.context.length = 0;
  stand.calls.prompt.length = 0;
};
const spawnAuditWorker = async (directorID, options = {}) => {
  const stand = makeStand({ directorID, ...options });
  await run(stand, directorID);
  const spawned = await stand.tools.get("vibe_spawn").execute(
    { cli: "good", readOnly: true, prompt: "read-only audit" },
    { sessionID: directorID },
  );
  const workerID = stateOf(directorID).workers[0]?.id;
  if (!workerID) throw new Error(`audit worker was not created: ${textOf(spawned)}`);
  return { stand, workerID, spawned };
};
const callPromote = async (stand, workerID) => {
  const definition = stand.tools.get("vibe_promote");
  if (!definition) {
    return { registered: false, result: undefined, error: new Error("vibe_promote is not registered") };
  }
  try {
    const result = await definition.execute(
      { session: workerID, profile: "coding" },
      { sessionID: stand.directorID },
    );
    return { registered: true, result, error: undefined };
  } catch (error) {
    return { registered: true, result: undefined, error };
  }
};

if (shouldRun("model")) {
  const native = makeStand({ directorID: "ses_native_model" });
  await run(native, native.directorID);
  const nativeSpawn = await native.tools.get("vibe_spawn").execute(
    { cli: "fast", prompt: "native model" },
    { sessionID: native.directorID },
  );
  ok(
    "model: native fast agent model is passed to session.create",
    !textOf(nativeSpawn).startsWith("Ошибка:") &&
      native.calls.create[0]?.agent === "vibe-fast" &&
      native.calls.create[0]?.model?.id === "deepseek-v4.1-flash" &&
      stateOf(native.directorID).workers[0]?.readOnly === false,
    `result=${textOf(nativeSpawn).slice(0, 160)} create=${JSON.stringify(native.calls.create[0])}`,
  );

  const systemShaped = makeStand({
    directorID: "ses_system_model",
    agentUsesSystemModel: true,
  });
  await run(systemShaped, systemShaped.directorID);
  const systemSpawn = await systemShaped.tools.get("vibe_spawn").execute(
    { cli: "fast", prompt: "system-shaped model" },
    { sessionID: systemShaped.directorID },
  );
  ok(
    "model: agent frontmatter in system is used when API omits model",
    !textOf(systemSpawn).startsWith("Ошибка:") &&
      systemShaped.calls.create[0]?.model?.id === "deepseek-v4.1-flash",
    `result=${textOf(systemSpawn).slice(0, 200)} create=${JSON.stringify(systemShaped.calls.create[0])}`,
  );

  const unavailable = makeStand({
    directorID: "ses_unresolved_model",
    agentGetError: new Error("agent registry unavailable"),
  });
  await run(unavailable, unavailable.directorID);
  const blockedSpawn = await unavailable.tools.get("vibe_spawn").execute(
    { cli: "fast", prompt: "must not fall back" },
    { sessionID: unavailable.directorID },
  );
  ok(
    "model: missing agent model blocks spawn without director fallback",
    textOf(blockedSpawn).includes("model-unresolved") && unavailable.calls.create.length === 0,
    `result=${textOf(blockedSpawn).slice(0, 200)} creates=${unavailable.calls.create.length}`,
  );
}

if (shouldRun("activity")) {
  const activityBase = Date.now() - 5_000;
  const activityMessages = [
    {
      id: "assistant_activity_old",
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { path: "/run/media/admin1/DATA/AGGG/vibe-station/plugin/opencode/vibe.ts" },
            time: { completed: activityBase },
          },
        },
      ],
    },
    {
      id: "assistant_activity_new",
      type: "assistant",
      content: ["read", "grep", "glob", "list", "search", "inspect", "finalize"].map((name, index) => ({
        type: "tool",
        name,
        state: {
          status: "completed",
          input: { path: `trace-${index}.txt` },
          time: { completed: activityBase + (index + 1) * 100 },
        },
      })),
    },
  ];
  const activity = makeStand({ directorID: "ses_activity" });
  await run(activity, activity.directorID);
  await activity.tools.get("vibe_spawn").execute(
    { cli: "fast", prompt: "activity" },
    { sessionID: activity.directorID },
  );
  const activityWorkerID = [...activity.sessions.keys()].at(-1);
  activity.sessions.get(activityWorkerID).messages = activityMessages;
  const listed = await activity.tools.get("vibe_list").execute({}, { sessionID: activity.directorID });
  const traceMatch = textOf(listed).match(/trace=([^\n]+)/);
  ok(
    "activity: roster advances to the newest tool and keeps a bounded trace",
    textOf(listed).includes("lastActivityAt=") &&
      textOf(listed).includes("lastActivity=finalize") &&
      textOf(listed).includes("lastTool=finalize") &&
      textOf(listed).includes("toolCallCount=8") &&
      traceMatch?.[1].split(" | ").length === 6,
    textOf(listed).slice(0, 420),
  );
  activity.setContextError(true);
  const degraded = await activity.tools.get("vibe_list").execute({}, { sessionID: activity.directorID });
  ok(
    "activity: context failure preserves the last confirmed activity",
    textOf(degraded).includes("lastTool=finalize") && textOf(degraded).includes("lastActivityAt="),
    textOf(degraded).slice(0, 320),
  );
}

if (shouldRun("wait")) {
  const waiting = makeStand({ directorID: "ses_wait_activity" });
  await run(waiting, waiting.directorID);
  await waiting.tools.get("vibe_spawn").execute(
    { cli: "fast", prompt: "wait activity" },
    { sessionID: waiting.directorID },
  );
  const waitingWorkerID = [...waiting.sessions.keys()].at(-1);
  waiting.sessions.get(waitingWorkerID).messages = [
    {
      id: "assistant_wait_activity",
      type: "assistant",
      time: { created: Date.now() - 1000 },
      content: [
        {
          type: "tool",
          name: "read",
          state: { status: "completed", input: { path: "AGGG/README.md" }, time: { completed: Date.now() - 500 } },
        },
      ],
    },
  ];
  const waited = await waiting.tools.get("vibe_wait").execute(
    { sessions: [waitingWorkerID], timeout: 0.05 },
    { sessionID: waiting.directorID },
  );
  const waitedState = stateOf(waiting.directorID);
  const waitedWorker = waitedState.workers.find((worker) => worker.id === waitingWorkerID);
  ok(
    "wait: timeout preserves the running job and reports current activity",
    textOf(waited).includes("Job остаётся в полёте") &&
      textOf(waited).includes("stillRunning=true") &&
      textOf(waited).includes("elapsed=") &&
      textOf(waited).includes("lastActivityAt=") &&
      textOf(waited).includes("lastActivity=") &&
      textOf(waited).includes("lastTool=read") &&
      waitedWorker?.currentJob?.phase === "running" &&
      waitedWorker?.currentJob?.id,
    textOf(waited).slice(0, 420),
  );
}

if (shouldRun("readonly")) {
  const audit = makeStand({ directorID: "ses_readonly" });
  await run(audit, audit.directorID);
  const spawned = await audit.tools.get("vibe_spawn").execute(
    { cli: "fast", readOnly: true, prompt: "read-only audit" },
    { sessionID: audit.directorID },
  );
  ok(
    "readonly: readOnly spawn selects the audit agent identity",
    !textOf(spawned).startsWith("Ошибка:") &&
      audit.calls.create[0]?.agent === "vibe-audit-fast" &&
      stateOf(audit.directorID).workers[0]?.readOnly === true,
    `result=${textOf(spawned).slice(0, 180)} create=${JSON.stringify(audit.calls.create[0])}`,
  );
}

if (shouldRun("promote")) {
  const successHistory = [
    { id: "user_audit_history", type: "user", text: "existing audit history" },
    { id: "assistant_audit_history", type: "assistant", content: [{ type: "text", text: "audit result" }] },
  ];
  const success = await spawnAuditWorker("ses_promote_success", { activityMessages: successHistory });
  makeWorkerIdle(success.stand.directorID, success.workerID);
  const beforeHistory = await success.stand.ctx.session.context({ sessionID: success.workerID });
  clearPromotionCalls(success.stand);
  const successCall = await callPromote(success.stand, success.workerID);
  const afterHistory = await success.stand.ctx.session.context({ sessionID: success.workerID });
  const successState = stateOf(success.stand.directorID);
  const successWorker = successState.workers[0];
  const successText = textOf(successCall.result);
  ok(
    "promote: idle good audit worker keeps its session and becomes coding",
    successCall.registered &&
      !successCall.error &&
      !successText.startsWith("Ошибка:") &&
      success.stand.calls.switchModel[0]?.sessionID === success.workerID &&
      success.stand.calls.switchAgent[0]?.sessionID === success.workerID &&
      success.stand.calls.switchAgent[0]?.agent === "vibe-good" &&
      success.stand.calls.sessionGet.at(-1)?.sessionID === success.workerID &&
      successWorker?.id === success.workerID &&
      successWorker?.readOnly === false &&
      success.stand.sessions.has(success.workerID) &&
      success.stand.calls.create.length === 1 &&
      success.stand.calls.prompt.length === 0 &&
      JSON.stringify(beforeHistory?.data) === JSON.stringify(afterHistory?.data),
    `result=${successText.slice(0, 180)} error=${successCall.error?.message ?? "none"} switchModel=${JSON.stringify(success.stand.calls.switchModel)} switchAgent=${JSON.stringify(success.stand.calls.switchAgent)} sessionGet=${JSON.stringify(success.stand.calls.sessionGet)} worker=${JSON.stringify(successWorker)}`,
  );

  clearPromotionCalls(success.stand);
  const followup = await success.stand.tools.get("vibe_send").execute(
    { session: success.workerID, message: "continue on the same coding session" },
    { sessionID: success.stand.directorID },
  );
  const followupState = stateOf(success.stand.directorID).workers[0];
  const followupText = textOf(followup);
  ok(
    "promote: next vibe_send is admitted on the same worker session",
    !followupText.startsWith("Ошибка:") &&
      followupState?.id === success.workerID &&
      followupState?.readOnly === false &&
      followupState?.state === "running" &&
      followupState?.currentJob?.workerID === success.workerID,
    `result=${followupText.slice(0, 180)} worker=${JSON.stringify(followupState)}`,
  );

  const preconditionCases = [
    ["running", () => ({ state: "running" })],
    ["currentJob", (original) => ({ currentJob: original.currentJob })],
    ["queued", () => ({ queued: ["queued turn"] })],
    ["steerPending", () => ({ steerPending: { id: "steer_pending", text: "pending steer" } })],
    ["stopping", () => ({ state: "stopping" })],
  ];
  for (const [label, makePatch] of preconditionCases) {
    const prepared = await spawnAuditWorker(`ses_promote_pre_${label}`);
    const originalWorker = stateOf(prepared.stand.directorID).workers[0];
    makeWorkerIdle(prepared.stand.directorID, prepared.workerID);
    patchWorkerState(prepared.stand.directorID, prepared.workerID, makePatch(originalWorker));
    clearPromotionCalls(prepared.stand);
    const call = await callPromote(prepared.stand, prepared.workerID);
    const resultText = textOf(call.result);
    const worker = stateOf(prepared.stand.directorID).workers[0];
    ok(
      `promote precondition: ${label} is rejected without switch APIs`,
      call.registered &&
        !call.error &&
        resultText.startsWith("Ошибка:") &&
        prepared.stand.calls.switchModel.length === 0 &&
        prepared.stand.calls.switchAgent.length === 0 &&
        worker?.readOnly === true,
      `result=${resultText.slice(0, 180)} error=${call.error?.message ?? "none"} worker=${JSON.stringify(worker)} switchModel=${JSON.stringify(prepared.stand.calls.switchModel)} switchAgent=${JSON.stringify(prepared.stand.calls.switchAgent)}`,
    );
  }

  const idempotent = await spawnAuditWorker("ses_promote_idempotent");
  makeWorkerIdle(idempotent.stand.directorID, idempotent.workerID);
  patchWorkerState(idempotent.stand.directorID, idempotent.workerID, { readOnly: false });
  clearPromotionCalls(idempotent.stand);
  const idempotentCall = await callPromote(idempotent.stand, idempotent.workerID);
  const idempotentText = textOf(idempotentCall.result);
  ok(
    "promote: already-coding worker is idempotent without switch calls",
    idempotentCall.registered &&
      !idempotentCall.error &&
      !idempotentText.startsWith("Ошибка:") &&
      idempotent.stand.calls.switchModel.length === 0 &&
      idempotent.stand.calls.switchAgent.length === 0 &&
      stateOf(idempotent.stand.directorID).workers[0]?.readOnly === false,
    `result=${idempotentText.slice(0, 180)} error=${idempotentCall.error?.message ?? "none"} switchModel=${JSON.stringify(idempotent.stand.calls.switchModel)} switchAgent=${JSON.stringify(idempotent.stand.calls.switchAgent)}`,
  );

  const transitionState = await spawnAuditWorker("ses_promote_transition_state");
  makeWorkerIdle(transitionState.stand.directorID, transitionState.workerID);
  patchWorkerState(transitionState.stand.directorID, transitionState.workerID, {
    accessTransition: {
      from: "audit",
      to: "coding",
      phase: "failed",
      targetAgent: "vibe-good",
      targetModel: "opencode-go/space-bunny-free",
      startedAt: 123,
      error: "model switch failed",
    },
  });
  const transitionList = await transitionState.stand.tools.get("vibe_list").execute(
    {},
    { sessionID: transitionState.stand.directorID },
  );
  const transitionText = textOf(transitionList);
  ok(
    "promote state: access transition survives state validation and status projection",
    transitionText.includes("promotion-failed") &&
      transitionText.includes("targetAgent=vibe-good") &&
      transitionText.includes("model switch failed"),
    transitionText.slice(0, 360),
  );

  clearPromotionCalls(transitionState.stand);
  const blockedSend = await transitionState.stand.tools.get("vibe_send").execute(
    { session: transitionState.workerID, message: "must wait for reconciliation" },
    { sessionID: transitionState.stand.directorID },
  );
  const blockedSendText = textOf(blockedSend);
  ok(
    "promote: vibe_send is blocked while access transition is unresolved",
    blockedSendText.startsWith("Ошибка:") &&
      transitionState.stand.calls.prompt.length === 0 &&
      transitionState.stand.calls.switchModel.length === 0 &&
      transitionState.stand.calls.switchAgent.length === 0,
    `result=${blockedSendText.slice(0, 180)} prompt=${JSON.stringify(transitionState.stand.calls.prompt)}`,
  );

  const recoveryCases = [
    ["coding", "vibe-good", false],
    ["audit", undefined, false],
    ["unknown", () => undefined, true],
  ];
  for (const [label, sessionAgent, expectFailed] of recoveryCases) {
    const recovery = await spawnAuditWorker(`ses_promote_recovery_${label}`, {
      sessionGetAgent: sessionAgent,
      waitResolvesIdle: true,
    });
    makeWorkerIdle(recovery.stand.directorID, recovery.workerID);
    patchWorkerState(recovery.stand.directorID, recovery.workerID, {
      accessTransition: {
        from: "audit",
        to: "coding",
        phase: "switching",
        targetAgent: "vibe-good",
        targetModel: "opencode-go/space-bunny-free",
        startedAt: Date.now(),
      },
    });
    await plugin.default.setup(recovery.stand.ctx);
    const recovered = readStateSafe(recovery.stand.directorID)?.workers[0];
    const expectedReadOnly = label === "coding" ? false : true;
    ok(
      `promote recovery: ${label} session is reconciled without replacing the worker`,
      Boolean(recovered) &&
        recovered.id === recovery.workerID &&
        recovered.readOnly === expectedReadOnly &&
        (expectFailed
          ? recovered.accessTransition?.phase === "failed" && recovered.lastStatus === "promotion-failed"
          : recovered.accessTransition === undefined),
      `worker=${JSON.stringify(recovered)}`,
    );
  }

  const modelFailure = await spawnAuditWorker("ses_promote_model_failure", {
    failSwitchModel: new Error("model switch failed"),
  });
  makeWorkerIdle(modelFailure.stand.directorID, modelFailure.workerID);
  clearPromotionCalls(modelFailure.stand);
  const modelFailureCall = await callPromote(modelFailure.stand, modelFailure.workerID);
  const modelFailureText = textOf(modelFailureCall.result);
  const modelFailureWorker = stateOf(modelFailure.stand.directorID).workers[0];
  ok(
    "promote failure: model switch failure never changes the agent",
    modelFailureCall.registered &&
      !modelFailureCall.error &&
      modelFailureText.startsWith("Ошибка:") &&
      modelFailure.stand.calls.switchModel.length === 1 &&
      modelFailure.stand.calls.switchAgent.length === 0 &&
      modelFailureWorker?.readOnly === true &&
      modelFailureWorker?.accessTransition?.phase === "failed" &&
      modelFailureWorker?.accessTransition?.error === "model switch failed",
    `result=${modelFailureText.slice(0, 180)} error=${modelFailureCall.error?.message ?? "none"} worker=${JSON.stringify(modelFailureWorker)} switchModel=${JSON.stringify(modelFailure.stand.calls.switchModel)} switchAgent=${JSON.stringify(modelFailure.stand.calls.switchAgent)}`,
  );

  const agentFailure = await spawnAuditWorker("ses_promote_agent_failure", {
    failSwitchAgent: new Error("agent switch failed"),
  });
  makeWorkerIdle(agentFailure.stand.directorID, agentFailure.workerID);
  clearPromotionCalls(agentFailure.stand);
  const agentFailureCall = await callPromote(agentFailure.stand, agentFailure.workerID);
  const agentFailureText = textOf(agentFailureCall.result);
  const agentFailureWorker = stateOf(agentFailure.stand.directorID).workers[0];
  ok(
    "promote failure: agent switch failure is not reported as success",
    agentFailureCall.registered &&
      !agentFailureCall.error &&
      agentFailureText.startsWith("Ошибка:") &&
      agentFailure.stand.calls.switchModel.length === 2 &&
      agentFailure.stand.calls.switchAgent.length >= 1 &&
      agentFailureWorker?.readOnly === true &&
      agentFailureWorker?.accessTransition?.phase === "failed" &&
      agentFailureWorker?.accessTransition?.error === "agent switch failed",
    `result=${agentFailureText.slice(0, 180)} error=${agentFailureCall.error?.message ?? "none"} worker=${JSON.stringify(agentFailureWorker)} switchModel=${JSON.stringify(agentFailure.stand.calls.switchModel)} switchAgent=${JSON.stringify(agentFailure.stand.calls.switchAgent)}`,
  );

  const verificationError = "authoritative agent mismatch";
  const verificationFailure = await spawnAuditWorker("ses_promote_verification_failure", {
    sessionGetAgent: ({ currentAgent }) =>
      currentAgent === "vibe-good" ? "vibe-audit-fast" : currentAgent,
  });
  makeWorkerIdle(verificationFailure.stand.directorID, verificationFailure.workerID);
  clearPromotionCalls(verificationFailure.stand);
  const verificationFailureCall = await callPromote(verificationFailure.stand, verificationFailure.workerID);
  const verificationFailureText = textOf(verificationFailureCall.result);
  const verificationFailureWorker = stateOf(verificationFailure.stand.directorID).workers[0];
  const verificationCalls = verificationFailure.stand.calls;
  const rollbackModelCall = verificationCalls.switchModel[1];
  const rollbackAgentCall = verificationCalls.switchAgent[1];
  const auditModel = verificationFailure.stand.agentModels["vibe-audit-good"];
  const mismatchObserved = verificationCalls.sessionGet.some(
    (call) => call.sessionID === verificationFailure.workerID && call.returnedAgent === "vibe-audit-fast",
  );
  const rollbackVerified = verificationCalls.sessionGet.some(
    (call) => call.sessionID === verificationFailure.workerID && call.returnedAgent === "vibe-audit-good",
  ) && verificationCalls.sessionGet.at(-1)?.returnedAgent === "vibe-audit-good";
  const auditSession = verificationFailure.stand.sessions.get(verificationFailure.workerID);
  ok(
    "promote failure: verification mismatch rolls back model and agent, then confirms audit state",
    verificationFailureCall.registered &&
      !verificationFailureCall.error &&
      verificationFailureText.startsWith("Ошибка:") &&
      mismatchObserved &&
      rollbackModelCall?.sessionID === verificationFailure.workerID &&
      modelKey(rollbackModelCall.model) === modelKey(auditModel) &&
      rollbackAgentCall?.sessionID === verificationFailure.workerID &&
      rollbackAgentCall.agent === "vibe-audit-good" &&
      rollbackVerified &&
      auditSession?.agent === "vibe-audit-good" &&
      verificationFailureWorker?.readOnly === true &&
      verificationFailureWorker?.accessTransition?.phase === "failed" &&
      verificationFailureWorker?.accessTransition?.error === verificationError,
    `result=${verificationFailureText.slice(0, 180)} error=${verificationFailureCall.error?.message ?? "none"} expectedError=${verificationError} worker=${JSON.stringify(verificationFailureWorker)} switchModel=${JSON.stringify(verificationCalls.switchModel)} switchAgent=${JSON.stringify(verificationCalls.switchAgent)} sessionGet=${JSON.stringify(verificationCalls.sessionGet)}`,
  );
}

if (shouldRun("rehydrate")) {
  const idleRecovery = await spawnAuditWorker("ses_rehydrate_idle", { waitResolvesIdle: true });
  makeWorkerIdle(idleRecovery.stand.directorID, idleRecovery.workerID);
  patchVibeState(idleRecovery.stand.directorID, {
    lifecycleScope: {
      version: 2,
      directorSessionID: idleRecovery.stand.directorID,
      directorAgent: "vibe-director",
      cwd: "/tmp/vibe-parity",
    },
  });
  clearPromotionCalls(idleRecovery.stand);
  const idlePromptsBeforeRecovery = idleRecovery.stand.calls.prompt.length;
  await plugin.default.setup(idleRecovery.stand.ctx);
  const idleWorker = readStateSafe(idleRecovery.stand.directorID)?.workers[0];
  ok(
    "rehydrate: existing idle worker is restored without create or prompt replay",
    idleWorker?.id === idleRecovery.workerID &&
      idleWorker?.recovery?.state === "restored" &&
      idleWorker?.suspended !== true &&
      idleRecovery.stand.calls.create.length === 1 &&
      idleRecovery.stand.calls.prompt.length === idlePromptsBeforeRecovery,
    `worker=${JSON.stringify(idleWorker)} create=${JSON.stringify(idleRecovery.stand.calls.create)} prompt=${JSON.stringify(idleRecovery.stand.calls.prompt)}`,
  );

  const suspendedRecovery = await spawnAuditWorker("ses_rehydrate_suspended", { waitResolvesIdle: true });
  makeWorkerIdle(suspendedRecovery.stand.directorID, suspendedRecovery.workerID);
  patchVibeState(suspendedRecovery.stand.directorID, {
    lifecycleScope: {
      version: 2,
      directorSessionID: suspendedRecovery.stand.directorID,
      directorAgent: "vibe-director",
      cwd: "/tmp/vibe-parity",
    },
  });
  patchWorkerState(suspendedRecovery.stand.directorID, suspendedRecovery.workerID, { suspended: true });
  await plugin.default.setup(suspendedRecovery.stand.ctx);
  const suspendedWorker = readStateSafe(suspendedRecovery.stand.directorID)?.workers[0];
  ok(
    "rehydrate: owner-suspended worker stays suspended after restart",
    suspendedWorker?.suspended === true,
    `worker=${JSON.stringify(suspendedWorker)}`,
  );

  const interruptedRecovery = await spawnAuditWorker("ses_rehydrate_interrupted");
  const interruptedJob = stateOf(interruptedRecovery.stand.directorID).workers[0].currentJob;
  makeWorkerIdle(interruptedRecovery.stand.directorID, interruptedRecovery.workerID);
  patchVibeState(interruptedRecovery.stand.directorID, {
    lifecycleScope: {
      version: 2,
      directorSessionID: interruptedRecovery.stand.directorID,
      directorAgent: "vibe-director",
      cwd: "/tmp/vibe-parity",
    },
  });
  patchWorkerState(interruptedRecovery.stand.directorID, interruptedRecovery.workerID, {
    state: "running",
    currentJob: interruptedJob,
  });
  const promptsBeforeRecovery = interruptedRecovery.stand.calls.prompt.length;
  await plugin.default.setup(interruptedRecovery.stand.ctx);
  const interruptedWorker = readStateSafe(interruptedRecovery.stand.directorID)?.workers[0];
  ok(
    "rehydrate: in-flight job is retained as interrupted without prompt replay",
    interruptedWorker?.id === interruptedRecovery.workerID &&
      interruptedWorker?.recovery?.state === "interrupted" &&
      interruptedWorker?.currentJob?.id === interruptedJob?.id &&
      interruptedRecovery.stand.calls.prompt.length === promptsBeforeRecovery &&
      interruptedRecovery.stand.calls.create.length === 1,
    `worker=${JSON.stringify(interruptedWorker)} prompt=${JSON.stringify(interruptedRecovery.stand.calls.prompt)} create=${JSON.stringify(interruptedRecovery.stand.calls.create)}`,
  );

  const missingRecovery = await spawnAuditWorker("ses_rehydrate_missing", { waitResolvesIdle: true });
  makeWorkerIdle(missingRecovery.stand.directorID, missingRecovery.workerID);
  patchVibeState(missingRecovery.stand.directorID, {
    lifecycleScope: {
      version: 2,
      directorSessionID: missingRecovery.stand.directorID,
      directorAgent: "vibe-director",
      cwd: "/tmp/vibe-parity",
    },
  });
  missingRecovery.stand.sessions.delete(missingRecovery.workerID);
  clearPromotionCalls(missingRecovery.stand);
  const missingPromptsBeforeRecovery = missingRecovery.stand.calls.prompt.length;
  await plugin.default.setup(missingRecovery.stand.ctx);
  const missingWorker = readStateSafe(missingRecovery.stand.directorID)?.workers[0];
  ok(
    "rehydrate: missing worker is marked missing without replacement session",
    missingWorker?.id === missingRecovery.workerID &&
      missingWorker?.state === "dead" &&
      missingWorker?.recovery?.state === "missing" &&
      missingRecovery.stand.calls.create.length === 1 &&
      missingRecovery.stand.calls.prompt.length === missingPromptsBeforeRecovery,
    `worker=${JSON.stringify(missingWorker)} create=${JSON.stringify(missingRecovery.stand.calls.create)}`,
  );
}

if (shouldRun("skill")) {
  const knownSkill = makeStand({ directorID: "ses_skill_known" });
  resetStationState();
  await plugin.default.setup(knownSkill.ctx);
  await knownSkill.handlers.get("vibe").execute({
    sessionID: knownSkill.directorID,
    prompt: { text: "/skill:known fix the parser" },
  });
  const knownPrompt = knownSkill.calls.prompt.at(-1);
  ok(
    "skill: explicit leading token uses native skill attachment",
    knownPrompt?.text === "fix the parser" &&
      JSON.stringify(knownPrompt?.skills) === JSON.stringify([{ id: "known" }]),
    `prompt=${JSON.stringify(knownPrompt)}`,
  );

  const proseSkill = makeStand({ directorID: "ses_skill_prose" });
  resetStationState();
  await plugin.default.setup(proseSkill.ctx);
  await proseSkill.handlers.get("vibe").execute({
    sessionID: proseSkill.directorID,
    prompt: { text: "Explain /skill:missing in ordinary prose" },
  });
  const prosePrompt = proseSkill.calls.prompt.at(-1);
  ok(
    "skill: a token in ordinary prose is not auto-admitted",
    prosePrompt?.text === "Explain /skill:missing in ordinary prose" && prosePrompt?.skills === undefined,
    `prompt=${JSON.stringify(prosePrompt)}`,
  );

  const unknownSkill = makeStand({ directorID: "ses_skill_unknown" });
  resetStationState();
  await plugin.default.setup(unknownSkill.ctx);
  const unknownResponse = await unknownSkill.handlers.get("vibe").execute({
    sessionID: unknownSkill.directorID,
    prompt: { text: "/skill:missing do not run" },
  });
  ok(
    "skill: unknown ID is rejected before vibe state or prompt admission",
    (unknownSkill.calls.synthetic.at(-1)?.text ?? "").includes("skill") &&
      readStateSafe(unknownSkill.directorID) === undefined &&
      unknownSkill.calls.prompt.length === 0,
    `response=${unknownSkill.calls.synthetic.at(-1)?.text ?? ""} state=${JSON.stringify(readStateSafe(unknownSkill.directorID))} prompt=${JSON.stringify(unknownSkill.calls.prompt)}`,
  );

  const emptySkill = makeStand({ directorID: "ses_skill_empty" });
  resetStationState();
  await plugin.default.setup(emptySkill.ctx);
  const emptyResponse = await emptySkill.handlers.get("vibe").execute({
    sessionID: emptySkill.directorID,
    prompt: { text: "/skill:known" },
  });
  ok(
    "skill: empty remaining prompt is rejected instead of inventing text",
    (emptySkill.calls.synthetic.at(-1)?.text ?? "").includes("text") &&
      readStateSafe(emptySkill.directorID) === undefined &&
      emptySkill.calls.prompt.length === 0,
    `response=${emptySkill.calls.synthetic.at(-1)?.text ?? ""} state=${JSON.stringify(readStateSafe(emptySkill.directorID))} prompt=${JSON.stringify(emptySkill.calls.prompt)}`,
  );
}

if (shouldRun("model")) {
  const previousFallback = process.env.VIBE_MODEL_FALLBACK;
  delete process.env.VIBE_MODEL_FALLBACK;
  const noFallback = makeStand({
    directorID: "ses_model_no_fallback",
    agentModels: {},
    defaultModel: { providerID: "test-provider", modelID: "default-model" },
  });
  resetStationState();
  await plugin.default.setup(noFallback.ctx);
  await noFallback.handlers.get("vibe").execute({ sessionID: noFallback.directorID, prompt: { text: "" } });
  const blocked = await noFallback.tools.get("vibe_spawn").execute(
    { cli: "good", prompt: "must resolve a model" },
    { sessionID: noFallback.directorID },
  );
  ok(
    "model: missing agent model stays blocked with fallback none",
    textOf(blocked).includes("model-unresolved") && noFallback.calls.create.length === 0,
    `result=${textOf(blocked).slice(0, 180)} create=${JSON.stringify(noFallback.calls.create)}`,
  );

  process.env.VIBE_MODEL_FALLBACK = "default";
  const withFallback = makeStand({
    directorID: "ses_model_default_fallback",
    agentModels: {},
    defaultModel: { providerID: "test-provider", modelID: "default-model" },
  });
  resetStationState();
  await plugin.default.setup(withFallback.ctx);
  await withFallback.handlers.get("vibe").execute({ sessionID: withFallback.directorID, prompt: { text: "" } });
  const fallbackSpawn = await withFallback.tools.get("vibe_spawn").execute(
    { cli: "good", prompt: "use explicit default fallback" },
    { sessionID: withFallback.directorID },
  );
  const fallbackWorker = readStateSafe(withFallback.directorID)?.workers[0];
  const fallbackList = await withFallback.tools.get("vibe_list").execute({}, { sessionID: withFallback.directorID });
  ok(
    "model: explicit default fallback is used and survives state validation",
    !textOf(fallbackSpawn).startsWith("Ошибка:") &&
      !textOf(fallbackList).startsWith("Ошибка:") &&
      fallbackWorker?.model === "test-provider/default-model" &&
      fallbackWorker?.modelSource === "default",
    `spawn=${textOf(fallbackSpawn).slice(0, 180)} list=${textOf(fallbackList).slice(0, 180)} worker=${JSON.stringify(fallbackWorker)}`,
  );
  if (previousFallback === undefined) delete process.env.VIBE_MODEL_FALLBACK;
  else process.env.VIBE_MODEL_FALLBACK = previousFallback;
}

if (shouldRun("scope")) {
  const scope = await spawnAuditWorker("ses_scope_owner", {
    activeSessions: ["ses_scope_owner"],
  });
  patchVibeState(scope.stand.directorID, {
    lifecycleScope: {
      version: 2,
      directorSessionID: scope.stand.directorID,
      directorAgent: "vibe-director",
      cwd: "/tmp/vibe-parity",
    },
  });
  const scopeSession = scope.stand.sessions.get(scope.stand.directorID);
  if (scopeSession) scopeSession.agent = "build";
  clearPromotionCalls(scope.stand);
  const wrongAgentSpawn = await scope.stand.tools.get("vibe_spawn").execute(
    { cli: "fast", prompt: "must be blocked" },
    { sessionID: scope.stand.directorID },
  );
  const wrongAgentText = textOf(wrongAgentSpawn);
  ok(
    "scope: coordinator mutation rejects a non-authoritative director agent",
    wrongAgentText.startsWith("Ошибка:") && scope.stand.calls.create.length === 1,
    `result=${wrongAgentText.slice(0, 180)} create=${JSON.stringify(scope.stand.calls.create)}`,
  );

  const activeWorkerSessions = ["ses_scope_worker_active"];
  const activeWorker = await spawnAuditWorker("ses_scope_worker_active", {
    activeSessions: activeWorkerSessions,
  });
  activeWorkerSessions.splice(0, 1, activeWorker.workerID);
  patchVibeState(activeWorker.stand.directorID, {
    lifecycleScope: {
      version: 2,
      directorSessionID: activeWorker.stand.directorID,
      directorAgent: "vibe-director",
      cwd: "/tmp/vibe-parity",
    },
  });
  await activeWorker.stand.tools.get("vibe_list").execute({}, { sessionID: activeWorker.stand.directorID });
  ok(
    "scope: active worker session is attributed to its director scope",
    readStateSafe(activeWorker.stand.directorID)?.workers[0]?.suspended !== true,
    `worker=${JSON.stringify(readStateSafe(activeWorker.stand.directorID)?.workers[0])}`,
  );

  const switchActiveSessions = ["ses_scope_switch"];
  const switchScope = await spawnAuditWorker("ses_scope_switch", {
    activeSessions: switchActiveSessions,
  });
  switchScope.stand.sessions.set("ses_scope_new", {
    id: "ses_scope_new",
    agent: "vibe-director",
    location: { directory: "/tmp/vibe-parity" },
  });
  switchActiveSessions.splice(0, 1, "ses_scope_new");
  patchVibeState(switchScope.stand.directorID, {
    lifecycleScope: {
      version: 2,
      directorSessionID: switchScope.stand.directorID,
      directorAgent: "vibe-director",
      cwd: "/tmp/vibe-parity",
    },
  });
  await switchScope.stand.tools.get("vibe_list").execute({}, { sessionID: "ses_scope_new" });
  const suspendedWorker = stateOf(switchScope.stand.directorID).workers[0];
  ok(
    "scope: definite active-session change suspends old workers without teardown",
    suspendedWorker?.suspended === true,
    `worker=${JSON.stringify(suspendedWorker)}`,
  );
  const oldDirectorMutation = await switchScope.stand.tools.get("vibe_spawn").execute(
    { cli: "fast", prompt: "old director must be blocked" },
    { sessionID: switchScope.stand.directorID },
  );
  ok(
    "scope: old director cannot mutate after definite active-session switch",
    textOf(oldDirectorMutation).includes("scope") && switchScope.stand.calls.create.length === 1,
    `result=${textOf(oldDirectorMutation).slice(0, 180)} create=${JSON.stringify(switchScope.stand.calls.create)}`,
  );
  switchActiveSessions.splice(0, 1, switchScope.stand.directorID);
  await switchScope.stand.tools.get("vibe_list").execute({}, { sessionID: switchScope.stand.directorID });
  ok(
    "scope: returning authoritative director clears owner suspension",
    readStateSafe(switchScope.stand.directorID)?.workers[0]?.suspended === false,
    `worker=${JSON.stringify(readStateSafe(switchScope.stand.directorID)?.workers[0])}`,
  );
}

if (shouldRun("native")) {
  const nativeActiveSessions = ["ses_native_state"];
  const nativeState = await spawnAuditWorker("ses_native_state", { activeSessions: nativeActiveSessions });
  makeWorkerIdle(nativeState.stand.directorID, nativeState.workerID);
  nativeActiveSessions.splice(0);
  patchVibeState(nativeState.stand.directorID, {
    lifecycleScope: {
      version: 2,
      directorSessionID: nativeState.stand.directorID,
      directorAgent: "vibe-director",
      cwd: "/tmp/vibe-parity",
    },
  });
  patchWorkerState(nativeState.stand.directorID, nativeState.workerID, {
    suspended: true,
    recovery: { state: "interrupted", at: 123, reason: "restart probe" },
  });
  const nativeList = await nativeState.stand.tools.get("vibe_list").execute(
    {},
    { sessionID: nativeState.stand.directorID },
  );
  const nativeText = textOf(nativeList);
  ok(
    "native state: versioned lifecycle scope and recovery survive projection",
    nativeText.includes("lifecycle=v2") &&
      nativeText.includes("suspended=true") &&
      nativeText.includes("recovery=interrupted") &&
      nativeText.includes("restart probe"),
    nativeText.slice(0, 420),
  );
}

rmSync(STATE, { recursive: true, force: true });
rmSync(MODES_STATE, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
