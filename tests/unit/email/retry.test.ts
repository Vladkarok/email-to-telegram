import { describe, it, expect, vi, beforeEach } from "vitest";
import { markBotHealthy, markBotUnhealthy } from "../../../src/telegram/health.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindFailedLogs = vi.fn();
const mockClaimLog = vi.fn();
const mockUpdateLogStatus = vi.fn();
const mockFindAliasById = vi.fn();
const mockCountAttempts = vi.fn();
const mockCountCountedFailed = vi.fn();
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
  countCountedFailedAttemptsByLog: (...args: unknown[]): unknown => mockCountCountedFailed(...args),
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
const mockRepairChatMigration = vi.fn();
vi.mock("../../../src/telegram/chatMigration.js", () => ({
  repairChatMigration: (...args: unknown[]): unknown => mockRepairChatMigration(...args),
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

const fakeDb = {
  // retryDelivery persists the attempt + final status inside a transaction.
  // Pass fakeDb itself as the tx handle so repo calls keep the same first arg.
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeDb),
} as Parameters<typeof runRetryWorker>[0];
const fakeApi = { sendMessage: vi.fn() } as unknown as Parameters<typeof runRetryWorker>[1];

describe("runRetryWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    markBotHealthy();
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockClaimLog.mockResolvedValue(true);
    mockCountAttempts.mockResolvedValue(0);
    mockCountCountedFailed.mockResolvedValue(0);
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

  it("repairs from a REAL GrammyError shape, not a hand-built failure", async () => {
    // Acceptance criterion: the reactive path must work against the object
    // grammY actually throws, so the whole sender→classifier→repair chain is
    // exercised end to end rather than a convenient stand-in.
    const { GrammyError } = await import("grammy");
    const realError = new GrammyError(
      "Call to 'sendMessage' failed! (400: Bad Request: group chat was upgraded to a supergroup chat)",
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        parameters: { migrate_to_chat_id: -1002222333444 },
      },
      "sendMessage",
      {},
    );
    const { describeSendError } = await import("../../../src/telegram/errorClassifier.js");
    const failure = describeSendError(realError);

    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockRepairChatMigration.mockResolvedValue({ aliasCount: 1 });
    mockSendTelegramMessage.mockResolvedValue({
      ok: false,
      error: failure.description,
      failure,
    });

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockRepairChatMigration).toHaveBeenCalledWith(fakeDb, fakeApi, -100n, -1002222333444n);
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
  });

  it("delivers the WHOLE email to the new chat when a move lands before the retry", async () => {
    // move-during-retry: the alias moved after the failed attempt; the retry
    // reads the route once at attempt start, so text, attachment fallback and
    // the attempt record all target the new chat.
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, chatId: -777n, messageThreadId: null });
    mockListAttachments.mockResolvedValue([
      {
        id: "att-1",
        storagePath: "/data/att-1.bin",
        originalFilename: "photo.png",
        contentType: "image/png",
        sizeBytes: 10,
        encryptionMode: null,
        wrappedDek: null,
        kekKeyId: null,
      },
    ]);
    mockSendTelegramPhotos.mockResolvedValue({
      ok: false,
      failedPhotos: [{ id: "att-1", storagePath: "/data/att-1.bin" }],
    });

    await runRetryWorker(fakeDb, fakeApi);

    // One alias read for the whole attempt.
    expect(mockFindAliasById).toHaveBeenCalledTimes(1);
    for (const call of mockSendTelegramMessage.mock.calls) {
      expect((call[1] as { chatId: bigint }).chatId).toBe(-777n);
    }
    expect(mockSendTelegramPhotos).toHaveBeenCalledWith(
      fakeApi,
      expect.objectContaining({ chatId: -777n }),
    );
    expect(mockInsertAttempt).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ targetChatId: -777n }),
    );
  });

  it("aborts retryably when the RETRY's attachment send hits a migrate error", async () => {
    // The other half of ratified amendment 2: the same rule must hold on the
    // retry path, not just the initial delivery.
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockRepairChatMigration.mockResolvedValue({ aliasCount: 1 });
    mockListAttachments.mockResolvedValue([
      {
        id: "att-1",
        storagePath: "/data/att-1.bin",
        originalFilename: "photo.png",
        contentType: "image/png",
        sizeBytes: 10,
        encryptionMode: null,
        wrappedDek: null,
        kekKeyId: null,
      },
    ]);
    mockSendTelegramPhotos.mockResolvedValue({
      ok: false,
      failedPhotos: [{ id: "att-1", storagePath: "/data/att-1.bin" }],
      failure: {
        code: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        transient: false,
        migrateToChatId: -1002222333444n,
      },
    });

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockRepairChatMigration).toHaveBeenCalledWith(fakeDb, fakeApi, -100n, -1002222333444n);
    // Handed back as retryable so the next cycle delivers the whole email to
    // the new chat, rather than leaving it `delivered` minus its attachments.
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
    // No fallback message to the dead old route.
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("aborts retryably when the attachment FALLBACK send hits a migrate error", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockRepairChatMigration.mockResolvedValue({ aliasCount: 1 });
    mockListAttachments.mockResolvedValue([
      {
        id: "att-1",
        storagePath: "/data/att-1.bin",
        originalFilename: "photo.png",
        contentType: "image/png",
        sizeBytes: 10,
        encryptionMode: null,
        wrappedDek: null,
        kekKeyId: null,
      },
    ]);
    // Photos fail for an unrelated reason, so the fallback runs — and THAT is
    // where the upgrade lands.
    mockSendTelegramPhotos.mockResolvedValue({
      ok: false,
      failedPhotos: [{ id: "att-1", storagePath: "/data/att-1.bin" }],
    });
    mockSendTelegramMessage
      .mockResolvedValueOnce({ ok: true, telegramMessageId: 42 })
      .mockResolvedValueOnce({
        ok: false,
        error: "Bad Request: group chat was upgraded to a supergroup chat",
        failure: {
          code: 400,
          description: "Bad Request: group chat was upgraded to a supergroup chat",
          transient: false,
          migrateToChatId: -1002222333444n,
        },
      });

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockRepairChatMigration).toHaveBeenCalledWith(fakeDb, fakeApi, -100n, -1002222333444n);
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
  });

  it("retries to the route from the single fresh attempt-start read", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    // The alias moved to chat -200n / thread 9n since the original delivery.
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, chatId: -200n, messageThreadId: 9n });
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockFindAliasById).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      fakeApi,
      expect.objectContaining({ chatId: -200n, threadId: 9n }),
    );
    expect(mockInsertAttempt).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ targetChatId: -200n, targetThreadId: 9n }),
    );
  });

  it("keeps a migrate-failed retry retryable, repairs, and burns no budget", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockCountAttempts.mockResolvedValue(2);
    mockCountCountedFailed.mockResolvedValue(2); // one counted failure below the cap
    mockRepairChatMigration.mockResolvedValue({ aliasCount: 1 });
    mockSendTelegramMessage.mockResolvedValue({
      ok: false,
      error: "Bad Request: group chat was upgraded to a supergroup chat",
      failure: {
        code: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        transient: false,
        migrateToChatId: -1002222333444n,
      },
    });
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockInsertAttempt).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ status: "failed", errorClass: "migrated" }),
    );
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
    // The next worker cycle re-reads the alias and lands on the new chat id.
    expect(mockRepairChatMigration).toHaveBeenCalledWith(fakeDb, fakeApi, -100n, -1002222333444n);
  });

  it("marks permanently_failed when max retries reached", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockCountAttempts.mockResolvedValue(3);
    mockCountCountedFailed.mockResolvedValue(3); // counted failures already at MAX_RETRIES
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
    mockCountCountedFailed.mockResolvedValue(2); // both prior failures counted
    mockSendTelegramMessage.mockResolvedValue({ ok: false, error: "Telegram error" });
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
  });

  it("skips the whole cycle while the bot is unhealthy", async () => {
    markBotUnhealthy();
    mockFindFailedLogs.mockResolvedValue([fakeLog]);

    await runRetryWorker(fakeDb, fakeApi, { rawEmailDir: "/data/rawemails" });

    expect(mockListPendingRawEmails).not.toHaveBeenCalled();
    expect(mockFindFailedLogs).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("does not consume retry budget for transient network failures", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockCountAttempts.mockResolvedValue(10); // many prior transient attempts
    mockCountCountedFailed.mockResolvedValue(0);
    mockSendTelegramMessage.mockResolvedValue({ ok: false, error: "fetch failed" });

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockInsertAttempt).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ attemptNo: 11, status: "failed", errorClass: "network" }),
    );
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
  });

  it("fails permanently right away when the bot is blocked by the chat", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockSendTelegramMessage.mockResolvedValue({
      ok: false,
      error: "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
    });

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockInsertAttempt).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ status: "failed", errorClass: "forbidden" }),
    );
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
  });

  it("fails permanently right away when the chat no longer exists", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockSendTelegramMessage.mockResolvedValue({
      ok: false,
      error: "Call to 'sendMessage' failed! (400: Bad Request: chat not found)",
    });

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
    // Crash before the send, in a path not covered by the post-send persist
    // retry, so the worker's catch-all safety net is what resets the status.
    mockListAttachments.mockRejectedValueOnce(new Error("db exploded"));

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

  it("drops pending raw metadata for storage-limit rejections during recovery", async () => {
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
      result: { ok: false, reason: "storage_limit" },
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
