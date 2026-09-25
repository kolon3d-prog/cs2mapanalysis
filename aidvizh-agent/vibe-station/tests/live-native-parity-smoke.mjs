if (process.env.VIBE_NATIVE_PARITY !== "1") {
  console.error("Set VIBE_NATIVE_PARITY=1 to run the disposable native parity smoke.");
  process.exit(2);
}

function api(method, path, body) {
  const args = ["opencode2", "api", method, path];
  if (body !== undefined) args.push("--data", JSON.stringify(body));
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) throw new Error(`${method} ${path}: ${stderr || stdout}`);
  return stdout ? JSON.parse(stdout) : undefined;
}

function data(response) {
  return response?.data;
}

let sessionID;
try {
  const activeBefore = data(api("GET", "/api/session/active")) ?? {};
  if (process.env.VIBE_NATIVE_RESTART === "1") {
    if (Object.keys(activeBefore).length > 0) {
      console.log(`restart probe skipped: active sessions=${Object.keys(activeBefore).join(",")}`);
    } else {
      const restart = Bun.spawnSync(["opencode2", "service", "restart"], { stdout: "pipe", stderr: "pipe" });
      if (restart.exitCode !== 0) throw new Error(`service restart failed: ${restart.stderr.toString().trim()}`);
      const afterRestart = data(api("GET", "/api/session/active"));
      console.log(`restart probe completed: activeAfter=${Object.keys(afterRestart ?? {}).length}`);
    }
  } else {
    console.log(`restart probe skipped: set VIBE_NATIVE_RESTART=1 only when no active sessions (currently ${Object.keys(activeBefore).length})`);
  }

  const created = data(api("POST", "/api/session", {
    title: "vibe-native-parity-smoke",
    agent: "build",
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    location: { directory: "/tmp/opencode" },
  }));
  sessionID = created?.id;
  if (!sessionID) throw new Error("session.create did not return an id");
  api("POST", `/api/session/${sessionID}/prompt`, {
    text: "Reply with exactly OK. Do not use tools or modify files.",
  });
  api("POST", `/api/experimental/session/${sessionID}/wait`);
  const context = data(api("GET", `/api/session/${sessionID}/context`)) ?? [];
  const assistant = [...context].reverse().find((message) => message?.type === "assistant");
  const usage = assistant?.tokens;
  const duration = assistant?.time?.completed - assistant?.time?.created;
  if (!usage || typeof usage.output !== "number" || typeof duration !== "number" || duration < 100) {
    throw new Error("native assistant usage/timestamps unavailable");
  }
  const rate = (usage.output * 1000) / duration;
  console.log(`ok native usage smoke: session=${sessionID} output=${usage.output} duration=${duration}ms tok/s=${rate}`);
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
