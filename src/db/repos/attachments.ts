import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { attachments, type Attachment, type NewAttachment } from "../schema.js";
import { eq } from "drizzle-orm";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type NewAttachmentData = Omit<NewAttachment, "createdAt">;

export async function createAttachment(db: Db, data: NewAttachmentData): Promise<Attachment> {
  const [row] = await db.insert(attachments).values(data).returning();
  if (!row) throw new Error("createAttachment: no row returned");
  return row;
}

export async function listAttachmentsByDeliveryLogId(
  db: Db,
  deliveryLogId: string,
): Promise<Attachment[]> {
  return db.select().from(attachments).where(eq(attachments.deliveryLogId, deliveryLogId));
}
