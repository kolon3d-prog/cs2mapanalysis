/**
 * Расширение центра для omp и pi (один файл: их ExtensionAPI совпадает).
 *
 * Регистрирует слэш-команду `/center <подкоманда>` — она зовёт центр и показывает
 * его вывод как есть — и наполняет статусную строку дешёвой сводкой на старте
 * сессии (сводка считается локально из файлов, без спавна станций).
 *
 * Логику не дублирует: ядро в `lib/center.ts` грузится динамикой по реальному
 * пути файла — расширение обычно стоит симлинком в каталоге клиента, и статический
 * импорт `../lib/center.ts` считался бы от каталога ссылки, а не от станции.
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command, CommandResult, Summary } from "../lib/center.ts";

/** Что расширение берёт из ядра. Тип объявлен здесь намеренно: ядро грузится динамикой. */
type Core = {
  COMMANDS: Command[];
  runCommand: (input: string) => Promise<CommandResult>;
  summary: () => Summary;
};

type CommandContext = {
  hasUI?: boolean;
  ui?: {
    notify(text: string, level?: string): void;
    setStatus(key: string, text?: string): void;
  };
};

type ExtensionHost = {
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: CommandContext) => Promise<void> | void },
  ): void;
  on(event: "session_start", handler: (event: unknown, ctx: CommandContext) => unknown): unknown;
};

/** Ядро рядом с этим файлом: `plugin/agent/` → `plugin/lib/center.ts` (по реальному пути, не по ссылке). */
async function loadCore(): Promise<Core> {
  const self = realpathSync(fileURLToPath(import.meta.url));
  const target = pathToFileURL(join(dirname(self), "..", "lib", "center.ts")).href;
  return (await import(target)) as Core;
}

export default async function center(pi: ExtensionHost) {
  const { COMMANDS, runCommand, summary } = await loadCore();

  pi.registerCommand("center", {
    description: `Команды центра: ${COMMANDS.map((command) => command.name).join(" | ")}`,
    handler: async (args, ctx) => {
      const result = await runCommand(args ?? "");
      ctx.ui?.notify(result.text, result.ok ? "info" : "warn");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.ui?.setStatus) return undefined;
    try {
      ctx.ui.setStatus("center", summary().line);
    } catch {
      /* сводка не должна ронять старт сессии */
    }
    return undefined;
  });
}
