import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertStorageEncryptionReadiness } from "../../../src/startup/storageReadiness.js";

const mockReadAttachmentBytes = vi.fn();
const mockReadRawEmail = vi.fn();
const mockListPendingRawEmails = vi.fn();
const mockReadDeliveryLogMetadata = vi.fn();

vi.mock("../../../src/storage/disk.js", () => ({
  listPendingRawEmails: (...args: unknown[]): unknown => mockListPendingRawEmails(...args),
  readAttachmentBytes: (...args: unknown[]): unknown => mockReadAttachmentBytes(...args),
  readRawEmail: (...args: unknown[]): unknown => mockReadRawEmail(...args),
}));
vi.mock("../../../src/security/deliveryLogMetadata.js", () => ({
  readDeliveryLogMetadata: (...args: unknown[]): unknown => mockReadDeliveryLogMetadata(...args),
}));

function fakeDbWithRows(rowSets: unknown[][]) {
  const execute = vi.fn(() => Promise.resolve({ rows: rowSets.shift() ?? [] }));
  return { execute } as unknown as Parameters<typeof assertStorageEncryptionReadiness>[0];
}

const baseConfig = {
  storageEncryptionMode: "local-v1" as const,
  masterEncryptionKeyId: "local-env-v1",
  masterEncryptionKeyring: {},
  attachmentTtlHours: 24,
  rawEmailTtlHours: 24,
  rawEmailDir: "/data/rawemails",
};

describe("assertStorageEncryptionReadiness", () => {
  beforeEach(() => {
    mockReadAttachmentBytes.mockReset();
    mockReadRawEmail.mockReset();
    mockListPendingRawEmails.mockReset();
    mockReadDeliveryLogMetadata.mockReset();
    mockListPendingRawEmails.mockResolvedValue([]);
    mockReadDeliveryLogMetadata.mockResolvedValue({
      envelopeFrom: "sender@example.com",
      headerFrom: "Sender <sender@example.com>",
      subject: "Alert",
    });
  });

  it("rejects disabling encryption while encrypted rows still exist", async () => {
    const db = fakeDbWithRows([[{ present: 1 }], [], []]);

    await expect(
      assertStorageEncryptionReadiness(db, {
        ...baseConfig,
        storageEncryptionMode: "none",
      }),
    ).rejects.toThrow(/STORAGE_ENCRYPTION_MODE=none is not allowed/i);
  });

  it("allows disabling encryption when no encrypted rows or pending files remain", async () => {
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: "/data/rawemails/plain.eml",
        rawEmailEncryptionMode: "none",
        rawEmailWrappedDek: null,
        rawEmailKekKeyId: null,
      },
    ]);
    const db = fakeDbWithRows([[], [], []]);

    await expect(
      assertStorageEncryptionReadiness(db, {
        ...baseConfig,
        storageEncryptionMode: "none",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects startup when encrypted attachments were written with another key id", async () => {
    const db = fakeDbWithRows([[{ id: "a1", kek_key_id: "legacy-key" }], [], [], [], [], []]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Encrypted attachments were written with a different key id/i,
    );
  });

  it("rejects startup when encrypted raw emails were written with another key id", async () => {
    const db = fakeDbWithRows([
      [],
      [{ id: "d1", raw_email_kek_key_id: "legacy-key" }],
      [],
      [],
      [],
      [],
    ]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Encrypted raw emails were written with a different key id/i,
    );
  });

  it("rejects startup when encrypted delivery metadata was written with another key id", async () => {
    const db = fakeDbWithRows([
      [],
      [],
      [{ id: "d1", metadata_kek_key_id: "legacy-key" }],
      [],
      [],
      [],
    ]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Encrypted delivery metadata was written with a different key id/i,
    );
  });

  it("accepts encrypted rows whose key ids exist in the configured keyring", async () => {
    mockReadAttachmentBytes.mockResolvedValue(Buffer.from("image"));
    mockReadRawEmail.mockResolvedValue(Buffer.from("raw"));
    const db = fakeDbWithRows([
      [{ id: "a1", kek_key_id: "legacy-key" }],
      [{ id: "d1", raw_email_kek_key_id: "legacy-key" }],
      [{ id: "d1", metadata_kek_key_id: "legacy-key" }],
      [
        {
          id: "a1",
          storage_path: "/data/attachments/a1.bin",
          encryption_mode: "local-v1",
          wrapped_dek: "wrapped-attachment",
          kek_key_id: "legacy-key",
        },
      ],
      [
        {
          raw_email_path: "/data/rawemails/d1.eml",
          raw_email_encryption_mode: "local-v1",
          raw_email_wrapped_dek: "wrapped-raw",
          raw_email_kek_key_id: "legacy-key",
        },
      ],
      [
        {
          id: "d1",
          envelope_from: null,
          header_from: null,
          subject: null,
          metadata_ciphertext: "ciphertext",
          metadata_encryption_mode: "local-v1",
          metadata_wrapped_dek: "wrapped-metadata",
          metadata_kek_key_id: "legacy-key",
          metadata_encrypted_at: new Date("2026-04-07T12:00:00.000Z"),
        },
      ],
    ]);

    await expect(
      assertStorageEncryptionReadiness(db, {
        ...baseConfig,
        masterEncryptionKeyring: {
          "legacy-key": Buffer.alloc(32, 3).toString("base64"),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("verifies recent encrypted attachment and raw email samples can be decrypted", async () => {
    mockReadAttachmentBytes.mockResolvedValue(Buffer.from("image"));
    mockReadRawEmail.mockResolvedValue(Buffer.from("raw"));
    const db = fakeDbWithRows([
      [],
      [],
      [],
      [
        {
          id: "a1",
          storage_path: "/data/attachments/a1.bin",
          encryption_mode: "local-v1",
          wrapped_dek: "wrapped-attachment",
          kek_key_id: "local-env-v1",
        },
      ],
      [
        {
          raw_email_path: "/data/rawemails/d1.eml",
          raw_email_encryption_mode: "local-v1",
          raw_email_wrapped_dek: "wrapped-raw",
          raw_email_kek_key_id: "local-env-v1",
        },
      ],
      [
        {
          id: "d1",
          envelope_from: null,
          header_from: null,
          subject: null,
          metadata_ciphertext: "ciphertext",
          metadata_encryption_mode: "local-v1",
          metadata_wrapped_dek: "wrapped-metadata",
          metadata_kek_key_id: "local-env-v1",
          metadata_encrypted_at: new Date("2026-04-07T12:00:00.000Z"),
        },
      ],
    ]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).resolves.toBeUndefined();

    expect(mockReadAttachmentBytes).toHaveBeenCalledWith({
      id: "a1",
      storagePath: "/data/attachments/a1.bin",
      encryptionMode: "local-v1",
      wrappedDek: "wrapped-attachment",
      kekKeyId: "local-env-v1",
    });
    expect(mockReadRawEmail).toHaveBeenCalledWith("/data/rawemails/d1.eml", {
      rawEmailEncryptionMode: "local-v1",
      rawEmailWrappedDek: "wrapped-raw",
      rawEmailKekKeyId: "local-env-v1",
    });
    expect(mockReadDeliveryLogMetadata).toHaveBeenCalledWith({
      id: "d1",
      envelopeFrom: null,
      headerFrom: null,
      subject: null,
      metadataCiphertext: "ciphertext",
      metadataEncryptionMode: "local-v1",
      metadataWrappedDek: "wrapped-metadata",
      metadataKekKeyId: "local-env-v1",
      metadataEncryptedAt: new Date("2026-04-07T12:00:00.000Z"),
    });
  });

  it("fails startup when an encrypted attachment sample cannot be decrypted", async () => {
    mockReadAttachmentBytes.mockRejectedValue(new Error("bad key"));
    const db = fakeDbWithRows([
      [],
      [],
      [],
      [
        {
          id: "a1",
          storage_path: "/data/attachments/a1.bin",
          encryption_mode: "local-v1",
          wrapped_dek: "wrapped-attachment",
          kek_key_id: "local-env-v1",
        },
      ],
      [],
      [],
    ]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Failed to decrypt a stored attachment/i,
    );
  });

  it("ignores missing encrypted raw-email sample files during startup probes", async () => {
    mockReadRawEmail.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const db = fakeDbWithRows([
      [],
      [],
      [],
      [],
      [
        {
          raw_email_path: "/data/rawemails/d1.eml",
          raw_email_encryption_mode: "local-v1",
          raw_email_wrapped_dek: "wrapped-raw",
          raw_email_kek_key_id: "local-env-v1",
        },
      ],
      [],
    ]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).resolves.toBeUndefined();
  });

  it("fails startup when encrypted delivery metadata cannot be decrypted", async () => {
    mockReadDeliveryLogMetadata.mockRejectedValue(new Error("bad metadata key"));
    const db = fakeDbWithRows([
      [],
      [],
      [],
      [],
      [],
      [
        {
          id: "d1",
          envelope_from: null,
          header_from: null,
          subject: null,
          metadata_ciphertext: "ciphertext",
          metadata_encryption_mode: "local-v1",
          metadata_wrapped_dek: "wrapped-metadata",
          metadata_kek_key_id: "local-env-v1",
          metadata_encrypted_at: new Date("2026-04-07T12:00:00.000Z"),
        },
      ],
    ]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Failed to decrypt stored delivery metadata/i,
    );
  });

  it("rejects disabling encryption while encrypted pending raw emails still exist", async () => {
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: "/data/rawemails/pending.eml",
        rawEmailEncryptionMode: "local-v1",
        rawEmailWrappedDek: "wrapped-pending",
        rawEmailKekKeyId: "local-env-v1",
      },
    ]);
    const db = fakeDbWithRows([[], [], []]);

    await expect(
      assertStorageEncryptionReadiness(db, {
        ...baseConfig,
        storageEncryptionMode: "none",
      }),
    ).rejects.toThrow(/pending raw emails still exist/i);
  });

  it("rejects startup when encrypted pending raw emails were written with another key id", async () => {
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: "/data/rawemails/pending.eml",
        rawEmailEncryptionMode: "local-v1",
        rawEmailWrappedDek: "wrapped-pending",
        rawEmailKekKeyId: "legacy-key",
      },
    ]);
    const db = fakeDbWithRows([[], [], [], [], [], []]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Encrypted pending raw emails were written with a different key id/i,
    );
  });

  it("fails startup when an encrypted pending raw email cannot be decrypted", async () => {
    mockReadRawEmail.mockRejectedValue(new Error("bad pending key"));
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: "/data/rawemails/pending.eml",
        rawEmailEncryptionMode: "local-v1",
        rawEmailWrappedDek: "wrapped-pending",
        rawEmailKekKeyId: "local-env-v1",
      },
    ]);
    const db = fakeDbWithRows([[], [], [], [], [], []]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Failed to decrypt a pending raw email/i,
    );
  });

  it("ignores missing encrypted raw-email files that cleanup/recovery can self-heal", async () => {
    mockReadRawEmail.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: "/data/rawemails/pending.eml",
        rawEmailEncryptionMode: "local-v1",
        rawEmailWrappedDek: "wrapped-pending",
        rawEmailKekKeyId: "local-env-v1",
      },
    ]);
    const db = fakeDbWithRows([
      [],
      [],
      [],
      [],
      [
        {
          raw_email_path: "/data/rawemails/d1.eml",
          raw_email_encryption_mode: "local-v1",
          raw_email_wrapped_dek: "wrapped-raw",
          raw_email_kek_key_id: "local-env-v1",
        },
      ],
      [],
    ]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).resolves.toBeUndefined();
  });
});
