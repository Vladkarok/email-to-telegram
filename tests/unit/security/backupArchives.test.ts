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

  it("parses metadata sidecars with comments and blank optional fields", () => {
    const parsed = parseBackupArchiveMetadataLines(`
# comment
backup_archive_encryption_mode=none
backup_archive_wrapped_dek=
backup_archive_kek_key_id=
backup_archive_encrypted_at=
backup_archive_aad=backup-archive:test
backup_archive_plaintext_size_bytes=42
`);

    expect(parsed).toEqual({
      encryptionMode: "none",
      wrappedDek: null,
      kekKeyId: null,
      encryptedAt: null,
      aad: "backup-archive:test",
      plaintextSizeBytes: 42,
    });
  });

  it("rejects metadata without a supported encryption mode", () => {
    expect(() => parseBackupArchiveMetadataLines("backup_archive_aad=test")).toThrow(
      /supported backup_archive_encryption_mode/i,
    );
  });

  it("rejects metadata without an aad", () => {
    expect(() =>
      parseBackupArchiveMetadataLines(
        "backup_archive_encryption_mode=local-v1\nbackup_archive_plaintext_size_bytes=1",
      ),
    ).toThrow(/backup_archive_aad/i);
  });

  it("rejects metadata without a valid plaintext size", () => {
    expect(() =>
      parseBackupArchiveMetadataLines(
        "backup_archive_encryption_mode=local-v1\nbackup_archive_aad=test\nbackup_archive_plaintext_size_bytes=-1",
      ),
    ).toThrow(/valid backup_archive_plaintext_size_bytes/i);
  });
});
