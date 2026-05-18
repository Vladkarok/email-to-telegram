import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import type { NewUser, User } from "../db/schema.js";
import { findUserById, upsertUser } from "../db/repos/users.js";
import { reserveHostedOnboardingAttemptInTransaction } from "../db/repos/hostedOnboardingAttempts.js";

type Db = NodePgDatabase<typeof schema>;

export const HOSTED_ONBOARDING_RATE_LIMIT_MESSAGE =
  "⚠️ Too many account setup attempts. Please try again later.";

export class HostedOnboardingRateLimitError extends Error {
  constructor() {
    super("hosted onboarding rate limit exceeded");
    this.name = "HostedOnboardingRateLimitError";
  }
}

/**
 * Ensures the user row exists (the user IS the tenant). On hosted deployments,
 * applies a per-user attempt rate limit before any side effect — this is the
 * only state we need to provision for new accounts now that organizations
 * are gone.
 */
type OnboardingUserData = Pick<NewUser, "id" | "username"> & { locale?: string | null };

export async function ensureUserWithOnboardingLimit(
  db: Db,
  user: OnboardingUserData,
): Promise<User> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(${user.id})`);

    const existing = await findUserById(transactionalDb, user.id);
    if (existing) {
      return upsertUser(transactionalDb, {
        id: user.id,
        username: user.username,
        locale: user.locale,
      });
    }

    // Rate-limit only first-time provisioning. Existing users should not burn
    // onboarding attempts on normal bot commands.
    if (!(await reserveHostedOnboardingAttemptInTransaction(transactionalDb, user.id))) {
      throw new HostedOnboardingRateLimitError();
    }
    return upsertUser(transactionalDb, {
      id: user.id,
      username: user.username,
      locale: user.locale,
    });
  });
}
