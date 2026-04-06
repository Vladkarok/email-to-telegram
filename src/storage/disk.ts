import { createReadStream } from "fs";
import { readFile, writeFile, mkdir, unlink, rm, stat } from "fs/promises";
import { dirname } from "path";
import type { Readable } from "stream";

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
