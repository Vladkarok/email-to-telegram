import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { grantManualOrganizationPlan } from "../../billing/manual.js";
import {
  buildManualBillingPlanInput,
  redactManualBillingForLog,
  hostedManualBillingExitCode,
  withManualBillingWarnings,
} from "../../startup/hostedManualBilling.js";

export const setOrganizationPlanCommand: OperatorCommand = {
  matches: (startup) => startup.hostedSetOrganizationPlanId !== null,

  async run({ startup, logger }) {
    if (startup.warnings.length > 0) {
      for (const w of startup.warnings) logger.warn({ warning: w }, "Manual billing CLI warning");
    }

    const input = buildManualBillingPlanInput(startup);
    const result = await grantManualOrganizationPlan(getDb(), input);

    if (result.ok) {
      logger.info(
        { result: redactManualBillingForLog(result) },
        result.idempotent ? "billing.manual_grant.idempotent" : "billing.manual_grant.created",
      );
    } else {
      logger.error({ code: result.code }, "Manual organization plan grant failed.");
    }

    process.stdout.write(
      `${JSON.stringify(withManualBillingWarnings(result, startup.warnings), null, 2)}\n`,
    );
    process.exitCode = hostedManualBillingExitCode(result);
  },
};
