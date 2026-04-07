import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  backfillStoredEncryption,
  rewrapStoredEncryptionKeys,
} from "../../../src/security/storageMaintenance.js";
import {
  configureStorageEncryption,
  encryptBufferForStorage,
  resetStorageEncryptionForTests,
} from "../../../src/security/encryption.js";
import { readDeliveryLogMetadata } from "../../../src/security/deliveryLogMetadata.js";
import {
  backfillAttachmentFile,
  backfillRawEmailFile,
  listPendingRawEmails,
  openAttachmentStream,
  readRawEmail,
  writePendingRawEmailMeta,
} from "../../../src/storage/disk.js";
import { attachments, deliveryLogs } from "../../../src/db/schema.js";

const tempDirs: string[] = [];

function makeDb(rows: {
  plaintextAttachments?: Array<{ id: string; storagePath: string }>;
  plaintextRawEmails?: Array<{ id: string; rawEmailPath: string | null }>;
  plaintextMetadataLogs?: Array<{
    id: string;
    envelopeFrom: string | null;
    headerFrom: string | null;
    subject: string | null;
    metadataCiphertext: string | null;
    metadataEncryptionMode: string | null;
    metadataWrappedDek: string | null;
    metadataKekKeyId: string | null;
    metadataEncryptedAt: Date | null;
  }>;
  encryptedAttachments?: Array<{
    id: string;
    wrappedDek: string | null;
    kekKeyId: string | null;
    encryptedAt: Date | null;
  }>;
  encryptedRawEmails?: Array<{
    id: string;
    rawEmailWrappedDek: string | null;
    rawEmailKekKeyId: string | null;
    rawEmailEncryptedAt: Date | null;
  }>;
  encryptedMetadataLogs?: Array<{
    id: string;
    envelopeFrom: string | null;
    headerFrom: string | null;
    subject: string | null;
    metadataCiphertext: string | null;
    metadataEncryptionMode: string | null;
    metadataWrappedDek: string | null;
    metadataKekKeyId: string | null;
    metadataEncryptedAt: Date | null;
  }>;
}) {
  const updates = {
    attachments: [] as Array<{ where: string; values: Record<string, unknown> }>,
    deliveryLogs: [] as Array<{ where: string; values: Record<string, unknown> }>,
  };

  const attachmentSelects = [rows.plaintextAttachments ?? rows.encryptedAttachments ?? []];
  const deliveryLogSelects = [
    rows.plaintextRawEmails ?? rows.encryptedRawEmails ?? [],
    rows.plaintextMetadataLogs ?? rows.encryptedMetadataLogs ?? [],
  ];

  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === attachments) {
          return {
            where: () => Promise.resolve(attachmentSelects.shift() ?? []),
          };
        }
        if (table === deliveryLogs) {
          return {
            where: () => Promise.resolve(deliveryLogSelects.shift() ?? []),
          };
        }
        return { where: () => Promise.resolve([]) };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          const entry = { where: String(clause), values };
          if (table === attachments) updates.attachments.push(entry);
          else updates.deliveryLogs.push(entry);
          return Promise.resolve({ rowCount: 1 });
        },
      }),
    }),
    _updates: updates,
  };
}

describe("storage maintenance", () => {
  beforeEach(() => {
    resetStorageEncryptionForTests();
  });

  afterEach(async () => {
    resetStorageEncryptionForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("backfills plaintext attachment and raw-email files", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-maint-"));
    tempDirs.push(root);
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      masterKeyId: "current-v2",
    });

    const attachmentPath = join(root, "attachments", "a1.bin");
    const rawEmailPath = join(root, "raw", "2026-04-07", "m1.eml");
    await mkdir(dirname(attachmentPath), { recursive: true });
    await mkdir(dirname(rawEmailPath), { recursive: true });
    await writeFile(attachmentPath, Buffer.from("plain attachment"));
    await writeFile(rawEmailPath, Buffer.from("From: sender@example.com\r\n\r\nplain raw"));
    await writePendingRawEmailMeta(rawEmailPath, {
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      rawEmailEncryptionMode: "none",
      rawEmailWrappedDek: null,
      rawEmailKekKeyId: null,
    });

    const db = makeDb({
      plaintextAttachments: [{ id: "att-1", storagePath: attachmentPath }],
      plaintextRawEmails: [{ id: "log-1", rawEmailPath }],
      plaintextMetadataLogs: [
        {
          id: "log-1",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          subject: "Plain metadata",
          metadataCiphertext: null,
          metadataEncryptionMode: "none",
          metadataWrappedDek: null,
          metadataKekKeyId: null,
          metadataEncryptedAt: null,
        },
      ],
    });

    const summary = await backfillStoredEncryption(db as never, join(root, "raw"));

    expect(summary).toMatchObject({
      attachments: 1,
      rawEmails: 1,
      metadataLogs: 1,
      pendingRawEmails: 1,
    });
    const attachmentUpdate = db._updates.attachments[0];
    expect(attachmentUpdate?.values).toMatchObject({
      encryptionMode: "local-v1",
      kekKeyId: "current-v2",
    });
    const rawUpdate = db._updates.deliveryLogs[0];
    expect(rawUpdate?.values).toMatchObject({
      rawEmailEncryptionMode: "local-v1",
      rawEmailKekKeyId: "current-v2",
    });
    const metadataUpdate = db._updates.deliveryLogs[1];
    expect(metadataUpdate?.values).toMatchObject({
      envelopeFrom: null,
      headerFrom: null,
      subject: null,
      metadataEncryptionMode: "local-v1",
      metadataKekKeyId: "current-v2",
    });

    const pending = await listPendingRawEmails(join(root, "raw"));
    expect(pending[0]?.rawEmailEncryptionMode).toBe("local-v1");
    expect(pending[0]?.rawEmailKekKeyId).toBe("current-v2");

    const opened = await openAttachmentStream({
      id: "att-1",
      storagePath: attachmentPath,
      sizeBytes: Buffer.byteLength("plain attachment"),
      encryptionMode: String(attachmentUpdate?.values.encryptionMode),
      wrappedDek: String(attachmentUpdate?.values.wrappedDek),
      kekKeyId: String(attachmentUpdate?.values.kekKeyId),
    });
    const attachmentChunks: Buffer[] = [];
    for await (const chunk of opened.stream) {
      attachmentChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(new Uint8Array(chunk)));
    }
    expect(Buffer.concat(attachmentChunks).toString()).toBe("plain attachment");

    await expect(
      readRawEmail(rawEmailPath, {
        rawEmailEncryptionMode: String(rawUpdate?.values.rawEmailEncryptionMode),
        rawEmailWrappedDek: String(rawUpdate?.values.rawEmailWrappedDek),
        rawEmailKekKeyId: String(rawUpdate?.values.rawEmailKekKeyId),
      }),
    ).resolves.toEqual(Buffer.from("From: sender@example.com\r\n\r\nplain raw"));

    await expect(
      readDeliveryLogMetadata({
        id: "log-1",
        envelopeFrom: metadataUpdate?.values.envelopeFrom as string | null,
        headerFrom: metadataUpdate?.values.headerFrom as string | null,
        subject: metadataUpdate?.values.subject as string | null,
        metadataCiphertext: metadataUpdate?.values.metadataCiphertext as string | null,
        metadataEncryptionMode: metadataUpdate?.values.metadataEncryptionMode as
          | "none"
          | "local-v1",
        metadataWrappedDek: metadataUpdate?.values.metadataWrappedDek as string | null,
        metadataKekKeyId: metadataUpdate?.values.metadataKekKeyId as string | null,
        metadataEncryptedAt: metadataUpdate?.values.metadataEncryptedAt as Date | null,
      }),
    ).resolves.toEqual({
      envelopeFrom: "sender@example.com",
      headerFrom: "Sender <sender@example.com>",
      subject: "Plain metadata",
    });
  });

  it("rewraps stored DEKs to the current key id", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-maint-"));
    tempDirs.push(root);
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 3).toString("base64"),
      masterKeyId: "old-v1",
    });

    const { metadata: attachmentMetadata } = await encryptBufferForStorage(
      Buffer.from("attachment"),
      "attachment:att-1",
    );
    const { metadata: rawMetadata } = await encryptBufferForStorage(
      Buffer.from("raw"),
      "raw-email:message.eml",
    );
    const { metadata: logMetadata, blob: logMetadataBlob } = await encryptBufferForStorage(
      Buffer.from(
        JSON.stringify({
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          subject: "Encrypted metadata",
        }),
      ),
      "delivery-log-meta:log-1",
    );

    const rawEmailPath = join(root, "2026-04-07", "message.eml");
    await writePendingRawEmailMeta(rawEmailPath, {
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      rawEmailEncryptionMode: rawMetadata.encryptionMode,
      rawEmailWrappedDek: rawMetadata.wrappedDek,
      rawEmailKekKeyId: rawMetadata.kekKeyId,
    });

    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 4).toString("base64"),
      masterKeyId: "current-v2",
      additionalMasterKeys: {
        "old-v1": Buffer.alloc(32, 3).toString("base64"),
      },
    });

    const db = makeDb({
      encryptedAttachments: [
        {
          id: "att-1",
          wrappedDek: attachmentMetadata.wrappedDek,
          kekKeyId: attachmentMetadata.kekKeyId,
          encryptedAt: attachmentMetadata.encryptedAt,
        },
      ],
      encryptedRawEmails: [
        {
          id: "log-1",
          rawEmailWrappedDek: rawMetadata.wrappedDek,
          rawEmailKekKeyId: rawMetadata.kekKeyId,
          rawEmailEncryptedAt: rawMetadata.encryptedAt,
        },
      ],
      encryptedMetadataLogs: [
        {
          id: "log-1",
          envelopeFrom: null,
          headerFrom: null,
          subject: null,
          metadataCiphertext: logMetadataBlob.toString("base64"),
          metadataEncryptionMode: logMetadata.encryptionMode,
          metadataWrappedDek: logMetadata.wrappedDek,
          metadataKekKeyId: logMetadata.kekKeyId,
          metadataEncryptedAt: logMetadata.encryptedAt,
        },
      ],
    });

    const summary = await rewrapStoredEncryptionKeys(db as never, root);

    expect(summary).toMatchObject({
      attachments: 1,
      rawEmails: 1,
      metadataLogs: 1,
      pendingRawEmails: 1,
    });
    expect(db._updates.attachments[0]?.values).toMatchObject({ kekKeyId: "current-v2" });
    expect(db._updates.deliveryLogs[0]?.values).toMatchObject({ rawEmailKekKeyId: "current-v2" });
    expect(db._updates.deliveryLogs[1]?.values).toMatchObject({ metadataKekKeyId: "current-v2" });
    const pending = await listPendingRawEmails(root);
    expect(pending[0]?.rawEmailKekKeyId).toBe("current-v2");
  });

  it("resumes interrupted backfills from persisted metadata without re-encrypting the files again", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-maint-"));
    tempDirs.push(root);
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 11).toString("base64"),
      masterKeyId: "current-v2",
    });

    const attachmentPath = join(root, "attachments", "a2.bin");
    const rawEmailPath = join(root, "raw", "2026-04-07", "m2.eml");
    await mkdir(dirname(attachmentPath), { recursive: true });
    await mkdir(dirname(rawEmailPath), { recursive: true });
    await writeFile(attachmentPath, Buffer.from("resume attachment"));
    await writeFile(rawEmailPath, Buffer.from("From: sender@example.com\r\n\r\nresume raw"));
    await writePendingRawEmailMeta(rawEmailPath, {
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      rawEmailEncryptionMode: "none",
      rawEmailWrappedDek: null,
      rawEmailKekKeyId: null,
    });

    await backfillAttachmentFile(attachmentPath, "att-2");
    await backfillRawEmailFile(rawEmailPath);

    const db = makeDb({
      plaintextAttachments: [{ id: "att-2", storagePath: attachmentPath }],
      plaintextRawEmails: [{ id: "log-2", rawEmailPath }],
      plaintextMetadataLogs: [],
    });

    const summary = await backfillStoredEncryption(db as never, join(root, "raw"));

    expect(summary).toMatchObject({
      attachments: 1,
      rawEmails: 1,
      pendingRawEmails: 1,
      skippedMissingFiles: 0,
    });
    await expect(stat(`${attachmentPath}.backfill.json`)).rejects.toThrow();
    await expect(stat(`${rawEmailPath}.backfill.json`)).rejects.toThrow();
    const rawUpdate = db._updates.deliveryLogs[0];
    await expect(
      readRawEmail(rawEmailPath, {
        rawEmailEncryptionMode: String(rawUpdate?.values.rawEmailEncryptionMode),
        rawEmailWrappedDek: String(rawUpdate?.values.rawEmailWrappedDek),
        rawEmailKekKeyId: String(rawUpdate?.values.rawEmailKekKeyId),
      }),
    ).resolves.toEqual(Buffer.from("From: sender@example.com\r\n\r\nresume raw"));
  });

  it("skips unchanged rewrap targets and pending rows outside local-v1", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-maint-"));
    tempDirs.push(root);
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 12).toString("base64"),
      masterKeyId: "current-v2",
    });

    await writePendingRawEmailMeta(join(root, "2026-04-07", "message.eml"), {
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      rawEmailEncryptionMode: "none",
      rawEmailWrappedDek: null,
      rawEmailKekKeyId: null,
    });

    const metadata = await encryptBufferForStorage(Buffer.from("same"), "attachment:att-1");
    const db = makeDb({
      encryptedAttachments: [
        {
          id: "att-1",
          wrappedDek: metadata.metadata.wrappedDek,
          kekKeyId: metadata.metadata.kekKeyId,
          encryptedAt: metadata.metadata.encryptedAt,
        },
      ],
      encryptedRawEmails: [],
      encryptedMetadataLogs: [],
    });

    const summary = await rewrapStoredEncryptionKeys(db as never, root);

    expect(summary).toEqual({
      attachments: 0,
      rawEmails: 0,
      metadataLogs: 0,
      pendingRawEmails: 0,
      skippedMissingFiles: 0,
    });
    expect(db._updates.attachments).toHaveLength(0);
    expect(db._updates.deliveryLogs).toHaveLength(0);
  });

  it("skips missing files, null raw paths, empty metadata rows, and already encrypted pending rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-maint-"));
    tempDirs.push(root);
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 13).toString("base64"),
      masterKeyId: "current-v3",
    });

    const missingAttachmentPath = join(root, "attachments", "missing.bin");
    const missingRawEmailPath = join(root, "raw", "2026-04-07", "missing.eml");
    await writePendingRawEmailMeta(join(root, "raw", "2026-04-07", "already.encrypted.eml"), {
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      rawEmailEncryptionMode: "local-v1",
      rawEmailWrappedDek: "wrapped",
      rawEmailKekKeyId: "current-v3",
    });

    const db = makeDb({
      plaintextAttachments: [{ id: "att-missing", storagePath: missingAttachmentPath }],
      plaintextRawEmails: [
        { id: "log-null", rawEmailPath: null },
        { id: "log-missing", rawEmailPath: missingRawEmailPath },
      ],
      plaintextMetadataLogs: [
        {
          id: "log-empty",
          envelopeFrom: null,
          headerFrom: null,
          subject: null,
          metadataCiphertext: null,
          metadataEncryptionMode: "none",
          metadataWrappedDek: null,
          metadataKekKeyId: null,
          metadataEncryptedAt: null,
        },
      ],
    });

    const summary = await backfillStoredEncryption(db as never, join(root, "raw"));

    expect(summary).toEqual({
      attachments: 0,
      rawEmails: 0,
      metadataLogs: 0,
      pendingRawEmails: 0,
      skippedMissingFiles: 2,
    });
    expect(db._updates.attachments).toHaveLength(0);
    expect(db._updates.deliveryLogs).toHaveLength(0);
  });
});
