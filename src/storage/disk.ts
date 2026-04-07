import { createReadStream, createWriteStream } from "fs";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  unlink,
  rm,
  stat,
  readdir,
  rename,
} from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getLogger } from "../utils/logger.js";
import {
  decryptStreamFromStorage,
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

async function replaceFileAtomically(filePath: string, contents: Buffer | string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, contents);
  await rename(tempPath, filePath);
}

/**
 * Open a storage file for streaming download.
 * Returns the size (for Content-Length) and a read stream.
 * Plaintext files stream directly; encrypted files are first decrypted into a
 * temporary plaintext file so the AES-GCM tag is verified before any bytes are
 * exposed to the caller.
 */
export async function openAttachmentStream(attachment: {
  id: string;
  storagePath: string;
  sizeBytes: number | null;
  encryptionMode: string | null;
  wrappedDek: string | null;
  kekKeyId: string | null;
}): Promise<{ stream: Readable; size: number; dispose?: () => Promise<void> }> {
  if ((attachment.encryptionMode ?? "none") === "none") {
    const { size } = await stat(attachment.storagePath);
    const stream = createReadStream(attachment.storagePath);
    return { stream, size };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "email-to-telegram-attachment-"));
  const tempPath = join(tempDir, "download.bin");
  const decryptedStream = await decryptStreamFromStorage(
    createReadStream(attachment.storagePath),
    {
      encryptionMode: attachment.encryptionMode === "local-v1" ? "local-v1" : "none",
      wrappedDek: attachment.wrappedDek,
      kekKeyId: attachment.kekKeyId,
    },
    `attachment:${attachment.id}`,
  );
  await pipeline(decryptedStream, createWriteStream(tempPath, { mode: 0o600 }));
  const size = attachment.sizeBytes ?? (await stat(tempPath)).size;
  const stream = createReadStream(tempPath);
  let cleaned = false;
  const cleanupTemp = async () => {
    if (cleaned) return;
    cleaned = true;
    stream.removeAllListeners("close");
    stream.removeAllListeners("error");
    stream.destroy();
    await deleteFile(tempPath);
    await deleteDir(tempDir);
  };
  stream.once("close", () => {
    void cleanupTemp();
  });
  stream.once("error", () => {
    void cleanupTemp();
  });
  return {
    stream,
    size,
    dispose: cleanupTemp,
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

export async function backfillAttachmentFile(
  storagePath: string,
  attachmentId: string,
): Promise<StorageEncryptionMetadata> {
  const plaintext = await readFile(storagePath);
  const { blob, metadata } = await encryptBufferForStorage(plaintext, `attachment:${attachmentId}`);
  await replaceFileAtomically(storagePath, blob);
  return metadata;
}

export async function writeRawEmail(
  storagePath: string,
  data: Buffer,
): Promise<StorageEncryptionMetadata> {
  await mkdir(dirname(storagePath), { recursive: true });
  const { blob, metadata } = await encryptBufferForStorage(data, rawEmailAads(storagePath)[0]);
  await writeFile(storagePath, blob);
  return metadata;
}

export async function backfillRawEmailFile(
  storagePath: string,
): Promise<StorageEncryptionMetadata> {
  const plaintext = await readFile(storagePath);
  const { blob, metadata } = await encryptBufferForStorage(plaintext, rawEmailAads(storagePath)[0]);
  await replaceFileAtomically(storagePath, blob);
  return metadata;
}

export async function writePendingRawEmailMeta(
  rawEmailPath: string,
  data: Omit<PendingRawEmailMeta, "rawEmailPath" | "createdAt">,
): Promise<void> {
  await overwritePendingRawEmailMeta({
    rawEmailPath,
    localPart: data.localPart,
    envelopeFrom: data.envelopeFrom,
    rawEmailEncryptionMode: data.rawEmailEncryptionMode,
    rawEmailWrappedDek: data.rawEmailWrappedDek,
    rawEmailKekKeyId: data.rawEmailKekKeyId,
    correlationId: data.correlationId,
    createdAt: new Date().toISOString(),
  });
}

export async function overwritePendingRawEmailMeta(data: PendingRawEmailMeta): Promise<void> {
  const metaPath = pendingRawEmailMetaPath(data.rawEmailPath);
  await replaceFileAtomically(
    metaPath,
    JSON.stringify({
      rawEmailPath: data.rawEmailPath,
      localPart: data.localPart,
      envelopeFrom: data.envelopeFrom,
      rawEmailEncryptionMode: data.rawEmailEncryptionMode,
      rawEmailWrappedDek: data.rawEmailWrappedDek,
      rawEmailKekKeyId: data.rawEmailKekKeyId,
      correlationId: data.correlationId,
      createdAt: data.createdAt,
    }),
  );
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
  const encryptionMode: StorageEncryptionMetadata["encryptionMode"] =
    encryption?.rawEmailEncryptionMode === "local-v1"
      ? "local-v1"
      : encryption?.rawEmailEncryptionMode === "none" || encryption?.rawEmailEncryptionMode == null
        ? "none"
        : (() => {
            throw new Error(
              `Unsupported raw email encryption mode: ${encryption?.rawEmailEncryptionMode}`,
            );
          })();

  const metadata: Pick<StorageEncryptionMetadata, "encryptionMode" | "wrappedDek" | "kekKeyId"> = {
    encryptionMode,
    wrappedDek: encryption?.rawEmailWrappedDek ?? null,
    kekKeyId: encryption?.rawEmailKekKeyId ?? null,
  };
  const aads = rawEmailAads(storagePath);

  for (const aad of aads) {
    try {
      return await decryptBufferFromStorage(raw, metadata, aad);
    } catch (err: unknown) {
      if (aad === aads[aads.length - 1]) throw err;
    }
  }

  throw new Error("Failed to decrypt raw email");
}

function rawEmailAads(storagePath: string): string[] {
  const stableAad = `raw-email:${basename(storagePath)}`;
  const legacyAad = `raw-email:${storagePath}`;
  return stableAad === legacyAad ? [stableAad] : [stableAad, legacyAad];
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
