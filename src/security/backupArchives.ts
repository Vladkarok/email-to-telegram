import { createReadStream, createWriteStream } from "fs";
import { stat } from "fs/promises";
import { pipeline } from "stream/promises";
import {
  decryptStreamFromStorage,
  encryptStreamForStorage,
  type StorageEncryptionMetadata,
} from "./encryption.js";

export interface BackupArchiveMetadata extends StorageEncryptionMetadata {
  aad: string;
  plaintextSizeBytes: number;
}

export async function encryptBackupArchive(
  inputPath: string,
  outputPath: string,
  aad: string,
): Promise<BackupArchiveMetadata> {
  const { size } = await stat(inputPath);
  const { stream, metadata } = await encryptStreamForStorage(createReadStream(inputPath), aad);
  await pipeline(stream, createWriteStream(outputPath, { mode: 0o600 }));
  return {
    ...metadata,
    aad,
    plaintextSizeBytes: size,
  };
}

export async function decryptBackupArchive(
  inputPath: string,
  outputPath: string,
  metadata: Pick<BackupArchiveMetadata, "aad" | "encryptionMode" | "wrappedDek" | "kekKeyId">,
): Promise<void> {
  const stream = await decryptStreamFromStorage(
    createReadStream(inputPath),
    {
      encryptionMode: metadata.encryptionMode,
      wrappedDek: metadata.wrappedDek,
      kekKeyId: metadata.kekKeyId,
    },
    metadata.aad,
  );
  await pipeline(stream, createWriteStream(outputPath, { mode: 0o600 }));
}

export function formatBackupArchiveMetadataLines(metadata: BackupArchiveMetadata): string {
  return [
    `backup_archive_encryption_mode=${metadata.encryptionMode}`,
    `backup_archive_wrapped_dek=${metadata.wrappedDek ?? ""}`,
    `backup_archive_kek_key_id=${metadata.kekKeyId ?? ""}`,
    `backup_archive_encrypted_at=${metadata.encryptedAt?.toISOString() ?? ""}`,
    `backup_archive_aad=${metadata.aad}`,
    `backup_archive_plaintext_size_bytes=${metadata.plaintextSizeBytes}`,
  ].join("\n");
}

export function parseBackupArchiveMetadataLines(raw: string): BackupArchiveMetadata {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }

  const encryptionMode = values.get("backup_archive_encryption_mode");
  if (encryptionMode !== "none" && encryptionMode !== "local-v1") {
    throw new Error("Backup metadata is missing a supported backup_archive_encryption_mode");
  }

  const aad = values.get("backup_archive_aad");
  if (!aad) {
    throw new Error("Backup metadata is missing backup_archive_aad");
  }

  const plaintextSizeValue = values.get("backup_archive_plaintext_size_bytes");
  const plaintextSizeBytes = Number(plaintextSizeValue);
  if (!plaintextSizeValue || !Number.isFinite(plaintextSizeBytes) || plaintextSizeBytes < 0) {
    throw new Error("Backup metadata is missing a valid backup_archive_plaintext_size_bytes");
  }

  return {
    encryptionMode,
    wrappedDek: values.get("backup_archive_wrapped_dek") || null,
    kekKeyId: values.get("backup_archive_kek_key_id") || null,
    encryptedAt: values.get("backup_archive_encrypted_at")
      ? new Date(values.get("backup_archive_encrypted_at")!)
      : null,
    aad,
    plaintextSizeBytes,
  };
}
