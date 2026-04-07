import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const FILE_MAGIC = Buffer.from("ETG1", "ascii");
const FILE_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export type StorageEncryptionMode = "none" | "local-v1";

export interface StorageEncryptionMetadata {
  encryptionMode: StorageEncryptionMode;
  wrappedDek: string | null;
  kekKeyId: string | null;
  encryptedAt: Date | null;
}

interface KeyProvider {
  mode: "local-v1";
  wrapKey(plaintextDek: Buffer): Promise<{ wrappedDek: string; keyId: string }>;
  unwrapKey(wrappedDek: string, keyId?: string | null): Promise<Buffer>;
}

let activeProvider: KeyProvider | null = null;

export function configureStorageEncryption(config: {
  mode: StorageEncryptionMode;
  masterKey?: string | null;
  masterKeyId?: string | null;
}): void {
  if (config.mode === "none") {
    activeProvider = null;
    return;
  }

  if (!config.masterKey) {
    throw new Error("MASTER_ENCRYPTION_KEY is required when STORAGE_ENCRYPTION_MODE=local-v1");
  }

  activeProvider = createLocalKeyProvider(
    parseMasterEncryptionKey(config.masterKey),
    config.masterKeyId ?? "local-env-v1",
  );
}

export function resetStorageEncryptionForTests(): void {
  activeProvider = null;
}

export function parseMasterEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== KEY_LENGTH) {
    throw new Error("MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return decoded;
}

export async function encryptBufferForStorage(
  plaintext: Buffer,
  aad: string,
): Promise<{ blob: Buffer; metadata: StorageEncryptionMetadata }> {
  if (!activeProvider) {
    return {
      blob: plaintext,
      metadata: {
        encryptionMode: "none",
        wrappedDek: null,
        kekKeyId: null,
        encryptedAt: null,
      },
    };
  }

  const dek = randomBytes(KEY_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const { wrappedDek, keyId } = await activeProvider.wrapKey(dek);

  return {
    blob: Buffer.concat([FILE_MAGIC, Buffer.from([FILE_VERSION]), iv, ciphertext, tag]),
    metadata: {
      encryptionMode: activeProvider.mode,
      wrappedDek,
      kekKeyId: keyId,
      encryptedAt: new Date(),
    },
  };
}

export async function decryptBufferFromStorage(
  blob: Buffer,
  metadata: Pick<StorageEncryptionMetadata, "encryptionMode" | "wrappedDek" | "kekKeyId">,
  aad: string,
): Promise<Buffer> {
  if ((metadata.encryptionMode ?? "none") === "none") {
    return blob;
  }

  if (metadata.encryptionMode !== "local-v1") {
    throw new Error(`Unsupported storage encryption mode: ${metadata.encryptionMode}`);
  }

  if (!activeProvider) {
    throw new Error("Storage encryption is not configured");
  }

  if (!metadata.wrappedDek) {
    throw new Error("Encrypted blob is missing wrapped DEK metadata");
  }

  if (blob.length < FILE_MAGIC.length + 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted blob is truncated");
  }

  const magic = blob.subarray(0, FILE_MAGIC.length);
  if (!magic.equals(FILE_MAGIC)) {
    throw new Error("Encrypted blob has invalid magic header");
  }

  const version = blob[FILE_MAGIC.length];
  if (version !== FILE_VERSION) {
    throw new Error(`Unsupported encrypted blob version: ${version}`);
  }

  const ivStart = FILE_MAGIC.length + 1;
  const ciphertextEnd = blob.length - TAG_LENGTH;
  const iv = blob.subarray(ivStart, ivStart + IV_LENGTH);
  const ciphertext = blob.subarray(ivStart + IV_LENGTH, ciphertextEnd);
  const tag = blob.subarray(ciphertextEnd);
  const dek = await activeProvider.unwrapKey(metadata.wrappedDek, metadata.kekKeyId);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAAD(Buffer.from(aad, "utf-8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function createLocalKeyProvider(masterKey: Buffer, keyId: string): KeyProvider {
  return {
    mode: "local-v1",
    wrapKey(plaintextDek: Buffer) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
      cipher.setAAD(Buffer.from(`local-wrap:${keyId}`, "utf-8"));
      const ciphertext = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Promise.resolve({
        wrappedDek: Buffer.concat([iv, ciphertext, tag]).toString("base64"),
        keyId,
      });
    },
    unwrapKey(wrappedDek: string, wrappedKeyId?: string | null) {
      const payload = Buffer.from(wrappedDek, "base64");
      if (payload.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error("Wrapped DEK payload is truncated");
      }

      const iv = payload.subarray(0, IV_LENGTH);
      const ciphertext = payload.subarray(IV_LENGTH, payload.length - TAG_LENGTH);
      const tag = payload.subarray(payload.length - TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
      decipher.setAAD(Buffer.from(`local-wrap:${wrappedKeyId ?? keyId}`, "utf-8"));
      decipher.setAuthTag(tag);
      return Promise.resolve(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    },
  };
}
