import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { deleteHostedOrganization } from "../../dataLifecycle/deleteOrganization.js";
import { hostedDeleteExitCode } from "../../startup/hostedDataLifecycle.js";

export const deleteCommand: OperatorCommand = {
  matches: (startup) => startup.hostedDeleteOrganizationId !== null,

  async run({ startup, logger }) {
    const organizationId = startup.hostedDeleteOrganizationId!;
    const result = await deleteHostedOrganization(getDb(), organizationId);

    logger.info({ organizationId, result }, "Hosted organization deletion complete.");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = hostedDeleteExitCode(result);
  },
};
