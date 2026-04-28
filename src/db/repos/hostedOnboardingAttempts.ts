import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import { hostedOnboardingAttempts, type HostedOnboardingAttempt } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface HostedOnboardingLimits {
  perTelegramUserDaily: number;
  globalDaily: number;
}

export interface HostedRateLimitBucket {
  bucketType: string;
  bucketKey: string;
  limit: number;
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

  return reserveHostedRateLimitBucketsInTransaction(db, windowStart, [
    { bucketType: "global", bucketKey: "all", limit: limits.globalDaily },
    {
      bucketType: "telegram_user",
      bucketKey: userKey,
      limit: limits.perTelegramUserDaily,
    },
  ]);
}

export function hostedOnboardingWindowStart(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function reserveHostedRateLimitBucketsInTransaction(
  db: Db,
  windowStart: string,
  buckets: HostedRateLimitBucket[],
): Promise<boolean> {
  if (buckets.length === 0) return true;

  const sortedBuckets = [...buckets].sort((a, b) =>
    `${a.bucketType}:${a.bucketKey}`.localeCompare(`${b.bucketType}:${b.bucketKey}`),
  );

  for (const bucket of sortedBuckets) {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`hosted-rate:${windowStart}:${bucket.bucketType}:${bucket.bucketKey}`}))`,
    );
  }

  const existingBuckets = await Promise.all(
    sortedBuckets.map((bucket) => findBucket(db, bucket.bucketType, bucket.bucketKey, windowStart)),
  );

  if (
    existingBuckets.some((bucket, index) => (bucket?.attempts ?? 0) >= sortedBuckets[index].limit)
  ) {
    return false;
  }

  await Promise.all(
    sortedBuckets.map((bucket) =>
      incrementBucket(db, bucket.bucketType, bucket.bucketKey, windowStart),
    ),
  );
  return true;
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
