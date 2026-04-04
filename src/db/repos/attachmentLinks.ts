import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
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
    storagePath: string;
    originalFilename: string | null;
    contentType: string | null;
    sizeBytes: number | null;
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
      storagePath: attachments.storagePath,
      originalFilename: attachments.originalFilename,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
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
      storagePath: row.storagePath,
      originalFilename: row.originalFilename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
    },
  };
}

export async function markLinkDownloaded(db: Db, linkId: string): Promise<void> {
  await db
    .update(attachmentLinks)
    .set({ downloadedAt: new Date() })
    .where(eq(attachmentLinks.id, linkId));
}

export async function createAttachmentLink(
  db: Db,
  attachmentId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(attachmentLinks).values({ attachmentId, token, expiresAt });
}
