import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { deliveryLogs, attachments, organizations } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { deleteFile, deleteDir } from "./disk.js";
import { getLogger } from "../utils/logger.js";
import { decrementOrganizationStorageUsage } from "../db/repos/storageUsage.js";
import { getEffectivePlan } from "../billing/limits.js";
import { PLAN_DEFINITIONS } from "../billing/plans.js";

type Db = NodePgDatabase<typeof schema>;
type RetentionOrganization = Parameters<typeof getEffectivePlan>[0] | null;

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

  // 1. Delete expired attachment files + their DB rows
  await cleanAttachments(db, config.attachmentDir, config.attachmentTtlHours, now, log);

  // 2. Delete old raw email files
  await cleanRawEmails(db, config.rawEmailDir, config.rawEmailTtlHours, now, log);

  // 3. Delete old delivery_log rows (cascades to delivery_attempts)
  await cleanDeliveryLogs(db, config.deliveryLogRetentionDays, now, log);
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
    // Delete DB rows older than cutoff (storagePath used to find files)
    const candidates = await db
      .select({
        id: attachments.id,
        storagePath: attachments.storagePath,
        sizeBytes: attachments.sizeBytes,
        createdAt: attachments.createdAt,
        organizationId: deliveryLogs.organizationId,
        organizationPlanCode: organizations.planCode,
        organizationSubscriptionStatus: organizations.subscriptionStatus,
        organizationCurrentPeriodEnd: organizations.currentPeriodEnd,
        organizationPaidThroughAt: organizations.paidThroughAt,
      })
      .from(attachments)
      .innerJoin(deliveryLogs, eq(deliveryLogs.id, attachments.deliveryLogId))
      .leftJoin(organizations, eq(organizations.id, deliveryLogs.organizationId))
      .where(lt(attachments.createdAt, candidateCutoff));

    let deletedFiles = 0;
    let deletedRows = 0;
    for (const row of candidates) {
      if (!isExpiredByRetention(row.createdAt, now, ttlHours, rowOrganization(row))) {
        continue;
      }
      try {
        await deleteFile(row.storagePath);
      } catch {
        continue;
      }
      const rows = await db.transaction(async (tx) => {
        const result = await tx.delete(attachments).where(eq(attachments.id, row.id));
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount > 0 && row.organizationId && row.sizeBytes != null && row.sizeBytes > 0) {
          await decrementOrganizationStorageUsage(tx as Db, row.organizationId, {
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

  // Also clean up any orphaned per-delivery-log attachment dirs
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
        organizationId: deliveryLogs.organizationId,
        organizationPlanCode: organizations.planCode,
        organizationSubscriptionStatus: organizations.subscriptionStatus,
        organizationCurrentPeriodEnd: organizations.currentPeriodEnd,
        organizationPaidThroughAt: organizations.paidThroughAt,
        receivedAt: deliveryLogs.receivedAt,
        rawSizeBytes: deliveryLogs.rawSizeBytes,
        rawEmailPath: deliveryLogs.rawEmailPath,
      })
      .from(deliveryLogs)
      .leftJoin(organizations, eq(organizations.id, deliveryLogs.organizationId))
      .where(and(isNotNull(deliveryLogs.rawEmailPath), lt(deliveryLogs.receivedAt, cutoff)));
    let cleared = 0;
    for (const row of rawLogCandidates) {
      if (!row.rawEmailPath) {
        continue;
      }
      if (!isExpiredByRetention(row.receivedAt, now, ttlHours, rowOrganization(row))) {
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
          })
          .where(eq(deliveryLogs.id, row.id));
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (
          rowCount > 0 &&
          row.organizationId &&
          row.rawSizeBytes != null &&
          row.rawSizeBytes > 0
        ) {
          await decrementOrganizationStorageUsage(tx as Db, row.organizationId, {
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
        organizationPlanCode: organizations.planCode,
        organizationSubscriptionStatus: organizations.subscriptionStatus,
        organizationCurrentPeriodEnd: organizations.currentPeriodEnd,
        organizationPaidThroughAt: organizations.paidThroughAt,
      })
      .from(deliveryLogs)
      .leftJoin(organizations, eq(organizations.id, deliveryLogs.organizationId))
      .where(lt(deliveryLogs.createdAt, candidateCutoff));

    let rows = 0;
    for (const row of candidates) {
      if (
        row.rawEmailPath ||
        !isExpiredByDeliveryLogRetention(row.createdAt, now, retentionDays, rowOrganization(row))
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
  organization: RetentionOrganization,
): boolean {
  const retentionMs = organization
    ? getEffectivePlan(organization).limits.retentionDays * 24 * 3600 * 1000
    : globalTtlHours * 3600 * 1000;
  return timestamp.getTime() < now - retentionMs;
}

function isExpiredByDeliveryLogRetention(
  timestamp: Date,
  now: number,
  globalRetentionDays: number,
  organization: RetentionOrganization,
): boolean {
  const retentionDays = organization
    ? getEffectivePlan(organization).limits.retentionDays
    : globalRetentionDays;
  return timestamp.getTime() < now - retentionDays * 24 * 3600 * 1000;
}

function rowOrganization(row: {
  organizationPlanCode: string | null;
  organizationSubscriptionStatus: string | null;
  organizationCurrentPeriodEnd: Date | null;
  organizationPaidThroughAt: Date | null;
}): RetentionOrganization {
  if (!row.organizationPlanCode || !row.organizationSubscriptionStatus) {
    return null;
  }

  return {
    planCode: row.organizationPlanCode,
    subscriptionStatus: row.organizationSubscriptionStatus,
    currentPeriodEnd: row.organizationCurrentPeriodEnd,
    paidThroughAt: row.organizationPaidThroughAt,
  };
}
