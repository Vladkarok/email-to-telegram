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

vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  findLogsNeedingRetry: (...args: unknown[]): unknown => mockFindFailedLogs(...args),
  claimDeliveryLogForRetry: (...args: unknown[]): unknown => mockClaimLog(...args),
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
vi.mock("../../../src/db/repos/deliveryAttempts.js", () => ({
  countAttemptsByLog: (...args: unknown[]): unknown => mockCountAttempts(...args),
  insertDeliveryAttempt: (...args: unknown[]): unknown => mockInsertAttempt(...args),
}));
vi.mock("../../../src/storage/disk.js", () => ({
  readRawEmail: (...args: unknown[]): unknown => mockReadRawEmail(...args),
}));
vi.mock("../../../src/telegram/sender.js", () => ({
  sendTelegramMessage: (...args: unknown[]): unknown => mockSendTelegramMessage(...args),
  sendTelegramPhotos: (...args: unknown[]): unknown => mockSendTelegramPhotos(...args),
}));
vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
};

const fakeLog = {
  id: "log-uuid",
  emailAddressId: "alias-uuid",
  rawEmailPath: "/data/rawemails/2026-01-01/test.eml",
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
    mockSendTelegramPhotos.mockResolvedValue(undefined);
    mockListAttachments.mockResolvedValue([]);
    mockCreateAttachmentLink.mockResolvedValue(undefined);
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
    expect(mockReadRawEmail).toHaveBeenCalledWith(fakeLog.rawEmailPath);
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

  it("records failed attempt and leaves status as failed when send fails but retries remain", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockCountAttempts.mockResolvedValue(0); // first attempt
    mockSendTelegramMessage.mockResolvedValue({ ok: false, error: "Telegram error" });
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockInsertAttempt).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ status: "failed" }),
    );
    // Still retries left — should NOT mark permanently_failed or delivered
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
});
