import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import type { Organization, User } from "../db/schema.js";
import { createOrganization } from "../db/repos/organizations.js";
import { addOrganizationMember } from "../db/repos/organizationMembers.js";
import { getPrimaryOrganizationForUser } from "../tenant/currentOrganization.js";
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

export async function ensurePersonalOrganizationForUserWithOnboardingLimit(
  db: Db,
  user: User,
): Promise<Organization> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id.toString()}))`);

    const existing = await getPrimaryOrganizationForUser(transactionalDb, user.id);
    if (existing) return existing;

    if (!(await reserveHostedOnboardingAttemptInTransaction(transactionalDb, user.id))) {
      throw new HostedOnboardingRateLimitError();
    }

    const organization = await createOrganization(transactionalDb, {
      name: personalOrganizationName(user),
      planCode: "free",
      subscriptionStatus: "free",
    });
    await addOrganizationMember(transactionalDb, {
      organizationId: organization.id,
      userId: user.id,
      role: "owner",
    });
    return organization;
  });
}

function personalOrganizationName(user: Pick<User, "username" | "id">): string {
  return user.username ? `@${user.username}` : `Telegram ${user.id.toString()}`;
}
