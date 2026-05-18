import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import type { User } from "../db/schema.js";
import { findOrCreateUserById } from "../db/repos/users.js";
import { reserveHostedOnboardingAttemptInTransaction } from "../db/repos/hostedOnboardingAttempts.js";

type Db = NodePgDatabase<typeof schema>;

export const HOSTED_ONBOARDING_RATE_LIMIT_MESSAGE =
  "⚠️ Too many workspace setup attempts. Please try again later.";

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
export async function ensureUserWithOnboardingLimit(db: Db, user: User): Promise<User> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(${user.id})`);

    // Rate-limit before any user-row mutation: limits churn on bot abuse.
    if (!(await reserveHostedOnboardingAttemptInTransaction(transactionalDb, user.id))) {
      throw new HostedOnboardingRateLimitError();
    }
    return findOrCreateUserById(transactionalDb, user.id);
  });
}
