import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { addManualOrganizationMember } from "../../billing/manual.js";
import {
  buildManualBillingMemberInput,
  hostedManualBillingExitCode,
} from "../../startup/hostedManualBilling.js";

export const addMemberCommand: OperatorCommand = {
  matches: (startup) => startup.hostedAddOrganizationMemberId !== null,

  async run({ startup, logger }) {
    const input = buildManualBillingMemberInput(startup);
    const result = await addManualOrganizationMember(getDb(), input);

    if (result.ok) {
      logger.info(
        {
          organizationId: result.organizationId,
          telegramUserId: result.telegramUserId,
          role: result.role,
        },
        "Manual organization member add complete.",
      );
    } else {
      logger.error({ code: result.code }, "Manual organization member add failed.");
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = hostedManualBillingExitCode(result);
  },
};
