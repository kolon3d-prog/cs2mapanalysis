import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type Json = Record<string, unknown>;

const buffers = new Map<string, string[]>();

const RESET = /^(clear|--clear)$/i;
const EMPTY_HINT = "sysprompt: текст пустой. Формат: /prompt <текст>, сброс: /prompt clear.";
const CLEARED = "sysprompt: буфер очищен.";

function inject(payload: unknown, text: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const p = payload as Json;

  if (typeof p.system === "string") return { ...p, system: p.system + "\n" + text };
  if (Array.isArray(p.system)) return { ...p, system: [...(p.system as Json[]), { type: "text", text }] };

  const systemInstruction = p.systemInstruction;
  if (systemInstruction && typeof systemInstruction === "object" && !Array.isArray(systemInstruction)) {
    const parts = (systemInstruction as Json).parts;
    if (Array.isArray(parts)) {
      return { ...p, systemInstruction: { ...(systemInstruction as Json), parts: [...(parts as Json[]), { text }] } };
    }
  }

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

export default function sysprompt(pi: ExtensionAPI) {
  pi.registerCommand("prompt", {
    description: "Вставить текст в системный контекст сессии (sysprompt)",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const text = (args ?? "").trim();

      if (RESET.test(text)) {
        buffers.delete(sessionId);
        ctx.ui.notify(CLEARED, "info");
        return;
      }
      if (!text) {
        ctx.ui.notify(EMPTY_HINT, "info");
        return;
      }

      const blocks = buffers.get(sessionId) ?? [];
      blocks.push(text);
      buffers.set(sessionId, blocks);
      ctx.ui.notify(`sysprompt: добавлено (блоков: ${blocks.length}, ${text.length} симв.)`, "info");
    },
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const blocks = buffers.get(ctx.sessionManager.getSessionId());
    if (!blocks || blocks.length === 0) return undefined;
    return inject(
      event.payload,
      blocks.map((text) => `<system-reminder>\n${text}\n</system-reminder>`).join("\n"),
    );
  });
}
