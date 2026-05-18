import { writeFile } from "fs/promises";
import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { exportHostedUserData } from "../../dataLifecycle/exportUser.js";

export const exportCommand: OperatorCommand = {
  matches: (startup) => startup.hostedExportUserId !== null,

  async run({ startup, logger }) {
    const userId = BigInt(startup.hostedExportUserId!);
    const exportData = await exportHostedUserData(getDb(), userId);

    if (!exportData) {
      logger.error({ userId: userId.toString() }, "Hosted user export failed: user not found.");
      process.exitCode = 1;
      return;
    }

    await writeFile(startup.hostedExportOutputPath!, `${JSON.stringify(exportData, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });

    logger.info(
      { userId: userId.toString(), outputPath: startup.hostedExportOutputPath },
      "Hosted user export complete.",
    );
  },
};
