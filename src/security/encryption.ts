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
  canUseKeyId(keyId?: string | null): boolean;
  currentKeyId(): string;
  configuredKeyIds(): string[];
}

let activeProvider: KeyProvider | null = null;

export function configureStorageEncryption(config: {
  mode: StorageEncryptionMode;
  masterKey?: string | null;
  masterKeyId?: string | null;
  additionalMasterKeys?: Record<string, string>;
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
    Object.fromEntries(
      Object.entries(config.additionalMasterKeys ?? {}).map(([keyId, value]) => [
        keyId,
        parseMasterEncryptionKey(value),
      ]),
    ),
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

export function parseMasterEncryptionKeyring(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};

  const entries = value
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const result: Record<string, string> = {};

  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(
        "MASTER_ENCRYPTION_KEYRING entries must use the format key_id=base64_or_hex_key",
      );
    }
    const keyId = entry.slice(0, separator).trim();
    const key = entry.slice(separator + 1).trim();
    if (!keyId) {
      throw new Error("MASTER_ENCRYPTION_KEYRING entries must include a non-empty key id");
    }
    if (!key) {
      throw new Error(`MASTER_ENCRYPTION_KEYRING entry ${keyId} is missing a key value`);
    }
    if (keyId in result) {
      throw new Error(`MASTER_ENCRYPTION_KEYRING contains duplicate key id ${keyId}`);
    }
    parseMasterEncryptionKey(key);
    result[keyId] = key;
  }

  return result;
}

export function listConfiguredStorageKeyIds(): string[] {
  if (!activeProvider) return [];
  return activeProvider.configuredKeyIds();
}

export function canUseStorageKeyId(
  mode: StorageEncryptionMode | null | undefined,
  keyId: string | null | undefined,
): boolean {
  if ((mode ?? "none") === "none") return true;
  if (mode !== "local-v1") return false;
  if (!activeProvider) return false;
  return activeProvider.canUseKeyId(keyId);
}

export async function rewrapStorageEncryptionMetadata(
  metadata: StorageEncryptionMetadata,
): Promise<StorageEncryptionMetadata> {
  if (metadata.encryptionMode !== "local-v1") return metadata;
  if (!metadata.wrappedDek) {
    throw new Error("Encrypted metadata is missing wrapped DEK");
  }
  if (!activeProvider) {
    throw new Error("Storage encryption is not configured");
  }
  const targetKeyId = activeProvider.currentKeyId();
  if ((metadata.kekKeyId ?? targetKeyId) === targetKeyId) {
    return metadata;
  }

  const dek = await activeProvider.unwrapKey(metadata.wrappedDek, metadata.kekKeyId);
  const { wrappedDek, keyId } = await activeProvider.wrapKey(dek);
  return {
    ...metadata,
    wrappedDek,
    kekKeyId: keyId,
  };
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

function createLocalKeyProvider(
  masterKey: Buffer,
  keyId: string,
  additionalKeys: Record<string, Buffer> = {},
): KeyProvider {
  const keys = new Map<string, Buffer>([[keyId, masterKey]]);
  for (const [extraKeyId, extraKey] of Object.entries(additionalKeys)) {
    keys.set(extraKeyId, extraKey);
  }

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
      const unwrapKeyId = wrappedKeyId ?? keyId;
      const kek = keys.get(unwrapKeyId);
      if (!kek) {
        throw new Error(`No configured master key for key id ${unwrapKeyId}`);
      }
      const payload = Buffer.from(wrappedDek, "base64");
      if (payload.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error("Wrapped DEK payload is truncated");
      }

      const iv = payload.subarray(0, IV_LENGTH);
      const ciphertext = payload.subarray(IV_LENGTH, payload.length - TAG_LENGTH);
      const tag = payload.subarray(payload.length - TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", kek, iv);
      decipher.setAAD(Buffer.from(`local-wrap:${unwrapKeyId}`, "utf-8"));
      decipher.setAuthTag(tag);
      return Promise.resolve(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    },
    canUseKeyId(wrappedKeyId?: string | null) {
      return keys.has(wrappedKeyId ?? keyId);
    },
    currentKeyId() {
      return keyId;
    },
    configuredKeyIds() {
      return [...keys.keys()];
    },
  };
}
