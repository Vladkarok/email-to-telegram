import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { rewrapStoredEncryptionKeys } from "../../security/storageMaintenance.js";

export const rewrapCommand: OperatorCommand = {
  matches: (startup) => startup.rewrapStorageKeys,

  async run({ config, logger }) {
    const summary = await rewrapStoredEncryptionKeys(getDb(), config.rawEmailDir);
    logger.info({ summary }, "Storage key rewrap complete.");
  },
};
