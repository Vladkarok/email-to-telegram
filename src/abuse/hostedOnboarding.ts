import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import type { Organization, User } from "../db/schema.js";
import {
  ensurePersonalOrganizationForUser,
  getPrimaryOrganizationForUser,
} from "../tenant/currentOrganization.js";
import { RateLimiter } from "../utils/rateLimit.js";

type Db = NodePgDatabase<typeof schema>;

export const HOSTED_ONBOARDING_RATE_LIMIT_MESSAGE =
  "⚠️ Too many workspace setup attempts. Please try again later.";

const hostedOnboardingLimiter = new RateLimiter(3, 24 * 60 * 60 * 1000);
hostedOnboardingLimiter.startSweep(10 * 60_000);

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
  const existing = await getPrimaryOrganizationForUser(db, user.id);
  if (existing) return existing;

  if (!hostedOnboardingLimiter.check(user.id.toString())) {
    throw new HostedOnboardingRateLimitError();
  }

  return ensurePersonalOrganizationForUser(db, user);
}

export function resetHostedOnboardingLimiterForTests(): void {
  hostedOnboardingLimiter.destroy();
}
