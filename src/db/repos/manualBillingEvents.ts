import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";
import {
  manualBillingEvents,
  type ManualBillingEvent,
  type NewManualBillingEvent,
} from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type ManualBillingEventInput = Pick<
  NewManualBillingEvent,
  | "organizationId"
  | "telegramUserId"
  | "planCode"
  | "subscriptionStatus"
  | "paidThroughAt"
  | "paymentReference"
  | "note"
  | "keptStripeLink"
> &
  Pick<Required<NewManualBillingEvent>, "operatorSource">;

export async function createManualBillingEvent(
  db: Db,
  data: ManualBillingEventInput,
): Promise<ManualBillingEvent> {
  const [row] = await db.insert(manualBillingEvents).values(data).returning();
  if (!row) throw new Error("createManualBillingEvent: no row returned");
  return row;
}

/**
 * Atomically insert a billing event or return the existing one when the
 * `(organization_id, payment_reference)` unique partial index matches.
 *
 * Returns `{ event, created }` — `created: false` means an existing row was
 * found (idempotent replay).
 */
export async function findOrCreateManualBillingEvent(
  db: Db,
  data: ManualBillingEventInput & { paymentReference: string },
): Promise<{ event: ManualBillingEvent; created: boolean }> {
  // INSERT … ON CONFLICT DO NOTHING — if a row with the same
  // (organization_id, payment_reference) already exists the insert is
  // silently skipped and returning() yields an empty array.
  const [inserted] = await db
    .insert(manualBillingEvents)
    .values(data)
    .onConflictDoNothing()
    .returning();

  if (inserted) return { event: inserted, created: true };

  // Conflict path — read the existing row.
  const existing = await findManualBillingEventByPaymentReference(
    db,
    data.organizationId,
    data.paymentReference,
  );
  if (!existing) throw new Error("findOrCreateManualBillingEvent: race condition lost");
  return { event: existing, created: false };
}

export async function findManualBillingEventByPaymentReference(
  db: Db,
  organizationId: string,
  paymentReference: string,
): Promise<ManualBillingEvent | null> {
  const [row] = await db
    .select()
    .from(manualBillingEvents)
    .where(
      and(
        eq(manualBillingEvents.organizationId, organizationId),
        eq(manualBillingEvents.paymentReference, paymentReference),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findManualBillingEventByUserAndPaymentReference(
  db: Db,
  telegramUserId: bigint,
  paymentReference: string,
): Promise<ManualBillingEvent | null> {
  const [row] = await db
    .select()
    .from(manualBillingEvents)
    .where(
      and(
        eq(manualBillingEvents.telegramUserId, telegramUserId),
        eq(manualBillingEvents.paymentReference, paymentReference),
      ),
    )
    .orderBy(desc(manualBillingEvents.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listManualBillingEventsForOrganization(
  db: Db,
  organizationId: string,
): Promise<ManualBillingEvent[]> {
  return db
    .select()
    .from(manualBillingEvents)
    .where(eq(manualBillingEvents.organizationId, organizationId))
    .orderBy(desc(manualBillingEvents.createdAt));
}

export async function findLatestManualBillingEventForOrganization(
  db: Db,
  organizationId: string,
): Promise<ManualBillingEvent | null> {
  const [row] = await db
    .select()
    .from(manualBillingEvents)
    .where(eq(manualBillingEvents.organizationId, organizationId))
    .orderBy(desc(manualBillingEvents.createdAt))
    .limit(1);
  return row ?? null;
}
