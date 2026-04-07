import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureStorageEncryption,
  resetStorageEncryptionForTests,
} from "../../../src/security/encryption.js";
import {
  backfillDeliveryLogMetadata,
  prepareDeliveryLogMetadataWrite,
  readDeliveryLogMetadata,
  rewrapDeliveryLogMetadata,
} from "../../../src/security/deliveryLogMetadata.js";

describe("delivery log metadata encryption", () => {
  beforeEach(() => {
    resetStorageEncryptionForTests();
  });

  afterEach(() => {
    resetStorageEncryptionForTests();
  });

  it("keeps delivery metadata plaintext when storage encryption is disabled", async () => {
    const stored = await prepareDeliveryLogMetadataWrite("log-1", {
      envelopeFrom: "sender@example.com",
      headerFrom: "Sender <sender@example.com>",
      subject: "Alert",
    });

    expect(stored).toMatchObject({
      envelopeFrom: "sender@example.com",
      headerFrom: "Sender <sender@example.com>",
      subject: "Alert",
      metadataEncryptionMode: "none",
      metadataCiphertext: null,
    });
  });

  it("encrypts and decrypts delivery metadata with the active storage key", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      masterKeyId: "meta-v1",
    });

    const stored = await prepareDeliveryLogMetadataWrite("log-2", {
      envelopeFrom: "sender@example.com",
      headerFrom: "Sender <sender@example.com>",
      subject: "Disk alert",
    });

    expect(stored.envelopeFrom).toBeNull();
    expect(stored.metadataEncryptionMode).toBe("local-v1");
    await expect(
      readDeliveryLogMetadata({
        id: "log-2",
        envelopeFrom: stored.envelopeFrom,
        headerFrom: stored.headerFrom,
        subject: stored.subject,
        metadataCiphertext: stored.metadataCiphertext,
        metadataEncryptionMode: stored.metadataEncryptionMode,
        metadataWrappedDek: stored.metadataWrappedDek,
        metadataKekKeyId: stored.metadataKekKeyId,
        metadataEncryptedAt: stored.metadataEncryptedAt,
      }),
    ).resolves.toEqual({
      envelopeFrom: "sender@example.com",
      headerFrom: "Sender <sender@example.com>",
      subject: "Disk alert",
    });
  });

  it("backfills plaintext metadata and rewraps it to a newer key id", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      masterKeyId: "old-v1",
    });

    const backfilled = await backfillDeliveryLogMetadata({
      id: "log-3",
      envelopeFrom: "legacy@example.com",
      headerFrom: "Legacy <legacy@example.com>",
      subject: "Legacy alert",
      metadataCiphertext: null,
      metadataEncryptionMode: "none",
      metadataWrappedDek: null,
      metadataKekKeyId: null,
      metadataEncryptedAt: null,
    });

    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 2).toString("base64"),
      masterKeyId: "current-v2",
      additionalMasterKeys: {
        "old-v1": Buffer.alloc(32, 1).toString("base64"),
      },
    });

    const rewrapped = await rewrapDeliveryLogMetadata({
      id: "log-3",
      envelopeFrom: backfilled.envelopeFrom,
      headerFrom: backfilled.headerFrom,
      subject: backfilled.subject,
      metadataCiphertext: backfilled.metadataCiphertext,
      metadataEncryptionMode: backfilled.metadataEncryptionMode,
      metadataWrappedDek: backfilled.metadataWrappedDek,
      metadataKekKeyId: backfilled.metadataKekKeyId,
      metadataEncryptedAt: backfilled.metadataEncryptedAt,
    });

    expect(backfilled.metadataKekKeyId).toBe("old-v1");
    expect(rewrapped.metadataKekKeyId).toBe("current-v2");
  });

  it("returns already encrypted metadata unchanged during backfill", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      masterKeyId: "meta-v1",
    });

    const stored = await prepareDeliveryLogMetadataWrite("log-4", {
      envelopeFrom: "sender@example.com",
      headerFrom: "Sender <sender@example.com>",
      subject: "Already encrypted",
    });

    await expect(
      backfillDeliveryLogMetadata({
        id: "log-4",
        envelopeFrom: stored.envelopeFrom,
        headerFrom: stored.headerFrom,
        subject: stored.subject,
        metadataCiphertext: stored.metadataCiphertext,
        metadataEncryptionMode: stored.metadataEncryptionMode,
        metadataWrappedDek: stored.metadataWrappedDek,
        metadataKekKeyId: stored.metadataKekKeyId,
        metadataEncryptedAt: stored.metadataEncryptedAt,
      }),
    ).resolves.toEqual(stored);
  });

  it("returns unchanged rewrap columns when metadata is not encrypted", async () => {
    await expect(
      rewrapDeliveryLogMetadata({
        id: "log-5",
        envelopeFrom: "sender@example.com",
        headerFrom: "Sender <sender@example.com>",
        subject: "Plain",
        metadataCiphertext: null,
        metadataEncryptionMode: "none",
        metadataWrappedDek: null,
        metadataKekKeyId: null,
        metadataEncryptedAt: null,
      }),
    ).resolves.toEqual({
      metadataWrappedDek: null,
      metadataKekKeyId: null,
    });
  });

  it("rejects unsupported encrypted metadata modes", async () => {
    await expect(
      readDeliveryLogMetadata({
        id: "log-6",
        envelopeFrom: null,
        headerFrom: null,
        subject: null,
        metadataCiphertext: "anything",
        metadataEncryptionMode: "kms-v1" as never,
        metadataWrappedDek: "wrapped",
        metadataKekKeyId: "key-id",
        metadataEncryptedAt: null,
      }),
    ).rejects.toThrow(/unsupported delivery-log metadata encryption mode/i);
  });

  it("rejects encrypted metadata records without ciphertext", async () => {
    await expect(
      readDeliveryLogMetadata({
        id: "log-7",
        envelopeFrom: null,
        headerFrom: null,
        subject: null,
        metadataCiphertext: null,
        metadataEncryptionMode: "local-v1",
        metadataWrappedDek: "wrapped",
        metadataKekKeyId: "key-id",
        metadataEncryptedAt: null,
      }),
    ).rejects.toThrow(/missing ciphertext/i);
  });
});
