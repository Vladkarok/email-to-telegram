import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, isNull, and } from "drizzle-orm";
import { attachmentLinks, attachments } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface AttachmentLinkWithAttachment {
  id: string;
  token: string;
  expiresAt: Date;
  downloadedAt: Date | null;
  attachmentId: string;
  attachment: {
    id: string;
    storagePath: string;
    originalFilename: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    encryptionMode: string | null;
    wrappedDek: string | null;
    kekKeyId: string | null;
  };
}

export async function findAttachmentLinkByToken(
  db: Db,
  token: string,
): Promise<AttachmentLinkWithAttachment | null> {
  const [row] = await db
    .select({
      id: attachmentLinks.id,
      token: attachmentLinks.token,
      expiresAt: attachmentLinks.expiresAt,
      downloadedAt: attachmentLinks.downloadedAt,
      attachmentId: attachmentLinks.attachmentId,
      attachedId: attachments.id,
      storagePath: attachments.storagePath,
      originalFilename: attachments.originalFilename,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
      encryptionMode: attachments.encryptionMode,
      wrappedDek: attachments.wrappedDek,
      kekKeyId: attachments.kekKeyId,
    })
    .from(attachmentLinks)
    .innerJoin(attachments, eq(attachmentLinks.attachmentId, attachments.id))
    .where(eq(attachmentLinks.token, token));

  if (!row) return null;

  return {
    id: row.id,
    token: row.token,
    expiresAt: row.expiresAt,
    downloadedAt: row.downloadedAt,
    attachmentId: row.attachmentId,
    attachment: {
      id: row.attachedId,
      storagePath: row.storagePath,
      originalFilename: row.originalFilename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      encryptionMode: row.encryptionMode,
      wrappedDek: row.wrappedDek,
      kekKeyId: row.kekKeyId,
    },
  };
}

/**
 * Atomically marks the link as downloaded only if it hasn't been already.
 * Returns true if this call claimed the download, false if already consumed
 * (concurrent request beat us to it).
 */
export async function markLinkDownloaded(db: Db, linkId: string): Promise<boolean> {
  const rows = await db
    .update(attachmentLinks)
    .set({ downloadedAt: new Date() })
    .where(and(eq(attachmentLinks.id, linkId), isNull(attachmentLinks.downloadedAt)))
    .returning({ id: attachmentLinks.id });
  return rows.length > 0;
}

export async function createAttachmentLink(
  db: Db,
  attachmentId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(attachmentLinks).values({ attachmentId, token, expiresAt });
}
