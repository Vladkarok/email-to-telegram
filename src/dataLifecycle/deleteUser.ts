import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import { attachments, chats, deliveryLogs, emailAddresses, users } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { deleteFile } from "../storage/disk.js";

type Db = NodePgDatabase<typeof schema>;

export interface DeleteUserResult {
  deleted: boolean;
  rawEmailFiles: number;
  attachmentFiles: number;
  failedFileDeletes: string[];
}

export async function deleteHostedUser(db: Db, userId: bigint): Promise<DeleteUserResult> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);

    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return {
        deleted: false,
        rawEmailPaths: [],
        attachmentPaths: [],
      };
    }

    const [rawEmailPaths, attachmentPaths] = await Promise.all([
      listRawEmailPaths(tx as Db, userId),
      listAttachmentPaths(tx as Db, userId),
    ]);

    // Delete in dependency order. cascade rules clean up chats/membership-equivalent rows
    // through the foreign keys defined in schema; this file deletes the rows the cascade
    // doesn't reach when the user row is dropped (email_addresses lacks ON DELETE CASCADE
    // on created_by).
    await tx.delete(deliveryLogs).where(eq(deliveryLogs.userId, userId));
    await tx.delete(emailAddresses).where(eq(emailAddresses.createdBy, userId));
    // Telegram DM chat rows share the user's id; their title embeds the user's
    // name (e.g. "🏠 <first> <last> (DM)"), so it must be wiped too. Group
    // chats are shared and intentionally left in place.
    await tx.delete(chats).where(and(eq(chats.id, userId), eq(chats.type, "private")));
    await tx.delete(users).where(eq(users.id, userId));

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

async function listRawEmailPaths(db: Db, userId: bigint): Promise<string[]> {
  const rows = await db
    .select({ rawEmailPath: deliveryLogs.rawEmailPath })
    .from(deliveryLogs)
    .where(eq(deliveryLogs.userId, userId));

  return uniquePaths(rows.map((row) => row.rawEmailPath));
}

async function listAttachmentPaths(db: Db, userId: bigint): Promise<string[]> {
  const rows = await db
    .select({ storagePath: attachments.storagePath })
    .from(attachments)
    .innerJoin(deliveryLogs, eq(deliveryLogs.id, attachments.deliveryLogId))
    .where(eq(deliveryLogs.userId, userId));

  return uniquePaths(rows.map((row) => row.storagePath));
}

function uniquePaths(paths: Array<string | null>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}
