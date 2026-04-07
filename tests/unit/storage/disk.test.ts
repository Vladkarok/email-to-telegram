import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  listPendingRawEmails,
  openAttachmentStream,
  writeAttachment,
  writePendingRawEmailMeta,
} from "../../../src/storage/disk.js";
import {
  configureStorageEncryption,
  resetStorageEncryptionForTests,
} from "../../../src/security/encryption.js";

const tempDirs: string[] = [];

describe("pending raw email metadata", () => {
  afterEach(async () => {
    resetStorageEncryptionForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes metadata and discovers it during recovery scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-disk-"));
    tempDirs.push(root);

    const rawEmailPath = join(root, "2026-04-07", "message.eml");
    await writePendingRawEmailMeta(rawEmailPath, {
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      correlationId: "req-1",
    });

    const pending = await listPendingRawEmails(root);

    expect(pending).toEqual([
      expect.objectContaining({
        rawEmailPath,
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        correlationId: "req-1",
      }),
    ]);
  });

  it("skips corrupt metadata files instead of aborting the whole scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-disk-"));
    tempDirs.push(root);

    const dayDir = join(root, "2026-04-07");
    await mkdir(dayDir, { recursive: true });
    await writeFile(join(dayDir, "broken.eml.pending.json"), "{not json");
    await writePendingRawEmailMeta(join(dayDir, "ok.eml"), {
      localPart: "alerts",
      envelopeFrom: null,
    });

    const pending = await listPendingRawEmails(root);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      rawEmailPath: join(dayDir, "ok.eml"),
      localPart: "alerts",
      envelopeFrom: null,
    });
  });

  it("encrypts attachment files at rest when local encryption is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-disk-"));
    tempDirs.push(root);
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 9).toString("base64"),
      masterKeyId: "test-key",
    });

    const storagePath = join(root, "attachment.bin");
    const plaintext = Buffer.from("secret attachment body");
    const metadata = await writeAttachment(storagePath, "att-1", plaintext);
    const onDisk = await readFile(storagePath);

    expect(metadata.encryptionMode).toBe("local-v1");
    expect(onDisk.equals(plaintext)).toBe(false);

    const opened = await openAttachmentStream({
      id: "att-1",
      storagePath,
      sizeBytes: plaintext.length,
      encryptionMode: metadata.encryptionMode,
      wrappedDek: metadata.wrappedDek,
      kekKeyId: metadata.kekKeyId,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else {
        throw new Error("unexpected stream chunk type");
      }
    }

    expect(opened.size).toBe(plaintext.length);
    expect(Buffer.concat(chunks)).toEqual(plaintext);
  });
});
