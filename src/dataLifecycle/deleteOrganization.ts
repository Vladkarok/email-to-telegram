import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, or } from "drizzle-orm";
import { attachments, chats, deliveryLogs, emailAddresses, organizations } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { deleteFile } from "../storage/disk.js";

type Db = NodePgDatabase<typeof schema>;

export interface DeleteOrganizationResult {
  deleted: boolean;
  rawEmailFiles: number;
  attachmentFiles: number;
}

export async function deleteHostedOrganization(
  db: Db,
  organizationId: string,
): Promise<DeleteOrganizationResult> {
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!organization) {
    return { deleted: false, rawEmailFiles: 0, attachmentFiles: 0 };
  }

  const [rawEmailPaths, attachmentPaths] = await Promise.all([
    listRawEmailPaths(db, organizationId),
    listAttachmentPaths(db, organizationId),
  ]);

  for (const filePath of [...rawEmailPaths, ...attachmentPaths]) {
    await deleteFile(filePath);
  }

  await db.transaction(async (tx) => {
    await tx.delete(deliveryLogs).where(eq(deliveryLogs.organizationId, organizationId));
    await tx.delete(emailAddresses).where(eq(emailAddresses.organizationId, organizationId));
    await tx.delete(chats).where(eq(chats.organizationId, organizationId));
    await tx.delete(organizations).where(eq(organizations.id, organizationId));
  });

  return {
    deleted: true,
    rawEmailFiles: rawEmailPaths.length,
    attachmentFiles: attachmentPaths.length,
  };
}

async function listRawEmailPaths(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ rawEmailPath: deliveryLogs.rawEmailPath })
    .from(deliveryLogs)
    .leftJoin(emailAddresses, eq(emailAddresses.id, deliveryLogs.emailAddressId))
    .where(
      or(
        eq(deliveryLogs.organizationId, organizationId),
        eq(emailAddresses.organizationId, organizationId),
      ),
    );

  return uniquePaths(rows.map((row) => row.rawEmailPath));
}

async function listAttachmentPaths(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ storagePath: attachments.storagePath })
    .from(attachments)
    .innerJoin(deliveryLogs, eq(deliveryLogs.id, attachments.deliveryLogId))
    .leftJoin(emailAddresses, eq(emailAddresses.id, deliveryLogs.emailAddressId))
    .where(
      or(
        eq(deliveryLogs.organizationId, organizationId),
        eq(emailAddresses.organizationId, organizationId),
      ),
    );

  return uniquePaths(rows.map((row) => row.storagePath));
}

function uniquePaths(paths: Array<string | null>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}
