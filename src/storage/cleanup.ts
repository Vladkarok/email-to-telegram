import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { lt } from "drizzle-orm";
import { deliveryLogs, attachments } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { deleteFile, deleteDir } from "./disk.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

/** Retention for delivery_logs / delivery_attempts rows (90 days). */
const LOG_RETENTION_DAYS = 90;

export interface CleanupConfig {
  attachmentDir: string;
  rawEmailDir: string;
  attachmentTtlHours: number;
  rawEmailTtlHours: number;
}

export async function runCleanup(db: Db, config: CleanupConfig): Promise<void> {
  const log = getLogger();
  const now = Date.now();

  // 1. Delete expired attachment files + their DB rows
  await cleanAttachments(db, config.attachmentDir, config.attachmentTtlHours, now, log);

  // 2. Delete old raw email files
  await cleanRawEmails(config.rawEmailDir, config.rawEmailTtlHours, now, log);

  // 3. Delete old delivery_log rows (cascades to delivery_attempts)
  await cleanDeliveryLogs(db, now, log);
}

async function cleanAttachments(
  db: Db,
  attachmentDir: string,
  ttlHours: number,
  now: number,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const cutoff = new Date(now - ttlHours * 3600 * 1000);
  try {
    // Delete DB rows older than cutoff (storagePath used to find files)
    const expired = await db
      .select({ storagePath: attachments.storagePath })
      .from(attachments)
      .where(lt(attachments.createdAt, cutoff));

    let deleted = 0;
    for (const { storagePath } of expired) {
      await deleteFile(storagePath).catch(() => {});
      deleted++;
    }

    // Delete DB rows
    const result = await db.delete(attachments).where(lt(attachments.createdAt, cutoff));
    const rows = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (rows > 0) {
      log.info({ files: deleted, rows }, "cleanup: removed expired attachments");
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
          await deleteDir(dirPath);
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
  rawEmailDir: string,
  ttlHours: number,
  now: number,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const cutoffMs = now - ttlHours * 3600 * 1000;
  try {
    const dateDirs = await readdir(rawEmailDir, { withFileTypes: true });
    let deleted = 0;
    for (const entry of dateDirs) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(rawEmailDir, entry.name);
      try {
        const s = await stat(dirPath);
        if (s.mtime.getTime() < cutoffMs) {
          await deleteDir(dirPath);
          deleted++;
        }
      } catch {
        // skip individual dirs
      }
    }
    if (deleted > 0) {
      log.info({ deleted }, "cleanup: removed old raw email directories");
    }
  } catch {
    // dir may not exist yet
  }
}

async function cleanDeliveryLogs(
  db: Db,
  now: number,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const cutoff = new Date(now - LOG_RETENTION_DAYS * 24 * 3600 * 1000);
  try {
    const result = await db.delete(deliveryLogs).where(lt(deliveryLogs.createdAt, cutoff));
    const rows = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (rows > 0) {
      log.info({ rows, retentionDays: LOG_RETENTION_DAYS }, "cleanup: purged old delivery logs");
    }
  } catch (err: unknown) {
    log.error({ err }, "cleanup: delivery log purge failed");
  }
}
