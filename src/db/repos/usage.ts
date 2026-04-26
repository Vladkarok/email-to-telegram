import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import {
  organizationUsageMonths,
  type NewOrganizationUsageMonth,
  type OrganizationUsageMonth,
} from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export function usageMonthForDate(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export async function getOrganizationUsageMonth(
  db: Db,
  organizationId: string,
  month: string,
): Promise<OrganizationUsageMonth | null> {
  const [usage] = await db
    .select()
    .from(organizationUsageMonths)
    .where(
      and(
        eq(organizationUsageMonths.organizationId, organizationId),
        eq(organizationUsageMonths.month, month),
      ),
    );
  return usage ?? null;
}

export async function incrementOrganizationUsageMonth(
  db: Db,
  data: Pick<NewOrganizationUsageMonth, "organizationId" | "month"> & {
    deliveredCount?: number;
    rejectedCount?: number;
    egressBytes?: bigint;
  },
): Promise<OrganizationUsageMonth> {
  const deliveredCount = data.deliveredCount ?? 0;
  const rejectedCount = data.rejectedCount ?? 0;
  const egressBytes = data.egressBytes ?? 0n;
  if (deliveredCount < 0 || rejectedCount < 0 || egressBytes < 0n) {
    throw new Error("Usage increments must be non-negative");
  }

  const [usage] = await db
    .insert(organizationUsageMonths)
    .values({
      organizationId: data.organizationId,
      month: data.month,
      deliveredCount,
      rejectedCount,
      egressBytes,
    })
    .onConflictDoUpdate({
      target: [organizationUsageMonths.organizationId, organizationUsageMonths.month],
      set: {
        deliveredCount: sql`${organizationUsageMonths.deliveredCount} + ${deliveredCount}`,
        rejectedCount: sql`${organizationUsageMonths.rejectedCount} + ${rejectedCount}`,
        egressBytes: sql`${organizationUsageMonths.egressBytes} + ${egressBytes}`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!usage) throw new Error("incrementOrganizationUsageMonth: no row returned");
  return usage;
}

export async function decrementOrganizationUsageMonth(
  db: Db,
  data: Pick<NewOrganizationUsageMonth, "organizationId" | "month"> & {
    deliveredCount?: number;
    rejectedCount?: number;
    egressBytes?: bigint;
  },
): Promise<OrganizationUsageMonth> {
  const deliveredCount = data.deliveredCount ?? 0;
  const rejectedCount = data.rejectedCount ?? 0;
  const egressBytes = data.egressBytes ?? 0n;
  if (deliveredCount < 0 || rejectedCount < 0 || egressBytes < 0n) {
    throw new Error("Usage decrements must be non-negative");
  }

  const [usage] = await db
    .update(organizationUsageMonths)
    .set({
      deliveredCount: sql`greatest(${organizationUsageMonths.deliveredCount} - ${deliveredCount}, 0)`,
      rejectedCount: sql`greatest(${organizationUsageMonths.rejectedCount} - ${rejectedCount}, 0)`,
      egressBytes: sql`greatest(${organizationUsageMonths.egressBytes} - ${egressBytes}, 0)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(organizationUsageMonths.organizationId, data.organizationId),
        eq(organizationUsageMonths.month, data.month),
      ),
    )
    .returning();
  if (!usage) throw new Error("decrementOrganizationUsageMonth: no row returned");
  return usage;
}
