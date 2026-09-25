import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
/** Каталог прошивок: считаем от файла плагина (или от PERSONA_DIR в тестах) — абсолютных путей нет. */
const PERSONAS_DIR =
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
  join(HERE, "../../../../personas");

/** Активная персона на сессию: одна, не стопка. */
const active = new Map<string, string>();

const PATTERN = /<persona>([\s\S]*?)<\/persona>/
const OFF = /^(off|clear|--clear|none)$/i;

function names(): string[] {
  try {
    return readdirSync(PERSONAS_DIR)
      .filter((file) => file.endsWith(".txt") || file.endsWith(".md"))
      .map((file) => file.replace(/\.(txt|md)$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function read(name: string): string | undefined {
  for (const ext of [".txt", ".md"]) {
    try {
      return readFileSync(join(PERSONAS_DIR, `${name}${ext}`), "utf8");
    } catch {
      /* пробуем следующее расширение */
    }
  }
  return undefined;
}

type PromptInput = { sessionID: string; prompt: { text: string } };
type ContextInput = { sessionID: string; system: { type?: string; text: string }[] };
type SessionHooks = {
  hook(event: "prompt", handler: (input: PromptInput) => void): Promise<unknown>;
  hook(event: "context", handler: (input: ContextInput) => void): Promise<unknown>;
};

export default {
  id: "persona",
  setup: async (context: { session: SessionHooks }) => {
    await context.session.hook("prompt", (input) => {
      const match = PATTERN.exec(input.prompt?.text ?? "");
      if (!match) return;
      const requested = (match[1] ?? "").trim();

      if (OFF.test(requested)) {
        active.delete(input.sessionID);
        input.prompt.text = "persona: снята, дальше отвечаю своим промтом.";
        return;
      }
      if (!requested) {
        const current = active.get(input.sessionID);
        input.prompt.text = `persona: сейчас ${current ?? "никакая"}. Есть: ${names().join(", ") || "ничего"}. Формат: /persona <имя>, снять — /persona off`;
        return;
      }
      const text = read(requested);
      if (!text) {
        input.prompt.text = `persona: нет прошивки ${requested}. Есть: ${names().join(", ") || "ничего"}`;
        return;
      }
      active.set(input.sessionID, requested);
      input.prompt.text = `persona: включена «${requested}» (${text.length} симв.). Снять — /persona off`;
    });

    await context.session.hook("context", (input) => {
      const name = active.get(input.sessionID);
      if (!name) return;
      const text = read(name);
      if (!text) return;
      input.system.push({ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` });
    });
  },
};
