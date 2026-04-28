import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindFailedLogs = vi.fn();
const mockClaimLog = vi.fn();
const mockUpdateLogStatus = vi.fn();
const mockFindAliasById = vi.fn();
const mockCountAttempts = vi.fn();
const mockInsertAttempt = vi.fn();
const mockReadRawEmail = vi.fn();
const mockSendTelegramMessage = vi.fn();
const mockSendTelegramPhotos = vi.fn();
const mockListAttachments = vi.fn();
const mockCreateAttachmentLink = vi.fn();
const mockCreateDeliveryViewLink = vi.fn();
const mockFindDeliveryLogByRawEmailPath = vi.fn();
const mockListPendingRawEmails = vi.fn();
const mockDeletePendingRawEmailMeta = vi.fn();
const mockDeleteFile = vi.fn();
const mockQueueInboundEmail = vi.fn();
const mockDeliverQueuedEmail = vi.fn();
const mockPipelineTrackerIsActive = vi.fn();
const mockPipelineTrackerRunFor = vi.fn();

vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  findLogsNeedingRetry: (...args: unknown[]): unknown => mockFindFailedLogs(...args),
  claimDeliveryLogForRetry: (...args: unknown[]): unknown => mockClaimLog(...args),
  findDeliveryLogByRawEmailPath: (...args: unknown[]): unknown =>
    mockFindDeliveryLogByRawEmailPath(...args),
  updateDeliveryLogStatus: (...args: unknown[]): unknown => mockUpdateLogStatus(...args),
}));
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
}));
vi.mock("../../../src/db/repos/attachments.js", () => ({
  listAttachmentsByDeliveryLogId: (...args: unknown[]): unknown => mockListAttachments(...args),
}));
vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  createAttachmentLink: (...args: unknown[]): unknown => mockCreateAttachmentLink(...args),
}));
vi.mock("../../../src/db/repos/deliveryViewLinks.js", () => ({
  createDeliveryViewLink: (...args: unknown[]): unknown => mockCreateDeliveryViewLink(...args),
}));
vi.mock("../../../src/db/repos/deliveryAttempts.js", () => ({
  countAttemptsByLog: (...args: unknown[]): unknown => mockCountAttempts(...args),
  insertDeliveryAttempt: (...args: unknown[]): unknown => mockInsertAttempt(...args),
}));
vi.mock("../../../src/storage/disk.js", () => ({
  readRawEmail: (...args: unknown[]): unknown => mockReadRawEmail(...args),
  listPendingRawEmails: (...args: unknown[]): unknown => mockListPendingRawEmails(...args),
  deletePendingRawEmailMeta: (...args: unknown[]): unknown =>
    mockDeletePendingRawEmailMeta(...args),
  deleteFile: (...args: unknown[]): unknown => mockDeleteFile(...args),
}));
vi.mock("../../../src/telegram/sender.js", () => ({
  sendTelegramMessage: (...args: unknown[]): unknown => mockSendTelegramMessage(...args),
  sendTelegramPhotos: (...args: unknown[]): unknown => mockSendTelegramPhotos(...args),
}));
vi.mock("../../../src/email/pipeline.js", () => ({
  queueInboundEmail: (...args: unknown[]): unknown => mockQueueInboundEmail(...args),
  deliverQueuedEmail: (...args: unknown[]): unknown => mockDeliverQueuedEmail(...args),
}));
vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../../src/utils/inFlight.js", () => ({
  pipelineTracker: {
    isActive: (...args: unknown[]): unknown => mockPipelineTrackerIsActive(...args),
    runFor: (...args: unknown[]): unknown => mockPipelineTrackerRunFor(...args),
  },
}));

// Use real parser/cleaner/renderer (they don't need DB)
const RAW_EMAIL = Buffer.from(
  "From: sender@example.com\r\nTo: alias@example.com\r\nSubject: Test\r\n\r\nHello world",
);

const fakeAlias = {
  id: "alias-uuid",
  localPart: "alerts",
  fullAddress: "alerts@example.com",
  chatId: -100n,
  messageThreadId: null,
  status: "active",
  renderMode: "plaintext",
  privacyModeEnabled: false,
  bodyDedupEnabled: false,
};

const fakeLog = {
  id: "log-uuid",
  emailAddressId: "alias-uuid",
  rawEmailPath: "/data/rawemails/2026-01-01/test.eml",
  receivedAt: new Date("2026-04-07T12:00:00.000Z"),
  rawEmailEncryptionMode: "none",
  rawEmailWrappedDek: null,
  rawEmailKekKeyId: null,
};

const { runRetryWorker } = await import("../../../src/email/retry.js");

const fakeDb = {} as Parameters<typeof runRetryWorker>[0];
const fakeApi = { sendMessage: vi.fn() } as unknown as Parameters<typeof runRetryWorker>[1];

describe("runRetryWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockClaimLog.mockResolvedValue(true);
    mockCountAttempts.mockResolvedValue(0);
    mockInsertAttempt.mockResolvedValue(undefined);
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockReadRawEmail.mockResolvedValue(RAW_EMAIL);
    mockSendTelegramMessage.mockResolvedValue({ ok: true, telegramMessageId: 42 });
    mockSendTelegramPhotos.mockResolvedValue({ ok: true, failedPhotos: [] });
    mockListAttachments.mockResolvedValue([]);
    mockCreateAttachmentLink.mockResolvedValue(undefined);
    mockCreateDeliveryViewLink.mockResolvedValue(undefined);
    mockFindDeliveryLogByRawEmailPath.mockResolvedValue(null);
    mockListPendingRawEmails.mockResolvedValue([]);
    mockDeletePendingRawEmailMeta.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockQueueInboundEmail.mockResolvedValue({
      queued: true,
      job: { deliveryLog: { id: "recovered-log" } },
    });
    mockDeliverQueuedEmail.mockResolvedValue({ ok: true });
    mockPipelineTrackerIsActive.mockReturnValue(false);
    mockPipelineTrackerRunFor.mockImplementation(async (_key: string, fn: () => Promise<unknown>) =>
      fn(),
    );
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
  });

  it("does nothing when there are no failed logs", async () => {
    mockFindFailedLogs.mockResolvedValue([]);
    await runRetryWorker(fakeDb, fakeApi);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("does nothing when api is null", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    await runRetryWorker(fakeDb, null);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("successfully retries a failed log and marks it delivered", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockClaimLog).toHaveBeenCalledWith(fakeDb, fakeLog.id);
    expect(mockReadRawEmail).toHaveBeenCalledWith(
      fakeLog.rawEmailPath,
      expect.objectContaining({ rawEmailEncryptionMode: "none" }),
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
    expect(mockInsertAttempt).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ status: "succeeded", attemptNo: 1 }),
    );
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "delivered");
  });

  it("marks permanently_failed when max retries reached", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockCountAttempts.mockResolvedValue(3); // already at MAX_RETRIES
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
  });

  it("marks permanently_failed when alias is deleted", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, status: "deleted" });
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("marks permanently_failed when raw email file is missing", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockReadRawEmail.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
  });

  it("marks permanently_failed when rawEmailPath is null", async () => {
    mockFindFailedLogs.mockResolvedValue([{ ...fakeLog, rawEmailPath: null }]);
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("records failed attempt and resets status to failed when send fails but retries remain", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockCountAttempts.mockResolvedValue(0); // first attempt
    mockSendTelegramMessage.mockResolvedValue({ ok: false, error: "Telegram error" });
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockInsertAttempt).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ status: "failed" }),
    );
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "delivered");
  });

  it("marks permanently_failed on last failed attempt", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockCountAttempts.mockResolvedValue(2); // attempt 3 of 3
    mockSendTelegramMessage.mockResolvedValue({ ok: false, error: "Telegram error" });
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
  });

  it("skips logs that another worker already claimed", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockClaimLog.mockResolvedValue(false);

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    expect(mockReadRawEmail).not.toHaveBeenCalled();
  });

  it("skips logs that are already active in the local pipeline tracker", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockPipelineTrackerIsActive.mockReturnValue(true);

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockClaimLog).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("resets the status to failed when retry crashes unexpectedly", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockInsertAttempt.mockRejectedValueOnce(new Error("db exploded"));

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
  });

  it("rebuilds fresh attachment links during retry", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockListAttachments.mockResolvedValue([
      {
        id: "att-1",
        originalFilename: "report.pdf",
        sizeBytes: 123,
        storagePath: "/data/attachments/log-uuid/report.pdf",
        contentType: "application/pdf",
      },
    ]);

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentTtlHours: 48,
      publicBaseUrl: "https://mail.example.com",
    });

    expect(mockCreateAttachmentLink).toHaveBeenCalledWith(
      fakeDb,
      "att-1",
      expect.any(String),
      expect.any(Date),
    );
    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("/dl/");
  });

  it("uses a privacy-mode alert and skips Telegram photo upload when privacy mode is enabled", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, privacyModeEnabled: true });
    mockListAttachments.mockResolvedValue([
      {
        id: "att-image-1",
        originalFilename: "graph.png",
        sizeBytes: 123,
        storagePath: "/data/attachments/log-uuid/graph.png",
        contentType: "image/png",
      },
    ]);

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentTtlHours: 24,
      rawEmailTtlHours: 24,
      publicBaseUrl: "https://mail.example.com",
    });

    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("/view/");
    expect(opts.text).not.toContain("Hello world");
    expect(mockSendTelegramPhotos).not.toHaveBeenCalled();
    expect(mockCreateAttachmentLink).not.toHaveBeenCalled();
    expect(mockCreateDeliveryViewLink).toHaveBeenCalledWith(
      fakeDb,
      fakeLog.id,
      expect.any(String),
      expect.any(Date),
    );
  });

  it("uses HTML parse mode for markdown-rendered retries", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, renderMode: "markdown" });
    mockReadRawEmail.mockResolvedValue(
      Buffer.from(
        "From: sender@example.com\r\nTo: alias@example.com\r\nSubject: Markdown\r\n\r\n# Heading\r\n\r\n**Bold**",
      ),
    );

    await runRetryWorker(fakeDb, fakeApi);

    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [
      unknown,
      { parseMode?: string; text: string },
    ];
    expect(opts.parseMode).toBe("HTML");
    expect(opts.text).toContain("<b>Heading</b>");
    expect(opts.text).toContain("<b>Bold</b>");
  });

  it("does not rebuild download links for image attachments that are resent as photos", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockListAttachments.mockResolvedValue([
      {
        id: "att-image",
        originalFilename: "photo.png",
        sizeBytes: 111,
        storagePath: "/data/attachments/log-uuid/photo.png",
        contentType: "image/png",
      },
      {
        id: "att-pdf",
        originalFilename: "report.pdf",
        sizeBytes: 123,
        storagePath: "/data/attachments/log-uuid/report.pdf",
        contentType: "application/pdf",
      },
    ]);

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentTtlHours: 48,
      publicBaseUrl: "https://mail.example.com",
    });

    expect(mockCreateAttachmentLink).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentLink).toHaveBeenCalledWith(
      fakeDb,
      "att-pdf",
      expect.any(String),
      expect.any(Date),
    );
    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("report.pdf");
    expect(opts.text).toContain("/dl/");
    expect(opts.text).not.toContain("photo.png");
    expect(mockSendTelegramPhotos).toHaveBeenCalledOnce();
  });

  it("sends fallback download links when retry photo upload fails", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockListAttachments.mockResolvedValue([
      {
        id: "att-image",
        originalFilename: "photo.png",
        sizeBytes: 111,
        storagePath: "/data/attachments/log-uuid/photo.png",
        contentType: "image/png",
      },
    ]);
    mockSendTelegramMessage
      .mockResolvedValueOnce({ ok: true, telegramMessageId: 42 })
      .mockResolvedValueOnce({ ok: true, telegramMessageId: 43 });
    mockSendTelegramPhotos.mockImplementationOnce((_api, opts: { photos: unknown[] }) =>
      Promise.resolve({
        ok: false,
        failedPhotos: opts.photos,
      }),
    );

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentTtlHours: 48,
      publicBaseUrl: "https://mail.example.com",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(2);
    const [, fallbackOpts] = mockSendTelegramMessage.mock.calls[1] as [unknown, { text: string }];
    expect(fallbackOpts.text).toContain("photo.png");
    expect(fallbackOpts.text).toContain("/dl/");
    expect(mockCreateAttachmentLink).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentLink).toHaveBeenCalledWith(
      fakeDb,
      "att-image",
      expect.any(String),
      expect.any(Date),
    );
  });

  it("keeps retry delivery marked delivered when image fallback link creation fails", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockListAttachments.mockResolvedValue([
      {
        id: "att-image",
        originalFilename: "photo.png",
        sizeBytes: 111,
        storagePath: "/data/attachments/log-uuid/photo.png",
        contentType: "image/png",
      },
    ]);
    mockSendTelegramMessage.mockResolvedValueOnce({ ok: true, telegramMessageId: 42 });
    mockSendTelegramPhotos.mockImplementationOnce((_api, opts: { photos: unknown[] }) =>
      Promise.resolve({
        ok: false,
        failedPhotos: opts.photos,
      }),
    );
    mockCreateAttachmentLink.mockRejectedValueOnce(new Error("db exploded"));

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentTtlHours: 48,
      publicBaseUrl: "https://mail.example.com",
    });

    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "delivered");
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
  });

  it("recovers pending raw emails by queueing and delivering them", async () => {
    mockFindFailedLogs.mockResolvedValue([]);
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: fakeLog.rawEmailPath,
        localPart: "alerts",
        recipientDomain: "mail.example.com",
        envelopeFrom: "sender@example.com",
        rawEmailEncryptionMode: "none",
        rawEmailWrappedDek: null,
        rawEmailKekKeyId: null,
        correlationId: "req-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentDir: "/data/attachments",
      attachmentTtlHours: 24,
      publicBaseUrl: "https://mail.example.com",
      rawEmailDir: "/data/rawemails",
    });

    const [, queuedInput] = mockQueueInboundEmail.mock.calls[0] as [
      unknown,
      {
        rawEmail: Buffer;
        rawEmailPath: string;
        localPart: string;
        recipientDomain: string;
        envelopeFrom: string;
        rawEmailEncryption: { encryptionMode: string };
      },
    ];
    expect(queuedInput.rawEmail).toEqual(RAW_EMAIL);
    expect(queuedInput.rawEmailPath).toBe(fakeLog.rawEmailPath);
    expect(queuedInput.localPart).toBe("alerts");
    expect(queuedInput.recipientDomain).toBe("mail.example.com");
    expect(queuedInput.envelopeFrom).toBe("sender@example.com");
    expect(queuedInput.rawEmailEncryption).toMatchObject({ encryptionMode: "none" });
    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledWith(fakeLog.rawEmailPath);
    expect(mockDeliverQueuedEmail).toHaveBeenCalledOnce();
  });

  it("drops pending raw metadata once the raw email already has a delivery log", async () => {
    mockFindFailedLogs.mockResolvedValue([]);
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: fakeLog.rawEmailPath,
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        rawEmailEncryptionMode: "none",
        rawEmailWrappedDek: null,
        rawEmailKekKeyId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mockFindDeliveryLogByRawEmailPath.mockResolvedValue({ id: "existing-log" });

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentDir: "/data/attachments",
      rawEmailDir: "/data/rawemails",
    });

    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledWith(fakeLog.rawEmailPath);
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
  });

  it("drops pending raw metadata for terminal recovery rejections", async () => {
    mockFindFailedLogs.mockResolvedValue([]);
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: fakeLog.rawEmailPath,
        localPart: "alerts",
        envelopeFrom: "blocked@example.com",
        rawEmailEncryptionMode: "none",
        rawEmailWrappedDek: null,
        rawEmailKekKeyId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mockQueueInboundEmail.mockResolvedValue({
      queued: false,
      result: { ok: false, reason: "sender_not_allowed" },
    });

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentDir: "/data/attachments",
      rawEmailDir: "/data/rawemails",
    });

    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledWith(fakeLog.rawEmailPath);
    expect(mockDeleteFile).toHaveBeenCalledWith(fakeLog.rawEmailPath);
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
  });

  it("drops pending raw metadata for hosted quota rejections during recovery", async () => {
    mockFindFailedLogs.mockResolvedValue([]);
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: fakeLog.rawEmailPath,
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        rawEmailEncryptionMode: "none",
        rawEmailWrappedDek: null,
        rawEmailKekKeyId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mockQueueInboundEmail.mockResolvedValue({
      queued: false,
      result: { ok: false, reason: "monthly_email_limit" },
    });

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentDir: "/data/attachments",
      rawEmailDir: "/data/rawemails",
    });

    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledWith(fakeLog.rawEmailPath);
    expect(mockDeleteFile).toHaveBeenCalledWith(fakeLog.rawEmailPath);
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
  });

  it("keeps deferred pending raw emails for a later recovery attempt", async () => {
    mockFindFailedLogs.mockResolvedValue([]);
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: fakeLog.rawEmailPath,
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        rawEmailEncryptionMode: "none",
        rawEmailWrappedDek: null,
        rawEmailKekKeyId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mockQueueInboundEmail.mockResolvedValue({
      queued: false,
      result: { ok: false, reason: "rate_limited" },
    });

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentDir: "/data/attachments",
      rawEmailDir: "/data/rawemails",
    });

    expect(mockDeletePendingRawEmailMeta).not.toHaveBeenCalled();
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
  });
});
