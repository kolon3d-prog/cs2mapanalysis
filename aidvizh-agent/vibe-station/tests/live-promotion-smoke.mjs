import { mkdirSync } from "node:fs";

if (process.env.VIBE_LIVE_PROMOTION !== "1") {
  console.error("Set VIBE_LIVE_PROMOTION=1 to run the disposable OpenCode2 promotion smoke.");
  process.exit(2);
}

const service = Bun.spawnSync(["opencode2", "service", "status"], { stdout: "pipe", stderr: "pipe" });
if (service.exitCode !== 0) {
  throw new Error(`opencode2 service status failed: ${service.stderr.toString().trim()}`);
}
if (!/https?:\/\/[^\s]+/.test(service.stdout.toString())) {
  throw new Error(`OpenCode2 service status did not return a server URL: ${service.stdout.toString().trim()}`);
}

mkdirSync("/tmp/opencode", { recursive: true });
let sessionID;
let cleanupError;

function api(method, path, body) {
  const args = ["api", method, path];
  if (body !== undefined) args.push("--data", JSON.stringify(body));
  const result = Bun.spawnSync(["opencode2", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`${method} ${path} failed (${result.exitCode}): ${stderr || stdout}`);
  }
  return stdout ? JSON.parse(stdout) : undefined;
}

function data(response) {
  return response?.data;
}

function permissionRules(agentID) {
  const info = data(api("GET", `/api/agent/${agentID}`));
  return Array.isArray(info?.permissions) ? info.permissions : [];
}

const auditRules = permissionRules("vibe-audit-fast");
const codingRules = permissionRules("vibe-fast");
const lastRule = (rules, action) => rules.filter((rule) => rule?.action === action && rule?.resource === "*").at(-1);
if (lastRule(auditRules, "*")?.effect !== "deny" || lastRule(auditRules, "read")?.effect !== "allow" || lastRule(auditRules, "question")?.effect !== "allow") {
  throw new Error("vibe-audit-fast effective permissions are not read-only");
}
if (lastRule(codingRules, "*")?.effect !== "allow") {
  throw new Error("vibe-fast is not full-access under the effective wildcard rule");
}

const historyOnly = (messages) => (Array.isArray(messages) ? messages : []).filter(
  (message) => message?.type !== "model-switched" && message?.type !== "agent-switched",
);

try {
  const created = data(api("POST", "/api/session", {
    title: "vibe-promotion-smoke",
    agent: "vibe-audit-fast",
    location: { directory: "/tmp/opencode" },
  }));
  sessionID = created?.id;
  if (typeof sessionID !== "string" || !sessionID) throw new Error("session.create did not return an id");

  const before = data(api("GET", `/api/session/${sessionID}/context`));
  api("POST", `/api/session/${sessionID}/model`, {
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
  });
  api("POST", `/api/session/${sessionID}/agent`, { agent: "vibe-fast" });
  const session = data(api("GET", `/api/session/${sessionID}`));
  const after = data(api("GET", `/api/session/${sessionID}/context`));

  if (session?.agent !== "vibe-fast") throw new Error(`expected agent vibe-fast, got ${session?.agent ?? "unknown"}`);
  if (JSON.stringify(historyOnly(before)) !== JSON.stringify(historyOnly(after))) {
    console.error(`history before=${JSON.stringify(historyOnly(before))}`);
    console.error(`history after=${JSON.stringify(historyOnly(after))}`);
    throw new Error("session history changed during native agent switch");
  }

  console.log(`ok native promotion smoke: session=${sessionID} agent=${session.agent} history preserved; effective audit/coding permissions verified`);
} finally {
  if (sessionID) {
    try {
      api("DELETE", `/api/session/${sessionID}`);
      console.log(`cleaned disposable session ${sessionID}`);
    } catch (error) {
      cleanupError = error;
      console.error(`cleanup failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (cleanupError) process.exitCode = 1;
