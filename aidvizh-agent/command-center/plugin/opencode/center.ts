/**
 * Плагин центра для opencode2.
 *
 * Регистрирует слэш-команду `/center <подкоманда>` через публичный API плагинов
 * (`context.command.transform` → `editor.add`), а вывод отдаёт синтетическим
 * сообщением (`context.session.synthetic`, `resume: false`) — оно видно в
 * транскрипте, но не вызывает модель. Это ровно та схема, которой пользуется
 * встроенный плагин `opencode.config.command`.
 *
 * Сводки на старте здесь нет намеренно: у promise-плагинов opencode нет ни
 * статусной строки, ни уведомлений — только сообщение в сессии, а оно бы в
 * каждой сессии мусорило транскрипт. Сводку показывает `/center status`.
 *
 * Ядро грузится динамикой по своему реальному пути — так один и тот же код
 * работает у всех трёх клиентов, независимо от того, от какого каталога
 * загрузчик считает относительные импорты.
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command, CommandResult } from "../lib/center.ts";

/** Что плагин берёт из ядра. Тип объявлен здесь намеренно: ядро грузится динамикой. */
type Core = {
  COMMANDS: Command[];
  runCommand: (input: string) => Promise<CommandResult>;
};

type CommandInput = {
  sessionID: string;
  /** Текст, набранный после имени команды: `/center status` → "status". */
  prompt?: { text?: string };
};

type CommandDefinition = {
  name: string;
  description?: string;
  execute: (input: CommandInput) => Promise<void>;
};

type PluginContext = {
  command: {
    transform(callback: (editor: { add(definition: CommandDefinition): void }) => void): Promise<unknown> | unknown;
  };
  session: {
    synthetic(input: { sessionID: string; text: string; description?: string; resume?: boolean }): Promise<unknown>;
  };
};

/** Ядро рядом с этим файлом: `plugin/opencode/` → `plugin/lib/center.ts`. */
async function loadCore(): Promise<Core> {
  const self = realpathSync(fileURLToPath(import.meta.url));
  const target = pathToFileURL(join(dirname(self), "..", "lib", "center.ts")).href;
  return (await import(target)) as Core;
}

export default {
  id: "command-center.plugin",
  setup: async (context: PluginContext) => {
    const { COMMANDS, runCommand } = await loadCore();
    await context.command.transform((editor) => {
      editor.add({
        name: "center",
        description: `Команды центра: ${COMMANDS.map((command) => command.name).join(" | ")}`,
        execute: async (input) => {
          const result = await runCommand(input.prompt?.text ?? "");
          await context.session.synthetic({
            sessionID: input.sessionID,
            text: result.text,
            description: result.ok ? "center" : "center (ошибка)",
            resume: false,
          });
        },
      });
    });
  },
};
