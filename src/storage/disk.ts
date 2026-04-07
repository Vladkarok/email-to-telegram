import { createReadStream } from "fs";
import { readFile, writeFile, mkdir, unlink, rm, stat, readdir, rename } from "fs/promises";
import { dirname, join } from "path";
import { Readable } from "stream";
import { getLogger } from "../utils/logger.js";
import {
  decryptBufferFromStorage,
  encryptBufferForStorage,
  type StorageEncryptionMetadata,
} from "../security/encryption.js";

export interface PendingRawEmailMeta {
  rawEmailPath: string;
  localPart: string;
  envelopeFrom: string | null;
  rawEmailEncryptionMode?: string | null;
  rawEmailWrappedDek?: string | null;
  rawEmailKekKeyId?: string | null;
  correlationId?: string;
  createdAt: string;
}

function pendingRawEmailMetaPath(rawEmailPath: string): string {
  return `${rawEmailPath}.pending.json`;
}

/**
 * Open a storage file for streaming download.
 * Returns the size (for Content-Length) and a read stream.
 * Streaming avoids buffering the entire attachment into memory.
 */
export async function openAttachmentStream(attachment: {
  id: string;
  storagePath: string;
  sizeBytes: number | null;
  encryptionMode: string | null;
  wrappedDek: string | null;
  kekKeyId: string | null;
}): Promise<{ stream: Readable; size: number }> {
  if ((attachment.encryptionMode ?? "none") === "none") {
    const { size } = await stat(attachment.storagePath);
    const stream = createReadStream(attachment.storagePath);
    return { stream, size };
  }

  const plaintext = await readAttachmentBytes(attachment);
  return {
    stream: Readable.from(plaintext),
    size: attachment.sizeBytes ?? plaintext.length,
  };
}

export async function readAttachmentBytes(attachment: {
  id: string;
  storagePath: string;
  encryptionMode: string | null;
  wrappedDek: string | null;
  kekKeyId: string | null;
}): Promise<Buffer> {
  const raw = await readFile(attachment.storagePath);
  const encryptionMode =
    attachment.encryptionMode === "local-v1"
      ? "local-v1"
      : attachment.encryptionMode === "none" || attachment.encryptionMode == null
        ? "none"
        : (() => {
            throw new Error(`Unsupported attachment encryption mode: ${attachment.encryptionMode}`);
          })();

  return decryptBufferFromStorage(
    raw,
    {
      encryptionMode,
      wrappedDek: attachment.wrappedDek,
      kekKeyId: attachment.kekKeyId,
    },
    `attachment:${attachment.id}`,
  );
}

export async function writeAttachment(
  storagePath: string,
  attachmentId: string,
  data: Buffer,
): Promise<StorageEncryptionMetadata> {
  await mkdir(dirname(storagePath), { recursive: true });
  const { blob, metadata } = await encryptBufferForStorage(data, `attachment:${attachmentId}`);
  await writeFile(storagePath, blob);
  return metadata;
}

export async function writeRawEmail(
  storagePath: string,
  data: Buffer,
): Promise<StorageEncryptionMetadata> {
  await mkdir(dirname(storagePath), { recursive: true });
  const { blob, metadata } = await encryptBufferForStorage(data, `raw-email:${storagePath}`);
  await writeFile(storagePath, blob);
  return metadata;
}

export async function writePendingRawEmailMeta(
  rawEmailPath: string,
  data: Omit<PendingRawEmailMeta, "rawEmailPath" | "createdAt">,
): Promise<void> {
  const metaPath = pendingRawEmailMetaPath(rawEmailPath);
  const tempPath = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(metaPath), { recursive: true });
  await writeFile(
    tempPath,
    JSON.stringify({
      rawEmailPath,
      localPart: data.localPart,
      envelopeFrom: data.envelopeFrom,
      rawEmailEncryptionMode: data.rawEmailEncryptionMode,
      rawEmailWrappedDek: data.rawEmailWrappedDek,
      rawEmailKekKeyId: data.rawEmailKekKeyId,
      correlationId: data.correlationId,
      createdAt: new Date().toISOString(),
    }),
  );
  await rename(tempPath, metaPath);
}

export async function deletePendingRawEmailMeta(rawEmailPath: string): Promise<void> {
  await deleteFile(pendingRawEmailMetaPath(rawEmailPath));
}

export async function listPendingRawEmails(rawEmailDir: string): Promise<PendingRawEmailMeta[]> {
  const pending: PendingRawEmailMeta[] = [];
  let dateDirs;
  try {
    dateDirs = await readdir(rawEmailDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return pending;
    }
    throw err;
  }

  for (const entry of dateDirs) {
    if (!entry.isDirectory()) continue;

    const dirPath = join(rawEmailDir, entry.name);
    let files;
    try {
      files = await readdir(dirPath, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".eml.pending.json")) continue;

      const metaPath = join(dirPath, file.name);
      try {
        const raw = await readFile(metaPath, "utf-8");
        pending.push(JSON.parse(raw) as PendingRawEmailMeta);
      } catch (err: unknown) {
        getLogger().error({ err, metaPath }, "failed to read pending raw email metadata");
      }
    }
  }

  return pending;
}

export async function readRawEmail(
  storagePath: string,
  encryption?: {
    rawEmailEncryptionMode: string | null;
    rawEmailWrappedDek: string | null;
    rawEmailKekKeyId: string | null;
  },
): Promise<Buffer> {
  const raw = await readFile(storagePath);
  const encryptionMode =
    encryption?.rawEmailEncryptionMode === "local-v1"
      ? "local-v1"
      : encryption?.rawEmailEncryptionMode === "none" || encryption?.rawEmailEncryptionMode == null
        ? "none"
        : (() => {
            throw new Error(
              `Unsupported raw email encryption mode: ${encryption?.rawEmailEncryptionMode}`,
            );
          })();

  return decryptBufferFromStorage(
    raw,
    {
      encryptionMode,
      wrappedDek: encryption?.rawEmailWrappedDek ?? null,
      kekKeyId: encryption?.rawEmailKekKeyId ?? null,
    },
    `raw-email:${storagePath}`,
  );
}

/** Delete a file, ignoring ENOENT (already gone). */
export async function deleteFile(filePath: string): Promise<void> {
  await unlink(filePath).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}

/** Delete a directory tree, ignoring ENOENT. */
export async function deleteDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

/** Return mtime of a file, or null if it doesn't exist. */
export async function fileMtime(filePath: string): Promise<Date | null> {
  try {
    const s = await stat(filePath);
    return s.mtime;
  } catch {
    return null;
  }
}
