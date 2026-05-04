import { writeFile } from "fs/promises";
import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { exportHostedOrganizationData } from "../../dataLifecycle/exportOrganization.js";

export const exportCommand: OperatorCommand = {
  matches: (startup) => startup.hostedExportOrganizationId !== null,

  async run({ startup, logger }) {
    const organizationId = startup.hostedExportOrganizationId!;
    const exportData = await exportHostedOrganizationData(getDb(), organizationId);

    if (!exportData) {
      logger.error({ organizationId }, "Hosted organization export failed: organization not found.");
      process.exitCode = 1;
      return;
    }

    await writeFile(startup.hostedExportOutputPath!, `${JSON.stringify(exportData, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });

    logger.info(
      { organizationId, outputPath: startup.hostedExportOutputPath },
      "Hosted organization export complete.",
    );
  },
};
