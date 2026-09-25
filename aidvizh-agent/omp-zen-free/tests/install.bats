#!/usr/bin/env bats
# Тесты omp-zen-free: установка расширения и поведение патча (заголовки, url, имена инструментов).
# Сети нет: fetch подменяется заглушкой; каталог агента подменяется (PI_CODING_AGENT_DIR).
# Запуск: bats tests/install.bats

setup() {
  STATION="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export STATION
  export OMP_AGENT_DIR="$BATS_TEST_TMPDIR/omp-agent"
  export PI_AGENT_DIR="$BATS_TEST_TMPDIR/pi-agent"
  unset PI_CODING_AGENT_DIR
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  cd "$BATS_TEST_TMPDIR"
}

@test "install кладёт симлинки: заголовки в omp и pi, /keys только в omp" {
  run bash "$STATION/install.sh"
  [ "$status" -eq 0 ]
  [ -L "$OMP_AGENT_DIR/extensions/zen-free-tier-headers.ts" ]
  [ -L "$PI_AGENT_DIR/extensions/zen-free-tier-headers.ts" ]
  [ -L "$OMP_AGENT_DIR/extensions/keys.ts" ]
  [ ! -e "$PI_AGENT_DIR/extensions/keys.ts" ]
  [ "$(readlink "$OMP_AGENT_DIR/extensions/zen-free-tier-headers.ts")" = "$STATION/zen-free-tier-headers.ts" ]

  run bash "$STATION/install.sh"
  [ "$status" -eq 0 ]
  [ "$(readlink "$PI_AGENT_DIR/extensions/zen-free-tier-headers.ts")" = "$STATION/zen-free-tier-headers.ts" ]
  [ "$(readlink "$OMP_AGENT_DIR/extensions/keys.ts")" = "$STATION/keys.ts" ]
}

@test "--omp и --pi ставят только в выбранный клиент" {
  run bash "$STATION/install.sh" --omp
  [ "$status" -eq 0 ]
  [ -L "$OMP_AGENT_DIR/extensions/zen-free-tier-headers.ts" ]
  [ -L "$OMP_AGENT_DIR/extensions/keys.ts" ]
  [ ! -e "$PI_AGENT_DIR/extensions/zen-free-tier-headers.ts" ]

  rm -rf "$OMP_AGENT_DIR"
  run bash "$STATION/install.sh" --pi
  [ "$status" -eq 0 ]
  [ ! -e "$OMP_AGENT_DIR/extensions/zen-free-tier-headers.ts" ]
  [ ! -e "$OMP_AGENT_DIR/extensions/keys.ts" ]
  [ -L "$PI_AGENT_DIR/extensions/zen-free-tier-headers.ts" ]
}

@test "dry-run показывает план и ничего не пишет" {
  run bash "$STATION/install.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"будет:"* ]]
  [ ! -e "$OMP_AGENT_DIR/extensions/zen-free-tier-headers.ts" ]
  [ ! -e "$PI_AGENT_DIR/extensions/zen-free-tier-headers.ts" ]
}

@test "занятый файл не подменяется молча" {
  mkdir -p "$OMP_AGENT_DIR/extensions"
  printf 'чужое\n' >"$OMP_AGENT_DIR/extensions/zen-free-tier-headers.ts"
  run bash "$STATION/install.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"занято"* ]]
  [ "$(cat "$OMP_AGENT_DIR/extensions/zen-free-tier-headers.ts")" = "чужое" ]
}

@test "патч правит url, заголовки и добивает имена инструментов" {
  run node --input-type=module -e '
    const calls = [];
    globalThis.fetch = async (input, init) => { calls.push({ input, init }); return new Response("{}", { status: 200 }); };
    await import(process.argv[1]);
    await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "m", messages: [], tools: [] }),
    });
    const call = calls[0];
    const url = typeof call.input === "string" ? call.input : call.input.url;
    const headers = new Headers(call.init.headers);
    const body = JSON.parse(call.init.body);
    console.log(JSON.stringify({
      url,
      ua: headers.get("user-agent"),
      client: headers.get("x-opencode-client"),
      session: headers.get("x-opencode-session"),
      names: (body.tools || []).map((t) => (t.function ? t.function.name : t.name)),
    }));
  ' "$STATION/zen-free-tier-headers.ts"
  [ "$status" -eq 0 ]
  # живой шлюз: /zen/go работает, перезапись URL по умолчанию выключена
  [ "$(printf '%s' "$output" | jq -r .url)" = "https://opencode.ai/zen/go/v1/chat/completions" ]
  [ "$(printf '%s' "$output" | jq -r .ua)" = "opencode/1.18.31" ]
  [ "$(printf '%s' "$output" | jq -r .client)" = "desktop" ]
  [[ "$(printf '%s' "$output" | jq -r .session)" =~ ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$ ]]
  [ "$(printf '%s' "$output" | jq -r '[.names[] | select(. == "bash" or . == "read")] | length')" = "2" ]
}

@test "перезапись url включается только по ZEN_REWRITE_URL=1" {
  run env ZEN_REWRITE_URL=1 node --input-type=module -e '
    const calls = [];
    globalThis.fetch = async (input, init) => { calls.push({ input, init }); return new Response("{}", { status: 200 }); };
    await import(process.argv[1]);
    await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [], tools: [] }),
    });
    console.log(typeof calls[0].input === "string" ? calls[0].input : calls[0].input.url);
  ' "$STATION/zen-free-tier-headers.ts"
  [ "$status" -eq 0 ]
  [ "$output" = "https://opencode.ai/inference/openai/v1/chat/completions" ]
}

@test "чужие хосты патч не трогает" {
  run node --input-type=module -e '
    const calls = [];
    globalThis.fetch = async (input, init) => { calls.push({ input, init }); return new Response("{}", { status: 200 }); };
    await import(process.argv[1]);
    await fetch("https://example.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [], tools: [] }),
    });
    const call = calls[0];
    const headers = new Headers(call.init.headers);
    console.log(JSON.stringify({
      url: typeof call.input === "string" ? call.input : call.input.url,
      ua: headers.get("user-agent"),
      client: headers.get("x-opencode-client"),
      session: headers.get("x-opencode-session"),
    }));
  ' "$STATION/zen-free-tier-headers.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .url)" = "https://example.com/v1/chat/completions" ]
  [ "$(printf '%s' "$output" | jq -r .ua)" = "null" ]
  [ "$(printf '%s' "$output" | jq -r .client)" = "null" ]
  [ "$(printf '%s' "$output" | jq -r .session)" = "null" ]
}

@test "keys.ts: add/list/disable/enable/remove на своей базе (нужен bun)" {
  command -v bun >/dev/null 2>&1 || skip "bun не установлен"
  local db="$BATS_TEST_TMPDIR/keys.db"
  cat >"$BATS_TEST_TMPDIR/schema.ts" <<'TS'
import { Database } from "bun:sqlite";
const db = new Database(process.env.OMP_KEYS_DB!);
db.run(`CREATE TABLE auth_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  data TEXT NOT NULL,
  disabled_cause TEXT DEFAULT NULL,
  identity_key TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
)`);
TS
  export OMP_KEYS_DB="$db" OMP_KEYS_SKIP_PROBE=1
  run bun "$BATS_TEST_TMPDIR/schema.ts"
  [ "$status" -eq 0 ]

  run bun "$STATION/keys.ts" list
  [ "$status" -eq 0 ]
  [ "$output" = "ключей нет" ]

  run bun "$STATION/keys.ts" add opencode-go sk-test-1234567890
  [ "$status" -eq 0 ]
  [[ "$output" == *"добавлен #1"* ]]

  run bun "$STATION/keys.ts" list
  [[ "$output" == *"sk-tes…7890"* ]]
  [[ "$output" == *"активен"* ]]

  run bun "$STATION/keys.ts" disable 1 тест-причина
  [[ "$output" == *"отключён"* ]]
  run bun "$STATION/keys.ts" list
  [[ "$output" == *"ОТКЛЮЧЁН (тест-причина)"* ]]

  run bun "$STATION/keys.ts" enable 1
  [[ "$output" == *"включён"* ]]

  run bun "$STATION/keys.ts" remove 1
  [[ "$output" == *"удалён"* ]]
  run bun "$STATION/keys.ts" list
  [ "$output" = "ключей нет" ]
}

@test "расширение регистрирует команду keys" {
  command -v bun >/dev/null 2>&1 || skip "bun не установлен"
  run bun -e "import ext from '$STATION/keys.ts'; const seen = {}; ext({ registerCommand: (n) => { seen[n] = true; } }); console.log(Object.keys(seen).join(','));"
  [ "$status" -eq 0 ]
  [ "$output" = "keys" ]
}

@test "отказ по деньгам закрывает ключ в сторе, соседний не трогает (нужен bun)" {
  command -v bun >/dev/null 2>&1 || skip "bun не установлен"
  local db="$BATS_TEST_TMPDIR/burn.db"
  cat >"$BATS_TEST_TMPDIR/burn-schema.ts" <<'TS'
import { Database } from "bun:sqlite";
const db = new Database(process.env.OMP_KEYS_DB!);
db.run(`CREATE TABLE auth_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  data TEXT NOT NULL,
  disabled_cause TEXT DEFAULT NULL,
  identity_key TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
)`);
for (const key of ["sk-burn-1", "sk-keep-2"]) {
  db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('opencode-go','api_key', ?)", [
    JSON.stringify({ key, source: "login" }),
  ]);
}
TS
  run env OMP_KEYS_DB="$db" bun "$BATS_TEST_TMPDIR/burn-schema.ts"
  [ "$status" -eq 0 ]

  cat >"$BATS_TEST_TMPDIR/burn-run.ts" <<'TS'
import { Database } from "bun:sqlite";
const BODY = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: Insufficient account funds" } });
globalThis.fetch = async () => new Response(BODY, { status: 402 });
await import(process.env.EXT!);
const response = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer sk-burn-1" },
  body: JSON.stringify({ model: "m", messages: [], tools: [] }),
});
const db = new Database(process.env.OMP_KEYS_DB!);
const read = () => db.query("SELECT id, disabled_cause FROM auth_credentials ORDER BY id").all() as Array<{ id: number; disabled_cause: string | null }>;
for (let i = 0; i < 60 && !read()[0].disabled_cause; i += 1) await new Promise((r) => setTimeout(r, 50));
console.log(JSON.stringify({ status: response.status, rows: read() }));
TS
  run env OMP_KEYS_DB="$db" EXT="$STATION/zen-free-tier-headers.ts" bun "$BATS_TEST_TMPDIR/burn-run.ts"
  [ "$status" -eq 0 ]
  local json="$output"
  # ответ ушёл вызывающему как есть
  [ "$(printf '%s' "$json" | jq -r .status)" = "402" ]
  # ключ, которым ушёл запрос, закрыт с причиной; соседний не тронут.
  # Дата в причине — UTC (так же её пишет keys.ts), поэтому и сверяем через date -u:
  # локальные сутки и UTC расходятся в окне 00:00–03:00 МСК, и локальная дата ловила бы это как поломку.
  [ "$(printf '%s' "$json" | jq -r '.rows[0].disabled_cause')" = "запрос $(date -u +%F): нет баланса (402)" ]
  [ "$(printf '%s' "$json" | jq -r '.rows[1].disabled_cause')" = "null" ]
}

@test "успех и ZEN_DISABLE_BURNED=0 стор не трогают (нужен bun)" {
  command -v bun >/dev/null 2>&1 || skip "bun не установлен"
  local db="$BATS_TEST_TMPDIR/keep.db"
  cat >"$BATS_TEST_TMPDIR/keep-schema.ts" <<'TS'
import { Database } from "bun:sqlite";
const db = new Database(process.env.OMP_KEYS_DB!);
db.run(`CREATE TABLE auth_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  data TEXT NOT NULL,
  disabled_cause TEXT DEFAULT NULL,
  identity_key TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
)`);
db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('opencode-go','api_key', ?)", [
  JSON.stringify({ key: "sk-keep-2", source: "login" }),
]);
TS
  cat >"$BATS_TEST_TMPDIR/keep-run.ts" <<'TS'
import { Database } from "bun:sqlite";
const FUNDS = JSON.stringify({ error: { type: "server_error", message: "402 Upstream request failed: Insufficient account funds" } });
const status = Number(process.env.STUB_STATUS ?? 402);
globalThis.fetch = async () => new Response(status === 402 ? FUNDS : "{}", { status });
await import(process.env.EXT!);
await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer sk-keep-2" },
  body: JSON.stringify({ model: "m", messages: [], tools: [] }),
});
await new Promise((r) => setTimeout(r, 300));
const db = new Database(process.env.OMP_KEYS_DB!);
console.log(JSON.stringify(db.query("SELECT disabled_cause FROM auth_credentials").all()));
TS

  run env OMP_KEYS_DB="$db" bun "$BATS_TEST_TMPDIR/keep-schema.ts"
  [ "$status" -eq 0 ]

  # 200 — не наш случай
  run env OMP_KEYS_DB="$db" EXT="$STATION/zen-free-tier-headers.ts" STUB_STATUS=200 bun "$BATS_TEST_TMPDIR/keep-run.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.[0].disabled_cause')" = "null" ]

  # 402, но выключатель опущен
  run env OMP_KEYS_DB="$db" EXT="$STATION/zen-free-tier-headers.ts" STUB_STATUS=402 ZEN_DISABLE_BURNED=0 \
    bun "$BATS_TEST_TMPDIR/keep-run.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.[0].disabled_cause')" = "null" ]
}

@test "в проекте нет абсолютных путей" {
  local checker="$STATION/../skills-hub/contrib/check-paths.sh"
  [[ -f "$checker" ]] || skip "сканер хаба не найден"
  run bash "$checker" "$STATION"
  [ "$status" -eq 0 ]
  [[ "$output" == *"чисто"* ]]
}
