import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadConfig } from "../config.js";
import {
  hostedOnboardingWindowStart,
  reserveHostedRateLimitBucketsInTransaction,
} from "../db/repos/hostedOnboardingAttempts.js";
import type * as schema from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

export const HOSTED_ALIAS_CREATE_RATE_LIMIT_MESSAGE =
  "⚠️ Too many alias creation attempts. Please try again later.";

const DAILY_ALIAS_ATTEMPTS_PER_TELEGRAM_USER = 10;

export class HostedAliasCreateRateLimitError extends Error {
  constructor() {
    super("hosted alias creation rate limit exceeded");
    this.name = "HostedAliasCreateRateLimitError";
  }
}

export async function reserveHostedAliasCreateAttempt(
  db: Db,
  telegramUserId: bigint,
  now = new Date(),
): Promise<void> {
  if (!shouldThrottleHostedAliases()) return;

  const ok = await reserveHostedRateLimitBucketsInTransaction(
    db,
    hostedOnboardingWindowStart(now),
    [
      {
        bucketType: "alias_create_telegram_user",
        bucketKey: telegramUserId.toString(),
        limit: DAILY_ALIAS_ATTEMPTS_PER_TELEGRAM_USER,
      },
    ],
  );

  if (!ok) throw new HostedAliasCreateRateLimitError();
}

function shouldThrottleHostedAliases(): boolean {
  const appMode = process.env["APP_MODE"];
  if (appMode === "hosted") return true;
  if (appMode === "self-hosted") return false;

  try {
    return loadConfig().appMode === "hosted";
  } catch {
    return false;
  }
}
