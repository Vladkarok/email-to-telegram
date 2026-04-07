import { readFile } from "fs/promises";
import {
  configureStorageEncryption,
  parseMasterEncryptionKeyring,
  type StorageEncryptionMode,
} from "./security/encryption.js";
import {
  decryptBackupArchive,
  encryptBackupArchive,
  formatBackupArchiveMetadataLines,
  parseBackupArchiveMetadataLines,
} from "./security/backupArchives.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "encrypt") {
    const [inputPath, outputPath, aad] = args;
    if (!inputPath || !outputPath || !aad) {
      throw new Error("Usage: backupArchiveCli encrypt <input> <output> <aad>");
    }

    configureFromEnv("local-v1");
    const metadata = await encryptBackupArchive(inputPath, outputPath, aad);
    process.stdout.write(`${formatBackupArchiveMetadataLines(metadata)}\n`);
    return;
  }

  if (command === "decrypt") {
    const [inputPath, outputPath, metadataPath] = args;
    if (!inputPath || !outputPath || !metadataPath) {
      throw new Error("Usage: backupArchiveCli decrypt <input> <output> <metadata-file>");
    }

    const metadata = parseBackupArchiveMetadataLines(await readFile(metadataPath, "utf-8"));
    if (metadata.encryptionMode !== "local-v1") {
      throw new Error(
        `Unsupported backup archive encryption mode in metadata: ${metadata.encryptionMode}`,
      );
    }

    configureFromEnv(metadata.encryptionMode);
    await decryptBackupArchive(inputPath, outputPath, metadata);
    return;
  }

  throw new Error("Usage: backupArchiveCli <encrypt|decrypt> ...");
}

function configureFromEnv(mode: StorageEncryptionMode): void {
  if (mode === "none") {
    configureStorageEncryption({ mode: "none" });
    return;
  }

  const masterKey = process.env["MASTER_ENCRYPTION_KEY"];
  if (!masterKey) {
    throw new Error("MASTER_ENCRYPTION_KEY is required for backup archive operations");
  }

  configureStorageEncryption({
    mode,
    masterKey,
    masterKeyId: process.env["MASTER_ENCRYPTION_KEY_ID"] ?? "local-env-v1",
    additionalMasterKeys: parseMasterEncryptionKeyring(process.env["MASTER_ENCRYPTION_KEYRING"]),
  });
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
