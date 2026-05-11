import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { grantManualUserPlan } from "../../billing/manual.js";
import {
  buildManualBillingUserInput,
  redactManualBillingForLog,
  hostedManualBillingExitCode,
  withManualBillingWarnings,
} from "../../startup/hostedManualBilling.js";

export const setUserPlanCommand: OperatorCommand = {
  matches: (startup) => startup.hostedSetUserPlanTelegramUserId !== null,

  async run({ startup, logger }) {
    if (startup.warnings.length > 0) {
      for (const w of startup.warnings) logger.warn({ warning: w }, "Manual billing CLI warning");
    }

    const input = buildManualBillingUserInput(startup);
    const result = await grantManualUserPlan(getDb(), input);

    if (result.ok) {
      logger.info(
        {
          result: redactManualBillingForLog(result),
          createdOrganization: result.createdOrganization,
        },
        result.idempotent ? "billing.manual_grant.idempotent" : "billing.manual_grant.created",
      );
    } else {
      logger.error(
        { code: result.code, organizationIds: result.organizationIds },
        "Manual user plan grant failed.",
      );
    }

    process.stdout.write(
      `${JSON.stringify(withManualBillingWarnings(result, startup.warnings), null, 2)}\n`,
    );
    process.exitCode = hostedManualBillingExitCode(result);
  },
};
