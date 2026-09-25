if (process.env.VIBE_NATIVE_SKILL_SMOKE !== "1") {
  console.error("Set VIBE_NATIVE_SKILL_SMOKE=1 and VIBE_NATIVE_SKILL_ID=<id> to run the disposable skill smoke.");
  process.exit(2);
}
const skillID = process.env.VIBE_NATIVE_SKILL_ID?.trim();
if (!skillID) throw new Error("VIBE_NATIVE_SKILL_ID is required");

function api(method, path, body) {
  const args = ["opencode2", "api", method, path];
  if (body !== undefined) args.push("--data", JSON.stringify(body));
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) throw new Error(`${method} ${path}: ${stderr || stdout}`);
  return stdout ? JSON.parse(stdout) : undefined;
}

const skills = api("GET", "/api/skill")?.data;
if (!Array.isArray(skills) || !skills.some((skill) => skill?.id === skillID)) {
  throw new Error(`skill not found: ${skillID}`);
}

let sessionID;
try {
  const created = api("POST", "/api/session", {
    title: "vibe-native-skill-smoke",
    agent: "build",
    location: { directory: "/tmp/opencode" },
  })?.data;
  sessionID = created?.id;
  if (!sessionID) throw new Error("session.create did not return an id");
  const admitted = api("POST", `/api/session/${sessionID}/prompt`, {
    text: "Read the attached skill and reply with OK. Do not modify files or run commands.",
    skills: [{ id: skillID }],
  });
  if (!admitted) throw new Error("skill prompt admission returned no response");
  console.log(`ok native skill admission: session=${sessionID} skill=${skillID}`);
} finally {
  if (sessionID) {
    try {
      api("DELETE", `/api/session/${sessionID}`);
      console.log(`cleaned disposable session ${sessionID}`);
    } catch (error) {
      console.error(`cleanup failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
