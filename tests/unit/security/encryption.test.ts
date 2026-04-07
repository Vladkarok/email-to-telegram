import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureStorageEncryption,
  decryptBufferFromStorage,
  encryptBufferForStorage,
  parseMasterEncryptionKey,
  resetStorageEncryptionForTests,
} from "../../../src/security/encryption.js";

describe("storage encryption", () => {
  beforeEach(() => {
    resetStorageEncryptionForTests();
  });

  afterEach(() => {
    resetStorageEncryptionForTests();
  });

  it("parses both base64 and hex master keys", () => {
    const raw = Buffer.alloc(32, 5);
    expect(parseMasterEncryptionKey(raw.toString("base64"))).toEqual(raw);
    expect(parseMasterEncryptionKey(raw.toString("hex"))).toEqual(raw);
  });

  it("round-trips encrypted storage blobs with local envelope encryption", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      masterKeyId: "unit-test-key",
    });

    const plaintext = Buffer.from("hello encrypted world");
    const { blob, metadata } = await encryptBufferForStorage(plaintext, "attachment:att-1");
    const decrypted = await decryptBufferFromStorage(blob, metadata, "attachment:att-1");

    expect(metadata.encryptionMode).toBe("local-v1");
    expect(decrypted).toEqual(plaintext);
  });

  it("rejects ciphertext tampering via AES-GCM authentication", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 8).toString("base64"),
      masterKeyId: "unit-test-key",
    });

    const { blob, metadata } = await encryptBufferForStorage(
      Buffer.from("tamper me"),
      "attachment:att-2",
    );
    blob[blob.length - 1] ^= 0xff;

    await expect(decryptBufferFromStorage(blob, metadata, "attachment:att-2")).rejects.toThrow();
  });
});
