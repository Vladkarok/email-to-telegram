import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { organizationStorageUsage, type OrganizationStorageUsage } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function getOrganizationStorageUsage(
  db: Db,
  organizationId: string,
): Promise<OrganizationStorageUsage | null> {
  const [usage] = await db
    .select()
    .from(organizationStorageUsage)
    .where(eq(organizationStorageUsage.organizationId, organizationId));
  return usage ?? null;
}

export async function incrementOrganizationStorageUsage(
  db: Db,
  organizationId: string,
  data: { rawEmailBytes?: bigint; attachmentBytes?: bigint },
): Promise<OrganizationStorageUsage> {
  const rawEmailBytes = data.rawEmailBytes ?? 0n;
  const attachmentBytes = data.attachmentBytes ?? 0n;
  assertNonNegativeStorageDelta(rawEmailBytes, attachmentBytes);

  const [usage] = await db
    .insert(organizationStorageUsage)
    .values({ organizationId, rawEmailBytes, attachmentBytes })
    .onConflictDoUpdate({
      target: organizationStorageUsage.organizationId,
      set: {
        rawEmailBytes: sql`${organizationStorageUsage.rawEmailBytes} + ${rawEmailBytes}`,
        attachmentBytes: sql`${organizationStorageUsage.attachmentBytes} + ${attachmentBytes}`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!usage) throw new Error("incrementOrganizationStorageUsage: no row returned");
  return usage;
}

export async function decrementOrganizationStorageUsage(
  db: Db,
  organizationId: string,
  data: { rawEmailBytes?: bigint; attachmentBytes?: bigint },
): Promise<OrganizationStorageUsage> {
  const rawEmailBytes = data.rawEmailBytes ?? 0n;
  const attachmentBytes = data.attachmentBytes ?? 0n;
  assertNonNegativeStorageDelta(rawEmailBytes, attachmentBytes);

  const [usage] = await db
    .update(organizationStorageUsage)
    .set({
      rawEmailBytes: sql`greatest(${organizationStorageUsage.rawEmailBytes} - ${rawEmailBytes}, 0)`,
      attachmentBytes: sql`greatest(${organizationStorageUsage.attachmentBytes} - ${attachmentBytes}, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(organizationStorageUsage.organizationId, organizationId))
    .returning();
  if (!usage) throw new Error("decrementOrganizationStorageUsage: no row returned");
  return usage;
}

function assertNonNegativeStorageDelta(rawEmailBytes: bigint, attachmentBytes: bigint): void {
  if (rawEmailBytes < 0n || attachmentBytes < 0n) {
    throw new Error("Storage usage deltas must be non-negative");
  }
}
