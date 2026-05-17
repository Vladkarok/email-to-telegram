import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { userStorageUsage, type UserStorageUsage } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function getUserStorageUsage(
  db: Db,
  userId: bigint,
): Promise<UserStorageUsage | null> {
  const [usage] = await db
    .select()
    .from(userStorageUsage)
    .where(eq(userStorageUsage.userId, userId));
  return usage ?? null;
}

export async function incrementUserStorageUsage(
  db: Db,
  userId: bigint,
  data: { rawEmailBytes?: bigint; attachmentBytes?: bigint },
): Promise<UserStorageUsage> {
  const rawEmailBytes = data.rawEmailBytes ?? 0n;
  const attachmentBytes = data.attachmentBytes ?? 0n;
  assertNonNegativeStorageDelta(rawEmailBytes, attachmentBytes);

  const [usage] = await db
    .insert(userStorageUsage)
    .values({ userId, rawEmailBytes, attachmentBytes })
    .onConflictDoUpdate({
      target: userStorageUsage.userId,
      set: {
        rawEmailBytes: sql`${userStorageUsage.rawEmailBytes} + ${rawEmailBytes}`,
        attachmentBytes: sql`${userStorageUsage.attachmentBytes} + ${attachmentBytes}`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!usage) throw new Error("incrementUserStorageUsage: no row returned");
  return usage;
}

export async function decrementUserStorageUsage(
  db: Db,
  userId: bigint,
  data: { rawEmailBytes?: bigint; attachmentBytes?: bigint },
): Promise<UserStorageUsage> {
  const rawEmailBytes = data.rawEmailBytes ?? 0n;
  const attachmentBytes = data.attachmentBytes ?? 0n;
  assertNonNegativeStorageDelta(rawEmailBytes, attachmentBytes);

  const [usage] = await db
    .update(userStorageUsage)
    .set({
      rawEmailBytes: sql`greatest(${userStorageUsage.rawEmailBytes} - ${rawEmailBytes}, 0)`,
      attachmentBytes: sql`greatest(${userStorageUsage.attachmentBytes} - ${attachmentBytes}, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(userStorageUsage.userId, userId))
    .returning();
  if (!usage) throw new Error("decrementUserStorageUsage: no row returned");
  return usage;
}

function assertNonNegativeStorageDelta(rawEmailBytes: bigint, attachmentBytes: bigint): void {
  if (rawEmailBytes < 0n || attachmentBytes < 0n) {
    throw new Error("Storage usage deltas must be non-negative");
  }
}
