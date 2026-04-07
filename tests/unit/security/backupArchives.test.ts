import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  configureStorageEncryption,
  resetStorageEncryptionForTests,
} from "../../../src/security/encryption.js";
import {
  decryptBackupArchive,
  encryptBackupArchive,
  formatBackupArchiveMetadataLines,
  parseBackupArchiveMetadataLines,
} from "../../../src/security/backupArchives.js";

const tempDirs: string[] = [];

describe("backup archive encryption", () => {
  beforeEach(() => {
    resetStorageEncryptionForTests();
  });

  afterEach(async () => {
    resetStorageEncryptionForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("encrypts and decrypts backup archives with metadata sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-backup-"));
    tempDirs.push(root);
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 8).toString("base64"),
      masterKeyId: "backup-key",
    });

    const inputPath = join(root, "backup.sql.gz");
    const encryptedPath = join(root, "backup.sql.gz.etg");
    const restoredPath = join(root, "restored.sql.gz");
    await writeFile(inputPath, Buffer.from("compressed sql contents"));

    const metadata = await encryptBackupArchive(
      inputPath,
      encryptedPath,
      "backup-archive:backup.sql.gz.etg",
    );
    const metadataLines = formatBackupArchiveMetadataLines(metadata);
    const parsedMetadata = parseBackupArchiveMetadataLines(metadataLines);

    await decryptBackupArchive(encryptedPath, restoredPath, parsedMetadata);

    await expect(readFile(restoredPath)).resolves.toEqual(Buffer.from("compressed sql contents"));
    expect(parsedMetadata.kekKeyId).toBe("backup-key");
    expect(parsedMetadata.aad).toBe("backup-archive:backup.sql.gz.etg");
  });

  it("does not leave a partial restore file behind when decryption fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-backup-"));
    tempDirs.push(root);
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 9).toString("base64"),
      masterKeyId: "backup-key-v1",
    });

    const inputPath = join(root, "backup.sql.gz");
    const encryptedPath = join(root, "backup.sql.gz.etg");
    const restoredPath = join(root, "restored.sql.gz");
    await writeFile(inputPath, Buffer.from("compressed sql contents"));

    const metadata = await encryptBackupArchive(
      inputPath,
      encryptedPath,
      "backup-archive:backup.sql.gz.etg",
    );

    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 10).toString("base64"),
      masterKeyId: "backup-key-v2",
      additionalMasterKeys: {},
    });

    await expect(
      decryptBackupArchive(encryptedPath, restoredPath, {
        aad: metadata.aad,
        encryptionMode: metadata.encryptionMode,
        wrappedDek: metadata.wrappedDek,
        kekKeyId: metadata.kekKeyId,
      }),
    ).rejects.toThrow();
    await expect(stat(restoredPath)).rejects.toThrow();
  });
});
