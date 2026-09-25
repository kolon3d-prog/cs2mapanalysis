import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;

/** Минимум ExtensionAPI, который нужен этому расширению — так его можно проверить и без pi. */
export type CommandContext = {
  sessionManager: { getSessionId(): string };
  ui: { notify(text: string, level?: string): void };
};
export type ExtensionHost = {
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: CommandContext) => Promise<void> | void },
  ): void;
  on(
    event: "before_provider_request",
    handler: (event: { payload: unknown }, ctx: CommandContext) => Promise<unknown> | unknown,
  ): unknown;
};

// файл обычно поставлен симлинком: идём по нему до реального места, иначе относительные пути врут
const SELF = (() => {
  const own = fileURLToPath(import.meta.url);
  try {
    return realpathSync(own);
  } catch {
    return own;
  }
})();
const HERE = dirname(SELF);
/** Каталог прошивок: считаем от файла расширения (или от PERSONA_DIR для тестов) — абсолютных путей нет. */
export const PERSONAS_DIR =
  process.env.PERSONA_DIR ||
  ["../../personas", "../../../personas", "../../../../personas"]
    .map((rel) => join(HERE, rel))
    .find((dir) => {
      try {
        return readdirSync(dir).length > 0;
      } catch {
        return false;
      }
    }) ||
  join(HERE, "../../personas");

/** Активная персона на сессию: одна на сессию, не стопка. */
const active = new Map<string, string>();

const OFF = /^(off|clear|--clear|none)$/i;
const EMPTY_HINT = "persona: формат — /persona <имя>, /persona off (снять), /persona (список).";

function listPersonas(): string[] {
  try {
    return readdirSync(PERSONAS_DIR)
      .filter((file) => file.endsWith(".txt") || file.endsWith(".md"))
      .map((file) => file.replace(/\.(txt|md)$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function readPersona(name: string): string | undefined {
  for (const ext of [".txt", ".md"]) {
    try {
      return readFileSync(join(PERSONAS_DIR, `${name}${ext}`), "utf8");
    } catch {
      /* пробуем следующее расширение */
    }
  }
  return undefined;
}

/** Тот же контракт, что у sysprompt: текст уезжает системным сообщением перед первым user-сообщением. */
function inject(payload: unknown, text: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const p = payload as Json;

  if (typeof p.system === "string") return { ...p, system: p.system + "\n" + text };
  if (Array.isArray(p.system)) return { ...p, system: [...(p.system as Json[]), { type: "text", text }] };

  if (Array.isArray(p.messages)) {
    const messages = p.messages as Json[];
    let at = 0;
    while (at < messages.length) {
      const role = messages[at]?.role;
      if (role !== "system" && role !== "developer") break;
      at++;
    }
    return { ...p, messages: [...messages.slice(0, at), { role: "system", content: text }, ...messages.slice(at)] };
  }

  if (typeof p.instructions === "string") return { ...p, instructions: p.instructions + "\n" + text };

  return undefined;
}

/** Точка входа расширения: omp и pi зовут её с своим ExtensionAPI (структурно совпадает). */
export default function persona(pi: ExtensionHost) {
  pi.registerCommand("persona", {
    description: "Сменить персону на ходу: /persona <имя> | off | (пусто — список)",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const text = (args ?? "").trim();

      if (OFF.test(text)) {
        active.delete(sessionId);
        ctx.ui.notify("persona: снята, дальше отвечаю своим промтом.", "info");
        return;
      }

      if (!text) {
        const names = listPersonas();
        const current = active.get(sessionId);
        ctx.ui.notify(
          names.length
            ? `persona: сейчас ${current ?? "никакая"}. Есть: ${names.join(", ")}. /persona <имя>, /persona off`
            : `persona: каталог прошивок пуст (${PERSONAS_DIR})`,
          "info",
        );
        return;
      }

      const persona = readPersona(text);
      if (!persona) {
        ctx.ui.notify(`persona: нет прошивки ${text}. Есть: ${listPersonas().join(", ") || "ничего"}`, "warn");
        return;
      }
      active.set(sessionId, text);
      ctx.ui.notify(`persona: включена «${text}» (${persona.length} симв.). Снять — /persona off`, "info");
    },
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const name = active.get(ctx.sessionManager.getSessionId());
    if (!name) return undefined;
    const persona = readPersona(name);
    if (!persona) return undefined;
    return inject(event.payload, `<system-reminder>\n${persona}\n</system-reminder>`);
  });
}
