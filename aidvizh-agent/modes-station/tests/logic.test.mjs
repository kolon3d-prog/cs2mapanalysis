/**
 * modes-station domain/e2e checks against a deterministic opencode2 adapter.
 * There are no model or wall-clock waits in this file: assertions wait for a
 * state/message condition, and the stand emits its own turn boundary.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "modes-parity-"));
const VIBE_STATE = mkdtempSync(join(tmpdir(), "modes-vibe-"));
process.env.MODES_STATE_DIR = STATE;
process.env.VIBE_STATE_DIR = VIBE_STATE;
process.env.MODES_LOG = join(STATE, "modes.log");
process.env.MODES_DEBUG = "1";
process.env.MODES_POLL_MS = "0";
process.env.MODES_ITERATION_PAUSE_MS = "0";
process.env.MODES_START_TIMEOUT = "1";
process.env.MODES_WAIT_TIMEOUT = "2";
process.env.MODES_CONDITION_TIMEOUT = "1";

const plugin = await import("../plugin/opencode/modes.ts");
const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`ok   ${name}`);
  else { console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); failures.push(name); }
};
const immediate = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await immediate();
  }
  throw new Error(`deadline: ${label}`);
}
const stateFile = (sid) => join(STATE, `${sid}.json`);
const readJSON = (sid) => JSON.parse(readFileSync(stateFile(sid), "utf8"));
const state = (sid) => { try { return readJSON(sid); } catch { return undefined; } };
const removeState = (sid) => rmSync(stateFile(sid), { force: true });

function makeStand(options = {}) {
  const messages = [];
  const visible = [];
  const promptCalls = [];
  const hidden = [];
  const said = [];
  const hooks = new Map();
  const tools = new Map();
  const commands = new Map();
  const interrupts = [];
  let tokens = options.tokens ?? { input: 0, output: 0, cache: { read: 0, write: 0 } };
  let agent = options.agent ?? "build";
  let location = options.location ?? process.cwd();
  let settings = options.settings ?? { goal: { enabled: true } };
  let mode = options.mode;
  let busy = false;
  let turnNumber = 0;
  let completeOnTurn = options.completeOnTurn ?? 0;
  let toolOnTurn = options.toolOnTurn === true;
  let interruptOnTurn = options.interruptOnTurn ?? 0;
  let turnHook = options.turnHook;
  let runTurn = options.runTurn;

  const stand = {
    messages, visible, promptCalls, hidden, said, hooks, tools, commands, interrupts,
    setAgent(value) { agent = value; }, setLocation(value) { location = value; },
    setSettings(value) { settings = value; }, setMode(value) { mode = value; },
    setTokens(value) { tokens = value; }, tokensNow: () => structuredClone(tokens),
    setRunTurn(value) { runTurn = value; },
    async injectUser(text) {
      messages.push({ id: `u${messages.length}`, type: "user", text });
      await performTurn("manual");
    },
  };

  async function performTurn(origin = "visible") {
    if (busy) return;
    busy = true;
    turnNumber += 1;
    if (turnHook) await turnHook({ turnNumber, origin, messages, stand });
    if (runTurn) {
      await runTurn({ turnNumber, origin, messages, stand });
    } else {
      if (options.tokensStep) {
        tokens = {
          input: tokens.input + options.tokensStep,
          output: tokens.output + options.tokensStep,
          cache: { read: tokens.cache.read + (options.cacheReadStep ?? 0), write: tokens.cache.write + (options.cacheWriteStep ?? 0) },
        };
      }
      const content = toolOnTurn || options.tools === true ? [{ type: "tool", name: "read" }, { type: "text", text: `turn ${turnNumber}` }] : [{ type: "text", text: `turn ${turnNumber}` }];
      messages.push({ id: `a${messages.length}`, type: "assistant", content });
      if (completeOnTurn && turnNumber >= completeOnTurn) {
        const tool = tools.get("goal");
        if (tool) await tool.execute({ op: "complete", reason: "test completion" }, { sessionID: options.sessionID ?? "stand" });
      }
      messages.push({ id: `i${messages.length}`, type: "idle", outcome: interruptOnTurn && turnNumber >= interruptOnTurn ? "interrupted" : "succeeded" });
    }
    busy = false;
  }

  const session = {
    hook: async (event, handler) => { hooks.set(event, handler); },
    synthetic: async (input) => {
      const text = String(input.text ?? "");
      if (input.resume) {
        hidden.push({ text, turn: turnNumber + 1 });
        messages.push({ id: `s${messages.length}`, type: "synthetic", text, description: input.description });
        await performTurn("hidden");
      } else {
        said.push(text);
        messages.push({ id: `n${messages.length}`, type: "synthetic", text, description: input.description });
      }
      return { data: { id: `synthetic-${messages.length}` } };
    },
    prompt: async (input) => {
      const text = String(input.text ?? "");
      visible.push(text);
      promptCalls.push({ text, delivery: input.delivery });
      messages.push({ id: `u${messages.length}`, type: "user", text, metadata: input.metadata });
      await performTurn("visible");
      return { data: { id: `user-${messages.length}` } };
    },
    context: async () => ({ data: messages }),
    get: async () => ({ data: { tokens, location: { directory: location }, agent, settings, mode } }),
    interrupt: async (input) => { interrupts.push(input); },
    wait: async () => undefined,
  };
  const ctx = {
    session,
    location: { directory: "/ctx/location/must/not/win" },
    command: { transform: (callback) => callback({ add: (definition) => commands.set(definition.name, definition) }) },
    tool: { transform: (callback) => callback({ add: (definition) => tools.set(definition.name, definition), remove: (name) => tools.delete(name) }) },
  };
  stand.ctx = ctx;
  stand.session = session;
  stand.locationValue = location;
  stand.agentValue = agent;
  stand.settingsValue = settings;
  stand.modeValue = mode;
  return stand;
}

async function install(stand, sid) {
  stand.sessionID = sid;
  stand.ctx.session.get = async () => ({ data: { tokens: stand.tokensNow(), location: { directory: stand.locationValue ?? process.cwd() }, agent: stand.agentValue ?? "build", settings: stand.settingsValue ?? { goal: { enabled: true } }, mode: stand.modeValue } });
  await plugin.default.setup(stand.ctx);
  return stand;
}

function prepare(options = {}) {
  const stand = makeStand(options);
  return stand;
}

const S = (n) => `ses_parity_${n}`;
let sidNumber = 0;
const nextSid = () => S(++sidNumber);
async function execute(stand, sid, command, text) {
  await stand.commands.get(command).execute({ sessionID: sid, prompt: { text } });
}
async function goalOp(stand, sid, args) {
  const tool = stand.tools.get("goal");
  if (!tool) return { content: [{ type: "text", text: "Error: goal tool is inactive" }] };
  return tool.execute(args, { sessionID: sid });
}

// A second, deliberately hostile stand for the review regressions.  The small
// original stand above stays unchanged for the parity checks; this one exposes
// the public V2 event/hook/receipt boundaries that those checks do not model.
function makeReviewStand(options = {}) {
  const messages = [];
  const visible = [];
  const hidden = [];
  const said = [];
  const tools = new Map();
  const commands = new Map();
  const toolHooks = new Map();
  const hooks = new Map();
  const eventWaiters = new Set();
  const eventQueue = [];
  const setupCleanups = [];
  let tokens = structuredClone(options.tokens ?? { input: 0, output: 0, cache: { read: 0, write: 0 } });
  let location = options.location ?? process.cwd();
  let agent = options.agent ?? "build";
  let mode = options.mode;
  let busy = false;
  let turnNumber = 0;
  let subscribeCalls = 0;
  let firstStream = true;
  let idleGate = null;
  let gateResolver = null;
  let usagePlan = Array.isArray(options.usagePlan) ? [...options.usagePlan] : null;
  let getDelayMs = options.getDelayMs ?? 0;
  const waitEvent = (signal) => {
    if (eventQueue.length) return Promise.resolve(eventQueue.shift());
    return new Promise((resolve) => {
      const waiter = { resolve };
      eventWaiters.add(waiter);
      signal?.addEventListener("abort", () => { eventWaiters.delete(waiter); resolve(undefined); }, { once: true });
    });
  };
  const emit = (event) => {
    for (const waiter of [...eventWaiters]) waiter.resolve(event);
    eventWaiters.clear();
  };
  const stand = {
    messages, visible, hidden, said, tools, commands, toolHooks, hooks,
    subscribeCalls: () => subscribeCalls,
    releaseIdle() {
      idleGate = null;
      const resolve = gateResolver;
      gateResolver = null;
      resolve?.();
    },
    holdIdle() {
      idleGate = new Promise((resolve) => { gateResolver = resolve; });
      return idleGate;
    },
    emit,
    setTokens(value) { tokens = structuredClone(value); },
    setUsagePlan(value) { usagePlan = [...value]; },
    setAgent(value) { agent = value; },
    setMode(value) { mode = value; },
    tokensNow: () => structuredClone(tokens),
    async injectUser(text) {
      return session.prompt({ sessionID: options.sessionID, text });
    },
  };

  async function performTurn(origin = "visible") {
    if (busy) return;
    busy = true;
    turnNumber += 1;
    if (options.beforeTurn) await options.beforeTurn({ turnNumber, origin, messages, stand });
    const content = options.toolTurn ? [{ type: "tool", name: "review" }, { type: "text", text: `turn ${turnNumber}` }] : [{ type: "text", text: `turn ${turnNumber}` }];
    messages.push({ id: `a${messages.length}`, type: "assistant", content });
    if (options.completeOnTurn && turnNumber >= options.completeOnTurn) {
      const tool = tools.get("goal");
      if (tool) await tool.execute({ op: "complete" }, { sessionID: options.sessionID });
    }
    if (options.emitTerminal !== false) emit({ type: "session.execution.succeeded", data: { sessionID: options.sessionID } });
    if (idleGate) await idleGate;
    if (options.postTurn) await options.postTurn({ turnNumber, origin, messages, stand });
    messages.push({ id: `i${messages.length}`, type: "idle", outcome: options.interruptOnTurn && turnNumber >= options.interruptOnTurn ? "interrupted" : "succeeded" });
    busy = false;
  }

  async function currentUsage() {
    if (usagePlan?.length) {
      const next = usagePlan.shift();
      if (next !== undefined) tokens = structuredClone(next);
    }
    if (getDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, getDelayMs));
    return structuredClone(tokens);
  }

  const session = {
    hook: async (event, handler) => {
      hooks.set(event, handler);
      const registration = { dispose: async () => { if (hooks.get(event) === handler) hooks.delete(event); } };
      setupCleanups.push(registration);
      return registration;
    },
    synthetic: async (input) => {
      const text = String(input.text ?? "");
      if (input.resume) {
        hidden.push({ text, turn: turnNumber + 1 });
        messages.push({ id: `s${messages.length}`, type: "synthetic", text, description: input.description });
        if (options.deferReceipt) void performTurn("hidden");
        else await performTurn("hidden");
      } else {
        said.push(text);
        messages.push({ id: `n${messages.length}`, type: "synthetic", text, description: input.description });
      }
      return { data: { id: `review-synthetic-${messages.length}` } };
    },
    prompt: async (input) => {
      const hook = hooks.get("prompt");
      const event = { sessionID: options.sessionID, prompt: { text: String(input.text ?? ""), metadata: input.metadata }, delivery: input.delivery ?? "steer" };
      if (hook) await hook(event);
      const text = String(event.prompt.text ?? "");
      visible.push(text);
      messages.push({ id: `u${messages.length}`, type: "user", text, metadata: event.prompt.metadata });
      if (options.deferReceipt) void performTurn("visible");
      else await performTurn("visible");
      return { data: { id: `review-user-${messages.length}` } };
    },
    context: async () => ({ data: messages }),
    get: async () => ({ data: { tokens: await currentUsage(), location: { directory: location }, agent, mode } }),
    interrupt: async () => {},
    wait: async () => undefined,
  };
  const ctx = {
    session,
    location: { directory: "/review/location" },
    command: { transform: async (callback) => {
      const registration = { dispose: async () => {} };
      callback({ add: (definition) => commands.set(definition.name, definition) });
      return registration;
    } },
    tool: {
      transform: async (callback) => {
        const registration = { dispose: async () => {} };
        callback({ add: (definition) => tools.set(definition.name, definition), remove: (name) => tools.delete(name) });
        return registration;
      },
      hook: async (event, handler) => {
        toolHooks.set(event, handler);
        return { dispose: async () => { if (toolHooks.get(event) === handler) toolHooks.delete(event); } };
      },
    },
    event: { subscribe: ({ signal } = {}) => {
      subscribeCalls += 1;
      const attempt = subscribeCalls;
      return (async function* () {
        if (options.closeFirstStream && firstStream) {
          firstStream = false;
          if (options.throwFirstStream) throw new Error("review stream failed");
          return;
        }
        firstStream = false;
        while (!signal?.aborted) {
          const event = await waitEvent(signal);
          if (!event || signal?.aborted) return;
          yield event;
        }
      })();
    } },
  };
  stand.ctx = ctx;
  stand.session = session;
  stand.locationValue = location;
  stand.agentValue = agent;
  stand.modeValue = mode;
  stand.setLocation = (value) => { location = value; };
  return stand;
}

async function installReview(stand, sid) {
  stand.sessionID = sid;
  const cleanup = await plugin.default.setup(stand.ctx);
  stand.cleanup = cleanup;
  return stand;
}

async function reviewExecute(stand, sid, command, text) {
  await stand.commands.get(command).execute({ sessionID: sid, prompt: { text } });
}

{
  const cases = [
    ["2", "iterations", 2],
    ["10m", "duration", 600_000],
    ["1h30m", "duration", 5_400_000],
    ["30m1h2s", "duration", 5_402_000],
    ["2 hours", "duration", 7_200_000],
    ["5minutes", "duration", 300_000],
  ];
  for (const [input, kind, value] of cases) {
    const parsed = plugin.parseLoopArgs(input);
    check(`parser ${input}`, typeof parsed !== "string" && parsed.limit?.kind === kind && (kind === "iterations" ? parsed.limit.iterations === value : parsed.limit.durationMs === value), JSON.stringify(parsed));
  }
  const shell = plugin.readShellWord(` a"b c"d\\ e rest`);
  check("shell-word tokenizer concatenates and unescapes", shell !== undefined && shell !== "unterminated" && shell.value === "ab cd e" && shell.rest === "rest", JSON.stringify(shell));
  const escaped = plugin.readShellWord(`"a'b" tail`);
  check("shell-word tokenizer handles quote concatenation", escaped !== undefined && escaped !== "unterminated" && escaped.value === "a'b", JSON.stringify(escaped));
  const errors = [
    ["0", "positive integer"], ["-1", "Usage:"], ["1.5h", "Usage:"], ["10x", "unit must"],
    ["9007199254740992", "positive integer"], ["--while true --until false", "only one"],
    ["--wat true", "Unknown /loop flag"], ["--until 'oops", "unterminated"], ["--until", "needs a shell command"],
  ];
  for (const [input, fragment] of errors) {
    const parsed = plugin.parseLoopArgs(input);
    check(`parser error ${input}`, typeof parsed === "string" && parsed.includes(fragment), JSON.stringify(parsed));
  }
  const compact = plugin.parseLoopArgs("2 --compact fix");
  check("--compact adapter extension", typeof compact !== "string" && compact.compact === true && compact.prompt === "fix", JSON.stringify(compact));
}

// ---------------------------------------------------------------- loop arithmetic and conditions
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid); await execute(stand, sid, "loop", "2 body");
  await until(() => state(sid)?.loop?.status === "off", "loop count stops");
  const st = state(sid);
  check("loop N is N resubmits plus first", st.loop.used === 3 && st.loop.limit.remaining === 0 && stand.visible.filter((x) => x === "body").length === 3, JSON.stringify({ used: st.loop.used, remaining: st.loop.limit.remaining, visible: stand.visible.length }));
  check("loop stopped state is not active", st.active === false, JSON.stringify({ active: st.active, kind: st.kind }));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid); await execute(stand, sid, "loop", "1 --while 'exit 0' body");
  await until(() => state(sid)?.loop?.status === "off", "while continues");
  check("--while continues on exit 0", stand.visible.filter((x) => x === "body").length === 2, JSON.stringify(stand.visible));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid); await execute(stand, sid, "loop", "5 --until 'exit 0' body");
  await until(() => state(sid)?.loop?.status === "off", "until halts on success");
  check("--until halts on exit 0", stand.visible.filter((x) => x === "body").length === 1, JSON.stringify(stand.visible));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid); await execute(stand, sid, "loop", "5 --while 'exit 3' body");
  await until(() => state(sid)?.loop?.status === "off", "condition error stops");
  check("condition exit >1 is an error", String(state(sid).loop.reason).includes("failed"), JSON.stringify(state(sid).loop));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid); await execute(stand, sid, "loop", "1 body"); await until(() => state(sid)?.loop?.used === 1, "loop first turn");
  await execute(stand, sid, "loop", "garbage --not-a-flag"); const st = state(sid);
  check("repeat /loop disables before parsing", st.loop === undefined, JSON.stringify(st));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid); await execute(stand, sid, "loop", "2");
  await until(() => state(sid)?.loop?.awaitingBody === true, "loop waits for body");
  await stand.injectUser("manual body");
  await until(() => state(sid)?.loop?.status === "off", "manual body completes loop");
  check("/loop without body adopts next manual prompt", stand.messages.filter((m) => m.type === "user" && m.text === "manual body").length === 3, JSON.stringify(stand.messages.filter((m) => m.type === "user").map((m) => m.text)));
  removeState(sid);
}

// ---------------------------------------------------------------- goal semantics
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, completeOnTurn: 2 }); await install(stand, sid);
  await execute(stand, sid, "goal", "finish the work");
  await until(() => state(sid)?.goal?.status === "complete", "goal complete tool");
  check("first objective is visible user prompt", stand.visible[0] === "finish the work" && stand.promptCalls[0]?.delivery === undefined, JSON.stringify(stand.promptCalls.slice(0, 2)));
  check("later goal continuations are hidden", stand.hidden.length >= 1 && stand.visible.filter((x) => x === "finish the work").length === 1, JSON.stringify({ visible: stand.visible, hidden: stand.hidden.length }));
  check("GOAL: DONE is not a completion path", state(sid).goal.status === "complete" && state(sid).reason !== "GOAL: DONE", JSON.stringify(state(sid).goal));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: false }); await install(stand, sid);
  await execute(stand, sid, "goal", "no tools first");
  await until(() => state(sid)?.goal?.waitingUser === true, "hidden no-tools waits for user");
  check("no-tools suppression does not apply to first objective", stand.visible.filter((x) => x === "no tools first").length === 1 && stand.hidden.length >= 1, JSON.stringify({ visible: stand.visible, hidden: stand.hidden.length }));
  check("hidden continuation with no tools waits", state(sid).goal.status === "active" && state(sid).goal.waitingUser === true, JSON.stringify(state(sid).goal));
  const beforeResume = stand.hidden.length;
  await stand.injectUser("continue after no-tools");
  await until(() => stand.hidden.length > beforeResume, "manual prompt resumes hidden goal");
  check("manual prompt re-enables goal continuation", stand.hidden.length > beforeResume && state(sid).goal.status === "active", JSON.stringify({ hidden: stand.hidden.length, state: state(sid).goal }));
  await execute(stand, sid, "goal", "drop"); removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, completeOnTurn: 1, tokens: { input: 100, output: 20, cache: { read: 999999, write: 7 } }, tokensStep: 10, cacheWriteStep: 3, cacheReadStep: 1000 }); await install(stand, sid);
  await execute(stand, sid, "goal", "account final turn");
  await until(() => state(sid)?.goal?.status === "complete", "final usage complete");
  const goal = state(sid).goal;
  check("final turn flushes input+output+cache.write and excludes cache.read", goal.tokensUsed === 10 + 10 + 3, JSON.stringify({ used: goal.tokensUsed, baseline: goal.usageBaseline }));
  check("completed goal cannot be resumed", state(sid).goal.status === "complete" && !stand.tools.has("goal"), JSON.stringify(state(sid).goal));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, tokensStep: 10 }); await install(stand, sid);
  await execute(stand, sid, "goal", "pause me"); await until(() => state(sid)?.goal?.status === "active", "goal active");
  await execute(stand, sid, "goal", "pause"); const paused = state(sid).goal;
  check("pause preserves usage and todos", paused.status === "paused" && paused.tokensUsed >= 0 && Array.isArray(paused.todos), JSON.stringify(paused));
  await execute(stand, sid, "goal", "resume"); await until(() => state(sid)?.goal?.status === "active", "goal resumed");
  check("resume preserves goal usage", state(sid).goal.tokensUsed >= paused.tokensUsed, JSON.stringify(state(sid).goal));
  await execute(stand, sid, "goal", "drop");
  check("drop preserves usage and is not resumable", state(sid).goal.status === "dropped" && state(sid).goal.tokensUsed >= paused.tokensUsed, JSON.stringify(state(sid).goal));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  await execute(stand, sid, "goal", "preserve state"); await until(() => state(sid)?.goal?.status === "active", "preserve goal active");
  await goalOp(stand, sid, { op: "todo", action: "add", text: "keep todo" });
  await execute(stand, sid, "goal", "pause");
  const pausedState = state(sid); pausedState.goal.timeUsedSeconds = 17; writeFileSync(stateFile(sid), JSON.stringify(pausedState));
  await execute(stand, sid, "goal", "resume"); await until(() => state(sid)?.goal?.status === "active", "preserve resume");
  await execute(stand, sid, "goal", "drop");
  check("pause/resume/drop preserve time and todos", state(sid).goal.timeUsedSeconds >= 17 && state(sid).goal.todos.some((todo) => todo.text === "keep todo"), JSON.stringify(state(sid).goal));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, completeOnTurn: 3 }); await install(stand, sid);
  await execute(stand, sid, "goal", "marker only"); stand.setRunTurn(async ({ messages }) => { messages.push({ id: `a${messages.length}`, type: "assistant", content: [{ type: "text", text: "GOAL: DONE" }] }); messages.push({ id: `i${messages.length}`, type: "idle", outcome: "succeeded" }); });
  await execute(stand, sid, "goal", "drop"); const st = state(sid);
  check("text marker never closes a goal", st.goal === undefined || st.goal.status === "dropped", JSON.stringify(st));
  removeState(sid);
}

// ---------------------------------------------------------------- independent envelope and guards
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, completeOnTurn: 4 }); await install(stand, sid);
  await execute(stand, sid, "loop", "1 loop body"); await execute(stand, sid, "goal", "parallel goal");
  await until(() => state(sid)?.loop && state(sid)?.goal, "envelope has both modes");
  check("goal and loop share one envelope", state(sid).version === 2 && state(sid).loop !== undefined && state(sid).goal !== undefined, JSON.stringify(state(sid)));
  await execute(stand, sid, "loop", "off");
  await until(() => state(sid)?.goal?.status === "complete", "goal continues after loop off");
  check("goal continuation yields while loop is enabled", state(sid).goal.status === "complete", JSON.stringify(state(sid).goal));
  removeState(sid);
}
{
  const sid = nextSid(); const planStand = prepare({ sessionID: sid, agent: "plan", tools: true }); await install(planStand, sid); await execute(planStand, sid, "goal", "blocked"); check("goal blocks native plan", !state(sid)?.goal && planStand.said.at(-1).includes("plan"), planStand.said.at(-1));
  await execute(planStand, sid, "loop", "1 allowed"); check("loop is allowed in plan mode", state(sid)?.loop?.status !== "off", JSON.stringify(state(sid)?.loop));
  removeState(sid);
}
{
  const sid = nextSid(); const vibeStand = prepare({ sessionID: sid, agent: "vibe-director", tools: true }); await install(vibeStand, sid); await execute(vibeStand, sid, "goal", "blocked"); check("goal blocks live vibe agent", !state(sid)?.goal && vibeStand.said.at(-1).includes("vibe"), vibeStand.said.at(-1));
  await execute(vibeStand, sid, "loop", "1 allowed"); check("loop is allowed in vibe mode", state(sid)?.loop?.status !== "off", JSON.stringify(state(sid)?.loop));
  removeState(sid);
}
{
  const sid = nextSid(); const pausedPlan = prepare({ sessionID: sid, mode: "plan_paused", tools: true }); await install(pausedPlan, sid); await execute(pausedPlan, sid, "goal", "blocked"); check("goal blocks paused native plan", !state(sid)?.goal && pausedPlan.said.at(-1).includes("plan"), pausedPlan.said.at(-1)); removeState(sid);
}
{
  const sid = nextSid(); writeFileSync(join(VIBE_STATE, `${sid}.json`), JSON.stringify({ enabled: true, sessionID: sid })); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid); await execute(stand, sid, "goal", "blocked"); check("goal sees active vibe state bridge", !state(sid)?.goal && stand.said.at(-1).includes("vibe"), stand.said.at(-1)); removeState(sid);
}
{
  const sid = nextSid(); const disabled = prepare({ sessionID: sid, settings: { goal: { enabled: false } }, tools: true }); await install(disabled, sid); await execute(disabled, sid, "goal", "allowed-without-unverified-settings"); check("unverified session settings are not treated as public config", Boolean(state(sid)?.goal), disabled.said.at(-1));
  await execute(disabled, sid, "loop", "1 allowed"); check("loop remains allowed in the V2 adapter", state(sid)?.loop?.status !== "off", JSON.stringify(state(sid)?.loop));
  removeState(sid);
}
{
  const sessionCwd = mkdtempSync(join(tmpdir(), "modes-cwd-")); const sid = nextSid(); const stand = prepare({ sessionID: sid, location: sessionCwd, tools: true }); await install(stand, sid); await execute(stand, sid, "loop", "1 body");
  check("commands use session.get location, not ctx.location", state(sid)?.cwd === sessionCwd && state(sid)?.cwd !== "/ctx/location/must/not/win", JSON.stringify(state(sid)?.cwd));
  await until(() => state(sid)?.loop?.status === "off", "cwd loop"); removeState(sid); rmSync(sessionCwd, { recursive: true, force: true });
}

// ---------------------------------------------------------------- recovery, migration, stale ownership
{
  const sid = "ses_legacy_recovery";
  writeFileSync(stateFile(sid), JSON.stringify({ kind: "goal", active: true, sessionID: sid, cwd: process.cwd(), objective: "recover me", prompt: "recover me", maxIterations: 1000, turnsLimited: false, used: 2, startedAt: Date.now() - 5000, token: "old", pid: 999999, todos: [{ text: "keep", done: true }], tokensUsed: 12 }));
  const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  const recovered = state(sid);
  check("cold restart pauses an active goal", recovered.goal?.status === "paused" && recovered.goal.todos[0]?.text === "keep", JSON.stringify(recovered));
  removeState(sid);
}
{
  const sid = "ses_legacy_loop";
  writeFileSync(stateFile(sid), JSON.stringify({ kind: "loop", active: true, sessionID: sid, cwd: process.cwd(), prompt: "legacy", objective: "legacy", maxIterations: 4, turnsLimited: true, used: 1, startedAt: Date.now(), token: "old", pid: 999999 }));
  const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  check("cold restart does not leave active loop zombie", state(sid)?.loop === undefined, JSON.stringify(state(sid)));
  removeState(sid);
}

// ---------------------------------------------------------------- tool visibility and state safety
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid); await execute(stand, sid, "loop", "1 body");
  const result = await goalOp(stand, sid, { op: "complete" });
  check("goal tool cannot complete when only loop is active", result.content[0].text.includes("inactive") && state(sid).loop?.status !== "off", JSON.stringify(result));
  await execute(stand, sid, "loop", "off"); removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  await Promise.all([execute(stand, sid, "goal", "concurrent"), execute(stand, sid, "goal", "show")]);
  const valid = await until(() => { try { return JSON.parse(readFileSync(stateFile(sid), "utf8")); } catch { return false; } }, "atomic state remains valid");
  check("concurrent state writes leave valid JSON", valid.version === 2, JSON.stringify(valid));
  await execute(stand, sid, "goal", "drop"); removeState(sid);
}

// ---------------------------------------------------------------- late edge contracts
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, interruptOnTurn: 1 }); await install(stand, sid);
  await execute(stand, sid, "loop", "3 old body");
  await until(() => state(sid)?.loop?.status === "paused", "streaming abort pauses loop");
  const paused = state(sid);
  check("Esc/interrupted keeps loop enabled", paused.loop.status === "paused" && paused.active === true, JSON.stringify(paused));
  await stand.injectUser("new body after Esc");
  await until(() => state(sid)?.loop?.prompt === "new body after Esc", "manual body replaces after Esc");
  check("next manual prompt replaces loop body", state(sid).loop.prompt === "new body after Esc", JSON.stringify(state(sid).loop));
  await execute(stand, sid, "loop", "off"); removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  process.env.MODES_WAIT_TIMEOUT = "0.01";
  await execute(stand, sid, "loop", "1");
  await until(() => state(sid)?.loop?.status === "off" || state(sid)?.loop === undefined, "loop wait timeout");
  check("loop wait timeout does not leave active state", state(sid)?.loop?.status !== "active", JSON.stringify(state(sid)));
  process.env.MODES_WAIT_TIMEOUT = "2"; removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: false }); await install(stand, sid);
  process.env.MODES_WAIT_TIMEOUT = "0.01";
  await execute(stand, sid, "goal", "wait timeout");
  await until(() => state(sid)?.goal?.status === "paused", "goal wait timeout");
  check("goal wait timeout pauses instead of leaving active state", state(sid).goal.status === "paused", JSON.stringify(state(sid).goal));
  process.env.MODES_WAIT_TIMEOUT = "2"; removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  process.env.MODES_CONDITION_TIMEOUT_MS = "5";
  await execute(stand, sid, "loop", "1 --while 'while :; do :; done' body");
  await until(() => state(sid)?.loop?.status === "off", "condition timeout");
  check("condition timeout stops with an honest error", String(state(sid).loop.reason).includes("timed out"), JSON.stringify(state(sid).loop));
  delete process.env.MODES_CONDITION_TIMEOUT_MS; removeState(sid);
}
{
  const root = mkdtempSync(join(tmpdir(), "modes-stale-")); const started = join(root, "started"); const release = join(root, "release");
  const quote = (p) => `'${p.replaceAll("'", "'\\''")}'`;
  const command = `printf started > ${quote(started)}; while [ ! -f ${quote(release)} ]; do :; done; exit 0`;
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  process.env.MODES_CONDITION_TIMEOUT_MS = "1000";
  await execute(stand, sid, "loop", `1 --while ${quote(command)} body`);
  await until(() => existsSync(started), "condition started");
  await execute(stand, sid, "loop", "off"); writeFileSync(release, "go");
  await until(() => state(sid)?.loop === undefined, "stale condition driver exits");
  check("stale loop token cannot submit after disable", stand.visible.filter((x) => x === "body").length === 1, JSON.stringify(stand.visible));
  delete process.env.MODES_CONDITION_TIMEOUT_MS; rmSync(root, { recursive: true, force: true }); removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, tokensStep: 10 }); await install(stand, sid);
  await execute(stand, sid, "goal", "budget target --tokens 5"); await until(() => state(sid)?.goal?.status === "budget-limited", "budget limit");
  const spent = state(sid).goal.tokensUsed;
  await execute(stand, sid, "goal", "budget 100");
  check("raising budget preserves accumulated usage", state(sid).goal.tokensUsed === spent && state(sid).goal.tokenBudget === 100, JSON.stringify(state(sid).goal));
  await execute(stand, sid, "goal", "drop"); removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: false }); await install(stand, sid);
  check("goal tool is absent without a goal", !stand.tools.has("goal"), [...stand.tools.keys()].join(","));
  await execute(stand, sid, "goal", "created by command");
  check("goal tool becomes active with a goal", stand.tools.has("goal"), [...stand.tools.keys()].join(","));
  const got = await goalOp(stand, sid, { op: "get" });
  check("goal tool get reports the active goal", String(got.content[0].text).includes("created by command"), JSON.stringify(got));
  await goalOp(stand, sid, { op: "complete" });
  check("goal tool complete is the only completion operation", state(sid).goal.status === "complete", JSON.stringify(state(sid).goal));
  check("completed goal removes the dynamic tool", !stand.tools.has("goal"), [...stand.tools.keys()].join(","));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, tokensStep: 10, completeOnTurn: 1 }); await install(stand, sid);
  await execute(stand, sid, "goal", "final budget completion --tokens 1");
  await until(() => state(sid)?.goal?.status === "complete", "budget completion from final flush");
  check("final budget flush: complete wins after usage crosses budget", state(sid)?.goal?.status === "complete", JSON.stringify(state(sid)?.goal));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  await execute(stand, sid, "goal", "resume baseline");
  await until(() => state(sid)?.goal?.status === "active", "baseline goal active");
  await execute(stand, sid, "goal", "pause");
  stand.setTokens({ input: 100, output: 20, cache: { read: 0, write: 0 } });
  await execute(stand, sid, "goal", "resume");
  await until(() => state(sid)?.goal?.status === "active", "baseline goal resumed");
  check("resume resets usage baseline to current session usage", state(sid)?.goal?.usageBaseline?.input === 100 && state(sid)?.goal?.usageBaseline?.output === 20, JSON.stringify(state(sid)?.goal));
  await execute(stand, sid, "goal", "drop");
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: false }); await install(stand, sid);
  await execute(stand, sid, "guided-goal", "rough objective");
  check("guided interview exposes goal create", stand.tools.has("goal"), [...stand.tools.keys()].join(","));
  check("guided interview starts a model-driven turn", stand.hidden.some((item) => item.text.includes("model-driven interview")), JSON.stringify(stand.hidden));
  const created = await goalOp(stand, sid, { op: "create", objective: "from interview" });
  check("goal tool create works during interview", String(created.content[0].text).includes("Goal created"), JSON.stringify(created));
  await goalOp(stand, sid, { op: "complete" }); removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  stand.setRunTurn(async ({ messages }) => { messages.push({ id: `a${messages.length}`, type: "assistant", content: [{ type: "text", text: "GOAL: DONE" }] }); messages.push({ id: `i${messages.length}`, type: "idle", outcome: "succeeded" }); });
  await execute(stand, sid, "goal", "marker must not close"); await until(() => (state(sid)?.goal?.turns ?? 0) >= 1, "marker turn");
  check("GOAL: DONE text leaves goal active", state(sid).goal.status === "active", JSON.stringify(state(sid).goal));
  await execute(stand, sid, "goal", "drop"); removeState(sid);
}
{
  const sid = "ses_recovery_v2";
  writeFileSync(stateFile(sid), JSON.stringify({ version: 2, sessionID: sid, revision: 1, goal: { token: "old", status: "active", objective: "v2", prompt: "v2", startedAt: Date.now(), updatedAt: Date.now(), turns: 1, tokensUsed: 3, usageBaseline: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, timeUsedSeconds: 2, lastAccountedAt: Date.now(), todos: [] } }));
  const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  check("startup reconcile pauses ownerless v2 goal", state(sid).goal.status === "paused", JSON.stringify(state(sid)));
  removeState(sid);
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  process.env.MODES_ITERATION_PAUSE_MS = "1100";
  await execute(stand, sid, "loop", "1s body");
  await until(() => state(sid)?.loop?.status === "off", "deadline after delay");
  check("deadline is rechecked after iteration delay", stand.messages.filter((m) => m.type === "user" && m.text === "body").length === 1, JSON.stringify(state(sid).loop));
  delete process.env.MODES_ITERATION_PAUSE_MS; removeState(sid);
}

{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true, completeOnTurn: 1005 }); await install(stand, sid);
  await execute(stand, sid, "goal", "unlimited beyond old safety cap");
  await until(() => state(sid)?.goal?.status === "complete", "unlimited goal reaches explicit completion", 15000);
  check("default goal has no hidden turn cap", (state(sid).goal.turns ?? 0) >= 1004 && state(sid).goal.turnLimit === undefined, JSON.stringify({ turns: state(sid).goal.turns, limit: state(sid).goal.turnLimit }));
  removeState(sid);
}
{
  const units = [["1s", 1000], ["1sec", 1000], ["1secs", 1000], ["1second", 1000], ["1seconds", 1000], ["1m", 60000], ["1min", 60000], ["1mins", 60000], ["1minute", 60000], ["1minutes", 60000], ["1h", 3600000], ["1hr", 3600000], ["1hrs", 3600000], ["1hour", 3600000], ["1hours", 3600000]];
  check("all OMP duration units are accepted", units.every(([input, ms]) => { const parsed = plugin.parseLoopArgs(input); return typeof parsed !== "string" && parsed.limit?.durationMs === ms; }), JSON.stringify(units.filter(([input]) => typeof plugin.parseLoopArgs(input) === "string")));
}
{
  const sid = nextSid(); const stand = prepare({ sessionID: sid, tools: true }); stand.setRunTurn(async () => {}); await install(stand, sid);
  process.env.MODES_START_TIMEOUT = "0.05";
  await execute(stand, sid, "goal", "never starts");
  await until(() => state(sid)?.goal?.status === "paused", "start timeout");
  check("a prompt that never starts does not leave an active goal", state(sid).goal.status === "paused" && state(sid).goal.reason === "ход не поднялся", JSON.stringify(state(sid).goal));
  process.env.MODES_START_TIMEOUT = "1"; removeState(sid);
}
{
  const sid = "ses_legacy_marker";
  writeFileSync(stateFile(sid), JSON.stringify({ kind: "goal", active: true, sessionID: sid, objective: "marker", prompt: "marker", turnsLimited: false, maxIterations: 1000, used: 1, startedAt: Date.now(), token: "old", pid: 999999, reason: "GOAL: DONE", tokensUsed: 19 }));
  const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  check("legacy GOAL: DONE state migrates as unfinished", state(sid).goal.status === "paused" && state(sid).goal.tokensUsed === 19, JSON.stringify(state(sid).goal));
  removeState(sid);
}
{
  const sid = "ses_legacy_unbounded_loop";
  writeFileSync(stateFile(sid), JSON.stringify({ kind: "loop", active: true, sessionID: sid, prompt: "legacy", objective: "legacy", maxIterations: 1000, turnsLimited: false, used: 4, startedAt: Date.now(), token: "old", pid: process.pid }));
  const stand = prepare({ sessionID: sid, tools: true }); await install(stand, sid);
  check("legacy unbounded loop does not inherit the old safety cap", state(sid).loop === undefined || state(sid).loop.limit === undefined, JSON.stringify(state(sid).loop));
  removeState(sid);
}

// ---------------------------------------------------------------- review RED regressions
// These cases are intentionally hostile: each one is a mutation/contract test
// for a blocker found in review, not a live-model smoke test.
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  stand.holdIdle();
  await reviewExecute(stand, sid, "goal", "guard continuation");
  await until(() => stand.visible.includes("guard continuation"), "first goal prompt visible");
  stand.setAgent("plan");
  stand.releaseIdle();
  await until(() => state(sid)?.goal?.status === "paused", "plan guard pauses continuation");
  check("goal continuation rechecks plan guard", stand.hidden.length === 0 && state(sid)?.goal?.reason?.includes("plan"), JSON.stringify({ hidden: stand.hidden, goal: state(sid)?.goal }));
  await reviewExecute(stand, sid, "goal", "drop");
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid, deferReceipt: true });
  await installReview(stand, sid);
  stand.holdIdle();
  await reviewExecute(stand, sid, "goal", "terminal-before-idle");
  await until(() => stand.messages.some((m) => m.type === "assistant"), "terminal-before-idle assistant");
  await immediate(); await immediate(); await immediate();
  check("continuation waits for idle, not only assistant/terminal", stand.hidden.length === 0, JSON.stringify({ hidden: stand.hidden.length }));
  stand.releaseIdle();
  await until(() => state(sid)?.goal?.turns >= 1, "terminal-before-idle first turn");
  await reviewExecute(stand, sid, "goal", "drop");
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid, toolTurn: true });
  await installReview(stand, sid);
  await Promise.all([
    reviewExecute(stand, sid, "loop", "1 loop body"),
    reviewExecute(stand, sid, "goal", "goal objective"),
  ]);
  await until(() => state(sid)?.goal && state(sid)?.loop, "goal and loop commands serialized");
  await until(() => state(sid)?.goal?.turns >= 1, "goal first objective started");
  const beforeDrop = stand.visible.slice();
  check("goal first objective is not consumed as loop body", !beforeDrop.includes("loop body") && beforeDrop.filter((x) => x === "goal objective").length === 1, JSON.stringify(beforeDrop));
  await reviewExecute(stand, sid, "goal", "drop");
  await until(() => state(sid)?.loop?.status === "off" || state(sid)?.loop === undefined, "loop resumes after goal yields");
  check("loop runs only after goal terminal state", stand.visible.filter((x) => x === "loop body").length >= 1, JSON.stringify(stand.visible));
  removeState(sid);
}
{
  const sid = nextSid();
  const oldWait = process.env.MODES_WAIT_TIMEOUT;
  process.env.MODES_WAIT_TIMEOUT = "0.01";
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "goal", "stale waiting coordinator");
  await until(() => state(sid)?.goal?.waitingUser === true, "waitingUser reached");
  await reviewExecute(stand, sid, "goal", "drop");
  await until(() => state(sid)?.goal?.status === "dropped", "drop won transition");
  await new Promise((resolve) => setTimeout(resolve, 40));
  check("stale waitingUser coordinator cannot resurrect dropped goal", state(sid)?.goal?.status === "dropped", JSON.stringify(state(sid)?.goal));
  if (oldWait === undefined) delete process.env.MODES_WAIT_TIMEOUT; else process.env.MODES_WAIT_TIMEOUT = oldWait;
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid, toolTurn: true });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "goal", "flush race");
  await until(() => state(sid)?.goal?.status === "active", "flush race goal active");
  stand.setUsagePlan([
    { input: 10, output: 0, cache: { read: 0, write: 0 } },
    { input: 20, output: 0, cache: { read: 0, write: 0 } },
  ]);
  await Promise.all([
    reviewExecute(stand, sid, "goal", "pause"),
    reviewExecute(stand, sid, "goal", "drop"),
  ]);
  check("concurrent goal flushes preserve the newest usage", (state(sid)?.goal?.tokensUsed ?? 0) >= 20, JSON.stringify(state(sid)?.goal));
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  const lock = `${stateFile(sid)}.lock`;
  mkdirSync(lock, { recursive: true });
  await reviewExecute(stand, sid, "goal", "must not bypass live lock");
  check("state lock failure is reported and never fails open", !state(sid)?.goal && stand.said.at(-1)?.includes("lock"), stand.said.at(-1));
  rmSync(lock, { recursive: true, force: true });
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  const lock = `${stateFile(sid)}.lock`;
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999999, processStart: "0", instance: "dead" }));
  await reviewExecute(stand, sid, "goal", "recover stale lock");
  check("stale inter-process lock owner is recovered", Boolean(state(sid)?.goal) && !existsSync(lock), `${JSON.stringify(state(sid)?.goal)} lock=${existsSync(lock)}`);
  await reviewExecute(stand, sid, "goal", "drop");
  rmSync(lock, { recursive: true, force: true });
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  const oldMode = 0o755;
  chmodSync(STATE, 0o500);
  await reviewExecute(stand, sid, "goal", "write must propagate");
  chmodSync(STATE, oldMode);
  check("write error never produces a success message", !state(sid)?.goal && /не (сохранил|записал)|persist|write|lock/i.test(stand.said.at(-1) ?? ""), stand.said.at(-1));
  removeState(sid);
}
{
  const sid = nextSid();
  const env = { version: 2, sessionID: sid, revision: 1, goal: { token: "same-pid-other-module", ownerPid: process.pid, status: "active", objective: "same live process", prompt: "same live process", startedAt: Date.now(), updatedAt: Date.now(), turns: 0, tokensUsed: 0, usageBaseline: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, timeUsedSeconds: 0, lastAccountedAt: Date.now(), todos: [] } };
  writeFileSync(stateFile(sid), JSON.stringify(env));
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  check("same live process is not treated as cold by ownerInstance", state(sid)?.goal?.status === "active", JSON.stringify(state(sid)?.goal));
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid, toolTurn: true });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "goal", "transition race");
  await until(() => state(sid)?.goal?.status === "active", "transition race active");
  await Promise.all([reviewExecute(stand, sid, "goal", "pause"), reviewExecute(stand, sid, "goal", "drop")]);
  const transitionText = stand.said.slice(-2).join(" | ");
  const successCount = ["на паузе", "снята"].filter((part) => transitionText.includes(part)).length;
  check("serialized goal transitions report one winner", successCount === 1 && ["paused", "dropped"].includes(state(sid)?.goal?.status), JSON.stringify({ transitionText, status: state(sid)?.goal?.status }));
  removeState(sid);
}
{
  const sidA = nextSid();
  const sidB = nextSid();
  const a = makeReviewStand({ sessionID: sidA });
  const b = makeReviewStand({ sessionID: sidB });
  await installReview(a, sidA);
  await reviewExecute(a, sidA, "goal", "session A goal");
  await installReview(b, sidB);
  const createdOnB = await goalOp(b, sidB, { op: "create", objective: "must not be inferred from A" });
  check("global goal tool cannot create a goal in B from A's state", !state(sidB)?.goal && String(createdOnB.content?.[0]?.text).includes("interview"), JSON.stringify(createdOnB));
  await reviewExecute(a, sidA, "goal", "drop");
  removeState(sidA); removeState(sidB);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid, toolTurn: true });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "goal", "pause tool visibility");
  await reviewExecute(stand, sid, "goal", "pause");
  check("goal tool is removed on pause", !stand.tools.has("goal"), [...stand.tools.keys()].join(","));
  await reviewExecute(stand, sid, "goal", "resume");
  await reviewExecute(stand, sid, "goal", "drop");
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid, agent: "plan" });
  await installReview(stand, sid);
  let settingsReads = 0;
  stand.ctx.session.get = async () => ({ data: { tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } }, location: { directory: process.cwd() }, agent: "plan", get settings() { settingsReads += 1; return { goal: { enabled: false } }; } } });
  await reviewExecute(stand, sid, "goal", "public config only");
  check("goal does not read nonexistent session.info.settings", settingsReads === 0, String(settingsReads));
  await reviewExecute(stand, sid, "guided-goal", "must be blocked");
  check("guided-goal uses the same plan guard", !stand.tools.has("goal") && stand.said.at(-1)?.includes("plan"), stand.said.at(-1));
  removeState(sid);
}
{
  const root = mkdtempSync(join(tmpdir(), "modes-review-condition-"));
  const marker = join(root, "started");
  const release = join(root, "release");
  const childPid = join(root, "child.pid");
  const quote = (p) => `'${p.replaceAll("'", "'\\''")}'`;
  const command = `printf started > ${quote(marker)}; sleep 30 & child=$!; printf '%s' \"$child\" > ${quote(childPid)}; wait`;
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  process.env.MODES_CONDITION_TIMEOUT_MS = "5000";
  await reviewExecute(stand, sid, "loop", `1 --while ${quote(command)} body`);
  await until(() => existsSync(marker) && existsSync(childPid), "review condition child started");
  await reviewExecute(stand, sid, "loop", "off");
  writeFileSync(release, "go");
  await until(() => state(sid)?.loop === undefined || state(sid)?.loop?.status === "off", "review condition aborted");
  const pid = Number(readFileSync(childPid, "utf8"));
  await until(() => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      return state === "Z";
    } catch {
      return true;
    }
  }, "condition child process exits", 2000);
  let childAlive = true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    childAlive = state !== "Z";
  } catch { childAlive = false; }
  check("condition abort kills the child process tree", !childAlive, `pid=${pid}`);
  delete process.env.MODES_CONDITION_TIMEOUT_MS;
  rmSync(root, { recursive: true, force: true }); removeState(sid);
}
{
  const root = mkdtempSync(join(tmpdir(), "modes-review-manual-condition-"));
  const marker = join(root, "started");
  const release = join(root, "release");
  const quote = (p) => `'${p.replaceAll("'", "'\\''")}'`;
  const command = `printf started > ${quote(marker)}; while [ ! -f ${quote(release)} ]; do :; done; exit 0`;
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  process.env.MODES_CONDITION_TIMEOUT_MS = "5000";
  await reviewExecute(stand, sid, "loop", `1 --while ${quote(command)} old body`);
  await until(() => existsSync(marker), "manual condition started");
  stand.holdIdle();
  const manual = stand.injectUser("new body from condition");
  await until(() => state(sid)?.loop?.prompt === "new body from condition", "manual prompt replaced condition body");
  stand.releaseIdle();
  writeFileSync(release, "go");
  await manual;
  await immediate();
  check("manual prompt cancels an in-flight loop condition", stand.visible.filter((x) => x === "old body").length === 1 && state(sid)?.loop?.prompt === "new body from condition", JSON.stringify({ visible: stand.visible, loop: state(sid)?.loop }));
  await reviewExecute(stand, sid, "loop", "off");
  delete process.env.MODES_CONDITION_TIMEOUT_MS;
  rmSync(root, { recursive: true, force: true }); removeState(sid);
}
{
  const oldPause = process.env.MODES_ITERATION_PAUSE_MS;
  process.env.MODES_ITERATION_PAUSE_MS = "250";
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "loop", "2 old delay body");
  await until(() => (state(sid)?.loop?.used ?? 0) >= 1, "loop delay started");
  stand.holdIdle();
  const manual = stand.injectUser("new body from delay");
  await until(() => state(sid)?.loop?.prompt === "new body from delay", "manual prompt replaced delayed body");
  stand.releaseIdle();
  await manual;
  await immediate();
  check("manual prompt cancels the old delay iteration", stand.visible.filter((x) => x === "old delay body").length === 1, JSON.stringify(stand.visible));
  await reviewExecute(stand, sid, "loop", "off");
  if (oldPause === undefined) delete process.env.MODES_ITERATION_PAUSE_MS; else process.env.MODES_ITERATION_PAUSE_MS = oldPause;
  removeState(sid);
}
{
  const root = mkdtempSync(join(tmpdir(), "modes-review-manual-compact-"));
  const marker = join(root, "compact.started");
  const release = join(root, "compact.release");
  const script = join(root, "compact.sh");
  writeFileSync(script, `#!/usr/bin/env bash\nprintf started > '${marker}'\nwhile [ ! -f '${release}' ]; do :; done\n`);
  chmodSync(script, 0o755);
  const oldBin = process.env.MODES_OPENCODE_BIN;
  process.env.MODES_OPENCODE_BIN = script;
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "loop", "1 --compact old compact body");
  await until(() => existsSync(marker), "manual compact started");
  stand.holdIdle();
  const manual = stand.injectUser("new body from compact");
  await until(() => state(sid)?.loop?.prompt === "new body from compact", "manual prompt replaced compact body");
  stand.releaseIdle();
  writeFileSync(release, "go");
  await manual;
  await immediate();
  check("manual prompt cancels compact before the old submit", stand.visible.filter((x) => x === "old compact body").length === 1, JSON.stringify(stand.visible));
  await reviewExecute(stand, sid, "loop", "off");
  if (oldBin === undefined) delete process.env.MODES_OPENCODE_BIN; else process.env.MODES_OPENCODE_BIN = oldBin;
  rmSync(root, { recursive: true, force: true }); removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  const hasConditionTestApi = typeof plugin.__testing?.evaluateCondition === "function";
  check("condition test seam exists", hasConditionTestApi, typeof plugin.__testing);
  if (hasConditionTestApi) {
    const result = await plugin.__testing.evaluateCondition({ command: "printf 'x%.0s' {1..20000}; printf '\\nMARKER'; exit 2", until: false }, process.cwd(), sid, 1000);
    check("condition output is bounded but keeps a useful tail", result.out.length < 1000 && result.out.includes("MARKER"), JSON.stringify(result));
  }
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid, toolTurn: false });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "goal", "objective <unsafe> & todo </goal>");
  await goalOp(stand, sid, { op: "todo", action: "add", text: "todo <unsafe> & more" });
  await until(() => stand.hidden.length >= 1, "escaped continuation available");
  const hook = stand.hooks.get("context");
  const payload = { sessionID: sid, system: [] };
  hook?.(payload);
  const contextText = payload.system.map((part) => part.text).join("\n");
  const continuation = stand.hidden[0]?.text ?? "";
  check("objective and todo are XML escaped", contextText.includes("&lt;unsafe&gt; &amp;") && continuation.includes("&lt;unsafe&gt; &amp;"), JSON.stringify({ contextText, continuation }));
  check("continuation carries remaining budget, time, and audit rules", /remaining|остат/i.test(continuation) && /audit|аудит|evidence|доказ/i.test(continuation), continuation);
  await reviewExecute(stand, sid, "goal", "drop"); removeState(sid);
}
{
  for (const command of ["goal", "goal set", "goal budget"]) {
    const sid = nextSid();
    const stand = makeReviewStand({ sessionID: sid });
    await installReview(stand, sid);
    await reviewExecute(stand, sid, "goal", command.replace(/^goal\s*/, "") || "");
    check(`bare /${command} does not create a bogus objective`, !state(sid)?.goal && /нужна цель|нужен|budget|usage|формат/i.test(stand.said.at(-1) ?? ""), stand.said.at(-1));
    removeState(sid);
  }
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid, closeFirstStream: true, throwFirstStream: true });
  await installReview(stand, sid);
  await until(() => stand.subscribeCalls() >= 2, "event stream reconnect");
  check("event stream reconnects after close/error", stand.subscribeCalls() >= 2, String(stand.subscribeCalls()));
  check("setup returns a cleanup handle", typeof stand.cleanup === "function", typeof stand.cleanup);
  stand.cleanup?.();
  removeState(sid);
}
{
  const sid = nextSid();
  const gate = Promise.withResolvers();
  const stand = makeReviewStand({ sessionID: sid, deferReceipt: true, beforeTurn: () => gate.promise });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "goal", "tool accounting --tokens 10");
  await until(() => state(sid)?.goal?.turnInFlight === true, "goal turn held for accounting hook");
  const current = state(sid);
  current.goal.tokenBudget = 10;
  current.goal.tokensUsed = 0;
  current.goal.usageBaseline = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  current.goal.status = "active";
  current.goal.budgetNoticeGeneration = undefined;
  writeFileSync(stateFile(sid), JSON.stringify(current));
  stand.setTokens({ input: 20, output: 0, cache: { read: 0, write: 0 } });
  const accounting = stand.toolHooks.get("execute.after");
  await accounting?.({ sessionID: sid, tool: "read" });
  await accounting?.({ sessionID: sid, tool: "read" });
  const limited = state(sid)?.goal;
  check(
    "tool accounting: execute.after flushes usage and sends one budget steer",
    limited?.status === "budget-limited" && limited.tokensUsed >= 20 && stand.hidden.filter((item) => item.text.includes("BUDGET LIMIT")).length === 1,
    JSON.stringify({ goal: limited, hidden: stand.hidden.filter((item) => item.text.includes("BUDGET LIMIT")).length }),
  );
  gate.resolve();
  await immediate();
  await reviewExecute(stand, sid, "goal", "drop");
  removeState(sid);
}
{
  const sid = nextSid();
  const stand = makeReviewStand({ sessionID: sid });
  await installReview(stand, sid);
  await reviewExecute(stand, sid, "loop", "1 loop body");
  await until(() => state(sid)?.loop?.status === "off", "status loop completed");
  const current = state(sid);
  writeFileSync(stateFile(sid), JSON.stringify({ ...current, goal: { ...current.loop, status: "complete", objective: "terminal", prompt: "terminal", token: "terminal", kind: "goal" }, loop: { ...current.loop, status: "active", used: 1, reason: "still running" } }));
  await reviewExecute(stand, sid, "goal", "show");
  check("status shows active loop beside terminal goal", stand.said.at(-1)?.includes("loop"), stand.said.at(-1));
  removeState(sid);
}

rmSync(VIBE_STATE, { recursive: true, force: true });
if (failures.length) {
  console.log(`\nПРОВАЛОВ: ${failures.length}`);
  console.log(failures.join("\n"));
  try { console.log(readFileSync(process.env.MODES_LOG, "utf8").split("\n").slice(-40).join("\n")); } catch {}
  process.exit(1);
}
console.log("\nвсе проверки прошли");
