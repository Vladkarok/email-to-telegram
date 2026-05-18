import type { OperatorCommand } from "../dispatcher.js";
import { getDb } from "../../db/client.js";
import { deleteHostedUser } from "../../dataLifecycle/deleteUser.js";
import { hostedDeleteExitCode } from "../../startup/hostedDataLifecycle.js";

export const deleteCommand: OperatorCommand = {
  matches: (startup) => startup.hostedDeleteUserId !== null,

  async run({ startup, logger }) {
    const userId = BigInt(startup.hostedDeleteUserId!);
    const result = await deleteHostedUser(getDb(), userId);

    logger.info({ userId: userId.toString(), result }, "Hosted user deletion complete.");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = hostedDeleteExitCode(result);
  },
};
