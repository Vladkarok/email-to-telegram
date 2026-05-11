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

  // Primary conflict path: same (organization_id, payment_reference).
  const byOrg = await findManualBillingEventByPaymentReference(
    db,
    data.organizationId,
    data.paymentReference,
  );
  if (byOrg) return { event: byOrg, created: false };

  // Secondary conflict path: same (telegram_user_id, payment_reference) but a
  // concurrent transaction resolved a different org. The unique index on
  // (telegram_user_id, payment_reference) blocked the duplicate insert; treat
  // the winner's event as the canonical idempotent result.
  if (data.telegramUserId != null) {
    const byUser = await findManualBillingEventByUserAndPaymentReference(
      db,
      data.telegramUserId,
      data.paymentReference,
    );
    if (byUser) return { event: byUser, created: false };
  }

  // Third conflict path: global payment_reference uniqueness constraint blocked
  // the insert (different org, null telegramUserId). Return the existing event so
  // the caller can detect the cross-org conflict via organizationId mismatch.
  const byPayref = await findAnyManualBillingEventByPaymentReference(db, data.paymentReference);
  if (byPayref) return { event: byPayref, created: false };

  throw new Error("findOrCreateManualBillingEvent: race condition lost");
}

export async function findAnyManualBillingEventByPaymentReference(
  db: Db,
  paymentReference: string,
): Promise<ManualBillingEvent | null> {
  const rows = await db
    .select()
    .from(manualBillingEvents)
    .where(eq(manualBillingEvents.paymentReference, paymentReference))
    .limit(2);
  if (rows.length > 1) {
    throw new Error(
      `findAnyManualBillingEventByPaymentReference: multiple events found for paymentReference=${paymentReference} — data integrity violation`,
    );
  }
  return rows[0] ?? null;
}

export async function findManualBillingEventByPaymentReference(
  db: Db,
  organizationId: string,
  paymentReference: string,
): Promise<ManualBillingEvent | null> {
  const rows = await db
    .select()
    .from(manualBillingEvents)
    .where(
      and(
        eq(manualBillingEvents.organizationId, organizationId),
        eq(manualBillingEvents.paymentReference, paymentReference),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new Error(
      `findManualBillingEventByPaymentReference: multiple events found for organizationId=${organizationId} paymentReference=${paymentReference} — data integrity violation`,
    );
  }
  return rows[0] ?? null;
}

export async function findManualBillingEventByUserAndPaymentReference(
  db: Db,
  telegramUserId: bigint,
  paymentReference: string,
): Promise<ManualBillingEvent | null> {
  const rows = await db
    .select()
    .from(manualBillingEvents)
    .where(
      and(
        eq(manualBillingEvents.telegramUserId, telegramUserId),
        eq(manualBillingEvents.paymentReference, paymentReference),
      ),
    )
    .orderBy(desc(manualBillingEvents.createdAt))
    .limit(2);
  if (rows.length > 1) {
    throw new Error(
      `findManualBillingEventByUserAndPaymentReference: multiple events found for telegramUserId=${telegramUserId} paymentReference=${paymentReference} — data integrity violation`,
    );
  }
  return rows[0] ?? null;
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
