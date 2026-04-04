import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

export async function readAttachmentStream(storagePath: string): Promise<Buffer> {
  return readFile(storagePath);
}

export async function writeAttachment(storagePath: string, data: Buffer): Promise<void> {
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, data);
}
