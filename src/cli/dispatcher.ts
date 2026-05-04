import type { StartupOptions } from "../cli.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "pino";
import { closeDb } from "../db/client.js";

export interface OperatorCommandContext {
  startup: StartupOptions;
  config: AppConfig;
  logger: Logger;
}

export interface OperatorCommand {
  /** Returns true if this command should run for the given startup options. */
  matches(startup: StartupOptions): boolean;
  /** Executes the command. Sets process.exitCode when appropriate. */
  run(ctx: OperatorCommandContext): Promise<void>;
}

/**
 * Dispatches to the first matching operator command.
 *
 * Returns true if a command matched and ran — caller should close the DB and
 * return from main(). Returns false when no operator command matched and normal
 * server startup should continue.
 */
export async function dispatchOperatorCommand(ctx: OperatorCommandContext): Promise<boolean> {
  const { commands } = await import("./commands/index.js");

  for (const command of commands) {
    if (command.matches(ctx.startup)) {
      await command.run(ctx);
      await closeDb();
      return true;
    }
  }

  return false;
}
