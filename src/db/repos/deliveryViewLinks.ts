import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { deliveryLogs, deliveryViewLinks } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface DeliveryViewLinkWithLog {
  id: string;
  tokenHash: string;
  expiresAt: Date;
  viewedAt: Date | null;
  deliveryLogId: string;
  deliveryLog: {
    id: string;
    emailAddressId: string;
    userId: bigint | null;
    rawEmailPath: string | null;
    envelopeFrom: string | null;
    headerFrom: string | null;
    subject: string | null;
    metadataCiphertext: string | null;
    metadataEncryptionMode: string | null;
    metadataWrappedDek: string | null;
    metadataKekKeyId: string | null;
    metadataEncryptedAt: Date | null;
    receivedAt: Date;
    rawEmailEncryptionMode: string | null;
    rawEmailWrappedDek: string | null;
    rawEmailKekKeyId: string | null;
  };
}

export async function createDeliveryViewLink(
  db: Db,
  deliveryLogId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await db
    .insert(deliveryViewLinks)
    .values({ deliveryLogId, tokenHash, expiresAt, viewedAt: null })
    .onConflictDoUpdate({
      target: deliveryViewLinks.deliveryLogId,
      set: {
        tokenHash,
        expiresAt,
        viewedAt: null,
        createdAt: new Date(),
      },
    });
}

export async function findDeliveryViewLinkByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<DeliveryViewLinkWithLog | null> {
  const [row] = await db
    .select({
      id: deliveryViewLinks.id,
      tokenHash: deliveryViewLinks.tokenHash,
      expiresAt: deliveryViewLinks.expiresAt,
      viewedAt: deliveryViewLinks.viewedAt,
      deliveryLogId: deliveryViewLinks.deliveryLogId,
      logId: deliveryLogs.id,
      emailAddressId: deliveryLogs.emailAddressId,
      userId: deliveryLogs.userId,
      rawEmailPath: deliveryLogs.rawEmailPath,
      envelopeFrom: deliveryLogs.envelopeFrom,
      headerFrom: deliveryLogs.headerFrom,
      subject: deliveryLogs.subject,
      metadataCiphertext: deliveryLogs.metadataCiphertext,
      metadataEncryptionMode: deliveryLogs.metadataEncryptionMode,
      metadataWrappedDek: deliveryLogs.metadataWrappedDek,
      metadataKekKeyId: deliveryLogs.metadataKekKeyId,
      metadataEncryptedAt: deliveryLogs.metadataEncryptedAt,
      receivedAt: deliveryLogs.receivedAt,
      rawEmailEncryptionMode: deliveryLogs.rawEmailEncryptionMode,
      rawEmailWrappedDek: deliveryLogs.rawEmailWrappedDek,
      rawEmailKekKeyId: deliveryLogs.rawEmailKekKeyId,
    })
    .from(deliveryViewLinks)
    .innerJoin(deliveryLogs, eq(deliveryViewLinks.deliveryLogId, deliveryLogs.id))
    .where(eq(deliveryViewLinks.tokenHash, tokenHash));

  if (!row) return null;

  return {
    id: row.id,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    viewedAt: row.viewedAt,
    deliveryLogId: row.deliveryLogId,
    deliveryLog: {
      id: row.logId,
      emailAddressId: row.emailAddressId,
      userId: row.userId,
      rawEmailPath: row.rawEmailPath,
      envelopeFrom: row.envelopeFrom,
      headerFrom: row.headerFrom,
      subject: row.subject,
      metadataCiphertext: row.metadataCiphertext,
      metadataEncryptionMode: row.metadataEncryptionMode,
      metadataWrappedDek: row.metadataWrappedDek,
      metadataKekKeyId: row.metadataKekKeyId,
      metadataEncryptedAt: row.metadataEncryptedAt,
      receivedAt: row.receivedAt,
      rawEmailEncryptionMode: row.rawEmailEncryptionMode,
      rawEmailWrappedDek: row.rawEmailWrappedDek,
      rawEmailKekKeyId: row.rawEmailKekKeyId,
    },
  };
}

/**
 * Deletes delivery view links whose `expires_at` is in the past. Expired links
 * are already non-functional (the /view route rejects them) and would otherwise
 * linger until the parent delivery log is purged. Returns the row count.
 */
export async function deleteExpiredDeliveryViewLinks(db: Db, now: Date): Promise<number> {
  const result = await db.delete(deliveryViewLinks).where(lt(deliveryViewLinks.expiresAt, now));
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

export async function markDeliveryViewLinkViewed(db: Db, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(deliveryViewLinks)
    .set({ viewedAt: new Date() })
    .where(
      and(
        eq(deliveryViewLinks.id, id),
        isNull(deliveryViewLinks.viewedAt),
        gt(deliveryViewLinks.expiresAt, now),
      ),
    )
    .returning({ id: deliveryViewLinks.id });

  return rows.length > 0;
}
