import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { deliveryLogs, attachments, users } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { deleteFile, deleteDir } from "./disk.js";
import { getLogger } from "../utils/logger.js";
import { decrementUserStorageUsage } from "../db/repos/storageUsage.js";
import { deleteExpiredDeliveryViewLinks } from "../db/repos/deliveryViewLinks.js";
import { deleteExpiredAttachmentLinks } from "../db/repos/attachmentLinks.js";
import { getEffectivePlan } from "../billing/limits.js";
import { PLAN_DEFINITIONS } from "../billing/plans.js";

type Db = NodePgDatabase<typeof schema>;
type RetentionUser = Parameters<typeof getEffectivePlan>[0] | null;

export interface CleanupConfig {
  attachmentDir: string;
  rawEmailDir: string;
  attachmentTtlHours: number;
  rawEmailTtlHours: number;
  deliveryLogRetentionDays: number;
}

export async function runCleanup(db: Db, config: CleanupConfig): Promise<void> {
  const log = getLogger();
  const now = Date.now();

  await cleanAttachments(db, config.attachmentDir, config.attachmentTtlHours, now, log);
  await cleanRawEmails(db, config.rawEmailDir, config.rawEmailTtlHours, now, log);
  await cleanDeliveryLogs(db, config.deliveryLogRetentionDays, now, log);
  await cleanExpiredLinks(db, now, log);
}

async function cleanAttachments(
  db: Db,
  attachmentDir: string,
  ttlHours: number,
  now: number,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const candidateCutoff = broadRetentionCandidateCutoff(now, ttlHours);
  try {
    const candidates = await db
      .select({
        id: attachments.id,
        storagePath: attachments.storagePath,
        sizeBytes: attachments.sizeBytes,
        createdAt: attachments.createdAt,
        userId: deliveryLogs.userId,
        userPlanCode: users.planCode,
        userSubscriptionStatus: users.subscriptionStatus,
        userCurrentPeriodEnd: users.currentPeriodEnd,
        userPaidThroughAt: users.paidThroughAt,
      })
      .from(attachments)
      .innerJoin(deliveryLogs, eq(deliveryLogs.id, attachments.deliveryLogId))
      .leftJoin(users, eq(users.id, deliveryLogs.userId))
      .where(lt(attachments.createdAt, candidateCutoff));

    let deletedFiles = 0;
    let deletedRows = 0;
    for (const row of candidates) {
      if (!isExpiredByRetention(row.createdAt, now, ttlHours, rowUser(row))) {
        continue;
      }
      // Unlink the file first, then delete the row and decrement usage. This
      // ordering is self-healing: deleteFile tolerates ENOENT, so if the
      // transaction fails the next cleanup run re-lists the row, no-ops the
      // already-gone file, and retries the transaction. The reverse order
      // could permanently strand the file if the unlink later fails.
      try {
        await deleteFile(row.storagePath);
      } catch {
        continue;
      }
      const rows = await db.transaction(async (tx) => {
        const result = await tx.delete(attachments).where(eq(attachments.id, row.id));
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount > 0 && row.userId && row.sizeBytes != null && row.sizeBytes > 0) {
          await decrementUserStorageUsage(tx as Db, row.userId, {
            attachmentBytes: BigInt(row.sizeBytes),
          });
        }
        return rowCount;
      });
      deletedFiles++;
      deletedRows += rows;
    }
    if (deletedRows > 0) {
      log.info({ files: deletedFiles, rows: deletedRows }, "cleanup: removed expired attachments");
    }
  } catch (err: unknown) {
    log.error({ err }, "cleanup: attachment cleanup failed");
  }

  await cleanOrphanedDirs(attachmentDir, ttlHours, now, log);
}

async function cleanOrphanedDirs(
  baseDir: string,
  ttlHours: number,
  now: number,
  _log: ReturnType<typeof getLogger>,
): Promise<void> {
  const cutoffMs = now - ttlHours * 3600 * 1000;
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(baseDir, entry.name);
      try {
        const s = await stat(dirPath);
        if (s.mtime.getTime() < cutoffMs) {
          const children = await readdir(dirPath);
          if (children.length === 0) {
            await deleteDir(dirPath);
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // dir may not exist yet
  }
}

async function cleanRawEmails(
  db: Db,
  rawEmailDir: string,
  ttlHours: number,
  now: number,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const cutoffMs = broadRetentionCandidateCutoff(now, ttlHours).getTime();
  const cutoff = new Date(cutoffMs);
  try {
    const rawLogCandidates = await db
      .select({
        id: deliveryLogs.id,
        userId: deliveryLogs.userId,
        userPlanCode: users.planCode,
        userSubscriptionStatus: users.subscriptionStatus,
        userCurrentPeriodEnd: users.currentPeriodEnd,
        userPaidThroughAt: users.paidThroughAt,
        receivedAt: deliveryLogs.receivedAt,
        rawSizeBytes: deliveryLogs.rawSizeBytes,
        rawEmailPath: deliveryLogs.rawEmailPath,
      })
      .from(deliveryLogs)
      .leftJoin(users, eq(users.id, deliveryLogs.userId))
      .where(and(isNotNull(deliveryLogs.rawEmailPath), lt(deliveryLogs.receivedAt, cutoff)));
    let cleared = 0;
    for (const row of rawLogCandidates) {
      if (!row.rawEmailPath) {
        continue;
      }
      if (!isExpiredByRetention(row.receivedAt, now, ttlHours, rowUser(row))) {
        continue;
      }
      try {
        await deleteFile(row.rawEmailPath);
      } catch {
        continue;
      }
      const rows = await db.transaction(async (tx) => {
        const result = await tx
          .update(deliveryLogs)
          .set({
            rawEmailPath: null,
            rawEmailEncryptionMode: "none",
            rawEmailWrappedDek: null,
            rawEmailKekKeyId: null,
            rawEmailEncryptedAt: null,
            // The raw file is the only retry source; once it expires an
            // undelivered log can never deliver, so close it out.
            finalStatus: sql`case when ${deliveryLogs.finalStatus} in ('failed', 'received', 'retrying', 'processing') then 'permanently_failed' else ${deliveryLogs.finalStatus} end`,
          })
          .where(eq(deliveryLogs.id, row.id));
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount > 0 && row.userId && row.rawSizeBytes != null && row.rawSizeBytes > 0) {
          await decrementUserStorageUsage(tx as Db, row.userId, {
            rawEmailBytes: BigInt(row.rawSizeBytes),
          });
        }
        return rowCount;
      });
      cleared += rows;
    }
    if (cleared > 0) {
      log.info({ rows: cleared }, "cleanup: cleared expired raw email references");
    }
  } catch (err: unknown) {
    log.error({ err }, "cleanup: raw email reference cleanup failed");
  }

  await cleanOrphanedDirs(rawEmailDir, ttlHours, now, log);
}

async function cleanDeliveryLogs(
  db: Db,
  retentionDays: number,
  now: number,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const candidateCutoff = broadRetentionCandidateCutoff(now, retentionDays * 24);
  try {
    const candidates = await db
      .select({
        id: deliveryLogs.id,
        createdAt: deliveryLogs.createdAt,
        rawEmailPath: deliveryLogs.rawEmailPath,
        userPlanCode: users.planCode,
        userSubscriptionStatus: users.subscriptionStatus,
        userCurrentPeriodEnd: users.currentPeriodEnd,
        userPaidThroughAt: users.paidThroughAt,
      })
      .from(deliveryLogs)
      .leftJoin(users, eq(users.id, deliveryLogs.userId))
      .where(lt(deliveryLogs.createdAt, candidateCutoff));

    let rows = 0;
    for (const row of candidates) {
      if (
        row.rawEmailPath ||
        !isExpiredByDeliveryLogRetention(row.createdAt, now, retentionDays, rowUser(row))
      ) {
        continue;
      }

      const result = await db
        .delete(deliveryLogs)
        .where(
          and(
            eq(deliveryLogs.id, row.id),
            isNull(deliveryLogs.rawEmailPath),
            notExists(
              sql`select 1 from ${attachments} where ${attachments.deliveryLogId} = ${deliveryLogs.id}`,
            ),
          ),
        );
      rows += (result as unknown as { rowCount?: number }).rowCount ?? 0;
    }
    if (rows > 0) {
      log.info({ rows, retentionDays }, "cleanup: purged old delivery logs");
    }
  } catch (err: unknown) {
    log.error({ err }, "cleanup: delivery log purge failed");
  }
}

/**
 * Deletes download/view link rows whose `expires_at` has passed. These rows are
 * cascade-deleted when their parent attachment / delivery log is eventually
 * purged, but link TTLs are far shorter than retention, so expired-dead rows
 * would otherwise linger. Failure here is logged and isolated from other passes.
 */
async function cleanExpiredLinks(
  db: Db,
  now: number,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const cutoff = new Date(now);
  try {
    const viewLinks = await deleteExpiredDeliveryViewLinks(db, cutoff);
    const downloadLinks = await deleteExpiredAttachmentLinks(db, cutoff);
    if (viewLinks > 0 || downloadLinks > 0) {
      log.info(
        { deliveryViewLinks: viewLinks, attachmentLinks: downloadLinks },
        "cleanup: removed expired download links",
      );
    }
  } catch (err: unknown) {
    log.error({ err }, "cleanup: expired link cleanup failed");
  }
}

function broadRetentionCandidateCutoff(now: number, globalTtlHours: number): Date {
  return new Date(Math.max(now - globalTtlHours * 3600 * 1000, now - minimumPlanRetentionMs()));
}

function minimumPlanRetentionMs(): number {
  const retentionDays = Object.values(PLAN_DEFINITIONS).map((plan) => plan.limits.retentionDays);
  return Math.min(...retentionDays) * 24 * 3600 * 1000;
}

function isExpiredByRetention(
  timestamp: Date,
  now: number,
  globalTtlHours: number,
  user: RetentionUser,
): boolean {
  const retentionMs = user
    ? getEffectivePlan(user).limits.retentionDays * 24 * 3600 * 1000
    : globalTtlHours * 3600 * 1000;
  return timestamp.getTime() < now - retentionMs;
}

function isExpiredByDeliveryLogRetention(
  timestamp: Date,
  now: number,
  globalRetentionDays: number,
  user: RetentionUser,
): boolean {
  const retentionDays = user ? getEffectivePlan(user).limits.retentionDays : globalRetentionDays;
  return timestamp.getTime() < now - retentionDays * 24 * 3600 * 1000;
}

function rowUser(row: {
  userPlanCode: string | null;
  userSubscriptionStatus: string | null;
  userCurrentPeriodEnd: Date | null;
  userPaidThroughAt: Date | null;
}): RetentionUser {
  if (!row.userPlanCode || !row.userSubscriptionStatus) {
    return null;
  }

  return {
    planCode: row.userPlanCode,
    subscriptionStatus: row.userSubscriptionStatus,
    currentPeriodEnd: row.userCurrentPeriodEnd,
    paidThroughAt: row.userPaidThroughAt,
  };
}
