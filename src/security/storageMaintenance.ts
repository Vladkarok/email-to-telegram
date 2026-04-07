import { and, eq, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { attachments, deliveryLogs } from "../db/schema.js";
import {
  backfillAttachmentFile,
  backfillRawEmailFile,
  clearStorageBackfillMeta,
  listPendingRawEmails,
  overwritePendingRawEmailMeta,
  type PendingRawEmailMeta,
} from "../storage/disk.js";
import { rewrapStorageEncryptionMetadata, type StorageEncryptionMetadata } from "./encryption.js";
import { backfillDeliveryLogMetadata, rewrapDeliveryLogMetadata } from "./deliveryLogMetadata.js";

type Db = NodePgDatabase<typeof schema>;

export interface StorageMaintenanceSummary {
  attachments: number;
  rawEmails: number;
  metadataLogs: number;
  pendingRawEmails: number;
  skippedMissingFiles: number;
}

export async function rewrapStoredEncryptionKeys(
  db: Db,
  rawEmailDir: string,
): Promise<StorageMaintenanceSummary> {
  const summary: StorageMaintenanceSummary = {
    attachments: 0,
    rawEmails: 0,
    metadataLogs: 0,
    pendingRawEmails: 0,
    skippedMissingFiles: 0,
  };

  const encryptedAttachments = await db
    .select({
      id: attachments.id,
      wrappedDek: attachments.wrappedDek,
      kekKeyId: attachments.kekKeyId,
      encryptedAt: attachments.encryptedAt,
    })
    .from(attachments)
    .where(eq(attachments.encryptionMode, "local-v1"));

  for (const attachment of encryptedAttachments) {
    const next = await rewrapStorageEncryptionMetadata({
      encryptionMode: "local-v1",
      wrappedDek: attachment.wrappedDek,
      kekKeyId: attachment.kekKeyId,
      encryptedAt: attachment.encryptedAt,
    });
    if (next.wrappedDek === attachment.wrappedDek && next.kekKeyId === attachment.kekKeyId) {
      continue;
    }
    await db
      .update(attachments)
      .set({
        wrappedDek: next.wrappedDek,
        kekKeyId: next.kekKeyId,
      })
      .where(eq(attachments.id, attachment.id));
    summary.attachments++;
  }

  const encryptedRawEmails = await db
    .select({
      id: deliveryLogs.id,
      rawEmailWrappedDek: deliveryLogs.rawEmailWrappedDek,
      rawEmailKekKeyId: deliveryLogs.rawEmailKekKeyId,
      rawEmailEncryptedAt: deliveryLogs.rawEmailEncryptedAt,
    })
    .from(deliveryLogs)
    .where(
      and(
        isNotNull(deliveryLogs.rawEmailPath),
        eq(deliveryLogs.rawEmailEncryptionMode, "local-v1"),
      ),
    );

  for (const rawEmail of encryptedRawEmails) {
    const next = await rewrapStorageEncryptionMetadata({
      encryptionMode: "local-v1",
      wrappedDek: rawEmail.rawEmailWrappedDek,
      kekKeyId: rawEmail.rawEmailKekKeyId,
      encryptedAt: rawEmail.rawEmailEncryptedAt,
    });
    if (
      next.wrappedDek === rawEmail.rawEmailWrappedDek &&
      next.kekKeyId === rawEmail.rawEmailKekKeyId
    ) {
      continue;
    }
    await db
      .update(deliveryLogs)
      .set({
        rawEmailWrappedDek: next.wrappedDek,
        rawEmailKekKeyId: next.kekKeyId,
      })
      .where(eq(deliveryLogs.id, rawEmail.id));
    summary.rawEmails++;
  }

  const encryptedMetadataLogs = await db
    .select({
      id: deliveryLogs.id,
      metadataWrappedDek: deliveryLogs.metadataWrappedDek,
      metadataKekKeyId: deliveryLogs.metadataKekKeyId,
      metadataEncryptedAt: deliveryLogs.metadataEncryptedAt,
      metadataEncryptionMode: deliveryLogs.metadataEncryptionMode,
      metadataCiphertext: deliveryLogs.metadataCiphertext,
      envelopeFrom: deliveryLogs.envelopeFrom,
      headerFrom: deliveryLogs.headerFrom,
      subject: deliveryLogs.subject,
    })
    .from(deliveryLogs)
    .where(eq(deliveryLogs.metadataEncryptionMode, "local-v1"));

  for (const deliveryLog of encryptedMetadataLogs) {
    const next = await rewrapDeliveryLogMetadata({
      id: deliveryLog.id,
      metadataCiphertext: deliveryLog.metadataCiphertext,
      metadataEncryptionMode:
        deliveryLog.metadataEncryptionMode === "local-v1" ? "local-v1" : "none",
      metadataWrappedDek: deliveryLog.metadataWrappedDek,
      metadataKekKeyId: deliveryLog.metadataKekKeyId,
      metadataEncryptedAt: deliveryLog.metadataEncryptedAt,
      envelopeFrom: deliveryLog.envelopeFrom,
      headerFrom: deliveryLog.headerFrom,
      subject: deliveryLog.subject,
    });
    if (
      next.metadataWrappedDek === deliveryLog.metadataWrappedDek &&
      next.metadataKekKeyId === deliveryLog.metadataKekKeyId
    ) {
      continue;
    }
    await db
      .update(deliveryLogs)
      .set({
        metadataWrappedDek: next.metadataWrappedDek,
        metadataKekKeyId: next.metadataKekKeyId,
      })
      .where(eq(deliveryLogs.id, deliveryLog.id));
    summary.metadataLogs++;
  }

  const pendingRawEmails = await listPendingRawEmails(rawEmailDir);
  for (const pendingRawEmail of pendingRawEmails) {
    if ((pendingRawEmail.rawEmailEncryptionMode ?? "none") !== "local-v1") continue;
    const next = await rewrapStorageEncryptionMetadata({
      encryptionMode: "local-v1",
      wrappedDek: pendingRawEmail.rawEmailWrappedDek ?? null,
      kekKeyId: pendingRawEmail.rawEmailKekKeyId ?? null,
      encryptedAt: null,
    });
    if (
      next.wrappedDek === pendingRawEmail.rawEmailWrappedDek &&
      next.kekKeyId === pendingRawEmail.rawEmailKekKeyId
    ) {
      continue;
    }
    await overwritePendingRawEmailMeta({
      ...pendingRawEmail,
      rawEmailWrappedDek: next.wrappedDek,
      rawEmailKekKeyId: next.kekKeyId,
    });
    summary.pendingRawEmails++;
  }

  return summary;
}

export async function backfillStoredEncryption(
  db: Db,
  rawEmailDir: string,
): Promise<StorageMaintenanceSummary> {
  const summary: StorageMaintenanceSummary = {
    attachments: 0,
    rawEmails: 0,
    metadataLogs: 0,
    pendingRawEmails: 0,
    skippedMissingFiles: 0,
  };
  const rewrittenRawPaths = new Map<string, StorageEncryptionMetadata>();

  const plaintextAttachments = await db
    .select({
      id: attachments.id,
      storagePath: attachments.storagePath,
    })
    .from(attachments)
    .where(eq(attachments.encryptionMode, "none"));

  for (const attachment of plaintextAttachments) {
    try {
      const metadata = await backfillAttachmentFile(attachment.storagePath, attachment.id);
      await db
        .update(attachments)
        .set({
          encryptionMode: metadata.encryptionMode,
          wrappedDek: metadata.wrappedDek,
          kekKeyId: metadata.kekKeyId,
          encryptedAt: metadata.encryptedAt,
        })
        .where(eq(attachments.id, attachment.id));
      await clearStorageBackfillMeta(attachment.storagePath);
      summary.attachments++;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        summary.skippedMissingFiles++;
        continue;
      }
      throw err;
    }
  }

  const plaintextRawEmails = await db
    .select({
      id: deliveryLogs.id,
      rawEmailPath: deliveryLogs.rawEmailPath,
    })
    .from(deliveryLogs)
    .where(
      and(isNotNull(deliveryLogs.rawEmailPath), eq(deliveryLogs.rawEmailEncryptionMode, "none")),
    );

  for (const rawEmail of plaintextRawEmails) {
    const rawEmailPath = rawEmail.rawEmailPath;
    if (!rawEmailPath) continue;
    try {
      const metadata = await backfillRawEmailFile(rawEmailPath);
      await db
        .update(deliveryLogs)
        .set({
          rawEmailEncryptionMode: metadata.encryptionMode,
          rawEmailWrappedDek: metadata.wrappedDek,
          rawEmailKekKeyId: metadata.kekKeyId,
          rawEmailEncryptedAt: metadata.encryptedAt,
        })
        .where(eq(deliveryLogs.id, rawEmail.id));
      await clearStorageBackfillMeta(rawEmailPath);
      summary.rawEmails++;
      rewrittenRawPaths.set(rawEmailPath, metadata);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        summary.skippedMissingFiles++;
        continue;
      }
      throw err;
    }
  }

  const plaintextMetadataLogs = await db
    .select({
      id: deliveryLogs.id,
      envelopeFrom: deliveryLogs.envelopeFrom,
      headerFrom: deliveryLogs.headerFrom,
      subject: deliveryLogs.subject,
      metadataCiphertext: deliveryLogs.metadataCiphertext,
      metadataEncryptionMode: deliveryLogs.metadataEncryptionMode,
      metadataWrappedDek: deliveryLogs.metadataWrappedDek,
      metadataKekKeyId: deliveryLogs.metadataKekKeyId,
      metadataEncryptedAt: deliveryLogs.metadataEncryptedAt,
    })
    .from(deliveryLogs)
    .where(eq(deliveryLogs.metadataEncryptionMode, "none"));

  for (const deliveryLog of plaintextMetadataLogs) {
    if (
      deliveryLog.envelopeFrom == null &&
      deliveryLog.headerFrom == null &&
      deliveryLog.subject == null
    ) {
      continue;
    }

    const encryptedMetadata = await backfillDeliveryLogMetadata({
      id: deliveryLog.id,
      envelopeFrom: deliveryLog.envelopeFrom,
      headerFrom: deliveryLog.headerFrom,
      subject: deliveryLog.subject,
      metadataCiphertext: deliveryLog.metadataCiphertext,
      metadataEncryptionMode:
        deliveryLog.metadataEncryptionMode === "local-v1" ? "local-v1" : "none",
      metadataWrappedDek: deliveryLog.metadataWrappedDek,
      metadataKekKeyId: deliveryLog.metadataKekKeyId,
      metadataEncryptedAt: deliveryLog.metadataEncryptedAt,
    });

    if (encryptedMetadata.metadataEncryptionMode === "none") {
      continue;
    }

    await db
      .update(deliveryLogs)
      .set({
        envelopeFrom: encryptedMetadata.envelopeFrom,
        headerFrom: encryptedMetadata.headerFrom,
        subject: encryptedMetadata.subject,
        metadataCiphertext: encryptedMetadata.metadataCiphertext,
        metadataEncryptionMode: encryptedMetadata.metadataEncryptionMode,
        metadataWrappedDek: encryptedMetadata.metadataWrappedDek,
        metadataKekKeyId: encryptedMetadata.metadataKekKeyId,
        metadataEncryptedAt: encryptedMetadata.metadataEncryptedAt,
      })
      .where(eq(deliveryLogs.id, deliveryLog.id));
    summary.metadataLogs++;
  }

  const pendingRawEmails = await listPendingRawEmails(rawEmailDir);
  for (const pendingRawEmail of pendingRawEmails) {
    if ((pendingRawEmail.rawEmailEncryptionMode ?? "none") !== "none") continue;

    try {
      const metadata =
        rewrittenRawPaths.get(pendingRawEmail.rawEmailPath) ??
        (await backfillRawEmailFile(pendingRawEmail.rawEmailPath));
      await overwritePendingRawEmailMeta(updatePendingEncryption(pendingRawEmail, metadata));
      await clearStorageBackfillMeta(pendingRawEmail.rawEmailPath);
      summary.pendingRawEmails++;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        summary.skippedMissingFiles++;
        continue;
      }
      throw err;
    }
  }

  return summary;
}

function updatePendingEncryption(
  pendingRawEmail: PendingRawEmailMeta,
  metadata: StorageEncryptionMetadata,
): PendingRawEmailMeta {
  return {
    ...pendingRawEmail,
    rawEmailEncryptionMode: metadata.encryptionMode,
    rawEmailWrappedDek: metadata.wrappedDek,
    rawEmailKekKeyId: metadata.kekKeyId,
  };
}
