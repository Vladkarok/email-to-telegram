import { createReadStream } from "fs";
import { readFile, writeFile, mkdir, unlink, rm, stat, readdir, rename } from "fs/promises";
import { dirname, join } from "path";
import type { Readable } from "stream";
import { getLogger } from "../utils/logger.js";

export interface PendingRawEmailMeta {
  rawEmailPath: string;
  localPart: string;
  envelopeFrom: string | null;
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
export async function openAttachmentStream(
  storagePath: string,
): Promise<{ stream: Readable; size: number }> {
  const { size } = await stat(storagePath);
  const stream = createReadStream(storagePath);
  return { stream, size };
}

export async function writeAttachment(storagePath: string, data: Buffer): Promise<void> {
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, data);
}

export async function writeRawEmail(storagePath: string, data: Buffer): Promise<void> {
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, data);
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
    const files = await readdir(dirPath, { withFileTypes: true });
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

export async function readRawEmail(storagePath: string): Promise<Buffer> {
  return readFile(storagePath);
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
