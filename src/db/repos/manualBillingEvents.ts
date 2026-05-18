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
 * `(telegram_user_id, payment_reference)` unique partial index matches.
 *
 * Returns `{ event, created }` — `created: false` means an existing row was
 * found (idempotent replay).
 */
export async function findOrCreateManualBillingEvent(
  db: Db,
  data: ManualBillingEventInput & { paymentReference: string },
): Promise<{ event: ManualBillingEvent; created: boolean }> {
  const [inserted] = await db
    .insert(manualBillingEvents)
    .values(data)
    .onConflictDoNothing()
    .returning();

  if (inserted) return { event: inserted, created: true };

  const byUser = await findManualBillingEventByUserAndPaymentReference(
    db,
    data.telegramUserId,
    data.paymentReference,
  );
  if (byUser) return { event: byUser, created: false };

  // Global payment_reference uniqueness blocked the insert (different user).
  // Return the existing event so the caller can detect cross-user conflict via
  // telegramUserId mismatch.
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
      `findAnyManualBillingEventByPaymentReference: multiple events found for paymentReference=[REDACTED] — data integrity violation`,
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
      `findManualBillingEventByUserAndPaymentReference: multiple events found for telegramUserId=${telegramUserId} paymentReference=[REDACTED] — data integrity violation`,
    );
  }
  return rows[0] ?? null;
}

export async function listManualBillingEventsForUser(
  db: Db,
  telegramUserId: bigint,
): Promise<ManualBillingEvent[]> {
  return db
    .select()
    .from(manualBillingEvents)
    .where(eq(manualBillingEvents.telegramUserId, telegramUserId))
    .orderBy(desc(manualBillingEvents.createdAt));
}

export async function listRecentManualBillingEvents(
  db: Db,
  limit = 10,
): Promise<ManualBillingEvent[]> {
  return db
    .select()
    .from(manualBillingEvents)
    .orderBy(desc(manualBillingEvents.createdAt))
    .limit(limit);
}

export async function findLatestManualBillingEventForUser(
  db: Db,
  telegramUserId: bigint,
): Promise<ManualBillingEvent | null> {
  const [row] = await db
    .select()
    .from(manualBillingEvents)
    .where(eq(manualBillingEvents.telegramUserId, telegramUserId))
    .orderBy(desc(manualBillingEvents.createdAt))
    .limit(1);
  return row ?? null;
}
