import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import { hostedOnboardingAttempts, type HostedOnboardingAttempt } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface HostedOnboardingLimits {
  perTelegramUserDaily: number;
  globalDaily: number;
}

const DEFAULT_LIMITS: HostedOnboardingLimits = {
  perTelegramUserDaily: 3,
  globalDaily: 100,
};

export async function reserveHostedOnboardingAttempt(
  db: Db,
  telegramUserId: bigint,
  now = new Date(),
  limits: HostedOnboardingLimits = DEFAULT_LIMITS,
): Promise<boolean> {
  return db.transaction(async (tx) =>
    reserveHostedOnboardingAttemptInTransaction(tx as Db, telegramUserId, now, limits),
  );
}

export async function reserveHostedOnboardingAttemptInTransaction(
  db: Db,
  telegramUserId: bigint,
  now = new Date(),
  limits: HostedOnboardingLimits = DEFAULT_LIMITS,
): Promise<boolean> {
  const windowStart = hostedOnboardingWindowStart(now);
  const userKey = telegramUserId.toString();

  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`hosted-onboarding:${windowStart}`}))`,
  );
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`hosted-onboarding:user:${userKey}`}))`,
  );

  const [globalBucket, userBucket] = await Promise.all([
    findBucket(db, "global", "all", windowStart),
    findBucket(db, "telegram_user", userKey, windowStart),
  ]);

  if ((globalBucket?.attempts ?? 0) >= limits.globalDaily) return false;
  if ((userBucket?.attempts ?? 0) >= limits.perTelegramUserDaily) return false;

  await Promise.all([
    incrementBucket(db, "global", "all", windowStart),
    incrementBucket(db, "telegram_user", userKey, windowStart),
  ]);
  return true;
}

export function hostedOnboardingWindowStart(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

async function findBucket(
  db: Db,
  bucketType: string,
  bucketKey: string,
  windowStart: string,
): Promise<HostedOnboardingAttempt | null> {
  const [bucket] = await db
    .select()
    .from(hostedOnboardingAttempts)
    .where(
      and(
        eq(hostedOnboardingAttempts.bucketType, bucketType),
        eq(hostedOnboardingAttempts.bucketKey, bucketKey),
        eq(hostedOnboardingAttempts.windowStart, windowStart),
      ),
    );
  return bucket ?? null;
}

async function incrementBucket(
  db: Db,
  bucketType: string,
  bucketKey: string,
  windowStart: string,
): Promise<void> {
  await db
    .insert(hostedOnboardingAttempts)
    .values({ bucketType, bucketKey, windowStart, attempts: 1 })
    .onConflictDoUpdate({
      target: [
        hostedOnboardingAttempts.bucketType,
        hostedOnboardingAttempts.bucketKey,
        hostedOnboardingAttempts.windowStart,
      ],
      set: {
        attempts: sql`${hostedOnboardingAttempts.attempts} + 1`,
        updatedAt: new Date(),
      },
    });
}
