import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, or, sql } from "drizzle-orm";
import { attachments, chats, deliveryLogs, emailAddresses, organizations } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { deleteFile } from "../storage/disk.js";

type Db = NodePgDatabase<typeof schema>;

export interface DeleteOrganizationResult {
  deleted: boolean;
  rawEmailFiles: number;
  attachmentFiles: number;
  failedFileDeletes: string[];
}

export async function deleteHostedOrganization(
  db: Db,
  organizationId: string,
): Promise<DeleteOrganizationResult> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`);

    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (!organization) {
      return {
        deleted: false,
        rawEmailPaths: [],
        attachmentPaths: [],
      };
    }

    const [rawEmailPaths, attachmentPaths] = await Promise.all([
      listRawEmailPaths(tx as Db, organizationId),
      listAttachmentPaths(tx as Db, organizationId),
    ]);

    await tx.delete(deliveryLogs).where(eq(deliveryLogs.organizationId, organizationId));
    await tx.delete(emailAddresses).where(eq(emailAddresses.organizationId, organizationId));
    await tx.delete(chats).where(eq(chats.organizationId, organizationId));
    await tx.delete(organizations).where(eq(organizations.id, organizationId));

    return {
      deleted: true,
      rawEmailPaths,
      attachmentPaths,
    };
  });

  const failedFileDeletes: string[] = [];
  for (const filePath of [...result.rawEmailPaths, ...result.attachmentPaths]) {
    try {
      await deleteFile(filePath);
    } catch {
      failedFileDeletes.push(filePath);
    }
  }

  return {
    deleted: result.deleted,
    rawEmailFiles: result.rawEmailPaths.length,
    attachmentFiles: result.attachmentPaths.length,
    failedFileDeletes,
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
