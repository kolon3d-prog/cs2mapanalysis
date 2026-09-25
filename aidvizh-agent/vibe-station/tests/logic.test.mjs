/**
 * Logic tests for vibe-station. The stand-in OpenCode V2 API is deliberately
 * event-driven: no polling loops or time-based waits are used here.
 */
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "vibe-test-"));
const MODES_STATE = mkdtempSync(join(tmpdir(), "vibe-modes-"));
process.env.VIBE_STATE_DIR = STATE;
process.env.VIBE_LOG = join(STATE, "vibe.log");
process.env.MODES_STATE_DIR = MODES_STATE;
process.env.VIBE_FAST_MODEL = "fast-provider/fast-model";
delete process.env.VIBE_MAX_WORKERS;
delete process.env.VIBE_TURN_TIMEOUT_MS;

const plugin = await import("../plugin/opencode/vibe.ts");
const wallModule = await import("../plugin/opencode-tui/wall.ts").catch(() => undefined);
const rpcModule = await import("../plugin/opencode-tui/rpc.ts").catch(() => undefined);

let failed = 0;
const ok = (name, condition, detail = "") => {
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failed += 1;
};
const stateFile = (sessionID) => join(STATE, `${sessionID}.json`);
const stateOf = (sessionID) => {
  try {
    return JSON.parse(readFileSync(stateFile(sessionID), "utf8"));
  } catch {
    return undefined;
  }
};
const clearState = (sessionID) => rmSync(stateFile(sessionID), { force: true });
const orphanFiles = () => {
  try {
    return readdirSync(STATE).filter((name) => name.includes(".orphan-") && name.endsWith(".json"));
  } catch {
    return [];
  }
};
const clearOrphans = () => {
  for (const name of orphanFiles()) rmSync(join(STATE, name), { force: true });
};
const deferred = () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  return { promise, resolve, reject };
};
const errorText = (error) => (error instanceof Error ? error.message : String(error));
const until = async (predicate, label, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`не дождался: ${label}`);
};

function makeBus() {
  const streams = [];
  const pendingEvents = [];
  const eventWaiters = [];
  const subscriberWaiters = [];
  const makeStream = () => {
    const queue = [];
    const waiters = [];
    let closed = false;
    const stream = {
      get closed() {
        return closed;
      },
      push(event) {
        if (closed) return false;
        const waiter = waiters.shift();
        if (waiter) waiter({ value: event, done: false });
        else queue.push(event);
        return true;
      },
      close() {
        if (closed) return Promise.resolve();
        closed = true;
        for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
        return Promise.resolve();
      },
      stream: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
              if (closed) return Promise.resolve({ value: undefined, done: true });
              const next = deferred();
              waiters.push(next.resolve);
              return next.promise;
            },
          };
        },
      },
    };
    return stream;
  };
  return {
    streams,
    subscribe() {
      const stream = makeStream();
      streams.push(stream);
      for (const event of pendingEvents.splice(0)) stream.push(event);
      for (const waiter of subscriberWaiters.splice(0)) {
        if (waiter.count <= streams.length) waiter.resolve();
        else subscriberWaiters.push(waiter);
      }
      return stream.stream;
    },
    push(event) {
      const stream = streams.toReversed().find((candidate) => !candidate.closed);
      if (!stream || !stream.push(event)) pendingEvents.push(event);
      for (const waiter of [...eventWaiters]) {
        if (!waiter.predicate(event)) continue;
        clearTimeout(waiter.timer);
        eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    },
    waitForEvent(predicate, label, timeoutMs = 2_000) {
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiter.timer = setTimeout(() => {
          const index = eventWaiters.indexOf(waiter);
          if (index >= 0) eventWaiters.splice(index, 1);
          reject(new Error(`не дождался: ${label}`));
        }, timeoutMs);
        eventWaiters.push(waiter);
      });
    },
    closeCurrent() {
      return streams.at(-1)?.close() ?? Promise.resolve();
    },
    waitForSubscribers(count) {
      if (streams.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { count, resolve };
        const timer = setTimeout(() => reject(new Error(`не дождался ${count} event subscribers`)), 2_000);
        const originalResolve = waiter.resolve;
        waiter.resolve = () => {
          clearTimeout(timer);
          originalResolve();
        };
        subscriberWaiters.push(waiter);
      });
    },
  };
}

function makeStand(options = {}) {
  const {
    agentsMissing = false,
    autoFinish = true,
    finishMode = "idle",
    rejectSteer = false,
    rejectTurn = false,
    steerThrowsAfterAccept = false,
    steerThrowsWithoutReceipt = false,
    interruptReturnsOnly = false,
    waitError,
    failWait = false,
    createGate,
    promptGate,
    promptGateFor,
    onCreate,
    syntheticGate,
    fail,
    omitAgent = false,
    sessionAgent = "build",
    sessionMode,
    sessionPlanPaused = false,
    switchAgentNoop = false,
    toolHookFails = false,
    sessionDirectory = "/tmp/session-cwd",
    pluginLocation = "/tmp/vibe-cwd",
    sessionWorkspaceID,
    sessionModel = { id: "session-model", providerID: "session-provider" },
    agentModels = { "vibe-good": { id: "good-model", providerID: "test-provider" } },
    suppressDeliveryEvent = false,
    hidePromptMessage = false,
    finishAssistant = true,
    assistantModel = "session",
    failVibeTurnSyntheticOnce = false,
    acceptVibeTurnSyntheticThenThrowOnce = false,
    beforeSyntheticReturn,
  } = options;
  const bus = makeBus();
  const tag = Math.random().toString(36).slice(2, 9);
  const sessions = new Map();
  const calls = {
    switchAgent: [],
    prompt: [],
    create: [],
    interrupt: [],
    update: [],
    synthetic: [],
    syntheticDone: [],
    finish: [],
    wait: [],
  };
  const handlers = new Map();
  const toolMap = new Map();
  const toolHooks = new Map();
  const hooks = new Map();
  const rpcState = { definition: undefined, handlers: undefined, events: [], disposed: 0 };
  const callWaiters = new Set();
  const manualFinishes = new Map();
  const idleSessions = new Set(["ses_director"]);
  const waiters = new Map();
  let vibeTurnSyntheticFailed = false;
  let vibeTurnSyntheticAcceptedThenThrow = false;
  let emitAssistant = finishAssistant;

  const addSession = (id, extra = {}) => {
    const location = { directory: sessionDirectory };
    if (sessionWorkspaceID !== undefined) location.workspaceID = sessionWorkspaceID;
    const session = {
      id,
      agent: omitAgent ? undefined : sessionAgent,
      mode: sessionMode,
      planPaused: sessionPlanPaused,
      model: sessionModel,
      location,
      messages: [],
      ...extra,
    };
    sessions.set(id, session);
    if (!extra.running) idleSessions.add(id);
    return session;
  };
  const director = addSession("ses_director");

  const notifyCall = (name) => {
    for (const waiter of [...callWaiters]) {
      if (waiter.name !== name || !waiter.predicate(calls[name])) continue;
      clearTimeout(waiter.timer);
      callWaiters.delete(waiter);
      waiter.resolve();
    }
  };
  const waitForCall = (name, predicate, label, timeoutMs = 2_000) => {
    if (predicate(calls[name])) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { name, predicate, resolve };
      waiter.timer = setTimeout(() => {
        callWaiters.delete(waiter);
        reject(new Error(`не дождался: ${label}`));
      }, timeoutMs);
      callWaiters.add(waiter);
    });
  };
  const shouldFail = (name, sessionID) => {
    try {
      return fail?.(name, sessionID, calls) === true;
    } catch (error) {
      throw error;
    }
  };
  const markIdle = (sessionID) => {
    idleSessions.add(sessionID);
    for (const waiter of [...(waiters.get(sessionID) ?? [])]) waiter.resolve(undefined);
    waiters.delete(sessionID);
  };

  const finishTurn = (sessionID, text = "finished", toolCount = 2) => {
    const session = sessions.get(sessionID);
    if (!session) throw new Error(`unknown test session ${sessionID}`);
    const tools = Array.from({ length: toolCount }, (_, index) => ({ type: "tool", name: `tool-${index}` }));
    const model = assistantModel === "session" ? session.model : assistantModel;
    if (emitAssistant) {
      session.messages.push({
        id: `a${session.messages.length}`,
        type: "assistant",
        ...(model ? { model } : {}),
        content: [...tools, { type: "text", text: `сделал: ${text}` }],
      });
    }
    if (finishMode !== "event") {
      session.messages.push({ id: `i${session.messages.length}`, type: "idle", outcome: "succeeded" });
    }
    idleSessions.add(sessionID);
    for (const waiter of [...(waiters.get(sessionID) ?? [])]) waiter.resolve(undefined);
    waiters.delete(sessionID);
    bus.push({
      type: "session.execution.succeeded",
      data: { sessionID, reason: "test-terminal" },
    });
    calls.finish.push({ sessionID, text, toolCount });
    notifyCall("finish");
  };

  const runTurn = (session, text, messageID) => {
    const promptID = messageID ?? `msg_test_${session.messages.length}`;
    if (!hidePromptMessage) session.messages.push({ id: promptID, type: "user", text });
    idleSessions.delete(session.id);
    if (!suppressDeliveryEvent) {
      bus.push({
        type: "session.inbox.delivered",
        data: { sessionID: session.id, inboxID: promptID },
      });
    }
    bus.push({ type: "session.execution.started", data: { sessionID: session.id } });
    if (!autoFinish) {
      manualFinishes.set(session.id, text);
      return;
    }
    finishTurn(session.id, text);
  };

  const session = {
    hook: async (event, handler) => {
      hooks.set(event, handler);
    },
    create: async (input) => {
      calls.create.push({ ...input });
      notifyCall("create");
      await onCreate?.(input, calls);
      if (createGate) await createGate;
      const id = `ses_${tag}_worker_${sessions.size}`;
      addSession(id, { agent: input.agent, model: input.model ?? sessionModel, title: input.title });
      return { data: { id, agent: input.agent, model: input.model ?? sessionModel, title: input.title } };
    },
    get: async ({ sessionID }) => {
      const value = sessions.get(sessionID) ?? addSession(sessionID);
      return { data: { id: value.id, agent: value.agent, mode: value.mode, planPaused: value.planPaused, model: value.model, location: value.location } };
    },
    active: async () => ({
      data: Object.fromEntries(
        [...sessions]
          .filter(([, value]) => value.agent === "vibe-director" || !idleSessions.has(value.id))
          .map(([id, value]) => [id, { id: value.id }]),
      ),
    }),
    context: async ({ sessionID }) => ({ data: sessions.get(sessionID)?.messages ?? [] }),
    prompt: async ({ sessionID, id, text, delivery }) => {
      calls.prompt.push({ sessionID, id, text, delivery });
      notifyCall("prompt");
      const selectedGate = promptGateFor?.(text, delivery, id);
      if (selectedGate) await selectedGate;
      else if (promptGate) await promptGate;
      if (shouldFail("prompt", sessionID)) throw new Error("prompt rejected");
      if (delivery === "steer" && rejectSteer) {
        throw Object.assign(new Error("steer недоступен"), { status: 422 });
      }
      if (delivery === "steer" && steerThrowsWithoutReceipt) throw new Error("network reset after steer send");
      if (delivery === "steer" && steerThrowsAfterAccept) {
        const current = sessions.get(sessionID);
        current?.messages.push({ id: id ?? `msg_steer_${current.messages.length}`, type: "user", text });
        throw new Error("steer receipt lost");
      }
      if (delivery !== "steer" && rejectTurn) throw new Error("prompt rejected");
      const current = sessions.get(sessionID);
      if (current && delivery !== "steer") runTurn(current, text, id);
      return { data: { ok: true } };
    },
    synthetic: async ({ sessionID, id, text, resume }) => {
      calls.synthetic.push({ sessionID, id, text, resume });
      notifyCall("synthetic");
      if (syntheticGate && text.includes("<vibe-turn")) await syntheticGate;
      if (failVibeTurnSyntheticOnce && text.includes("<vibe-turn") && !vibeTurnSyntheticFailed) {
        vibeTurnSyntheticFailed = true;
        throw new Error("synthetic transient failure");
      }
      if (shouldFail("synthetic", sessionID)) throw new Error("synthetic rejected");
      const current = sessions.get(sessionID);
      if (current && id && current.messages.some((message) => message.type === "synthetic" && message.id === id)) {
        calls.syntheticDone.push({ sessionID, id, text, resume });
        notifyCall("syntheticDone");
        return { data: { ok: true } };
      }
      if (current) current.messages.push({ id: id ?? `syn${current.messages.length}`, type: "synthetic", text });
      if (beforeSyntheticReturn) await beforeSyntheticReturn({ sessionID, id, text, resume });
      if (acceptVibeTurnSyntheticThenThrowOnce && text.includes("<vibe-turn") && !vibeTurnSyntheticAcceptedThenThrow) {
        vibeTurnSyntheticAcceptedThenThrow = true;
        throw new Error("synthetic receipt lost after admission");
      }
      calls.syntheticDone.push({ sessionID, id, text, resume });
      notifyCall("syntheticDone");
      return { data: { ok: true } };
    },
    interrupt: async ({ sessionID }) => {
      calls.interrupt.push(sessionID);
      notifyCall("interrupt");
      if (shouldFail("interrupt", sessionID)) throw new Error(`interrupt ${sessionID} failed`);
      if (!interruptReturnsOnly) markIdle(sessionID);
      return { data: { ok: true } };
    },
    update: async ({ sessionID, title }) => {
      calls.update.push({ sessionID, title });
      notifyCall("update");
      if (shouldFail("update", sessionID)) throw new Error(`update ${sessionID} failed`);
      return { data: { ok: true } };
    },
    switchAgent: async ({ sessionID, agent }) => {
      calls.switchAgent.push({ sessionID, agent });
      notifyCall("switchAgent");
      if (shouldFail("switchAgent", sessionID)) throw new Error(`switchAgent ${sessionID} failed`);
      const current = sessions.get(sessionID);
      if (current && !switchAgentNoop) current.agent = agent;
      return { data: { ok: true } };
    },
    wait: async ({ sessionID }) => {
      calls.wait.push({ sessionID });
      notifyCall("wait");
      if (failWait) throw new Error("session.wait unavailable");
      const unavailable = waitError?.(sessionID, calls);
      if (unavailable) throw unavailable;
      if (idleSessions.has(sessionID)) return undefined;
      const waiter = deferred();
      waiters.set(sessionID, [...(waiters.get(sessionID) ?? []), waiter]);
      return await waiter.promise;
    },
  };

  const knownAgents = new Set(agentsMissing ? [] : ["vibe-director", "vibe-fast", "vibe-good"]);
  const ctx = {
    session,
    agent: {
      get: async ({ agentID }) => {
        if (!knownAgents.has(agentID)) return { data: undefined };
        const model = agentModels[agentID];
        return { data: model ? { id: agentID, model } : { id: agentID } };
      },
    },
    tool: {
      transform: (callback) => callback({ add: (definition) => toolMap.set(definition.name, definition) }),
      hook: async (event, handler) => {
        if (toolHookFails) throw new Error("tool hook unavailable");
        toolHooks.set(event, handler);
      },
    },
    command: { transform: (callback) => callback({ add: (definition) => handlers.set(definition.name, definition) }) },
    location: { directory: pluginLocation },
    event: { subscribe: () => bus.subscribe() },
    rpc: {
      register: async (definition, handlers) => {
        rpcState.definition = definition;
        rpcState.handlers = handlers;
        return {
          events: {
            emit: async (name, data) => {
              rpcState.events.push({ name, data });
            },
          },
          dispose: async () => {
            rpcState.disposed += 1;
          },
        };
      },
    },
  };
  return {
    ctx,
    calls,
    handlers,
    tools: toolMap,
    toolHooks,
    hooks,
    rpc: rpcState,
    sessions,
    director,
    bus,
    waitForCall,
    confirmIdle: (sessionID) => markIdle(sessionID),
    hasManualTurn: (sessionID) => manualFinishes.has(sessionID),
    setFinishAssistant: (value) => { emitAssistant = value; },
    finishTurn: (sessionID, text, toolCount) => finishTurn(sessionID, text, toolCount),
    finishWithTools: (sessionID, toolCount, text = "trace") => finishTurn(sessionID, text, toolCount),
    finishNext: (sessionID) => {
      const text = manualFinishes.get(sessionID);
      if (text === undefined) throw new Error(`no manual turn for ${sessionID}`);
      manualFinishes.delete(sessionID);
      finishTurn(sessionID, text);
    },
  };
}

const runCommand = async (stand, text, sessionID = "ses_director") => {
  await stand.handlers.get("vibe").execute({ sessionID, prompt: { text } });
};
const runTool = async (stand, name, args, sessionID = "ses_director") =>
  stand.tools.get(name).execute(args, { sessionID });
const textOfTool = (result) => result?.content?.[0]?.text ?? "";
const textOfCall = (call) => call?.text ?? textOfTool(call);
const enable = async (stand, sessionID) => {
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
};
const disable = async (stand, sessionID) => {
  await runCommand(stand, "off", sessionID);
};

// 0. Recovery is retryable: a successful restart cleanup removes the state.
{
  const sessionID = "ses_recover";
  clearState(sessionID);
  writeFileSync(
    stateFile(sessionID),
    JSON.stringify({
      sessionID,
      cwd: "/tmp/vibe-cwd",
      enabled: true,
      previousAgent: "build",
      workers: [
        {
          id: "ses_recover_worker",
          cli: "fast",
          title: "vibe:fast#1 recover",
          model: "fast-provider/fast-model",
          state: "running",
          turns: 1,
          queued: [],
          startedAt: Date.now(),
        },
      ],
      startedAt: Date.now(),
      turnsDelivered: 0,
    }),
  );
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await stand.bus.waitForSubscribers(1);
  await stand.bus.closeCurrent();
  ok(
    "restart: незакрытый vibe-state свернут и прошлый агент возвращён",
    stateOf(sessionID) === undefined &&
      stand.calls.interrupt.includes(sessionID) &&
      stand.calls.interrupt.includes("ses_recover_worker") &&
      stand.calls.switchAgent.at(-1)?.agent === "build",
    `state=${Boolean(stateOf(sessionID))} interrupts=${stand.calls.interrupt.join(",")}`,
  );
}

// 1. Entry, public location contract, and core roster operations.
{
  const sessionID = "ses_core";
  clearState(sessionID);
  const stand = makeStand({ sessionWorkspaceID: "workspace-from-parent" });
  await enable(stand, sessionID);
  const payload = { sessionID, system: [] };
  stand.hooks.get("context")(payload);
  const injected = payload.system.map((part) => part.text).join("\n");
  ok(
    "вход: режим и агент директора включены, roster инжектится",
    stateOf(sessionID)?.enabled === true &&
      stand.calls.switchAgent.at(-1)?.agent === "vibe-director" &&
      injected.includes("<vibe-roster>"),
    injected.slice(0, 80),
  );
  const fast = await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "механическая задача" }, sessionID);
  const good = await runTool(stand, "vibe_spawn", { cli: "good", prompt: "сложная задача" }, sessionID);
  const createdFast = stand.calls.create[0];
  const createdGood = stand.calls.create[1];
  ok(
    "spawn: public V2 location содержит только directory, без undocumented workspaceID",
    createdFast?.location?.directory === "/tmp/session-cwd" &&
      Object.keys(createdFast.location).join(",") === "directory" &&
      !Object.hasOwn(createdFast.location, "workspaceID") &&
      createdGood?.location?.directory === "/tmp/session-cwd" &&
      !Object.hasOwn(createdGood.location, "workspaceID") &&
      stateOf(sessionID)?.cwd === "/tmp/session-cwd",
    `location=${JSON.stringify(createdFast?.location)}`,
  );
  await stand.waitForCall("finish", (items) => items.length >= 2, "два worker-а не завершились");
  await stand.waitForCall(
    "synthetic",
    (items) => items.filter((item) => item.text.includes("<vibe-turn")).length >= 2,
    "self-delivery не пришла",
  );
  const workers = stateOf(sessionID).workers;
  ok(
    "spawn: fast/good создаются с native agent/model и результаты self-deliver",
    textOfTool(fast).includes("vibe-fast") === false &&
      textOfTool(good).includes("vibe-good") === false &&
      createdFast.agent === "vibe-fast" &&
      createdGood.agent === "vibe-good" &&
      workers.length === 2 &&
      stand.calls.synthetic.filter((item) => item.text.includes("<vibe-turn")).length === 2,
    `workers=${workers.length} deliveries=${stand.calls.synthetic.filter((item) => item.text.includes("<vibe-turn")).length} fast=${textOfTool(fast)} good=${textOfTool(good)} agents=${createdFast?.agent},${createdGood?.agent}`,
  );
  const workerID = workers[0].id;
  await runTool(stand, "vibe_send", { session: workerID, message: "продолжай" }, sessionID);
  ok(
    "send: idle worker starts a normal next turn",
    stand.calls.prompt.some((item) => item.sessionID === workerID && item.delivery === undefined),
    `prompts=${stand.calls.prompt.length}`,
  );
  const listed = await runTool(stand, "vibe_list", {}, sessionID);
  ok("list: roster contains both worker types", listed.content[0].text.includes("[fast]") && listed.content[0].text.includes("[good]"));
  const killed = await runTool(stand, "vibe_kill", { session: workerID }, sessionID);
  ok(
    "kill: worker is stopped and renamed",
    textOfTool(killed).includes("снят") &&
      stand.calls.update.some((item) => item.sessionID === workerID && item.title.includes("снят")),
    textOfTool(killed),
  );
  await runTool(stand, "vibe_todo", { op: "add", text: "пункт A" }, sessionID);
  const todo = await runTool(stand, "vibe_todo", { op: "list" }, sessionID);
  ok("todo: director progress is stored", todo.content[0].text.includes("пункт A"), todo.content[0].text);
  await disable(stand, sessionID);
  ok("выход: state удаляется только после успешного teardown", stateOf(sessionID) === undefined);
}

{
  const sessionID = "ses_todo_metadata";
  clearState(sessionID);
  const stand = makeStand();
  await enable(stand, sessionID);
  await runTool(stand, "vibe_todo", { op: "add", text: "build", phase: "implementation" }, sessionID);
  const firstTodo = stateOf(sessionID).todos[0];
  await runTool(stand, "vibe_todo", { op: "add", text: "verify", phase: "verification", blockedBy: [firstTodo.id] }, sessionID);
  const metadataList = await runTool(stand, "vibe_todo", { op: "list" }, sessionID);
  const metadataState = stateOf(sessionID);
  ok(
    "todo: phase and stable blockedBy IDs survive list projection",
    firstTodo.id === "todo-1" &&
      metadataState.todos[1]?.phase === "verification" &&
      JSON.stringify(metadataState.todos[1]?.blockedBy) === JSON.stringify([firstTodo.id]) &&
      metadataList.content[0].text.includes("implementation") &&
      metadataList.content[0].text.includes("verification"),
    `state=${JSON.stringify(metadataState.todos)} result=${metadataList.content[0].text}`,
  );

  const invalidTodo = await runTool(stand, "vibe_todo", { op: "add", text: "bad", blockedBy: [0] }, sessionID);
  ok(
    "todo: blockedBy rejects indexes instead of guessing",
    textOfTool(invalidTodo).includes("blockedBy") && stateOf(sessionID).todos.length === 2,
    textOfTool(invalidTodo),
  );

  const legacyState = stateOf(sessionID);
  legacyState.todos = [{ text: "legacy", done: false }];
  writeFileSync(stateFile(sessionID), JSON.stringify(legacyState));
  const legacyList = await runTool(stand, "vibe_todo", { op: "list" }, sessionID);
  ok(
    "todo: legacy flat state remains readable with a projected stable legacy ID",
    textOfTool(legacyList).includes("legacy") &&
      textOfTool(legacyList).includes("id=legacy-1") &&
      stateOf(sessionID).todos[0]?.id === undefined,
    `result=${textOfTool(legacyList)} state=${JSON.stringify(stateOf(sessionID).todos)}`,
  );
  clearState(sessionID);
}

// Basic entry guards remain covered alongside the parity regressions.
{
  const sessionID = "ses_missing_agents";
  clearState(sessionID);
  const stand = makeStand({ agentsMissing: true });
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  ok(
    "вход без native agent files отклонён",
    stateOf(sessionID) === undefined && textOfCall(stand.calls.synthetic.at(-1)).includes("агентов режима нет"),
    textOfCall(stand.calls.synthetic.at(-1)),
  );
}
{
  const sessionID = "ses_plan_agent";
  clearState(sessionID);
  const stand = makeStand({ sessionAgent: "plan" });
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  ok("plan agent нельзя переключить в vibe-director", stateOf(sessionID) === undefined && textOfCall(stand.calls.synthetic.at(-1)).includes("plan"));
}
{
  const sessionID = "ses_plan_paused";
  clearState(sessionID);
  const stand = makeStand({ sessionMode: "plan_paused" });
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  ok(
    "plan_paused signal blocks vibe",
    stateOf(sessionID) === undefined && textOfCall(stand.calls.synthetic.at(-1)).includes("plan"),
    textOfCall(stand.calls.synthetic.at(-1)),
  );
}
{
  const sessionID = "ses_outside_tools";
  clearState(sessionID);
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  const result = await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "outside" }, sessionID);
  ok("vibe tools вне режима отказывают", textOfTool(result).startsWith("Ошибка:"), textOfTool(result));
}
{
  const sessionID = "ses_switch_role_unconfirmed";
  clearState(sessionID);
  const stand = makeStand({ switchAgentNoop: true });
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  const response = textOfCall(stand.calls.synthetic.at(-1));
  ok(
    "activation: switchAgent without authoritative role confirmation is rejected",
    stateOf(sessionID) === undefined && response.toLowerCase().includes("роль") && response.toLowerCase().includes("подтверж"),
    `response=${response}`,
  );
}
{
  const sessionID = "ses_guard_registration_failure";
  clearState(sessionID);
  const stand = makeStand({ toolHookFails: true });
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  const response = textOfCall(stand.calls.synthetic.at(-1));
  ok(
    "activation: unavailable tool guard blocks protected mode",
    stateOf(sessionID) === undefined && response.toLowerCase().includes("guard") && stand.calls.switchAgent.length === 0,
    `response=${response}`,
  );
}

// 2. Parallel spawn admission: fresh commit, cap, and no orphan on lost commit.
{
  const sessionID = "ses_parallel";
  clearState(sessionID);
  const gate = deferred();
  let firstCreate;
  let mergeWritten = false;
  const firstEntered = new Promise((resolve) => { firstCreate = resolve; });
  const stand = makeStand({
    createGate: gate.promise,
    onCreate: async () => {
      if (!mergeWritten) {
        const current = stateOf(sessionID);
        current.todos = [{ text: "fresh merge", done: false }];
        writeFileSync(stateFile(sessionID), JSON.stringify(current));
        mergeWritten = true;
      }
      firstCreate();
    },
  });
  await enable(stand, sessionID);
  const first = runTool(stand, "vibe_spawn", { cli: "fast", prompt: "parallel one" }, sessionID);
  const second = runTool(stand, "vibe_spawn", { cli: "good", prompt: "parallel two" }, sessionID);
  await firstEntered;
  gate.resolve();
  const results = await Promise.all([first, second]);
  const workers = stateOf(sessionID).workers;
  ok(
    "parallel spawn: both admissions commit against fresh state",
    results.every((item) => textOfTool(item).includes("запущен")) &&
      workers.length === 2 &&
      stateOf(sessionID)?.todos?.[0]?.text === "fresh merge",
    `workers=${workers.length} todos=${JSON.stringify(stateOf(sessionID)?.todos)}`,
  );
  await disable(stand, sessionID);
}
{
  const sessionID = "ses_parallel_cap";
  clearState(sessionID);
  process.env.VIBE_MAX_WORKERS = "1";
  const gate = deferred();
  let firstCreate;
  const firstEntered = new Promise((resolve) => { firstCreate = resolve; });
  const stand = makeStand({
    createGate: gate.promise,
    onCreate: async () => firstCreate(),
  });
  await enable(stand, sessionID);
  const first = runTool(stand, "vibe_spawn", { cli: "fast", prompt: "one" }, sessionID);
  const second = runTool(stand, "vibe_spawn", { cli: "good", prompt: "two" }, sessionID);
  await firstEntered;
  gate.resolve();
  const results = await Promise.all([first, second]);
  ok(
    "parallel spawn: cap is checked before create and rejects the second admission",
    results.filter((item) => textOfTool(item).includes("запущен")).length === 1 &&
      results.filter((item) => textOfTool(item).includes("потолок")).length === 1 &&
      stand.calls.create.length === 1,
    `creates=${stand.calls.create.length} results=${results.map(textOfTool).join(" | ")}`,
  );
  delete process.env.VIBE_MAX_WORKERS;
  await disable(stand, sessionID);
}
{
  const sessionID = "ses_lost_commit";
  clearState(sessionID);
  const stand = makeStand({
    onCreate: async () => {
      const current = stateOf(sessionID);
      current.enabled = false;
      writeFileSync(stateFile(sessionID), JSON.stringify(current));
    },
  });
  await enable(stand, sessionID);
  const result = await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "must be cleaned" }, sessionID);
  const state = stateOf(sessionID);
  ok(
    "spawn: a commit that loses the director state is cleaned up, not orphaned",
    textOfTool(result).includes("не зачислен") && state?.enabled === false && stand.calls.interrupt.length === 1 && stand.calls.update.length === 1,
    `result=${textOfTool(result)} interrupts=${stand.calls.interrupt.join(",")}`,
  );
  clearState(sessionID);
}

// 3. Wait snapshots the exact job/turn; rejected steers join into one follow-up.
{
  const sessionID = "ses_wait_turn";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event", rejectSteer: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "first" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  await runTool(stand, "vibe_send", { session: workerID, message: "queued one" }, sessionID);
  await runTool(stand, "vibe_send", { session: workerID, message: "queued two" }, sessionID);
  const waitPromise = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  stand.finishNext(workerID);
  const waited = await waitPromise;
  await stand.waitForCall("prompt", (items) => items.filter((item) => item.delivery === undefined).length >= 2, "queued follow-up не стартовал");
  const queued = stand.calls.prompt.find((item) => item.text === "queued one\n\nqueued two");
  ok(
    "wait: rejected steers are one queued turn and wait returns the first full job",
    textOfTool(waited).includes('turn="1"') &&
      textOfTool(waited).includes("сделал: first") &&
      !textOfTool(waited).includes("сделал: queued") &&
      textOfTool(waited).includes('tool-calls="2"') &&
      textOfTool(waited).includes('model="fast-provider/fast-model"') &&
      Boolean(queued) &&
      stand.calls.synthetic.filter((item) => item.text.includes("<vibe-turn")).length === 0,
    `wait=${textOfTool(waited).slice(0, 180)} prompt=${JSON.stringify(queued)} state=${JSON.stringify(stateOf(sessionID))} sessions=${JSON.stringify([...stand.sessions.keys()])}`,
  );
  stand.finishNext(workerID);
  await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  const duplicateWait = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  ok("wait: успешно прочитанный job не выдаётся повторно", textOfTool(duplicateWait).includes("Нет ходов"), textOfTool(duplicateWait));
  clearState(sessionID);
}

// 3a. Exact 19846 has no ToolContext cancellation field; timeout must say so.
{
  const sessionID = "ses_wait_capability";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "capability wait" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const jobID = stateOf(sessionID).workers[0].currentJob.id;
  const result = await stand.tools.get("vibe_wait").execute(
    { sessions: [workerID], timeout: 0.01 },
    { sessionID },
  );
  const current = stateOf(sessionID).workers[0].currentJob;
  ok(
    "capability 19846: cancellation is reported unsupported and job stays active",
    textOfTool(result).includes("Окно ожидания вышло") &&
      textOfTool(result).toLowerCase().includes("отмена ожидания не поддерживается") &&
      current?.id === jobID &&
      !current.claim,
    `result=${textOfTool(result)} current=${JSON.stringify(current)}`,
  );
  stand.finishNext(workerID);
  await stand.waitForCall("syntheticDone", (items) => items.length >= 1, "capability wait observer did not settle");
  clearState(sessionID);
}
{
  const source = readFileSync(new URL("../plugin/opencode/vibe.ts", import.meta.url), "utf8");
  ok(
    "capability 19846: station has no unsupported toolCtx abort/signal path",
    !source.includes("toolCtx.abort") && !source.includes("waitForAbort"),
    "source must use only exact installed ToolContext",
  );
}

// 3b. Corrupt station state is not treated as absent and overwritten.
{
  const sessionID = "ses_corrupt_state";
  const corrupt = "{ definitely-not-json";
  writeFileSync(stateFile(sessionID), corrupt);
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  const raw = readFileSync(stateFile(sessionID), "utf8");
  ok(
    "state: corrupt JSON blocks enable and is preserved",
    textOfCall(stand.calls.synthetic.at(-1)).toLowerCase().includes("поврежд") &&
      raw === corrupt &&
      stand.calls.switchAgent.length === 0,
    `raw=${raw} response=${textOfCall(stand.calls.synthetic.at(-1))}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_corrupt_off";
  const corrupt = "{ off-corrupt";
  writeFileSync(stateFile(sessionID), corrupt);
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "off", sessionID);
  const response = textOfCall(stand.calls.synthetic.at(-1));
  ok(
    "state: corrupt state blocks /vibe off and is preserved",
    response.toLowerCase().includes("поврежд") && readFileSync(stateFile(sessionID), "utf8") === corrupt,
    `response=${response}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_corrupt_active_guard";
  clearState(sessionID);
  const stand = makeStand();
  await enable(stand, sessionID);
  writeFileSync(stateFile(sessionID), "{ active-corrupt");
  const guard = stand.toolHooks.get("execute.before");
  let denied = false;
  try {
    await guard?.({ sessionID, agent: "vibe-director", tool: "write" });
  } catch {
    denied = true;
  }
  ok("state: corrupt active state blocks unsafe tools", denied, `denied=${denied}`);
  clearState(sessionID);
}

// 3c. Valid JSON with an invalid station shape is also corrupt.
{
  const sessionID = "ses_invalid_state_shape";
  const invalid = JSON.stringify({ sessionID, cwd: "/tmp/session-cwd", enabled: true, workers: null, startedAt: Date.now(), turnsDelivered: 0 });
  writeFileSync(stateFile(sessionID), invalid);
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  ok(
    "state: invalid shape blocks enable and is preserved",
    textOfCall(stand.calls.synthetic.at(-1)).toLowerCase().includes("поврежд") &&
      readFileSync(stateFile(sessionID), "utf8") === invalid &&
      stand.calls.switchAgent.length === 0,
    `response=${textOfCall(stand.calls.synthetic.at(-1))}`,
  );
  clearState(sessionID);
}

{
  const sessionID = "ses_invalid_worker_shape";
  clearState(sessionID);
  const invalid = JSON.stringify({
    sessionID,
    cwd: "/tmp/session-cwd",
    enabled: true,
    workers: [{ cli: "fast" }],
    startedAt: Date.now(),
    turnsDelivered: 0,
  });
  writeFileSync(stateFile(sessionID), invalid);
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  const listed = await runTool(stand, "vibe_list", {}, sessionID);
  ok(
    "state: malformed worker record blocks enable and status explains corruption",
    textOfCall(stand.calls.synthetic.at(-1)).toLowerCase().includes("повреж") &&
      textOfTool(listed).toLowerCase().includes("повреж") &&
      readFileSync(stateFile(sessionID), "utf8") === invalid,
    `enable=${textOfCall(stand.calls.synthetic.at(-1))} list=${textOfTool(listed)}`,
  );
  clearState(sessionID);
}

{
  const sessionID = "ses_invalid_job_shape";
  clearState(sessionID);
  const invalid = JSON.stringify({
    sessionID,
    cwd: "/tmp/session-cwd",
    enabled: true,
    workers: [{
      id: `${sessionID}_worker`,
      cli: "fast",
      title: "vibe:fast#1",
      state: "idle",
      turns: 1,
      queued: [],
      startedAt: Date.now(),
      lastJob: { id: "broken-job" },
    }],
    startedAt: Date.now(),
    turnsDelivered: 0,
  });
  writeFileSync(stateFile(sessionID), invalid);
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "status", sessionID);
  const listed = await runTool(stand, "vibe_list", {}, sessionID);
  ok(
    "state: malformed job record blocks status and explains corruption",
    textOfCall(stand.calls.synthetic.at(-1)).toLowerCase().includes("повреж") &&
      textOfTool(listed).toLowerCase().includes("повреж") &&
      readFileSync(stateFile(sessionID), "utf8") === invalid,
    `status=${textOfCall(stand.calls.synthetic.at(-1))} list=${textOfTool(listed)}`,
  );
  clearState(sessionID);
}

// 4. A wait after synthetic has started cannot claim the same delivery again.
{
  const sessionID = "ses_delayed_synthetic";
  clearState(sessionID);
  const syntheticGate = deferred();
  const stand = makeStand({ syntheticGate: syntheticGate.promise });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "delayed delivery" }, sessionID);
  await stand.waitForCall("synthetic", (items) => items.some((item) => item.text.includes("<vibe-turn")), "synthetic не начался");
  const waited = await runTool(stand, "vibe_wait", { sessions: [stateOf(sessionID).workers[0].id], timeout: 1 }, sessionID);
  ok(
    "delivery: wait after synthetic start does not duplicate the result",
    textOfTool(waited).includes("Нет ходов") && stand.calls.synthetic.filter((item) => item.text.includes("<vibe-turn")).length === 1,
    textOfTool(waited),
  );
  syntheticGate.resolve();
  await stand.waitForCall("syntheticDone", (items) => items.length >= 1, "delayed synthetic не завершился");
  clearState(sessionID);
}

// 4a. Context presence without exact inbox delivery is not completion.
{
  const sessionID = "ses_exact_delivery";
  clearState(sessionID);
  process.env.VIBE_TURN_TIMEOUT_MS = "1";
  const stand = makeStand({ autoFinish: false, finishMode: "event", suppressDeliveryEvent: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "exact delivery" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const waitPromise = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  stand.finishNext(workerID);
  const waited = await waitPromise;
  ok(
    "job identity: context without inbox.delivered remains retryable",
    /не подтвердил доставку|retryable|повтори/i.test(textOfTool(waited)),
    textOfTool(waited).slice(0, 220),
  );
  delete process.env.VIBE_TURN_TIMEOUT_MS;
  clearState(sessionID);
}

// 4a-1. A delivery event that wakes the observer must be rechecked before cursor advancement.
{
  const sessionID = "ses_delivery_after_wait_wake";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event", suppressDeliveryEvent: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "delivery after wait wake" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const messageID = stateOf(sessionID).workers[0].currentJob.messageID;
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  stand.bus.push({ type: "session.execution.started", data: { sessionID: workerID } });
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  stand.bus.push({ type: "session.inbox.delivered", data: { sessionID: workerID, inboxID: messageID } });
  stand.finishTurn(workerID, "RACE_READY", 0);
  const waited = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  ok(
    "job identity: delivery arriving after an event wake is not skipped",
    textOfTool(waited).includes("RACE_READY") && stateOf(sessionID)?.workers[0]?.currentJob === undefined,
    `result=${textOfTool(waited).slice(0, 240)} state=${JSON.stringify(stateOf(sessionID)?.workers[0]?.currentJob)}`,
  );
  clearState(sessionID);
}

// 4a-2. The text wall projects durable state without owning jobs.
{
  const sessionID = "ses_text_wall_projection";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "wall projection" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const active = await runTool(stand, "vibe_list", {}, sessionID);
  ok(
    "presentation: active wall shows durable job axes",
    textOfTool(active).includes("activeJob=true") &&
      (textOfTool(active).includes("job starting") || textOfTool(active).includes("job running")) &&
      textOfTool(active).includes("resultReady=false") &&
      textOfTool(active).includes("unreadResult=false"),
    textOfTool(active),
  );
  stand.finishNext(workerID);
  await until(() => {
    const worker = stateOf(sessionID)?.workers[0];
    return worker?.currentJob === undefined && worker?.lastJob?.phase === "settled";
  }, "wall projection worker did not settle");
  const ready = await runTool(stand, "vibe_list", {}, sessionID);
  ok(
    "presentation: settled wall separates result readiness from delivery",
    textOfTool(ready).includes("activeJob=false") &&
      textOfTool(ready).includes("resultReady=true") &&
      textOfTool(ready).includes("unreadResult=true") &&
      textOfTool(ready).includes("lastDuration="),
    textOfTool(ready),
  );
  clearState(sessionID);
}

// 4a-3. /vibe wall is a read-only alias, not a mode toggle.
{
  const sessionID = "ses_text_wall_alias";
  clearState(sessionID);
  const stand = makeStand();
  await enable(stand, sessionID);
  await runCommand(stand, "wall", sessionID);
  const response = textOfCall(stand.calls.synthetic.at(-1));
  ok(
    "presentation: /vibe wall returns a snapshot",
    response.includes("read/delivered=0") && stateOf(sessionID)?.enabled === true,
    response,
  );
  clearState(sessionID);
}

{
  const definition = rpcModule?.VibeWallDefinition;
  ok(
    "presentation: RPC wall contract is read-only and has changed event",
    definition?.id === "vibe-wall" &&
      typeof definition?.methods?.snapshot?.input === "object" &&
      definition?.methods?.snapshot?.input?.properties?.sessionID?.type === "string" &&
      definition?.methods?.snapshot?.input?.required?.includes("sessionID") === true &&
      typeof definition?.methods?.snapshot?.output === "object" &&
      typeof definition?.events?.changed?.schema === "object",
    String(definition),
  );
}

{
  const sessionID = "ses_rpc_snapshot";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  const snapshot = stand.rpc.handlers?.snapshot ? await stand.rpc.handlers.snapshot({ sessionID }) : undefined;
  ok(
    "presentation: server RPC returns a validated wall snapshot",
    snapshot?.state === "ok" && snapshot?.text?.startsWith("VIBE ON · workers 0"),
    String(snapshot),
  );
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "rpc event" }, sessionID);
  await until(() => stand.rpc.events.some((event) => event.name === "changed" && event.data?.sessionID === sessionID), "RPC wall did not emit changed");
  ok("presentation: server RPC emits after durable state write", true);
  const beforeExecutionEvent = stand.rpc.events.length;
  stand.bus.push({ type: "session.execution.started", data: { sessionID: stateOf(sessionID).workers[0].id } });
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  ok(
    "presentation: server RPC emits after native execution event",
    stand.rpc.events.length > beforeExecutionEvent,
    `events=${stand.rpc.events.length} before=${beforeExecutionEvent}`,
  );
  clearState(sessionID);
}

{
  const sessionID = "ses_rpc_event_only";
  clearState(sessionID);
  const stand = makeStand();
  await enable(stand, sessionID);
  const state = stateOf(sessionID);
  state.workers = [{
    id: "ses_event_only_worker",
    cli: "fast",
    readOnly: false,
    title: "vibe:fast#1 event-only",
    model: "fast-provider/fast-model",
    modelRole: "fast",
    modelSource: "env",
    generation: 1,
    state: "idle",
    turns: 0,
    queued: [],
    startedAt: Date.now(),
  }];
  writeFileSync(stateFile(sessionID), JSON.stringify(state));
  stand.sessions.set("ses_event_only_worker", {
    id: "ses_event_only_worker",
    agent: "vibe-fast",
    model: { providerID: "fast-provider", id: "fast-model" },
    location: { directory: stand.director.location.directory },
    messages: [],
  });
  await stand.bus.waitForSubscribers(1);
  const before = stand.rpc.events.length;
  stand.bus.push({ type: "session.execution.started", data: { sessionID: "ses_event_only_worker" } });
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  ok(
    "presentation: execution event publishes wall revision without an observer",
    stand.rpc.events.length > before,
    `events=${stand.rpc.events.length} before=${before}`,
  );
  clearState(sessionID);
}

{
  const tokenStand = makeStand({ autoFinish: false, finishMode: "event", finishAssistant: false });
  const sessionID = "ses_rpc_token_rate";
  clearState(sessionID);
  await enable(tokenStand, sessionID);
  await runTool(tokenStand, "vibe_spawn", { cli: "fast", prompt: "token rate" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  tokenStand.sessions.get(workerID).messages.push({
    id: "assistant_tokens",
    type: "assistant",
    time: { created: 1000, completed: 1100 },
    model: { id: "session-model", providerID: "session-provider" },
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: "text", text: "done" }],
  });
  tokenStand.finishTurn(workerID, "token rate");
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.phase === "settled", "token rate worker did not settle");
  const tokenSnapshot = tokenStand.rpc.handlers?.snapshot ? await tokenStand.rpc.handlers.snapshot({ sessionID }) : undefined;
  ok(
    "presentation: wall derives token rate from native assistant usage",
    tokenSnapshot?.workers?.[0]?.tokensPerSecond === 200 &&
      tokenSnapshot.workers[0].outputTail.includes("done"),
    String(tokenSnapshot),
  );
  clearState(sessionID);
}

{
  const parsed = wallModule?.parseWallSnapshot?.({ state: "ok", sessionID: "ses_rpc_view", revision: 2, text: "VIBE ON" }, "ses_rpc_view");
  ok("presentation: TUI validates RPC snapshot identity", parsed?.revision === 2 && parsed?.text === "VIBE ON", String(parsed));
}

{
  const structured = wallModule?.parseWallSnapshot?.({
    state: "ok",
    sessionID: "ses_rpc_workers",
    revision: 3,
    text: "VIBE ON",
    workers: [{
      id: "ses_worker",
      cli: "good",
      state: "idle",
      readOnly: true,
      model: "opencode-go/space-bunny-free",
      turns: 2,
      queued: 0,
      trace: ["read"],
      outputTail: [],
      accessState: "audit",
    }],
  }, "ses_rpc_workers");
  ok(
    "presentation: TUI parses structured worker wall entries",
    structured?.workers?.[0]?.id === "ses_worker" && structured.workers[0].accessState === "audit",
    String(structured),
  );
  const malformed = wallModule?.parseWallSnapshot?.({
    state: "ok",
    sessionID: "ses_rpc_bad",
    revision: 1,
    text: "VIBE ON",
    workers: [{ id: 7 }],
  }, "ses_rpc_bad");
  ok("presentation: TUI rejects malformed worker wall entries", malformed === undefined, String(malformed));
}


{
  const sessionID = "ses_stale_assistant";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "idle" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "first result" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  stand.finishNext(workerID);
  await stand.waitForCall("syntheticDone", (items) => items.length >= 1, "first result did not deliver");
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "delivered", "first delivery acknowledgement");
  stand.setFinishAssistant(false);
  const sent = await runTool(stand, "vibe_send", { session: workerID, message: "second without assistant" }, sessionID);
  await until(() => stand.hasManualTurn(workerID), "second manual turn queued");
  const beforeWait = stateOf(sessionID);
  const waitPromise = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  stand.finishNext(workerID);
  await until(() => {
    const current = stateOf(sessionID)?.workers[0]?.currentJob;
    return current?.phase === "retryable" || current === undefined;
  }, "second observer settled");
  const waited = await waitPromise;
  ok(
    "job identity: stale assistant is not returned for a new idle",
    /ambiguous|retryable|не подтверждён/i.test(textOfTool(waited)),
    `sent=${textOfTool(sent)} before=${JSON.stringify(beforeWait)} result=${textOfTool(waited).slice(0, 220)}`,
  );
  clearState(sessionID);
}

// 4d. Full response remains readable after automatic synthetic delivery.
{
  const sessionID = "ses_full_after_delivery";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "full result" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  stand.finishWithTools(workerID, 0, "x".repeat(5000));
  await stand.waitForCall("syntheticDone", (items) => items.length >= 1, "full result delivery did not finish");
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "delivered", "full delivery acknowledgement");
  const full = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  const repeat = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  ok(
    "result: delivered full response is readable once",
    textOfTool(full).length > 4500 &&
      textOfTool(full).includes("сделал: " + "x".repeat(10)) &&
      textOfTool(repeat).includes("Нет ходов"),
    `full=${textOfTool(full).length} hasText=${textOfTool(full).includes("сделал: " + "x".repeat(10))} repeat=${textOfTool(repeat)}`,
  );
  clearState(sessionID);
}

// 5. Terminal event branch works without an idle message.
{
  const sessionID = "ses_terminal";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "good", prompt: "event only" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const waitPromise = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  stand.finishNext(workerID);
  const waited = await waitPromise;
  ok(
    "event: terminal execution event settles a turn without idle fallback",
    textOfTool(waited).includes("сделал: event only") &&
      textOfTool(waited).includes('status="succeeded"') &&
      textOfTool(waited).includes('duration="0с"') &&
      textOfTool(waited).includes("test-terminal"),
    textOfTool(waited).slice(0, 180),
  );
  clearState(sessionID);
}

// 6. Event subscription reconnects after its stream closes.
{
  const sessionID = "ses_reconnect";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await plugin.default.setup(stand.ctx);
  await stand.bus.waitForSubscribers(1);
  await stand.bus.closeCurrent();
  let reconnected = true;
  try {
    await stand.bus.waitForSubscribers(2);
  } catch {
    reconnected = false;
  }
  let terminalWorked = false;
  if (reconnected) {
    await runCommand(stand, "", sessionID);
    await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "after reconnect" }, sessionID);
    const workerID = stateOf(sessionID).workers[0].id;
    const waitPromise = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
    stand.finishNext(workerID);
    const waited = await waitPromise;
    terminalWorked = textOfTool(waited).includes("after reconnect");
  }
  ok("events: closed subscription is rebound без нового setup", reconnected && terminalWorked, `reconnected=${reconnected} terminal=${terminalWorked}`);
  clearState(sessionID);
}

// 7. Active loop is allowed; active and paused goals remain blocked.
{
  const sessionID = "ses_loop";
  clearState(sessionID);
  writeFileSync(join(MODES_STATE, "ses_loop.json"), JSON.stringify({ sessionID, kind: "loop", active: true }));
  const stand = makeStand();
  await enable(stand, sessionID);
  ok("modes: active loop does not block vibe", stateOf(sessionID)?.enabled === true && stand.calls.switchAgent.at(-1)?.agent === "vibe-director");
  await disable(stand, sessionID);
  rmSync(join(MODES_STATE, "ses_loop.json"), { force: true });
}
for (const [sessionID, kind, active, reason] of [
  ["ses_goal_active", "goal", true, undefined],
  ["ses_goal_paused", "goal", false, "пауза"],
]) {
  clearState(sessionID);
  writeFileSync(join(MODES_STATE, `${sessionID}.json`), JSON.stringify({ sessionID, kind, active, reason }));
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  ok(`${kind} ${active ? "active" : "paused"} блокирует vibe`, stateOf(sessionID) === undefined && textOfCall(stand.calls.synthetic.at(-1)).includes("режима цели"));
  clearState(sessionID);
  rmSync(join(MODES_STATE, `${sessionID}.json`), { force: true });
}

{
  const sessionID = "ses_nested_goal";
  clearState(sessionID);
  writeFileSync(
    join(MODES_STATE, `${sessionID}.json`),
    JSON.stringify({ version: 2, sessionID, goal: { status: "active" }, loop: undefined, updatedAt: Date.now(), revision: 1 }),
  );
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  ok(
    "modes: canonical nested goal state blocks vibe",
    stateOf(sessionID) === undefined && textOfCall(stand.calls.synthetic.at(-1)).includes("режима цели"),
    textOfCall(stand.calls.synthetic.at(-1)),
  );
  rmSync(join(MODES_STATE, `${sessionID}.json`), { force: true });
}

{
  const sessionID = "ses_corrupt_modes_state";
  clearState(sessionID);
  writeFileSync(join(MODES_STATE, `${sessionID}.json`), "{ broken-modes");
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  await runCommand(stand, "", sessionID);
  ok(
    "modes: corrupt canonical state blocks vibe",
    stateOf(sessionID) === undefined && textOfCall(stand.calls.synthetic.at(-1)).toLowerCase().includes("state modes поврежд"),
    textOfCall(stand.calls.synthetic.at(-1)),
  );
  rmSync(join(MODES_STATE, `${sessionID}.json`), { force: true });
}

// 8. Disable/recovery report partial failure and keep retryable state.
for (const failure of ["switchAgent", "interrupt"]) {
  const sessionID = `ses_disable_${failure.toLowerCase()}`;
  clearState(sessionID);
  let failOnce = false;
  const stand = makeStand({
    fail: (name, calledSessionID) => {
      if (!failOnce) return false;
      if (failure === "switchAgent") return name === "switchAgent" && calledSessionID === sessionID;
      return name === "interrupt" && calledSessionID !== sessionID;
    },
  });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "teardown" }, sessionID);
  failOnce = true;
  stand.calls.synthetic.length = 0;
  await disable(stand, sessionID);
  const partialText = textOfCall(stand.calls.synthetic.at(-1));
  const retained = stateOf(sessionID);
  ok(
    `disable ${failure}: partial API failure is truthful and state remains retryable`,
    Boolean(retained) && partialText.includes("НЕ выключен") && stand.calls.interrupt.includes(sessionID),
    `state=${Boolean(retained)} text=${partialText}`,
  );
  failOnce = false;
  await disable(stand, sessionID);
  ok(`disable ${failure}: retry completes and clears state`, stateOf(sessionID) === undefined);
}

// Recovery must leave a retryable state when a teardown API call fails.
{
  const sessionID = "ses_recovery_partial";
  clearState(sessionID);
  writeFileSync(
    stateFile(sessionID),
    JSON.stringify({
      sessionID,
      cwd: "/tmp/vibe-cwd",
      enabled: true,
      previousAgent: "build",
      workers: [
        { id: "ses_recovery_partial_worker", cli: "fast", title: "vibe:fast#1", state: "running", turns: 1, queued: [], startedAt: Date.now() },
      ],
      startedAt: Date.now(),
      turnsDelivered: 0,
    }),
  );
  let failOnce = true;
  const stand = makeStand({
    fail: (name, calledSessionID) => failOnce && name === "switchAgent" && calledSessionID === sessionID,
  });
  await plugin.default.setup(stand.ctx);
  const retained = stateOf(sessionID);
  ok(
    "recovery: failed director teardown is not reported as complete",
    Boolean(retained) && typeof retained.stopError === "string",
    `state=${Boolean(retained)} stopError=${retained?.stopError}`,
  );
  failOnce = false;
  await runCommand(stand, "off", sessionID);
  ok("recovery: retry can clear the retained state", stateOf(sessionID) === undefined);
}

// 9. Review regressions: ownership, inter-process admission, truthful wait state,
// durable cleanup/recovery, exact job identity, and atomic wait claims.
{
  const ownerSession = "ses_wait_owner";
  const intruderSession = "ses_wait_intruder";
  clearState(ownerSession);
  clearState(intruderSession);
  const owner = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(owner, ownerSession);
  await runTool(owner, "vibe_spawn", { cli: "fast", prompt: "owned work" }, ownerSession);
  const workerID = stateOf(ownerSession).workers[0].id;

  await runCommand(owner, "", intruderSession);
  const foreign = stateOf(intruderSession);
  foreign.workers.push({
    id: workerID,
    cli: "fast",
    title: "foreign",
    state: "idle",
    turns: 0,
    queued: [],
    startedAt: Date.now(),
  });
  writeFileSync(stateFile(intruderSession), JSON.stringify(foreign));
  owner.sessions.set(workerID, {
    id: workerID,
    agent: "vibe-fast",
    model: { id: "session-model", providerID: "session-provider" },
    location: { directory: "/tmp/session-cwd" },
    messages: [],
  });

  const stolenWait = runTool(owner, "vibe_wait", { sessions: [workerID], timeout: 1 }, intruderSession);
  owner.finishNext(workerID);
  const stolen = await stolenWait;
  ok(
    "ownership: vibe_wait не выдаёт job чужого director",
    !textOfTool(stolen).includes("сделал: owned work"),
    textOfTool(stolen).slice(0, 160),
  );
  clearState(ownerSession);
  clearState(intruderSession);
}
{
  const sessionID = "ses_process_lock";
  clearState(sessionID);
  process.env.VIBE_MAX_WORKERS = "1";
  const createGate = deferred();
  const stand = makeStand({ autoFinish: false, createGate: createGate.promise });
  await enable(stand, sessionID);

  const lockPath = `${stateFile(sessionID)}.lock`;
  const lockFD = openSync(lockPath, "wx", 0o600);
  let settled = false;
  const spawnPromise = runTool(stand, "vibe_spawn", { cli: "fast", prompt: "locked" }, sessionID);
  void spawnPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const blockedBeforeCreate = !settled && stand.calls.create.length === 0;

  const capped = stateOf(sessionID);
  capped.workers.push({
    id: "ses_external_cap_holder",
    cli: "good",
    title: "vibe:good#1 external",
    state: "running",
    turns: 1,
    queued: [],
    startedAt: Date.now(),
  });
  writeFileSync(stateFile(sessionID), JSON.stringify(capped));
  closeSync(lockFD);
  rmSync(lockPath, { force: true });
  createGate.resolve();
  const result = await spawnPromise;
  ok(
    "lock: межпроцессовая admission блокирует cap до create и не теряет внешний worker",
    blockedBeforeCreate &&
      textOfTool(result).includes("потолок") &&
      stand.calls.create.length === 0 &&
      stateOf(sessionID).workers.some((worker) => worker.id === "ses_external_cap_holder"),
    `blocked=${blockedBeforeCreate} creates=${stand.calls.create.length} result=${textOfTool(result)}`,
  );
  delete process.env.VIBE_MAX_WORKERS;
  await disable(stand, sessionID);
}
{
  const sessionID = "ses_wait_retryable";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event", failWait: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "wait unavailable" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const waited = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  const worker = stateOf(sessionID).workers[0];
  ok(
    "completion: public session.wait failure stays retryable, not false terminal completion",
    stand.calls.wait.some((call) => call.sessionID === workerID) &&
      /retry|повтор|не подтверж/i.test(textOfTool(waited)) &&
      worker.state === "running" &&
      stand.calls.synthetic.filter((call) => call.text.includes("<vibe-turn")).length === 0,
    `waitCalls=${stand.calls.wait.length} text=${textOfTool(waited).slice(0, 180)} state=${worker.state}`,
  );
  await disable(stand, sessionID);
  // The failed public wait is intentionally retryable; isolate the next scenario.
  clearState(sessionID);
}
{
  const sessionID = "ses_durable_orphan";
  clearState(sessionID);
  clearOrphans();
  let cleanupFailure = true;
  const stand = makeStand({
    autoFinish: false,
    pluginLocation: "/tmp/session-cwd",
    onCreate: async () => {
      const current = stateOf(sessionID);
      current.enabled = false;
      writeFileSync(stateFile(sessionID), JSON.stringify(current));
    },
    fail: (name, calledSessionID) =>
      cleanupFailure && (name === "interrupt" || name === "update") && calledSessionID.includes("worker"),
  });
  await enable(stand, sessionID);
  const result = await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "orphan" }, sessionID);
  const journalExists = orphanFiles().length === 1;
  cleanupFailure = false;
  await plugin.default.setup(stand.ctx);
  ok(
    "orphan: неудачный teardown незачисленного worker Journal повторён после restart",
    textOfTool(result).includes("не зачислен") &&
      journalExists &&
      stand.calls.interrupt.filter((id) => id.includes("worker")).length === 2 &&
      stand.calls.update.filter((item) => item.sessionID.includes("worker")).length === 1 &&
      orphanFiles().length === 0,
    `result=${textOfTool(result)} journals=${orphanFiles().length} interrupts=${stand.calls.interrupt.join(",")}`,
  );
  clearState(sessionID);
  clearOrphans();
}
{
  const sessionID = "ses_orphan_idle_boundary";
  const workerID = "ses_orphan_idle_boundary_worker";
  clearState(sessionID);
  clearOrphans();
  writeFileSync(
    join(STATE, `${sessionID}.orphan-${workerID}.json`),
    JSON.stringify({
      version: 1,
      directorID: sessionID,
      workerID,
      title: "vibe:fast#1 orphan",
      cwd: "/tmp/session-cwd",
      createdAt: Date.now(),
    }),
  );
  let waitBroken = true;
  const stand = makeStand({
    pluginLocation: "/tmp/session-cwd",
    waitError: (calledSessionID) => (waitBroken && calledSessionID === workerID ? new Error("orphan idle unavailable") : undefined),
  });
  await plugin.default.setup(stand.ctx);
  const retainedRecord = orphanFiles().length === 1 ? JSON.parse(readFileSync(join(STATE, orphanFiles()[0]), "utf8")) : undefined;
  ok(
    "orphan teardown: interrupt без public idle не подтверждает cleanup",
    orphanFiles().length === 1 &&
      /idle/i.test(retainedRecord?.lastError ?? "") &&
      stand.calls.update.filter((item) => item.sessionID === workerID).length === 0,
    `journals=${orphanFiles().length} error=${retainedRecord?.lastError} updates=${stand.calls.update.length}`,
  );
  waitBroken = false;
  await plugin.default.setup(stand.ctx);
  ok(
    "orphan teardown: повторный idle-boundary cleanup завершает journal",
    orphanFiles().length === 0 && stand.calls.wait.filter((call) => call.sessionID === workerID).length >= 2,
    `journals=${orphanFiles().length} waits=${stand.calls.wait.filter((call) => call.sessionID === workerID).length}`,
  );
  clearState(sessionID);
  clearOrphans();
}
{
  const localSession = "ses_recover_local";
  const foreignSession = "ses_recover_foreign";
  clearState(localSession);
  clearState(foreignSession);
  const worker = (id) => ({
    id,
    cli: "fast",
    title: `vibe:fast#1 ${id}`,
    state: "running",
    turns: 1,
    queued: [],
    startedAt: Date.now(),
  });
  writeFileSync(
    stateFile(localSession),
    JSON.stringify({
      sessionID: localSession,
      cwd: "/tmp/vibe-cwd",
      enabled: true,
      previousAgent: "build",
      workers: [worker("ses_recover_local_worker")],
      startedAt: Date.now(),
      turnsDelivered: 0,
    }),
  );
  writeFileSync(
    stateFile(foreignSession),
    JSON.stringify({
      sessionID: foreignSession,
      cwd: "/tmp/other-cwd",
      enabled: true,
      previousAgent: "build",
      workers: [worker("ses_recover_foreign_worker")],
      startedAt: Date.now(),
      turnsDelivered: 0,
    }),
  );
  const stand = makeStand({ pluginLocation: "/tmp/vibe-cwd" });
  await plugin.default.setup(stand.ctx);
  ok(
    "recovery: setup трогает только state текущего location",
    stateOf(localSession) === undefined &&
      stateOf(foreignSession)?.enabled === true &&
      stand.calls.interrupt.includes("ses_recover_local_worker") &&
      !stand.calls.interrupt.includes("ses_recover_foreign_worker"),
    `local=${Boolean(stateOf(localSession))} foreign=${Boolean(stateOf(foreignSession))} interrupts=${stand.calls.interrupt.join(",")}`,
  );
  clearState(localSession);
  clearState(foreignSession);
}
{
  const localSession = "ses_recover_unknown_location";
  const foreignSession = "ses_recover_unknown_location_other";
  clearState(localSession);
  clearState(foreignSession);
  const state = (sessionID, cwd) => ({
    version: 1,
    sessionID,
    cwd,
    enabled: true,
    previousAgent: "build",
    workers: [],
    startedAt: Date.now(),
    turnsDelivered: 0,
  });
  writeFileSync(stateFile(localSession), JSON.stringify(state(localSession, "/tmp/one")));
  writeFileSync(stateFile(foreignSession), JSON.stringify(state(foreignSession, "/tmp/two")));
  const stand = makeStand({ pluginLocation: "" });
  await plugin.default.setup(stand.ctx);
  ok(
    "recovery: неизвестный location не сканирует чужие state",
    stateOf(localSession)?.enabled === true && stateOf(foreignSession)?.enabled === true,
    `local=${Boolean(stateOf(localSession))} foreign=${Boolean(stateOf(foreignSession))}`,
  );
  clearState(localSession);
  clearState(foreignSession);
}
{
  const sessionID = "ses_delayed_terminal";
  clearState(sessionID);
  const secondGate = deferred();
  const stand = makeStand({
    autoFinish: false,
    finishMode: "event",
    promptGateFor: (text) => (text === "second" ? secondGate.promise : undefined),
  });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "first" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const firstWait = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  stand.finishNext(workerID);
  await firstWait;

  await runTool(stand, "vibe_send", { session: workerID, message: "second" }, sessionID);
  await stand.waitForCall("prompt", (items) => items.length >= 2, "второй prompt не начался");
  stand.bus.push({
    type: "session.execution.succeeded",
    data: { sessionID: workerID, reason: "delayed-old-terminal" },
  });
  const delivered = stand.bus.waitForEvent(
    (event) => event.type === "session.inbox.delivered" && event.data.sessionID === workerID,
    "delivered второго prompt",
  );
  secondGate.resolve();
  await delivered;
  const secondWait = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  stand.finishNext(workerID);
  const waited = await secondWait;
  ok(
    "job identity: delayed terminal event от прошлого turn не завершает новый job",
    textOfTool(waited).includes("сделал: second") &&
      !textOfTool(waited).includes("delayed-old-terminal") &&
      textOfTool(waited).includes('turn="2"'),
    textOfTool(waited).slice(0, 220),
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_atomic_wait_claim";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "single consumer" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const first = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  const second = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  stand.finishNext(workerID);
  const results = await Promise.all([first, second]);
  const delivered = results.filter((result) => textOfTool(result).includes("сделал: single consumer"));
  ok(
    "wait claim: один межпроцессный claim, второй consumer не получает дубликат",
    delivered.length === 1 && results.some((result) => !textOfTool(result).includes("сделал: single consumer")),
    results.map(textOfTool).join(" | ").slice(0, 260),
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_wait_window_release";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "window" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const timedOut = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 0.05 }, sessionID);
  const released = stateOf(sessionID).workers[0].currentJob?.claim === undefined;
  const secondWait = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  stand.finishNext(workerID);
  const completed = await secondWait;
  ok(
    "wait window: timeout снимает только свой durable claim и следующий consumer забирает job",
    textOfTool(timedOut).includes("Окно ожидания вышло") &&
      released &&
      textOfTool(completed).includes("сделал: window"),
    `timeout=${textOfTool(timedOut)} released=${released} completed=${textOfTool(completed).slice(0, 120)}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_steer_once";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event", steerThrowsAfterAccept: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "base" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const firstSend = await runTool(stand, "vibe_send", { session: workerID, message: "steer once" }, sessionID);
  const secondSend = await runTool(stand, "vibe_send", { session: workerID, message: "steer once" }, sessionID);
  const steerCalls = stand.calls.prompt.filter((call) => call.delivery === "steer");
  ok(
    "steer idempotency: потерянный receipt не отправляет тот же message повторно",
    !textOfTool(firstSend).includes("очередь") &&
      steerCalls.length === 1 &&
      stand.sessions.get(workerID).messages.filter((message) => message.text === "steer once").length === 1 &&
      !textOfTool(secondSend).includes("запущен"),
    `first=${textOfTool(firstSend)} second=${textOfTool(secondSend)} steers=${steerCalls.length}`,
  );
  await disable(stand, sessionID);
}
{
  const sessionID = "ses_steer_ambiguous";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event", steerThrowsWithoutReceipt: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "base" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const first = await runTool(stand, "vibe_send", { session: workerID, message: "same steer" }, sessionID);
  const second = await runTool(stand, "vibe_send", { session: workerID, message: "same steer" }, sessionID);
  const worker = stateOf(sessionID).workers[0];
  const steerCalls = stand.calls.prompt.filter((call) => call.delivery === "steer");
  ok(
    "steer receipt без подтверждения: тот же ID остаётся pending и не отправляется повторно",
    textOfTool(first).includes("неоднозначен") &&
      textOfTool(second).includes("неясным") &&
      steerCalls.length === 1 &&
      worker.steerPending?.text === "same steer" &&
      worker.queued.length === 0,
    `first=${textOfTool(first)} second=${textOfTool(second)} steers=${steerCalls.length}`,
  );
  await disable(stand, sessionID);
}
{
  const sessionID = "ses_queue_write_error";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event", rejectSteer: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "base" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const promptCount = stand.calls.prompt.length;
  chmodSync(STATE, 0o500);
  let result;
  try {
    result = await runTool(stand, "vibe_send", { session: workerID, message: "must persist" }, sessionID);
  } finally {
    chmodSync(STATE, 0o700);
  }
  ok(
    "queue write errors: rejected steer не объявляется сохранённым, если state записать нельзя",
    textOfTool(result).startsWith("Ошибка:") &&
      !textOfTool(result).includes("очередь") &&
      stand.calls.prompt.length === promptCount,
    textOfTool(result),
  );
  await disable(stand, sessionID);
}
{
  const sessionID = "ses_trace_40";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "trace" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const wait = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  stand.finishWithTools(workerID, 45, "trace");
  const waited = await wait;
  const traceLines = textOfTool(waited).split("\n").filter((line) => line.startsWith("- tool-"));
  ok(
    "activity: полный tail из 40 tool calls и явный overflow",
    textOfTool(waited).includes('tool-calls="45"') &&
      traceLines.length === 40 &&
      textOfTool(waited).includes("- tool-5") &&
      textOfTool(waited).includes("- tool-44") &&
      !textOfTool(waited).includes("- tool-4\n") &&
      textOfTool(waited).includes("5 earlier tool call"),
    `lines=${traceLines.length} text=${textOfTool(waited).slice(0, 180)}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_optional_agent_restore";
  clearState(sessionID);
  const stand = makeStand({ omitAgent: true });
  await enable(stand, sessionID);
  await runCommand(stand, "off", sessionID);
  const firstText = textOfCall(stand.calls.synthetic.at(-1));
  const retainedUnknown = stateOf(sessionID)?.enabled === true && firstText.includes("НЕ выключен");
  stand.sessions.get(sessionID).agent = "build";
  await runCommand(stand, "off", sessionID);
  const secondText = textOfCall(stand.calls.synthetic.at(-1));
  const secondState = stateOf(sessionID);
  ok(
    "agent restore: неизвестный прежний агент не объявляется восстановленным; retry после ручного restore завершает выход",
    retainedUnknown && secondState === undefined,
    `first=${firstText} second=${secondText} stopError=${secondState?.stopError}`,
  );
  clearState(sessionID);
}

// 10. Kill/disable may report success only after public idle confirmation.
{
  const sessionID = "ses_kill_wait_boundary";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event", interruptReturnsOnly: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "kill boundary" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  await stand.waitForCall("wait", (items) => items.some((item) => item.sessionID === workerID), "observer wait не начался");
  const waitsBefore = stand.calls.wait.length;
  let settled = false;
  const killPromise = runTool(stand, "vibe_kill", { session: workerID }, sessionID);
  void killPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await stand.waitForCall("interrupt", (items) => items.includes(workerID), "kill interrupt не начался");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const durableBeforeIdle =
    stateOf(sessionID)?.workers[0]?.state === "stopping" &&
    stand.calls.wait.length > waitsBefore &&
    !settled;
  stand.confirmIdle(workerID);
  const result = await killPromise;
  ok(
    "kill boundary: interrupt API не равен idle; dead фиксируется после public session.wait",
    durableBeforeIdle &&
      textOfTool(result).includes("снят") &&
      stateOf(sessionID)?.workers[0]?.state === "dead",
    `before=${durableBeforeIdle} waits=${stand.calls.wait.length - waitsBefore} settled=${settled} result=${textOfTool(result)}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_kill_wait_unavailable";
  clearState(sessionID);
  let workerID = "";
  let failNext = true;
  const stand = makeStand({
    autoFinish: false,
    finishMode: "event",
    interruptReturnsOnly: true,
    waitError: (sessionID, calls) => {
      if (sessionID !== workerID || !calls.interrupt.includes(sessionID) || !failNext) return undefined;
      failNext = false;
      return Object.assign(new Error("OperationUnavailable"), { name: "OperationUnavailable" });
    },
  });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "kill unavailable" }, sessionID);
  workerID = stateOf(sessionID).workers[0].id;
  await stand.waitForCall("wait", (items) => items.some((item) => item.sessionID === workerID), "observer wait не начался");
  const result = await runTool(stand, "vibe_kill", { session: workerID }, sessionID);
  const worker = stateOf(sessionID)?.workers[0];
  const killCondition = textOfTool(result).startsWith("Ошибка:") &&
    textOfTool(result).includes("OperationUnavailable") &&
    worker?.state === "stopping" &&
    worker?.currentJob !== undefined;
  ok(
    "kill unavailable: OperationUnavailable оставляет retryable stopping и не сообщает «снят»",
    killCondition,
    `result=${JSON.stringify(textOfTool(result))} starts=${textOfTool(result).startsWith("Ошибка:")} hasOp=${textOfTool(result).includes("OperationUnavailable")} state=${worker?.state} currentJob=${Boolean(worker?.currentJob)}`,
  );
  stand.confirmIdle(workerID);
  clearState(sessionID);
}
{
  const sessionID = "ses_disable_wait_boundary";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event", interruptReturnsOnly: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "disable boundary" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  await stand.waitForCall("wait", (items) => items.some((item) => item.sessionID === workerID), "observer wait не начался");
  const waitsBefore = stand.calls.wait.length;
  const disablePromise = disable(stand, sessionID);
  await stand.waitForCall("interrupt", (items) => items.includes(sessionID), "director interrupt не начался");
  stand.confirmIdle(sessionID);
  await stand.waitForCall("interrupt", (items) => items.includes(workerID), "worker interrupt не начался");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const durableBeforeWorkerIdle =
    stateOf(sessionID)?.stopping === true &&
    stateOf(sessionID)?.workers[0]?.state === "stopping" &&
    stand.calls.wait.length >= waitsBefore + 2;
  stand.confirmIdle(workerID);
  await disablePromise;
  const result = textOfCall(stand.calls.synthetic.at(-1));
  ok(
    "disable boundary: state не удаляется до public idle director и worker",
    durableBeforeWorkerIdle &&
      result.includes("выключен") &&
      stateOf(sessionID) === undefined,
    `before=${durableBeforeWorkerIdle} waits=${stand.calls.wait.length - waitsBefore} result=${result}`,
  );
}
{
  const sessionID = "ses_disable_wait_unavailable";
  clearState(sessionID);
  let workerID = "";
  let failNext = true;
  const stand = makeStand({
    autoFinish: false,
    finishMode: "event",
    interruptReturnsOnly: true,
    waitError: (sessionID, calls) => {
      if (sessionID !== workerID || !calls.interrupt.includes(sessionID) || !failNext) return undefined;
      failNext = false;
      return Object.assign(new Error("OperationUnavailable"), { name: "OperationUnavailable" });
    },
  });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "disable unavailable" }, sessionID);
  workerID = stateOf(sessionID).workers[0].id;
  await stand.waitForCall("wait", (items) => items.some((item) => item.sessionID === workerID), "observer wait не начался");
  const disablePromise = disable(stand, sessionID);
  await stand.waitForCall("interrupt", (items) => items.includes(sessionID), "director interrupt не начался");
  stand.confirmIdle(sessionID);
  await stand.waitForCall("interrupt", (items) => items.includes(workerID), "worker interrupt не начался");
  await disablePromise;
  const result = textOfCall(stand.calls.synthetic.at(-1));
  const retained = stateOf(sessionID);
  ok(
    "disable unavailable: OperationUnavailable сохраняет vibe/worker stopping и не сообщает успех",
    result.includes("НЕ выключен") &&
      result.includes("OperationUnavailable") &&
      retained?.stopping === true &&
      retained?.workers[0]?.state === "stopping",
    `result=${result} vibe=${retained?.stopping} worker=${retained?.workers[0]?.state}`,
  );
  stand.confirmIdle(workerID);
  clearState(sessionID);
}

// 11. Prompt rejection and timeout remain immediate and observable.
for (const mode of ["reject", "timeout"]) {
  const sessionID = `ses_${mode}`;
  clearState(sessionID);
  if (mode === "timeout") process.env.VIBE_TURN_TIMEOUT_MS = "1";
  const promptGate = mode === "reject" ? deferred() : undefined;
  const stand = makeStand({ rejectTurn: mode === "reject", promptGate: promptGate?.promise, autoFinish: false, finishMode: "none" });
  await enable(stand, sessionID);
  const spawnPromise = runTool(stand, "vibe_spawn", { cli: "fast", prompt: mode }, sessionID);
  await stand.waitForCall("prompt", (items) => items.length >= 1, "prompt не зафиксирован");
  const workerID = stateOf(sessionID).workers[0].id;
  const waitPromise = runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 3 }, sessionID);
  promptGate?.resolve();
  await spawnPromise;
  const waited = await waitPromise;
  ok(
    `${mode}: vibe_wait receives the exact terminal result`,
    textOfTool(waited).includes(mode === "reject" ? "prompt отклонён" : "ход не дождался") &&
      (mode === "reject" || stand.calls.interrupt.includes(workerID)),
    textOfTool(waited).slice(0, 180),
  );
  delete process.env.VIBE_TURN_TIMEOUT_MS;
  clearState(sessionID);
}

// 10. Native V2 permission surface is checked against the station's agent files.
{
  const director = readFileSync(new URL("../agent/vibe-director.md", import.meta.url), "utf8");
  const fast = readFileSync(new URL("../agent/vibe-fast.md", import.meta.url), "utf8");
  const good = readFileSync(new URL("../agent/vibe-good.md", import.meta.url), "utf8");
  const skill = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  ok(
    "permissions: director uses a V2 wildcard deny plus only read/question/skill/vibe tools",
    /action:\s*["']\*["']/.test(director) &&
      /action:\s*["']read["']/.test(director) &&
      /action:\s*["']question["']/.test(director) &&
      /action:\s*["']skill["']/.test(director) &&
      /action:\s*["']vibe_\*["']/.test(director) &&
      !/action:\s*["']task["']/.test(director),
    director.slice(0, 220),
  );
  ok(
    "brief: director prompt требует short plan, fast/good rationale, file-scope warning и manual read",
    /краткий план|короткий план/i.test(director) &&
      /fast.*механичес|good.*проект/i.test(director) &&
      /пересеч|scope|област/i.test(director) &&
      /прочитай|чтением файлов|ручн.*провер/i.test(director) &&
      !/vibe_plan|vibe_verify/.test(director),
    director.slice(0, 520),
  );
}
// 12. Effective limits expose their source; no hidden unlimited fallback.
{
  const sessionID = "ses_effective_limits";
  clearState(sessionID);
  const stand = makeStand();
  await enable(stand, sessionID);
  const defaultList = await runTool(stand, "vibe_list", {}, sessionID);
  await runCommand(stand, "status", sessionID);
  const statusText = textOfCall(stand.calls.synthetic.at(-1));
  const defaultText = textOfTool(defaultList);
  const previousWorkers = process.env.VIBE_MAX_WORKERS;
  const previousTimeout = process.env.VIBE_TURN_TIMEOUT_MS;
  process.env.VIBE_MAX_WORKERS = "2";
  process.env.VIBE_TURN_TIMEOUT_MS = "1234";
  const configuredList = await runTool(stand, "vibe_list", {}, sessionID);
  const configuredText = textOfTool(configuredList);
  process.env.VIBE_MAX_WORKERS = "not-a-number";
  process.env.VIBE_TURN_TIMEOUT_MS = "0";
  const invalidList = await runTool(stand, "vibe_list", {}, sessionID);
  const invalidText = textOfTool(invalidList);
  ok(
    "limits: status показывает station default, env override и invalid fallback",
    defaultText.includes("cap=4") &&
      defaultText.includes("VIBE_MAX_WORKERS") &&
      defaultText.includes("turnTimeout=30м 0с") &&
      defaultText.includes("native cap/timeout: unverified") &&
      statusText.includes("native cap/timeout: unverified") &&
      configuredText.includes("cap=2") &&
      configuredText.includes("VIBE_TURN_TIMEOUT_MS") &&
      configuredText.includes("turnTimeout=1с") &&
      invalidText.includes("fallback") &&
      invalidText.includes("not-a-number"),
    `default=${defaultText} configured=${configuredText} invalid=${invalidText}`,
  );
  if (previousWorkers === undefined) delete process.env.VIBE_MAX_WORKERS;
  else process.env.VIBE_MAX_WORKERS = previousWorkers;
  if (previousTimeout === undefined) delete process.env.VIBE_TURN_TIMEOUT_MS;
  else process.env.VIBE_TURN_TIMEOUT_MS = previousTimeout;
  clearState(sessionID);
}
// 12. Actual model comes from the fresh assistant message, not the requested model.
{
  const sessionID = "ses_actual_model_mismatch";
  clearState(sessionID);
  const stand = makeStand({ assistantModel: { id: "actual-model", providerID: "actual-provider" } });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "model mismatch" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  await stand.waitForCall("syntheticDone", (items) => items.some((call) => call.text.includes("<vibe-turn")), "actual model delivery", 3000);
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "delivered", "actual model acknowledgement");
  const job = stateOf(sessionID)?.workers[0]?.lastJob;
  const delivery = stand.calls.synthetic.find((call) => call.text.includes("<vibe-turn"));
  const listed = await runTool(stand, "vibe_list", {}, sessionID);
  ok(
    "model: actual assistant model отличается от requested и сохраняется отдельно",
    job?.result?.model === "actual-provider/actual-model" &&
      job?.model === "fast-provider/fast-model" &&
      delivery?.text.includes('model="actual-provider/actual-model"') &&
      textOfTool(listed).includes("requested=fast-provider/fast-model") &&
      textOfTool(listed).includes("actualModel=actual-provider/actual-model"),
    `job=${JSON.stringify(job)} delivery=${delivery?.text.slice(0, 180)} list=${textOfTool(listed)}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_actual_model_unknown";
  clearState(sessionID);
  const stand = makeStand({ assistantModel: null });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "model unknown" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  await stand.waitForCall("syntheticDone", (items) => items.some((call) => call.text.includes("<vibe-turn")), "unknown model delivery", 3000);
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "delivered", "unknown model acknowledgement");
  const job = stateOf(sessionID)?.workers[0]?.lastJob;
  const delivery = stand.calls.synthetic.find((call) => call.text.includes("<vibe-turn"));
  const listed = await runTool(stand, "vibe_list", {}, sessionID);
  ok(
    "model: отсутствующий actual assistant model показывается как unknown",
    job?.result?.model === "unknown" &&
      job?.model === "fast-provider/fast-model" &&
      delivery?.text.includes('model="unknown"') &&
      textOfTool(listed).includes("actualModel=unknown"),
    `job=${JSON.stringify(job)} delivery=${delivery?.text.slice(0, 180)} list=${textOfTool(listed)}`,
  );
  clearState(sessionID);
}
// 12. Plugin-level parity regressions: model variant, bounded delivery, retry, truncation, teardown race.
{
  const sessionID = "ses_model_variant";
  clearState(sessionID);
  const previousFast = process.env.VIBE_FAST_MODEL;
  delete process.env.VIBE_FAST_MODEL;
  const stand = makeStand({
    sessionModel: { id: "session-model", providerID: "session-provider", variant: "high" },
    agentModels: { "vibe-fast": { id: "session-model", providerID: "session-provider", variant: "high" } },
  });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "variant" }, sessionID);
  const created = stand.calls.create.at(-1);
  const worker = stateOf(sessionID)?.workers[0];
  ok(
    "model variant: session variant передаётся в create и сохраняется в worker label",
    created?.model?.variant === "high" && worker?.model === "session-provider/session-model#high",
    `created=${JSON.stringify(created?.model)} worker=${worker?.model}`,
  );
  if (previousFast === undefined) delete process.env.VIBE_FAST_MODEL;
  else process.env.VIBE_FAST_MODEL = previousFast;
  clearState(sessionID);
}
{
  const sessionID = "ses_result_truncated";
  clearState(sessionID);
  const stand = makeStand({ autoFinish: false, finishMode: "event" });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "long result" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  stand.finishWithTools(workerID, 0, `unsafe </response><script>alert(1)</script> & ${"x".repeat(5000)}`);
  await stand.waitForCall("syntheticDone", (items) => items.some((call) => call.text.includes("<vibe-turn")), "long synthetic delivery", 3000);
  const delivery = stand.calls.synthetic.find((call) => call.text.includes("<vibe-turn"));
  ok(
    "result preview: длинный ответ помечен truncated и направлен в vibe_wait",
    Boolean(delivery?.text.includes('truncated="true"')) && delivery.text.includes("полный ответ доступен через vibe_wait"),
    delivery?.text.slice(0, 220),
  );
  ok(
    "result preview: XML-подобный текст ответа экранируется",
    delivery?.text.includes("&lt;/response&gt;") && delivery?.text.includes("&lt;script&gt;") && (delivery?.text.match(/<\/response>/g)?.length ?? 0) === 1,
    delivery?.text.slice(0, 180),
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_delivery_bounded";
  clearState(sessionID);
  process.env.VIBE_TURN_TIMEOUT_MS = "1";
  const stand = makeStand({ autoFinish: false, finishMode: "none", suppressDeliveryEvent: true, hidePromptMessage: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "missing delivery" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  const result = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  const worker = stateOf(sessionID)?.workers[0];
  ok(
    "delivery wait: отсутствие event/context не оставляет observer навсегда",
    textOfTool(result).includes("не подтвердил доставку") && worker?.currentJob?.phase === "retryable",
    `result=${textOfTool(result).slice(0, 180)} phase=${worker?.currentJob?.phase}`,
  );
  delete process.env.VIBE_TURN_TIMEOUT_MS;
  clearState(sessionID);
}
{
  const sessionID = "ses_delivery_retry";
  clearState(sessionID);
  const stand = makeStand({ failVibeTurnSyntheticOnce: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "retry delivery" }, sessionID);
  await stand.waitForCall("synthetic", (items) => items.filter((call) => call.text.includes("<vibe-turn")).length >= 2, "synthetic retry не начался", 3000);
  await stand.waitForCall("syntheticDone", (items) => items.some((call) => call.text.includes("<vibe-turn")), "synthetic retry не завершился", 3000);
  await new Promise((resolve) => setImmediate(resolve));
  const job = stateOf(sessionID)?.workers[0]?.lastJob;
  ok(
    "delivery retry: transient synthetic failure повторяется и фиксируется delivered",
    job?.delivery === "delivered" && job.deliveryAttempts === 0,
    `delivery=${job?.delivery} attempts=${job?.deliveryAttempts}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_delivery_stable_id";
  clearState(sessionID);
  const stand = makeStand({ acceptVibeTurnSyntheticThenThrowOnce: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "stable synthetic id" }, sessionID);
  await stand.waitForCall("synthetic", (items) => items.filter((call) => call.text.includes("<vibe-turn")).length >= 2, "stable-id retry не начался", 3000);
  await stand.waitForCall("syntheticDone", (items) => items.some((call) => call.text.includes("<vibe-turn")), "stable-id retry не завершился", 3000);
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "delivered", "stable-id delivery acknowledgement");
  const callsForJob = stand.calls.synthetic.filter((call) => call.text.includes("<vibe-turn"));
  const syntheticMessages = (stand.sessions.get(sessionID)?.messages ?? []).filter(
    (message) => message.type === "synthetic" && message.text.includes("<vibe-turn"),
  );
  ok(
    "delivery retry: accepted-then-error uses one stable synthetic ID",
    callsForJob.length >= 2 &&
      callsForJob.every((call) => typeof call.id === "string" && call.id === callsForJob[0].id) &&
      syntheticMessages.length === 1,
    `calls=${JSON.stringify(callsForJob.map((call) => call.id))} messages=${syntheticMessages.length}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_delivery_count_truthful";
  clearState(sessionID);
  const gate = deferred();
  const stand = makeStand({ autoFinish: false, finishMode: "event", syntheticGate: gate.promise });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "truthful delivery count" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  stand.finishWithTools(workerID, 0, "truthful count");
  await stand.waitForCall("synthetic", (items) => items.some((call) => call.text.includes("<vibe-turn")), "delivery count synthetic не начался");
  const during = stateOf(sessionID)?.turnsDelivered;
  gate.resolve();
  await stand.waitForCall("syntheticDone", (items) => items.some((call) => call.text.includes("<vibe-turn")), "delivery count synthetic не завершился");
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "delivered", "delivery count acknowledgement");
  const after = stateOf(sessionID)?.turnsDelivered;
  ok(
    "delivery count: turnsDelivered ждёт подтверждения synthetic",
    during === 0 && after === 1,
    `during=${during} after=${after}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_delivery_state_write_failure";
  clearState(sessionID);
  const stand = makeStand({
    autoFinish: false,
    finishMode: "event",
    beforeSyntheticReturn: async ({ sessionID: calledSessionID, text }) => {
      if (!text.includes("<vibe-turn")) return;
      const path = stateFile(calledSessionID);
      const raw = readFileSync(path, "utf8");
      rmSync(path, { force: true });
      mkdirSync(path);
      setImmediate(() => {
        rmSync(path, { recursive: true, force: true });
        writeFileSync(path, raw);
      });
    },
  });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "state write failure" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  stand.finishWithTools(workerID, 0, "state write failure");
  await stand.waitForCall("syntheticDone", (items) => items.some((call) => call.text.includes("<vibe-turn")), "state-write synthetic не завершился", 3000);
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "synthetic", "state-write old delivery state");
  const waited = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  const job = stateOf(sessionID)?.workers[0]?.lastJob;
  ok(
    "state-write failure: результат сохраняется как delivery-unknown и читается без duplicate",
    textOfTool(waited).includes("state write failure") &&
      textOfTool(waited).toLowerCase().includes("unknown") &&
      job?.delivery === "delivery-unknown" &&
      job?.consumedAt !== undefined &&
      stateOf(sessionID)?.turnsDelivered === 1 &&
      stand.calls.synthetic.filter((call) => call.text.includes("<vibe-turn")).length === 1,
    `wait=${textOfTool(waited).slice(0, 220)} job=${JSON.stringify(job)}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_delivery_failed_then_consume";
  clearState(sessionID);
  const stand = makeStand({ failVibeTurnSyntheticOnce: true });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "failed then consume" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  await stand.waitForCall("synthetic", (items) => items.some((call) => call.text.includes("<vibe-turn")), "failed delivery synthetic не начался", 3000);
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "failed", "failed delivery state");
  const waited = await runTool(stand, "vibe_wait", { sessions: [workerID], timeout: 1 }, sessionID);
  const sent = await runTool(stand, "vibe_send", { session: workerID, message: "следующий turn" }, sessionID);
  const job = stateOf(sessionID)?.workers[0]?.lastJob;
  ok(
    "delivery recovery: explicit consume с delivery-unknown разрешает следующий turn",
    textOfTool(waited).includes("failed then consume") &&
      job?.delivery === "delivery-unknown" &&
      job.consumedAt !== undefined &&
      (job.deliveryAttempts ?? 0) >= 1 &&
      !textOfTool(sent).startsWith("Ошибка:") &&
      stand.calls.prompt.filter((call) => call.sessionID === workerID).length === 2,
    `wait=${textOfTool(waited).slice(0, 180)} send=${textOfTool(sent)} prompts=${stand.calls.prompt.length}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_delivery_state_write_retry";
  clearState(sessionID);
  const stand = makeStand({
    autoFinish: false,
    finishMode: "event",
    acceptVibeTurnSyntheticThenThrowOnce: true,
    beforeSyntheticReturn: async ({ sessionID: calledSessionID, text }) => {
      if (!text.includes("<vibe-turn")) return;
      const path = stateFile(calledSessionID);
      const raw = readFileSync(path, "utf8");
      rmSync(path, { force: true });
      mkdirSync(path);
      setImmediate(() => {
        rmSync(path, { recursive: true, force: true });
        writeFileSync(path, raw);
      });
    },
  });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "state write retry" }, sessionID);
  const workerID = stateOf(sessionID).workers[0].id;
  stand.finishWithTools(workerID, 0, "state write retry");
  await stand.waitForCall("synthetic", (items) => items.filter((call) => call.text.includes("<vibe-turn")).length >= 2, "state-write retry не начался", 3000);
  await stand.waitForCall("syntheticDone", (items) => items.filter((call) => call.text.includes("<vibe-turn")).length >= 1, "state-write retry не завершился", 3000);
  await until(() => stateOf(sessionID)?.workers[0]?.lastJob?.delivery === "delivered", "state-write retry acknowledgement");
  const job = stateOf(sessionID)?.workers[0]?.lastJob;
  const callsForJob = stand.calls.synthetic.filter((call) => call.text.includes("<vibe-turn"));
  ok(
    "state-write failure: stable ID автоматически reconcile-ится после восстановления state",
    callsForJob.length >= 2 &&
      callsForJob.every((call) => call.id && call.id === callsForJob[0].id) &&
      job?.delivery === "delivered" &&
      stateOf(sessionID)?.turnsDelivered === 1,
    `calls=${JSON.stringify(callsForJob.map((call) => call.id))} job=${JSON.stringify(job)}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_restart_failed_delivery";
  clearState(sessionID);
  const job = {
    id: `${sessionID}_worker:t1:msg_restart`,
    workerID: `${sessionID}_worker`,
    cli: "fast",
    turn: 1,
    model: "fast-provider/fast-model",
    directorGeneration: 1,
    workerGeneration: 1,
    messageID: "msg_restart",
    startedAt: Date.now(),
    phase: "settled",
    delivery: "failed",
    baseline: { assistantIDs: [] },
    deliveryAttempts: 2,
    deliveryRetryAt: Date.now() + 60_000,
    syntheticID: "syn_restart",
    result: {
      workerID: `${sessionID}_worker`,
      jobID: `${sessionID}_worker:t1:msg_restart`,
      cli: "fast",
      turn: 1,
      status: "succeeded",
      text: "результат, который нельзя потерять",
      tools: [],
      toolCount: 0,
      duration: 1,
      model: "fast-provider/fast-model",
    },
  };
  writeFileSync(
    stateFile(sessionID),
    JSON.stringify({
      sessionID,
      cwd: "/tmp/vibe-cwd",
      enabled: true,
      previousAgent: "build",
      workers: [
        {
          id: `${sessionID}_worker`,
          cli: "fast",
          title: "vibe:fast#1",
          model: "fast-provider/fast-model",
          state: "idle",
          turns: 1,
          queued: [],
          startedAt: Date.now(),
          lastStatus: "succeeded",
          lastJob: job,
        },
      ],
      startedAt: Date.now(),
      turnsDelivered: 0,
    }),
  );
  const stand = makeStand();
  await plugin.default.setup(stand.ctx);
  const recovered = stateOf(sessionID);
  const recoveredJob = recovered?.workers[0]?.lastJob;
  const listed = await runTool(stand, "vibe_list", {}, sessionID);
  ok(
    "restart: failed delivery сохраняется как needs-reaccept, а не удаляется teardown-ом",
    Boolean(recovered?.enabled) &&
      recoveredJob?.result?.text === "результат, который нельзя потерять" &&
      recoveredJob?.delivery === "delivery-unknown" &&
      /needs-reaccept/i.test(recoveredJob?.error ?? "") &&
      textOfTool(listed).includes("delivery=delivery-unknown") &&
      textOfTool(listed).includes("attempts=2") &&
      !stand.calls.switchAgent.some((call) => call.sessionID === sessionID && call.agent === "build"),
    `state=${Boolean(recovered)} delivery=${recoveredJob?.delivery} error=${recoveredJob?.error} list=${textOfTool(listed)}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_teardown_race";
  clearState(sessionID);
  const gate = deferred();
  const stand = makeStand({ autoFinish: false, finishMode: "event", promptGate: gate.promise });
  await enable(stand, sessionID);
  await runTool(stand, "vibe_spawn", { cli: "fast", prompt: "teardown race" }, sessionID);
  await stand.waitForCall("prompt", (items) => items.length >= 1, "prompt race не начался");
  const disablePromise = disable(stand, sessionID);
  await new Promise((resolve) => setImmediate(resolve));
  const beforeIdle = stateOf(sessionID)?.stopping === true;
  gate.resolve();
  await disablePromise;
  const postDelivery = stand.calls.synthetic.some((call) => call.text.includes("<vibe-turn"));
  ok(
    "teardown race: disable ждёт внешний prompt и не выпускает synthetic после остановки",
    beforeIdle === false && !postDelivery && stateOf(sessionID) === undefined,
    `beforeIdle=${beforeIdle} postDelivery=${postDelivery}`,
  );
  clearState(sessionID);
}
{
  const sessionID = "ses_tool_guard";
  clearState(sessionID);
  const stand = makeStand();
  await enable(stand, sessionID);
  const guard = stand.toolHooks.get("execute.before");
  let denied = false;
  try {
    await guard?.({ sessionID, agent: "build", tool: "write" });
  } catch {
    denied = true;
  }
  let readAllowed = false;
  try {
    await guard?.({ sessionID, agent: "build", tool: "read" });
    readAllowed = true;
  } catch {}
  let coordinatorDenied = false;
  try {
    await guard?.({ sessionID, agent: "build", tool: "vibe_spawn" });
  } catch {
    coordinatorDenied = true;
  }
  ok(
    "tool guard: wrong role cannot call coordinator tools, read stays available",
    denied && readAllowed && coordinatorDenied,
    `denied=${denied} readAllowed=${readAllowed} coordinatorDenied=${coordinatorDenied}`,
  );
  clearState(sessionID);
}

rmSync(STATE, { recursive: true, force: true });
rmSync(MODES_STATE, { recursive: true, force: true });
console.log(failed ? `\nПРОВАЛОВ: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
