import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "stream";
import {
  canUseStorageKeyId,
  configureStorageEncryption,
  decryptBufferFromStorage,
  decryptStreamFromStorage,
  encryptBufferForStorage,
  parseMasterEncryptionKey,
  parseMasterEncryptionKeyring,
  rewrapStorageEncryptionMetadata,
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

  it("parses semicolon-delimited keyring entries", () => {
    const parsed = parseMasterEncryptionKeyring(
      `old-v1=${Buffer.alloc(32, 1).toString("base64")};older-v0=${Buffer.alloc(32, 2).toString("hex")}`,
    );

    expect(parsed).toEqual({
      "old-v1": Buffer.alloc(32, 1).toString("base64"),
      "older-v0": Buffer.alloc(32, 2).toString("hex"),
    });
  });

  it("rejects a keyring that redefines the active key id", () => {
    expect(() =>
      configureStorageEncryption({
        mode: "local-v1",
        masterKey: Buffer.alloc(32, 7).toString("base64"),
        masterKeyId: "current-v2",
        additionalMasterKeys: {
          "current-v2": Buffer.alloc(32, 8).toString("base64"),
        },
      }),
    ).toThrow(/must not redefine the active key id/i);
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

  it("decrypts legacy wrapped keys when they are configured in the local keyring", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      masterKeyId: "old-v1",
    });
    const { blob, metadata } = await encryptBufferForStorage(
      Buffer.from("legacy"),
      "attachment:att-3",
    );

    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 2).toString("base64"),
      masterKeyId: "current-v2",
      additionalMasterKeys: { "old-v1": Buffer.alloc(32, 1).toString("base64") },
    });

    await expect(decryptBufferFromStorage(blob, metadata, "attachment:att-3")).resolves.toEqual(
      Buffer.from("legacy"),
    );
    expect(canUseStorageKeyId("local-v1", "old-v1")).toBe(true);
  });

  it("rewraps encrypted metadata to the active key id without rewriting ciphertext", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 3).toString("base64"),
      masterKeyId: "old-v1",
    });
    const { blob, metadata } = await encryptBufferForStorage(
      Buffer.from("rotate me"),
      "attachment:att-4",
    );

    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 4).toString("base64"),
      masterKeyId: "current-v2",
      additionalMasterKeys: { "old-v1": Buffer.alloc(32, 3).toString("base64") },
    });

    const rewrapped = await rewrapStorageEncryptionMetadata(metadata);

    expect(rewrapped.kekKeyId).toBe("current-v2");
    expect(rewrapped.wrappedDek).not.toBe(metadata.wrappedDek);
    await expect(decryptBufferFromStorage(blob, rewrapped, "attachment:att-4")).resolves.toEqual(
      Buffer.from("rotate me"),
    );
  });

  it("streams encrypted blobs without buffering the entire ciphertext first", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 6).toString("base64"),
      masterKeyId: "stream-key",
    });

    const plaintext = Buffer.from("stream me in small chunks");
    const { blob, metadata } = await encryptBufferForStorage(plaintext, "attachment:att-5");
    const stream = await decryptStreamFromStorage(
      Readable.from([blob.subarray(0, 5), blob.subarray(5, 17), blob.subarray(17)]),
      metadata,
      "attachment:att-5",
    );

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else {
        throw new Error("unexpected stream chunk type");
      }
    }

    expect(Buffer.concat(chunks)).toEqual(plaintext);
  });
});
