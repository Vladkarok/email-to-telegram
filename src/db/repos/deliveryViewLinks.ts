import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";
import { deliveryLogs, deliveryViewLinks } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface DeliveryViewLinkWithLog {
  id: string;
  token: string;
  expiresAt: Date;
  viewedAt: Date | null;
  deliveryLogId: string;
  deliveryLog: {
    id: string;
    emailAddressId: string;
    rawEmailPath: string | null;
    envelopeFrom: string | null;
    headerFrom: string | null;
    subject: string | null;
    receivedAt: Date;
  };
}

export async function createDeliveryViewLink(
  db: Db,
  deliveryLogId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(deliveryViewLinks).values({ deliveryLogId, token, expiresAt });
}

export async function findDeliveryViewLinkByToken(
  db: Db,
  token: string,
): Promise<DeliveryViewLinkWithLog | null> {
  const [row] = await db
    .select({
      id: deliveryViewLinks.id,
      token: deliveryViewLinks.token,
      expiresAt: deliveryViewLinks.expiresAt,
      viewedAt: deliveryViewLinks.viewedAt,
      deliveryLogId: deliveryViewLinks.deliveryLogId,
      logId: deliveryLogs.id,
      emailAddressId: deliveryLogs.emailAddressId,
      rawEmailPath: deliveryLogs.rawEmailPath,
      envelopeFrom: deliveryLogs.envelopeFrom,
      headerFrom: deliveryLogs.headerFrom,
      subject: deliveryLogs.subject,
      receivedAt: deliveryLogs.receivedAt,
    })
    .from(deliveryViewLinks)
    .innerJoin(deliveryLogs, eq(deliveryViewLinks.deliveryLogId, deliveryLogs.id))
    .where(eq(deliveryViewLinks.token, token));

  if (!row) return null;

  return {
    id: row.id,
    token: row.token,
    expiresAt: row.expiresAt,
    viewedAt: row.viewedAt,
    deliveryLogId: row.deliveryLogId,
    deliveryLog: {
      id: row.logId,
      emailAddressId: row.emailAddressId,
      rawEmailPath: row.rawEmailPath,
      envelopeFrom: row.envelopeFrom,
      headerFrom: row.headerFrom,
      subject: row.subject,
      receivedAt: row.receivedAt,
    },
  };
}

export async function markDeliveryViewLinkViewed(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(deliveryViewLinks)
    .set({ viewedAt: new Date() })
    .where(and(eq(deliveryViewLinks.id, id), isNull(deliveryViewLinks.viewedAt)))
    .returning({ id: deliveryViewLinks.id });

  return rows.length > 0;
}
