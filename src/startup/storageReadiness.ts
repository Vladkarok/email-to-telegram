import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { listPendingRawEmails, readAttachmentBytes, readRawEmail } from "../storage/disk.js";
import type { AppConfig } from "../config.js";
import { readDeliveryLogMetadata } from "../security/deliveryLogMetadata.js";

type Db = NodePgDatabase<typeof schema>;

export async function assertStorageEncryptionReadiness(
  db: Db,
  config: Pick<
    AppConfig,
    | "storageEncryptionMode"
    | "masterEncryptionKeyId"
    | "masterEncryptionKeyring"
    | "attachmentTtlHours"
    | "rawEmailTtlHours"
    | "rawEmailDir"
  >,
): Promise<void> {
  const pendingRawEmails = await listPendingRawEmails(config.rawEmailDir);
  const acceptsKeyId = (keyId?: string | null) =>
    keyId == null ||
    keyId in config.masterEncryptionKeyring ||
    keyId === config.masterEncryptionKeyId;

  if (config.storageEncryptionMode === "none") {
    const encryptedAttachmentRows = rowsFromResult<{ present: number }>(
      await db.execute(
        sql`select 1 as present from attachments where encryption_mode <> 'none' limit 1`,
      ),
    );
    const encryptedRawRows = rowsFromResult<{ present: number }>(
      await db.execute(
        sql`select 1 as present from delivery_logs where raw_email_encryption_mode <> 'none' and raw_email_path is not null limit 1`,
      ),
    );
    const encryptedMetadataRows = rowsFromResult<{ present: number }>(
      await db.execute(
        sql`select 1 as present from delivery_logs where metadata_encryption_mode <> 'none' limit 1`,
      ),
    );

    const encryptedPendingRaw = pendingRawEmails.find(
      (email) => (email.rawEmailEncryptionMode ?? "none") !== "none",
    );

    if (
      encryptedAttachmentRows[0] ||
      encryptedRawRows[0] ||
      encryptedMetadataRows[0] ||
      encryptedPendingRaw
    ) {
      throw new Error(
        "STORAGE_ENCRYPTION_MODE=none is not allowed while encrypted attachments, raw emails, delivery metadata, or pending raw emails still exist",
      );
    }
    return;
  }

  const unexpectedAttachmentKey = rowsFromResult<{ kek_key_id: string | null }>(
    await db.execute(
      sql`select distinct kek_key_id from attachments where encryption_mode = 'local-v1'`,
    ),
  ).find((row) => !acceptsKeyId(row.kek_key_id));
  if (unexpectedAttachmentKey) {
    throw new Error(
      `Encrypted attachments were written with a different key id. Rotation is not supported yet; expected ${config.masterEncryptionKeyId}.`,
    );
  }

  const unexpectedRawKey = rowsFromResult<{ raw_email_kek_key_id: string | null }>(
    await db.execute(
      sql`select distinct raw_email_kek_key_id from delivery_logs where raw_email_encryption_mode = 'local-v1' and raw_email_path is not null`,
    ),
  ).find((row) => !acceptsKeyId(row.raw_email_kek_key_id));
  if (unexpectedRawKey) {
    throw new Error(
      `Encrypted raw emails were written with a different key id. Rotation is not supported yet; expected ${config.masterEncryptionKeyId}.`,
    );
  }

  const unexpectedMetadataKey = rowsFromResult<{ metadata_kek_key_id: string | null }>(
    await db.execute(
      sql`select distinct metadata_kek_key_id from delivery_logs where metadata_encryption_mode = 'local-v1'`,
    ),
  ).find((row) => !acceptsKeyId(row.metadata_kek_key_id));
  if (unexpectedMetadataKey) {
    throw new Error(
      `Encrypted delivery metadata was written with a different key id. Rotation is not supported yet; expected ${config.masterEncryptionKeyId}.`,
    );
  }

  const unexpectedPendingKey = pendingRawEmails.find(
    (email) => email.rawEmailEncryptionMode === "local-v1" && !acceptsKeyId(email.rawEmailKekKeyId),
  );
  if (unexpectedPendingKey) {
    throw new Error(
      `Encrypted pending raw emails were written with a different key id. Rotation is not supported yet; expected ${config.masterEncryptionKeyId}.`,
    );
  }

  const attachmentCutoff = new Date(Date.now() - config.attachmentTtlHours * 60 * 60 * 1000);
  const sampleAttachment = rowsFromResult<{
    id: string;
    storage_path: string;
    encryption_mode: string | null;
    wrapped_dek: string | null;
    kek_key_id: string | null;
  }>(
    await db.execute(
      sql`select id, storage_path, encryption_mode, wrapped_dek, kek_key_id from attachments where encryption_mode = 'local-v1' and created_at >= ${attachmentCutoff} order by created_at desc limit 1`,
    ),
  )[0];
  if (sampleAttachment) {
    try {
      await readAttachmentBytes({
        id: sampleAttachment.id,
        storagePath: sampleAttachment.storage_path,
        encryptionMode: sampleAttachment.encryption_mode,
        wrappedDek: sampleAttachment.wrapped_dek,
        kekKeyId: sampleAttachment.kek_key_id,
      });
    } catch (err: unknown) {
      throw new Error("Failed to decrypt a stored attachment with the configured key", {
        cause: err,
      });
    }
  }

  const sampleRawEmail = rowsFromResult<{
    raw_email_path: string;
    raw_email_encryption_mode: string | null;
    raw_email_wrapped_dek: string | null;
    raw_email_kek_key_id: string | null;
  }>(
    await db.execute(
      // Probe any still-retryable raw email, not just "recent" rows, because
      // startup runs before the scheduled cleanup that clears stale paths.
      sql`select raw_email_path, raw_email_encryption_mode, raw_email_wrapped_dek, raw_email_kek_key_id from delivery_logs where raw_email_encryption_mode = 'local-v1' and raw_email_path is not null order by received_at desc limit 1`,
    ),
  )[0];
  if (sampleRawEmail) {
    try {
      await readRawEmail(sampleRawEmail.raw_email_path, {
        rawEmailEncryptionMode: sampleRawEmail.raw_email_encryption_mode,
        rawEmailWrappedDek: sampleRawEmail.raw_email_wrapped_dek,
        rawEmailKekKeyId: sampleRawEmail.raw_email_kek_key_id,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Failed to decrypt a stored raw email with the configured key", {
          cause: err,
        });
      }
    }
  }

  const sampleMetadataLog = rowsFromResult<{
    id: string;
    envelope_from: string | null;
    header_from: string | null;
    subject: string | null;
    metadata_ciphertext: string | null;
    metadata_encryption_mode: string | null;
    metadata_wrapped_dek: string | null;
    metadata_kek_key_id: string | null;
    metadata_encrypted_at: Date | null;
  }>(
    await db.execute(
      sql`select id, envelope_from, header_from, subject, metadata_ciphertext, metadata_encryption_mode, metadata_wrapped_dek, metadata_kek_key_id, metadata_encrypted_at from delivery_logs where metadata_encryption_mode = 'local-v1' order by received_at desc limit 1`,
    ),
  )[0];
  if (sampleMetadataLog) {
    try {
      await readDeliveryLogMetadata({
        id: sampleMetadataLog.id,
        envelopeFrom: sampleMetadataLog.envelope_from,
        headerFrom: sampleMetadataLog.header_from,
        subject: sampleMetadataLog.subject,
        metadataCiphertext: sampleMetadataLog.metadata_ciphertext,
        metadataEncryptionMode:
          sampleMetadataLog.metadata_encryption_mode === "local-v1" ? "local-v1" : "none",
        metadataWrappedDek: sampleMetadataLog.metadata_wrapped_dek,
        metadataKekKeyId: sampleMetadataLog.metadata_kek_key_id,
        metadataEncryptedAt: sampleMetadataLog.metadata_encrypted_at,
      });
    } catch (err: unknown) {
      throw new Error("Failed to decrypt stored delivery metadata with the configured key", {
        cause: err,
      });
    }
  }

  for (const pendingRawEmail of pendingRawEmails) {
    if (pendingRawEmail.rawEmailEncryptionMode !== "local-v1") continue;

    try {
      await readRawEmail(pendingRawEmail.rawEmailPath, {
        rawEmailEncryptionMode: pendingRawEmail.rawEmailEncryptionMode,
        rawEmailWrappedDek: pendingRawEmail.rawEmailWrappedDek ?? null,
        rawEmailKekKeyId: pendingRawEmail.rawEmailKekKeyId ?? null,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new Error("Failed to decrypt a pending raw email with the configured key", {
        cause: err,
      });
    }
  }
}

function rowsFromResult<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result != null &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
