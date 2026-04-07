import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertStorageEncryptionReadiness } from "../../../src/startup/storageReadiness.js";

const mockReadAttachmentBytes = vi.fn();
const mockReadRawEmail = vi.fn();
const mockListPendingRawEmails = vi.fn();

vi.mock("../../../src/storage/disk.js", () => ({
  listPendingRawEmails: (...args: unknown[]): unknown => mockListPendingRawEmails(...args),
  readAttachmentBytes: (...args: unknown[]): unknown => mockReadAttachmentBytes(...args),
  readRawEmail: (...args: unknown[]): unknown => mockReadRawEmail(...args),
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
    mockListPendingRawEmails.mockResolvedValue([]);
  });

  it("rejects disabling encryption while encrypted rows still exist", async () => {
    const db = fakeDbWithRows([[{ present: 1 }], []]);

    await expect(
      assertStorageEncryptionReadiness(db, {
        ...baseConfig,
        storageEncryptionMode: "none",
      }),
    ).rejects.toThrow(/STORAGE_ENCRYPTION_MODE=none is not allowed/i);
  });

  it("rejects startup when encrypted attachments were written with another key id", async () => {
    const db = fakeDbWithRows([[{ id: "a1", kek_key_id: "legacy-key" }], []]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Encrypted attachments were written with a different key id/i,
    );
  });

  it("rejects startup when encrypted raw emails were written with another key id", async () => {
    const db = fakeDbWithRows([[], [{ id: "d1", raw_email_kek_key_id: "legacy-key" }], [], []]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Encrypted raw emails were written with a different key id/i,
    );
  });

  it("accepts encrypted rows whose key ids exist in the configured keyring", async () => {
    mockReadAttachmentBytes.mockResolvedValue(Buffer.from("image"));
    mockReadRawEmail.mockResolvedValue(Buffer.from("raw"));
    const db = fakeDbWithRows([
      [{ id: "a1", kek_key_id: "legacy-key" }],
      [{ id: "d1", raw_email_kek_key_id: "legacy-key" }],
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
  });

  it("fails startup when an encrypted attachment sample cannot be decrypted", async () => {
    mockReadAttachmentBytes.mockRejectedValue(new Error("bad key"));
    const db = fakeDbWithRows([
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
    ]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Failed to decrypt a stored attachment/i,
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
    const db = fakeDbWithRows([[], []]);

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
    const db = fakeDbWithRows([[], [], [], []]);

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
    const db = fakeDbWithRows([[], [], [], []]);

    await expect(assertStorageEncryptionReadiness(db, baseConfig)).rejects.toThrow(
      /Failed to decrypt a pending raw email/i,
    );
  });
});
