import { describe, it, expect, vi, beforeEach } from "vitest";
import { markBotHealthy, markBotUnhealthy } from "../../../src/telegram/health.js";
import { metricsRegistry, resetMetricsForTests } from "../../../src/observability/metrics.js";

const mockFindFailedLogs = vi.fn();
const mockClaimLog = vi.fn();
const mockSettleLog = vi.fn();
const mockCloseLog = vi.fn();
const mockReopenLog = vi.fn();
const mockResetLog = vi.fn();
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
  // Always a promise: the code chains .catch() on these, and a reset mock returns undefined.
  settleDeliveryLogAfterSend: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockSettleLog(...args)),
  closeDeliveryLogPermanentlyFailed: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockCloseLog(...args)),
  reopenDeliveryLogAfterMigration: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockReopenLog(...args)),
  resetDeliveryLogAfterError: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockResetLog(...args)),
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
const mockMarkAliasFirstDelivered = vi.fn();
vi.mock("../../../src/db/repos/aliasActivation.js", () => ({
  markAliasFirstDelivered: (...args: unknown[]): unknown => mockMarkAliasFirstDelivered(...args),
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
vi.mock("../../../src/email/inboundAdmission/queue.js", () => ({
  queueInboundEmail: (...args: unknown[]): unknown => mockQueueInboundEmail(...args),
}));
vi.mock("../../../src/email/pipeline.js", () => ({
  deliverQueuedEmail: (...args: unknown[]): unknown => mockDeliverQueuedEmail(...args),
}));
const mockRefundAcceptedEmail = vi.fn();
vi.mock("../../../src/billing/usageRefund.js", () => ({
  refundAcceptedEmail: (...args: unknown[]): unknown => mockRefundAcceptedEmail(...args),
}));
const mockNotifyApproachingMonthlyLimit = vi.fn();
vi.mock("../../../src/billing/quotaNotifier.js", () => ({
  notifyApproachingMonthlyLimit: (...args: unknown[]): unknown =>
    mockNotifyApproachingMonthlyLimit(...args),
}));
const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => mockLogger,
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

const { runRetryWorker, createRetryRunner } = await import("../../../src/email/retry.js");
const { createShutdown } = await import("../../../src/startup/shutdown.js");

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
    mockSettleLog.mockResolvedValue(undefined);
    mockCloseLog.mockResolvedValue(true);
    mockRefundAcceptedEmail.mockResolvedValue(undefined);
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
    expect(mockSettleLog).toHaveBeenCalledWith(fakeDb, fakeLog.id, "delivered");
    expect(mockMarkAliasFirstDelivered).toHaveBeenCalledWith(fakeDb, fakeLog.emailAddressId);
  });

  it("runs a claimed retry through the tracker under its log id", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    // Not running the work shows the retry is started only through the tracker.
    mockPipelineTrackerRunFor.mockResolvedValue(undefined);

    await runRetryWorker(fakeDb, fakeApi);

    expect(mockPipelineTrackerRunFor).toHaveBeenCalledWith(fakeLog.id, expect.any(Function));
    expect(mockReadRawEmail).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  describe("delivery metrics", () => {
    beforeEach(() => {
      resetMetricsForTests();
    });

    const lostAt = async (stage: string): Promise<number> => {
      const text = await metricsRegistry.getSingleMetricAsString(
        "email_to_telegram_deliveries_lost_total",
      );
      return Number(new RegExp(`\\{stage="${stage}"[^}]*\\} ([\\d.]+)`).exec(text)?.[1]);
    };

    const metricSum = async (
      name: string,
      labels: Record<string, string> = {},
    ): Promise<number> => {
      const metric = await metricsRegistry.getSingleMetric(name)?.get();
      return (metric?.values ?? [])
        .filter((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value))
        .reduce((sum, v) => sum + v.value, 0);
    };
    const retryResult = (result: string): Promise<number> =>
      metricSum("email_to_telegram_retry_attempts_total", { result });
    const sendFailures = (): Promise<number> =>
      metricSum("email_to_telegram_telegram_send_failures_total");

    it("counts a retry that runs out of budget as lost (stage retry)", async () => {
      mockFindFailedLogs.mockResolvedValue([fakeLog]);
      mockCountAttempts.mockResolvedValue(2);
      mockCountCountedFailed.mockResolvedValue(2);
      mockSendTelegramMessage.mockResolvedValue({ ok: false, error: "Telegram error" });

      await runRetryWorker(fakeDb, fakeApi);

      expect(mockSettleLog).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
      expect(await lostAt("retry")).toBe(1);
      expect(await retryResult("permanently_failed")).toBe(1);
      expect(await sendFailures()).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryLogId: fakeLog.id }),
        "retry worker: permanently failed",
      );
    });

    // The retry worker's hooks on the shared attempt module: its counters and
    // events per outcome.
    it("counts and logs a delivered retry", async () => {
      mockFindFailedLogs.mockResolvedValue([fakeLog]);

      await runRetryWorker(fakeDb, fakeApi);

      expect(await retryResult("succeeded")).toBe(1);
      expect(await sendFailures()).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { deliveryLogId: fakeLog.id, attemptNo: 1 },
        "retry worker: delivered",
      );
    });

    it("counts and logs a retry that will run again", async () => {
      mockFindFailedLogs.mockResolvedValue([fakeLog]);
      mockSendTelegramMessage.mockResolvedValue({ ok: false, error: "Telegram error" });

      await runRetryWorker(fakeDb, fakeApi);

      expect(await retryResult("failed")).toBe(1);
      expect(await retryResult("permanently_failed")).toBe(0);
      expect(await sendFailures()).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryLogId: fakeLog.id, attemptNo: 1 }),
        "retry worker: will retry again",
      );
    });

    it("counts a log closed before sending (raw email gone) as lost and refunds it", async () => {
      const log = { ...fakeLog, rawEmailPath: null, userId: 7n };
      mockFindFailedLogs.mockResolvedValue([log]);

      await runRetryWorker(fakeDb, fakeApi);

      expect(await lostAt("retry")).toBe(1);
      expect(mockRefundAcceptedEmail).toHaveBeenCalledTimes(1);
      expect(mockRefundAcceptedEmail).toHaveBeenCalledWith(fakeDb, {
        deliveryLogId: log.id,
        userId: 7n,
        receivedAt: log.receivedAt,
      });
    });

    it("leaves the loss and the refund to cleanup when cleanup closed the log first", async () => {
      // Cleanup deleted the expired raw file and closed the log while this
      // retry held its claim; the retry then cannot read the file.
      mockFindFailedLogs.mockResolvedValue([{ ...fakeLog, userId: 7n }]);
      mockReadRawEmail.mockRejectedValue(new Error("ENOENT"));
      mockCloseLog.mockResolvedValue(false);

      await runRetryWorker(fakeDb, fakeApi);

      expect(mockCloseLog).toHaveBeenCalledWith(fakeDb, fakeLog.id);
      expect(await lostAt("retry")).toBe(0);
      expect(await retryResult("permanently_failed")).toBe(0);
      expect(mockRefundAcceptedEmail).not.toHaveBeenCalled();
    });

    it("does not count a loss when the permanently_failed write fails", async () => {
      mockFindFailedLogs.mockResolvedValue([{ ...fakeLog, rawEmailPath: null }]);
      mockCloseLog.mockRejectedValue(new Error("db down"));

      await runRetryWorker(fakeDb, fakeApi);

      expect(await lostAt("retry")).toBe(0);
    });
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
    expect(mockSettleLog).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
    expect(mockSettleLog).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
    expect(mockCloseLog).not.toHaveBeenCalled();
    // The next worker cycle re-reads the alias and lands on the new chat id.
    expect(mockRepairChatMigration).toHaveBeenCalledWith(fakeDb, fakeApi, -100n, -1002222333444n);
  });

  it("marks permanently_failed when max retries reached", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockCountAttempts.mockResolvedValue(3);
    mockCountCountedFailed.mockResolvedValue(3); // counted failures already at MAX_RETRIES
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    expect(mockCloseLog).toHaveBeenCalledWith(fakeDb, fakeLog.id);
  });

  it("marks permanently_failed when alias is deleted", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, status: "deleted" });
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockCloseLog).toHaveBeenCalledWith(fakeDb, fakeLog.id);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("marks permanently_failed when raw email file is missing", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockReadRawEmail.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockCloseLog).toHaveBeenCalledWith(fakeDb, fakeLog.id);
  });

  it("marks permanently_failed when rawEmailPath is null", async () => {
    mockFindFailedLogs.mockResolvedValue([{ ...fakeLog, rawEmailPath: null }]);
    await runRetryWorker(fakeDb, fakeApi);

    expect(mockCloseLog).toHaveBeenCalledWith(fakeDb, fakeLog.id);
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
    expect(mockSettleLog).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
    expect(mockSettleLog).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
    expect(mockCloseLog).not.toHaveBeenCalled();
    expect(mockSettleLog).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "delivered");
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
    expect(mockSettleLog).toHaveBeenCalledWith(fakeDb, fakeLog.id, "failed");
    expect(mockSettleLog).not.toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
    expect(mockCloseLog).not.toHaveBeenCalled();
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
    expect(mockSettleLog).toHaveBeenCalledWith(fakeDb, fakeLog.id, "permanently_failed");
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

    expect(mockResetLog).toHaveBeenCalledWith(fakeDb, fakeLog.id);
  });

  it("passes the rich ineligibility reason to the send, and none for a rich body", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, renderMode: "html" });
    const raw = (body: string): Buffer =>
      Buffer.from(
        `From: sender@example.com\r\nTo: alias@example.com\r\nSubject: Big\r\nContent-Type: text/html\r\n\r\n${body}`,
      );
    const config = {
      attachmentTtlHours: 24,
      rawEmailTtlHours: 24,
      publicBaseUrl: "https://mail.example.com",
    };

    mockReadRawEmail.mockResolvedValue(raw("<p>x</p>".repeat(501)));
    await runRetryWorker(fakeDb, fakeApi, config);
    mockReadRawEmail.mockResolvedValue(raw("<p>x</p>"));
    await runRetryWorker(fakeDb, fakeApi, config);

    const [[, over], [, fits]] = mockSendTelegramMessage.mock.calls as [
      [unknown, { richHtml?: string; richIneligibleReason?: string }],
      [unknown, { richHtml?: string; richIneligibleReason?: string }],
    ];
    expect(over.richHtml).toBeUndefined();
    expect(over.richIneligibleReason).toBe("block_limit");
    expect(fits.richHtml).toBeDefined();
    expect(fits.richIneligibleReason).toBeUndefined();
  });

  it("uses a privacy-mode alert and skips Telegram photo upload when privacy mode is enabled", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockFindAliasById.mockResolvedValue({
      ...fakeAlias,
      privacyModeEnabled: true,
      renderMode: "html",
    });
    // Rich-capable body: without privacy mode this retry would carry richHtml.
    mockReadRawEmail.mockResolvedValue(
      Buffer.from(
        "From: sender@example.com\r\nTo: alias@example.com\r\nSubject: Private\r\n\r\n# Heading\r\n\r\nHello world",
      ),
    );
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

    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [
      unknown,
      { text: string; richHtml?: string; richIneligibleReason?: string },
    ];
    expect(opts.richHtml).toBeUndefined();
    expect(opts.richIneligibleReason).toBeUndefined();
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

  it("uses HTML parse mode for html-rendered retries", async () => {
    mockFindFailedLogs.mockResolvedValue([fakeLog]);
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, renderMode: "html" });
    mockReadRawEmail.mockResolvedValue(
      Buffer.from(
        "From: sender@example.com\r\nTo: alias@example.com\r\nSubject: Html\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h1>Heading</h1><p><b>Bold</b></p>",
      ),
    );

    await runRetryWorker(fakeDb, fakeApi);

    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [
      unknown,
      { parseMode?: string; text: string; richHtml?: string; richMessagesEnabled?: boolean },
    ];
    expect(opts.parseMode).toBe("HTML");
    expect(opts.text).toContain("<b>Heading</b>");
    expect(opts.text).toContain("<b>Bold</b>");
    expect(opts.richHtml).toContain("<h1>Heading</h1>");
    expect(opts.richMessagesEnabled).toBe(true);
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

  it("hands a recovered mail to the tracker under its log id and warns with the queue's usage", async () => {
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
    mockQueueInboundEmail.mockResolvedValue({
      queued: true,
      job: { deliveryLog: { id: "recovered-log", userId: 7n } },
      usage: { month: "2026-04", deliveredCount: 42 },
    });
    // Not running the work shows the delivery is started only through the tracker.
    mockPipelineTrackerRunFor.mockResolvedValue(undefined);

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentDir: "/data/attachments",
      attachmentTtlHours: 24,
      publicBaseUrl: "https://mail.example.com",
      rawEmailDir: "/data/rawemails",
    });

    expect(mockPipelineTrackerRunFor).toHaveBeenCalledWith("recovered-log", expect.any(Function));
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
    // The post-increment count from the queue, not a re-read.
    expect(mockNotifyApproachingMonthlyLimit).toHaveBeenCalledWith(
      fakeDb,
      fakeApi,
      7n,
      "2026-04",
      42,
    );
  });

  it("leaves pending raw emails younger than two minutes to their live request", async () => {
    mockFindFailedLogs.mockResolvedValue([]);
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: fakeLog.rawEmailPath,
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        createdAt: new Date(Date.now() - 30_000).toISOString(),
      },
    ]);

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentDir: "/data/attachments",
      attachmentTtlHours: 24,
      publicBaseUrl: "https://mail.example.com",
      rawEmailDir: "/data/rawemails",
    });

    expect(mockFindDeliveryLogByRawEmailPath).not.toHaveBeenCalled();
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
    expect(mockDeletePendingRawEmailMeta).not.toHaveBeenCalled();
  });

  it("recovers a pending raw email whose timestamp cannot be read", async () => {
    mockFindFailedLogs.mockResolvedValue([]);
    mockListPendingRawEmails.mockResolvedValue([
      {
        rawEmailPath: fakeLog.rawEmailPath,
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        createdAt: "not a date",
      },
    ]);

    await runRetryWorker(fakeDb, fakeApi, {
      attachmentDir: "/data/attachments",
      attachmentTtlHours: 24,
      publicBaseUrl: "https://mail.example.com",
      rawEmailDir: "/data/rawemails",
    });

    expect(mockQueueInboundEmail).toHaveBeenCalledOnce();
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

  // sender_auth_temperror is the one reason live ingress deletes but recovery keeps
  // (owner decision b), so it pins which policy column recovery reads.
  it.each(["rate_limited", "sender_auth_temperror"])(
    "keeps a pending raw email refused with %s for a later recovery attempt",
    async (reason) => {
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
        result: { ok: false, reason },
      });

      await runRetryWorker(fakeDb, fakeApi, {
        attachmentDir: "/data/attachments",
        rawEmailDir: "/data/rawemails",
      });

      expect(mockDeletePendingRawEmailMeta).not.toHaveBeenCalled();
      expect(mockDeleteFile).not.toHaveBeenCalled();
      expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
    },
  );
});

describe("retry runs at shutdown", () => {
  const dueLogs = [1, 2, 3].map((n) => ({ ...fakeLog, id: `log-${n}` }));

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const pending = (path: string) => ({
    rawEmailPath: path,
    localPart: "alerts",
    recipientDomain: "mail.example.com",
    envelopeFrom: "sender@example.com",
    rawEmailEncryptionMode: "none",
    rawEmailWrappedDek: null,
    rawEmailKekKeyId: null,
    correlationId: "req-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  /** The shutdown wired as src/index.ts wires it, around a retry runner. */
  function processWith(runner: ReturnType<typeof createRetryRunner>, events: string[]) {
    return createShutdown(
      {
        begin: () => runner.stop(),
        stopNotices: () => Promise.resolve(),
        closeHttp: () => Promise.resolve(),
        stopBot: () => Promise.resolve(),
        pollingRun: () => Promise.resolve(),
        retryRun: () => runner.activeRun(),
        // Between two retry deliveries the pipeline tracker reads zero.
        pipelines: { inFlight: 0, drain: () => Promise.resolve() },
        destroySessionStore: () => {},
        closeDb: () => {
          events.push("db_closed");
          return Promise.resolve();
        },
      },
      { logger: mockLogger, exit: (code) => events.push(`exit:${code}`) },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    markBotHealthy();
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockCountAttempts.mockResolvedValue(0);
    mockCountCountedFailed.mockResolvedValue(0);
    mockSettleLog.mockResolvedValue(undefined);
    mockCloseLog.mockResolvedValue(true);
    mockRefundAcceptedEmail.mockResolvedValue(undefined);
    mockReadRawEmail.mockResolvedValue(RAW_EMAIL);
    mockListAttachments.mockResolvedValue([]);
    mockListPendingRawEmails.mockResolvedValue([]);
    mockPipelineTrackerIsActive.mockReturnValue(false);
    mockPipelineTrackerRunFor.mockImplementation(async (_key: string, fn: () => Promise<unknown>) =>
      fn(),
    );
    mockFindFailedLogs.mockResolvedValue(dueLogs);
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
  });

  it("claims nothing after shutdown begins, and closes the DB after the run", async () => {
    const events: string[] = [];
    const runner = createRetryRunner((shouldStop) =>
      runRetryWorker(fakeDb, fakeApi, { shouldStop }),
    );
    const shutdown = processWith(runner, events);
    let shutdownDone: Promise<void> | undefined;
    mockClaimLog.mockImplementation((_db: unknown, id: string) => {
      events.push(`claim:${id}`);
      shutdownDone ??= shutdown("SIGTERM");
      return Promise.resolve(true);
    });
    mockSendTelegramMessage.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push("sent");
      return { ok: true, telegramMessageId: 42 };
    });

    runner.tick();
    await vi.waitFor(() => expect(shutdownDone).toBeDefined());
    await shutdownDone;

    expect(events).toEqual(["claim:log-1", "sent", "db_closed", "exit:0"]);
    expect(mockClaimLog).toHaveBeenCalledOnce();
  });

  it("stops pending raw email recovery before the next file", async () => {
    let stop = false;
    mockListPendingRawEmails.mockResolvedValue([pending("/raw/a.eml"), pending("/raw/b.eml")]);
    mockQueueInboundEmail.mockImplementation(() => {
      stop = true;
      return Promise.resolve({ queued: true, job: { deliveryLog: { id: "recovered-log" } } });
    });
    mockDeliverQueuedEmail.mockResolvedValue({ ok: true });

    await runRetryWorker(fakeDb, fakeApi, {
      rawEmailDir: "/data/rawemails",
      shouldStop: () => stop,
    });

    expect(mockQueueInboundEmail).toHaveBeenCalledOnce();
    expect(mockDeliverQueuedEmail).toHaveBeenCalledOnce();
    expect(mockClaimLog).not.toHaveBeenCalled();
  });

  it.each([
    ["the delivery-log lookup", () => mockFindDeliveryLogByRawEmailPath],
    ["the raw email read", () => mockReadRawEmail],
  ])("queues nothing when shutdown begins during %s", async (_step, stalledMock) => {
    let stop = false;
    const gate = deferred();
    mockListPendingRawEmails.mockResolvedValue([pending("/raw/a.eml")]);
    mockFindDeliveryLogByRawEmailPath.mockResolvedValue(null);
    stalledMock().mockImplementation(async () => {
      await gate.promise;
      return stalledMock() === mockReadRawEmail ? RAW_EMAIL : null;
    });
    mockQueueInboundEmail.mockResolvedValue({
      queued: true,
      job: { deliveryLog: { id: "recovered-log" } },
    });

    const run = runRetryWorker(fakeDb, fakeApi, {
      rawEmailDir: "/data/rawemails",
      shouldStop: () => stop,
    });
    await vi.waitFor(() => expect(stalledMock()).toHaveBeenCalledOnce());
    stop = true;
    gate.resolve();
    await run;

    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
    expect(mockDeletePendingRawEmailMeta).not.toHaveBeenCalled();
    expect(mockClaimLog).not.toHaveBeenCalled();
  });

  it("skips a tick while a run is active, runs on the next one, and awaits the run at shutdown", async () => {
    const events: string[] = [];
    const run = vi.fn((shouldStop: () => boolean) =>
      runRetryWorker(fakeDb, fakeApi, { shouldStop }),
    );
    const runner = createRetryRunner(run);
    mockFindFailedLogs.mockResolvedValue([dueLogs[0]]);
    mockClaimLog.mockResolvedValue(true);
    let sendGate = deferred();
    mockSendTelegramMessage.mockImplementation(async () => {
      await sendGate.promise;
      events.push("sent");
      return { ok: true, telegramMessageId: 42 };
    });

    runner.tick();
    await vi.waitFor(() => expect(mockSendTelegramMessage).toHaveBeenCalledOnce());
    runner.tick();
    expect(run).toHaveBeenCalledOnce();
    expect(mockLogger.info).toHaveBeenCalledWith("retry.run.overlap_skipped");

    sendGate.resolve();
    await runner.activeRun();
    expect(runner.isActive()).toBe(false);

    sendGate = deferred();
    runner.tick();
    expect(run).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(mockSendTelegramMessage).toHaveBeenCalledTimes(2));

    const shutdownDone = processWith(runner, events)("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["sent"]);
    sendGate.resolve();
    await shutdownDone;

    expect(events).toEqual(["sent", "sent", "db_closed", "exit:0"]);
    runner.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
