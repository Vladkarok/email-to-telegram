import type { OperatorCommand } from "../dispatcher.js";

export const migrateCommand: OperatorCommand = {
  matches: (startup) => startup.migrateOnly,

  run({ logger }) {
    logger.info("Migrations complete.");
    return Promise.resolve();
  },
};
