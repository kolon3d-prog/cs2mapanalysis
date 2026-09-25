if (process.env.VIBE_NATIVE_PROBE !== "1") {
  console.error("Set VIBE_NATIVE_PROBE=1 to run the native OpenCode2 API contract probe.");
  process.exit(2);
}

function api(method, path) {
  const result = Bun.spawnSync(["opencode2", "api", method, path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`${method} ${path} failed (${result.exitCode}): ${stderr || stdout}`);
  }
  return JSON.parse(stdout);
}

const openapi = api("GET", "/openapi.json");
const paths = openapi?.paths ?? {};
const operations = new Set(
  Object.values(paths).flatMap((path) =>
    Object.values(path).map((operation) => operation?.operationId).filter(Boolean),
  ),
);
const requiredOperations = [
  "session.get",
  "session.context",
  "session.prompt",
  "session.command",
  "event.subscribe",
  "skill.list",
  "model.default",
];
const requiredOperationAliases = new Map([
  ["session.wait", ["session.wait", "experimental.session.wait"]],
]);
const missing = requiredOperations
  .filter((operation) => !operations.has(operation))
  .concat(
    [...requiredOperationAliases]
      .filter(([operation, aliases]) => !aliases.some((alias) => operations.has(alias)))
      .map(([operation]) => operation),
  );
if (missing.length > 0) {
  throw new Error(`OpenCode2 public operations missing: ${missing.join(", ")}`);
}

const skills = api("GET", "/api/skill");
const active = api("GET", "/api/session/active");
if (!Array.isArray(skills?.data)) throw new Error("GET /api/skill did not return data[]");
if (!active?.data || typeof active.data !== "object") throw new Error("GET /api/session/active did not return data");

console.log(
  `ok native API probe: operations=${requiredOperations.length} skills=${skills.data.length} active=${Object.keys(active.data).length}`,
);
