import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { backfillStoredEncryption } from "../../security/storageMaintenance.js";

export const backfillCommand: OperatorCommand = {
  matches: (startup) => startup.backfillStorageEncryption,

  async run({ config, logger }) {
    const summary = await backfillStoredEncryption(getDb(), config.rawEmailDir);
    logger.info({ summary }, "Storage encryption backfill complete.");
  },
};
