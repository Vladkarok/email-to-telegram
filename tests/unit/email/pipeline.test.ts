import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processInboundEmail,
  queueInboundEmail,
  deliverQueuedEmail,
} from "../../../src/email/pipeline.js";
import { insertDeliveryAttempt } from "../../../src/db/repos/deliveryAttempts.js";
import { getPlanDefinition } from "../../../src/billing/plans.js";
import { metricsRegistry, resetMetricsForTests } from "../../../src/observability/metrics.js";
import { readFileSync } from "fs";
import { join } from "path";

const mockFindAlias = vi.fn();
const mockFindAliasById = vi.fn();
const mockListAllowRules = vi.fn();
const mockAuthenticateSender = vi.fn();
const mockIsDuplicate = vi.fn();
const mockCreateLog = vi.fn();
const mockSettleLog = vi.fn();
const mockReopenLog = vi.fn();
const mockResetLog = vi.fn();
const mockMarkProcessing = vi.fn();
const mockCountRecentDeliveries = vi.fn();
const mockCreateAttachment = vi.fn();
const mockCreateAttachmentLink = vi.fn();
const mockCreateDeliveryViewLink = vi.fn();
const mockSendTelegramPhotos = vi.fn();
const mockWriteAttachment = vi.fn();
const mockDeleteFile = vi.fn();
const mockCheckInboundLimit = vi.fn().mockResolvedValue({ ok: true });
const mockIncrementOrganizationUsageMonth = vi
  .fn()
  .mockResolvedValue({ deliveredCount: 1, rejectedCount: 0 });
const mockIncrementOrganizationStorageUsage = vi.fn().mockResolvedValue(undefined);
const mockDecrementOrganizationStorageUsage = vi.fn().mockResolvedValue(undefined);
const mockUsageMonthForDate = vi.fn(() => "2026-04");
const mockDecrementUserUsageMonth = vi.fn();

vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
  findAliasByLocalPart: (...args: unknown[]): unknown => mockFindAlias(...args),
  findAliasByLocalPartAndDomainId: (...args: unknown[]): unknown => mockFindAlias(...args),
}));
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  listAllowRules: (...args: unknown[]): unknown => mockListAllowRules(...args),
}));
vi.mock("../../../src/email/authenticateSender.js", () => ({
  authenticateSender: (...args: unknown[]): unknown => mockAuthenticateSender(...args),
}));
vi.mock("../../../src/email/dedup.js", () => ({
  isDuplicate: (...args: unknown[]): unknown => mockIsDuplicate(...args),
}));
vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  createDeliveryLog: (...args: unknown[]): unknown => mockCreateLog(...args),
  // Always a promise: the code chains .catch() on these, and a reset mock returns undefined.
  settleDeliveryLogAfterSend: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockSettleLog(...args)),
  reopenDeliveryLogAfterMigration: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockReopenLog(...args)),
  resetDeliveryLogAfterError: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockResetLog(...args)),
  markDeliveryLogProcessing: (...args: unknown[]): unknown => mockMarkProcessing(...args),
  countRecentDeliveriesByAlias: (...args: unknown[]): unknown => mockCountRecentDeliveries(...args),
}));
vi.mock("../../../src/db/repos/deliveryAttempts.js", () => ({
  insertDeliveryAttempt: vi.fn().mockResolvedValue(undefined),
}));
const mockMarkAliasFirstDelivered = vi.fn();
vi.mock("../../../src/db/repos/aliasActivation.js", () => ({
  markAliasFirstDelivered: (...args: unknown[]): unknown => mockMarkAliasFirstDelivered(...args),
}));

const mockSendTelegram = vi.fn();
vi.mock("../../../src/telegram/sender.js", () => ({
  sendTelegramMessage: (...args: unknown[]): unknown => mockSendTelegram(...args),
  sendTelegramPhotos: (...args: unknown[]): unknown => mockSendTelegramPhotos(...args),
}));

const mockRepairChatMigration = vi.fn();
vi.mock("../../../src/telegram/chatMigration.js", () => ({
  repairChatMigration: (...args: unknown[]): unknown => mockRepairChatMigration(...args),
}));

const MIGRATE_FAILURE = {
  code: 400,
  description: "Bad Request: group chat was upgraded to a supergroup chat",
  transient: false,
  migrateToChatId: -1002222333444n,
};

vi.mock("../../../src/db/repos/attachments.js", () => ({
  createAttachment: (...args: unknown[]): unknown => mockCreateAttachment(...args),
}));
vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  createAttachmentLink: (...args: unknown[]): unknown => mockCreateAttachmentLink(...args),
}));
vi.mock("../../../src/db/repos/deliveryViewLinks.js", () => ({
  createDeliveryViewLink: (...args: unknown[]): unknown => mockCreateDeliveryViewLink(...args),
}));
vi.mock("../../../src/storage/disk.js", () => ({
  writeAttachment: (...args: unknown[]): unknown => mockWriteAttachment(...args),
  deleteFile: (...args: unknown[]): unknown => mockDeleteFile(...args),
}));
const mockResolveInboundPlan = vi.fn();
vi.mock("../../../src/billing/limits.js", async () => {
  const { getPlanDefinition } = await import("../../../src/billing/plans.js");
  return {
    checkInboundLimitForPlan: (...args: unknown[]): unknown => mockCheckInboundLimit(...args),
    // Tracked; falls back to the free plan.
    resolveInboundPlan: (...args: unknown[]): unknown =>
      mockResolveInboundPlan(...args) ??
      Promise.resolve({ hosted: true, user: null, plan: getPlanDefinition("free") }),
  };
});
vi.mock("../../../src/db/repos/usage.js", () => ({
  incrementUserUsageMonth: (...args: unknown[]): unknown =>
    mockIncrementOrganizationUsageMonth(...args),
  usageMonthForDate: (): unknown => mockUsageMonthForDate(),
  decrementUserUsageMonth: (...args: unknown[]): unknown => mockDecrementUserUsageMonth(...args),
}));
vi.mock("../../../src/db/repos/storageUsage.js", () => ({
  incrementUserStorageUsage: (...args: unknown[]): unknown =>
    mockIncrementOrganizationStorageUsage(...args),
  decrementUserStorageUsage: (...args: unknown[]): unknown =>
    mockDecrementOrganizationStorageUsage(...args),
}));

function fixture(name: string): Buffer {
  return readFileSync(join(import.meta.dirname, "../../fixtures", name));
}

function simpleEmail() {
  return fixture("simple.eml");
}

const PIPELINE_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/att",
  attachmentTtlHours: 24,
  rawEmailTtlHours: 24,
  telegramRichMessagesEnabled: true,
};

const activeAlias = {
  id: "alias-uuid-1",
  localPart: "alerts",
  fullAddress: "alerts@example.com",
  createdBy: 1n,
  chatId: 100n,
  messageThreadId: null,
  status: "active",
  renderMode: "plaintext",
  privacyModeEnabled: false,
  bodyDedupEnabled: false,
};

const authenticatedExampleRules = [{ matchType: "domain", matchValue: "example.com" }];

// What a nested tx.transaction() hands its callback: the savepoint handle.
const SAVEPOINT = { savepoint: true };
const mockSavepoint = vi.fn();

function fakeTx<E>(execute: E) {
  return {
    execute,
    transaction: async <T>(fn: (savepoint: unknown) => Promise<T>): Promise<T> => {
      mockSavepoint();
      return fn(SAVEPOINT);
    },
  };
}

function fakeDb() {
  return {
    transaction: async <T>(
      fn: (tx: ReturnType<typeof fakeTx<ReturnType<typeof vi.fn>>>) => Promise<T>,
    ) => fn(fakeTx(vi.fn().mockResolvedValue(undefined))),
  };
}

function fakeDbHarness() {
  const execute = vi.fn().mockResolvedValue(undefined);
  return {
    db: {
      transaction: async <T>(fn: (tx: ReturnType<typeof fakeTx<typeof execute>>) => Promise<T>) =>
        fn(fakeTx(execute)),
    } as Parameters<typeof processInboundEmail>[0],
    execute,
  };
}

describe("processInboundEmail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCheckInboundLimit.mockResolvedValue({ ok: true });
    mockListAllowRules.mockResolvedValue(authenticatedExampleRules);
    mockAuthenticateSender.mockResolvedValue({
      headerFromEmail: "sender@example.com",
      headerFromDomain: "example.com",
      authenticatedDomains: ["example.com"],
      status: "pass",
    });
    mockFindAliasById.mockResolvedValue(activeAlias);
    mockIncrementOrganizationUsageMonth.mockResolvedValue({ deliveredCount: 1, rejectedCount: 0 });
    mockIncrementOrganizationStorageUsage.mockResolvedValue(undefined);
    mockDecrementOrganizationStorageUsage.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockUsageMonthForDate.mockReturnValue("2026-04");
    mockCountRecentDeliveries.mockResolvedValue(0);
    mockCreateAttachment.mockResolvedValue({ id: "att-uuid-1" });
    mockCreateAttachmentLink.mockResolvedValue(undefined);
    mockCreateDeliveryViewLink.mockResolvedValue(undefined);
    mockWriteAttachment.mockResolvedValue({
      encryptionMode: "none",
      wrappedDek: null,
      kekKeyId: null,
      encryptedAt: null,
    });
    mockSendTelegramPhotos.mockResolvedValue({ ok: true, failedPhotos: [] });
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
  });

  it("returns a domainless sender rejection when the mail has several From addresses", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: Buffer.from("From: a@one.example, b@two.example\r\nSubject: two\r\n\r\nbody"),
        localPart: "alerts",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({
      ok: false,
      reason: "sender_not_allowed",
      senderRejection: { aliasId: "alias-uuid-1", headerFromDomain: null },
    });
  });

  it("allows authenticated RFC5322 From when envelopeFrom is missing", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-no-envelope" });
    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: Buffer.from("From: allowed@example.com\r\nSubject: spoof\r\n\r\nbody"),
        localPart: "alerts",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: true });
    expect(mockAuthenticateSender).toHaveBeenCalledWith(expect.any(Buffer), null);
  });

  describe("the owner's plan in the queue transaction", () => {
    it("uses one plan, resolved in the transaction, for quota and hourly cap", async () => {
      const pro = getPlanDefinition("pro");
      const snapshot = {
        hosted: true,
        user: { id: 1n },
        plan: { ...pro, limits: { ...pro.limits, aliasEmailsPerHour: 2 } },
      };
      // Only the first resolution gets the snapshot; a second one would see
      // the free plan's 60 and let the mail through.
      mockResolveInboundPlan.mockResolvedValueOnce(snapshot);
      mockFindAlias.mockResolvedValue(activeAlias);
      mockIsDuplicate.mockResolvedValue(false);
      mockCountRecentDeliveries.mockResolvedValue(2);
      const { db, execute } = fakeDbHarness();

      const result = await queueInboundEmail(db, {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      });

      expect(result).toMatchObject({ queued: false, result: { reason: "rate_limited" } });
      expect(mockResolveInboundPlan).toHaveBeenCalledOnce();
      const [resolvedWith, ownerId] = mockResolveInboundPlan.mock.calls[0] as [unknown, bigint];
      expect(resolvedWith).toHaveProperty("execute", execute); // the transaction
      expect(ownerId).toBe(1n);
      expect(mockCheckInboundLimit.mock.calls[0]?.[1]).toBe(snapshot);
    });

    it("resolves the plan and the hour window only after both locks", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
        const order: string[] = [];
        const { db, execute } = fakeDbHarness();
        execute.mockImplementation(() => {
          order.push("lock");
          // The second lock waited ten minutes.
          if (order.length === 2) vi.setSystemTime(new Date("2026-10-06T12:10:00Z"));
          return Promise.resolve(undefined);
        });
        mockResolveInboundPlan.mockImplementationOnce(() => {
          order.push("resolve");
          return Promise.resolve({ hosted: true, user: null, plan: getPlanDefinition("free") });
        });
        mockFindAlias.mockResolvedValue(activeAlias);
        mockIsDuplicate.mockResolvedValue(false);
        mockCreateLog.mockResolvedValue({ id: "log-uuid-window" });
        mockCountRecentDeliveries.mockResolvedValue(0);

        await queueInboundEmail(db, {
          rawEmail: simpleEmail(),
          localPart: "alerts",
          envelopeFrom: "sender@example.com",
          ...PIPELINE_CONFIG,
        });

        expect(order).toEqual(["lock", "lock", "resolve"]);
        expect(mockCountRecentDeliveries.mock.calls[0]?.[2]).toEqual(
          new Date("2026-10-06T11:10:00Z"),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("persists the authoritative envelopeFrom in the delivery log", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-audit" });
    mockSettleLog.mockResolvedValue(undefined);

    await processInboundEmail(fakeDb() as Parameters<typeof processInboundEmail>[0], null, {
      rawEmail: simpleEmail(),
      rawEmailPath: "/data/rawemails/2026-01-01/test.eml",
      localPart: "alerts",
      envelopeFrom: "real-sender@sender.example.com",
      ...PIPELINE_CONFIG,
    });

    expect(mockCreateLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        envelopeFrom: "real-sender@sender.example.com",
        rawEmailPath: "/data/rawemails/2026-01-01/test.eml",
        bodyDedupApplied: false,
      }),
    );
  });

  it("passes the alias body dedup setting into the duplicate check and delivery log", async () => {
    mockFindAlias.mockResolvedValue({ ...activeAlias, bodyDedupEnabled: true });
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-dedup-enabled" });
    mockSettleLog.mockResolvedValue(undefined);

    await processInboundEmail(fakeDb() as Parameters<typeof processInboundEmail>[0], null, {
      rawEmail: simpleEmail(),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });

    expect(mockIsDuplicate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bodyDedupEnabled: true }),
    );
    expect(mockCreateLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bodyDedupApplied: true }),
    );
  });

  it("sends a privacy-mode alert with a one-time view link instead of the email body", async () => {
    mockFindAlias.mockResolvedValue({
      ...activeAlias,
      privacyModeEnabled: true,
      renderMode: "html",
    });
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({
      id: "log-privacy",
      rawEmailPath: "/tmp/raw/privacy.eml",
      receivedAt: new Date("2026-04-07T12:00:00.000Z"),
    });
    mockSettleLog.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 321 });

    await processInboundEmail(fakeDb() as Parameters<typeof processInboundEmail>[0], {} as never, {
      // Rich-capable body: without privacy mode this delivery would carry richHtml.
      // The inline image would otherwise be sent as a photo.
      rawEmail: Buffer.from(
        [
          "From: sender@example.com",
          "To: alerts@example.com",
          "Subject: Private",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="b1"',
          "",
          "--b1",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "# Heading",
          "",
          "CPU usage is high",
          "--b1",
          'Content-Type: image/png; name="chart.png"',
          'Content-Disposition: attachment; filename="chart.png"',
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from("image-bytes").toString("base64"),
          "--b1--",
          "",
        ].join("\r\n"),
      ),
      rawEmailPath: "/tmp/raw/privacy.eml",
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });

    const [, opts] = mockSendTelegram.mock.calls[0] as [
      unknown,
      { text: string; parseMode?: string; richHtml?: string },
    ];
    expect(opts.parseMode).toBe("HTML");
    expect(opts.richHtml).toBeUndefined();
    expect((opts as { richIneligibleReason?: string }).richIneligibleReason).toBeUndefined();
    expect(opts.text).toContain("Private email alert");
    expect(opts.text).toContain("/view/");
    expect(opts.text).not.toContain("CPU usage");
    expect(mockCreateAttachment).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramPhotos).not.toHaveBeenCalled();
    expect(mockCreateAttachmentLink).not.toHaveBeenCalled();
    expect(mockCreateDeliveryViewLink).toHaveBeenCalledWith(
      expect.anything(),
      "log-privacy",
      expect.any(String),
      expect.any(Date),
    );
  });

  it("returns ok:true when api is null (no send)", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-1" });
    mockSettleLog.mockResolvedValue(undefined);

    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it("delivers and returns ok:true on successful send", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-2" });
    mockSettleLog.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 42 });

    const fakeApi = {} as Parameters<typeof processInboundEmail>[1];
    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      fakeApi,
      {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: true });
    expect(vi.mocked(insertDeliveryAttempt)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deliveryLogId: "log-uuid-2",
        attemptNo: 1,
        status: "succeeded",
        telegramMessageId: 42n,
      }),
    );
    expect(mockSettleLog).toHaveBeenCalledWith(expect.anything(), "log-uuid-2", "delivered");
    // The alias is now working: the first-delivered marker follows the
    // persisted success.
    expect(mockMarkAliasFirstDelivered).toHaveBeenCalledWith(expect.anything(), activeAlias.id);
    expect(mockMarkAliasFirstDelivered.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockSettleLog.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("returns send_failed when Telegram delivery fails", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-3" });
    mockSettleLog.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: false, error: "flood wait" });

    const fakeApi = {} as Parameters<typeof processInboundEmail>[1];
    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      fakeApi,
      {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: false, reason: "send_failed" });
    expect(mockSettleLog).toHaveBeenCalledWith(expect.anything(), "log-uuid-3", "failed");
    expect(mockMarkAliasFirstDelivered).not.toHaveBeenCalled();
    expect(mockIncrementOrganizationUsageMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: activeAlias.createdBy,
        deliveredCount: 1,
      }),
    );
  });

  // Real fixture mail through the real parser, cleaner and renderer: what the
  // pipeline hands Telegram, and how it refuses at queue time. The queue's
  // rules themselves run on Postgres in tests/db/inboundAdmission.pg.test.ts.
  describe("fixture mail", () => {
    async function run(name: string, envelopeFrom?: string) {
      return processInboundEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as never,
        {
          rawEmail: fixture(name),
          localPart: "alerts",
          envelopeFrom,
          ...PIPELINE_CONFIG,
        },
      );
    }

    function sentText(): { text: string; parseMode?: string } {
      const [, opts] = mockSendTelegram.mock.calls[0] as [
        unknown,
        { text: string; parseMode?: string },
      ];
      return opts;
    }

    beforeEach(() => {
      mockFindAlias.mockResolvedValue(activeAlias);
      mockIsDuplicate.mockResolvedValue(false);
      mockCreateLog.mockResolvedValue({ id: "log-fixture" });
      mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });
    });

    it("plain text: delivers the body", async () => {
      expect(await run("simple.eml", "sender@example.com")).toEqual({ ok: true });
      expect(mockSendTelegram).toHaveBeenCalledOnce();
      expect(sentText().text).toContain("CPU usage");
    });

    it("HTML-rich email: rendered as plaintext by default", async () => {
      await run("html-rich.eml", "newsletter@example.com");
      expect(sentText().parseMode).toBeUndefined();
      expect(sentText().text.length).toBeGreaterThan(0);
    });

    it("quoted reply: the quoted block is stripped", async () => {
      await run("quoted-reply.eml", "colleague@example.com");
      expect(sentText().text).toContain("Sounds good");
      expect(sentText().text).not.toContain("Can everyone join");
    });

    it("signature: the signature is stripped", async () => {
      await run("with-signature.eml", "support@example.com");
      expect(sentText().text).toContain("Ticket #1234");
      expect(sentText().text).not.toContain("John Smith");
    });

    it("unicode subject and body: forwarded without corruption", async () => {
      await run("unicode.eml", "sender@example.com");
      expect(sentText().text).toContain("Сервер");
    });

    it.each([
      ["unknown", null],
      ["paused", { ...activeAlias, status: "paused" }],
    ])("refuses a %s alias as alias_not_found", async (_label, alias) => {
      mockFindAlias.mockResolvedValue(alias);
      expect(await run("simple.eml")).toEqual({ ok: false, reason: "alias_not_found" });
      expect(mockSendTelegram).not.toHaveBeenCalled();
    });

    it("refuses a sender no rule allows, carrying the From domain for the owner's notice", async () => {
      mockListAllowRules.mockResolvedValue([
        { matchType: "domain", matchValue: "trusted.example" },
      ]);
      expect(await run("simple.eml", "spam@attacker.com")).toEqual({
        ok: false,
        reason: "sender_not_allowed",
        senderRejection: { aliasId: activeAlias.id, headerFromDomain: "example.com" },
      });
      expect(mockSendTelegram).not.toHaveBeenCalled();
    });

    it("refuses a duplicate Message-ID without logging or sending", async () => {
      mockIsDuplicate.mockResolvedValue(true);
      expect(await run("simple.eml", "sender@example.com")).toEqual({
        ok: false,
        reason: "duplicate",
      });
      expect(mockCreateLog).not.toHaveBeenCalled();
      expect(mockSendTelegram).not.toHaveBeenCalled();
    });
  });
});

describe("queueInboundEmail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCheckInboundLimit.mockResolvedValue({ ok: true });
    mockIncrementOrganizationUsageMonth.mockResolvedValue({ deliveredCount: 1, rejectedCount: 0 });
    mockIncrementOrganizationStorageUsage.mockResolvedValue(undefined);
    mockDecrementOrganizationStorageUsage.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockUsageMonthForDate.mockReturnValue("2026-04");
    mockListAllowRules.mockResolvedValue(authenticatedExampleRules);
    mockAuthenticateSender.mockResolvedValue({
      headerFromEmail: "sender@example.com",
      headerFromDomain: "example.com",
      authenticatedDomains: ["example.com"],
      status: "pass",
    });
  });

  it("returns duplicate when the delivery-log insert loses a DB race", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCountRecentDeliveries.mockResolvedValue(0);
    mockCreateLog.mockResolvedValue(null);
    const harness = fakeDbHarness();

    const result = await queueInboundEmail(harness.db, {
      rawEmail: simpleEmail(),
      rawEmailPath: "/data/rawemails/test.eml",
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });

    expect(result).toEqual({ queued: false, result: { ok: false, reason: "duplicate" } });
    // The winner of the race was charged; the loser must not be.
    expect(mockIncrementOrganizationUsageMonth).not.toHaveBeenCalled();
  });
});

describe("deliverQueuedEmail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSettleLog.mockResolvedValue(undefined);
    mockFindAliasById.mockResolvedValue(activeAlias);
    mockDeleteFile.mockResolvedValue(undefined);
    mockDecrementOrganizationStorageUsage.mockResolvedValue(undefined);
    mockCreateAttachment.mockResolvedValue({ id: "att-uuid-1" });
    mockCreateAttachmentLink.mockResolvedValue(undefined);
    mockWriteAttachment.mockResolvedValue({
      encryptionMode: "none",
      wrappedDek: null,
      kekKeyId: null,
      encryptedAt: null,
    });
    mockSendTelegramPhotos.mockResolvedValue({ ok: true, failedPhotos: [] });
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
  });

  it("marks the queued delivery failed when an unexpected error escapes", async () => {
    mockSendTelegram.mockRejectedValue(new Error("telegram exploded"));

    await expect(
      deliverQueuedEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        {
          alias: activeAlias,
          parsed: {
            messageId: "<id@test>",
            subject: "Hi",
            envelopeFrom: "sender@example.com",
            headerFrom: "Sender <sender@example.com>",
            headerFromDisplay: "Sender <sender@example.com>",
            headerFromEmail: "sender@example.com",
            headerFromDomain: "example.com",
            textBody: "hello",
            htmlBody: null,
            bodySha256: "hash",
            attachments: [],
            rawSizeBytes: 5,
          },
          deliveryLog: { id: "log-failed" } as never,
          envelopeFrom: "sender@example.com",
          ...PIPELINE_CONFIG,
        },
      ),
    ).rejects.toThrow("telegram exploded");

    expect(mockMarkProcessing).toHaveBeenCalledWith(expect.anything(), "log-failed");
    expect(mockResetLog).toHaveBeenCalledWith(expect.anything(), "log-failed");
  });

  it("aborts before Telegram send when the queued alias was deleted", async () => {
    mockFindAliasById.mockResolvedValue(null);

    const result = await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Hi",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [],
          rawSizeBytes: 5,
        },
        deliveryLog: { id: "log-deleted" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(result).toEqual({ ok: false, reason: "user_deleted" });
    expect(mockSendTelegram).not.toHaveBeenCalled();
    // The log is left as queued: neither claimed for processing nor settled.
    expect(mockMarkProcessing).not.toHaveBeenCalled();
    expect(mockSettleLog).not.toHaveBeenCalled();
  });

  it("delivers the whole attempt to the route from the fresh pre-send read (move after queue)", async () => {
    // The queued job still carries the old chat (100n); the alias was moved
    // to chat 999n / thread 7n between queueing and this delivery attempt.
    mockFindAliasById.mockResolvedValue({ ...activeAlias, chatId: 999n, messageThreadId: 7n });
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 77 });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Moved",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [],
          rawSizeBytes: 5,
        },
        deliveryLog: { id: "log-moved" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(mockSendTelegram).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chatId: 999n, threadId: 7n }),
    );
    expect(vi.mocked(insertDeliveryAttempt)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetChatId: 999n, targetThreadId: 7n }),
    );
  });

  it("uses HTML parse mode for html-rendered deliveries", async () => {
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 77 });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: { ...activeAlias, renderMode: "html" },
        parsed: {
          messageId: "<id@test>",
          subject: "Markdown",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "Heading\n\nBold",
          htmlBody: "<h1>Heading</h1><p><b>Bold</b></p>",
          bodySha256: "hash",
          attachments: [],
          rawSizeBytes: 5,
        },
        deliveryLog: { id: "log-markdown" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    const [, opts] = mockSendTelegram.mock.calls[0] as [
      unknown,
      { parseMode?: string; text: string; richHtml?: string; richMessagesEnabled?: boolean },
    ];
    expect(opts.parseMode).toBe("HTML");
    expect(opts.text).toContain("<b>Heading</b>");
    expect(opts.text).toContain("<b>Bold</b>");
    expect(opts.richHtml).toContain("<h1>Heading</h1>");
    expect(opts.richMessagesEnabled).toBe(true);
  });

  it("passes the rich ineligibility reason of an over-limit body to the send", async () => {
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 98 });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: { ...activeAlias, renderMode: "html" },
        parsed: {
          messageId: "<id@test>",
          subject: "Big",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: null,
          htmlBody: "<p>x</p>".repeat(501),
          bodySha256: "hash",
          attachments: [],
          rawSizeBytes: 5,
        },
        deliveryLog: { id: "log-over-limit" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    const [, opts] = mockSendTelegram.mock.calls[0] as [
      unknown,
      { richHtml?: string; richIneligibleReason?: string },
    ];
    expect(opts.richHtml).toBeUndefined();
    expect(opts.richIneligibleReason).toBe("block_limit");
  });

  it("omits image download links when the image is sent as a Telegram photo", async () => {
    mockCreateAttachment
      .mockResolvedValueOnce({ id: "att-image" })
      .mockResolvedValueOnce({ id: "att-pdf" });
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Hi",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [
            {
              filename: "image.png",
              contentType: "image/png",
              sizeBytes: 10,
              sha256: "img-hash",
              content: Buffer.from("image-bytes"),
            },
            {
              filename: "report.pdf",
              contentType: "application/pdf",
              sizeBytes: 12,
              sha256: "pdf-hash",
              content: Buffer.from("pdf-bytes"),
            },
          ],
          rawSizeBytes: 22,
        },
        deliveryLog: { id: "log-images" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    const [, opts] = mockSendTelegram.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("report.pdf");
    expect(opts.text).toContain("/dl/");
    expect(opts.text).not.toContain("image.png");
    expect(mockCreateAttachmentLink).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentLink).toHaveBeenCalledWith(
      expect.anything(),
      "att-pdf",
      expect.any(String),
      expect.any(Date),
    );
    expect(mockSendTelegramPhotos).toHaveBeenCalledOnce();
  });

  it("aborts retryably when photo sends hit a migrate error, so the retry delivers it whole", async () => {
    mockRepairChatMigration.mockResolvedValue({ aliasCount: 1 });
    mockCreateAttachment.mockResolvedValueOnce({ id: "att-image" });
    mockSendTelegram.mockResolvedValueOnce({ ok: true, telegramMessageId: 99 });
    mockSendTelegramPhotos.mockImplementationOnce((_api, opts: { photos: unknown[] }) =>
      Promise.resolve({
        ok: false,
        failedPhotos: opts.photos,
        failure: MIGRATE_FAILURE,
      }),
    );

    const result = await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Hi",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [
            {
              filename: "image.png",
              contentType: "image/png",
              sizeBytes: 10,
              sha256: "img-hash",
              content: Buffer.from("image-bytes"),
            },
          ],
          rawSizeBytes: 10,
        },
        deliveryLog: { id: "log-photo-migrate" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    // The text landed before the upgrade, but the attachments did not. Rather
    // than keep the delivery `delivered` and silently lose them, the attempt
    // is handed back as retryable — the retry re-reads the route and sends the
    // whole email to the new chat. The duplicate text is the accepted cost.
    expect(result).toEqual({ ok: false, reason: "chat_migrated" });
    expect(mockRepairChatMigration).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      100n,
      -1002222333444n,
    );
    expect(mockReopenLog).toHaveBeenCalledWith(expect.anything(), "log-photo-migrate");
    // No fallback message to the dead old route, no orphan links.
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentLink).not.toHaveBeenCalled();
  });

  it("sends fallback download links when Telegram photo upload fails", async () => {
    mockCreateAttachment.mockResolvedValueOnce({ id: "att-image" });
    mockSendTelegram
      .mockResolvedValueOnce({ ok: true, telegramMessageId: 99 })
      .mockResolvedValueOnce({ ok: true, telegramMessageId: 100 });
    mockSendTelegramPhotos.mockImplementationOnce((_api, opts: { photos: unknown[] }) =>
      Promise.resolve({
        ok: false,
        failedPhotos: opts.photos,
      }),
    );

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Hi",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [
            {
              filename: "image.png",
              contentType: "image/png",
              sizeBytes: 10,
              sha256: "img-hash",
              content: Buffer.from("image-bytes"),
            },
          ],
          rawSizeBytes: 10,
        },
        deliveryLog: { id: "log-fallback" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    const [, fallbackOpts] = mockSendTelegram.mock.calls[1] as [unknown, { text: string }];
    expect(fallbackOpts.text).toContain("image.png");
    expect(fallbackOpts.text).toContain("/dl/");
    expect(mockCreateAttachmentLink).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentLink).toHaveBeenCalledWith(
      expect.anything(),
      "att-image",
      expect.any(String),
      expect.any(Date),
    );
  });

  it("runs each attachment insert and link insert in its own savepoint", async () => {
    // A failed statement aborts the Postgres transaction it runs in; only a
    // savepoint lets the per-attachment catch carry on with the rest.
    mockCreateAttachment
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValueOnce({ id: "att-pdf" });
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });
    const attachment = (filename: string) => ({
      filename,
      contentType: "application/pdf",
      sizeBytes: 12,
      sha256: "pdf-hash",
      content: Buffer.from("pdf-bytes"),
    });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Two attachments",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [attachment("broken.pdf"), attachment("report.pdf")],
          rawSizeBytes: 24,
        },
        deliveryLog: { id: "log-savepoints" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    // Two attachment inserts and the surviving attachment's link insert.
    expect(mockSavepoint).toHaveBeenCalledTimes(3);
    expect(mockCreateAttachment).toHaveBeenCalledTimes(2);
    for (const call of mockCreateAttachment.mock.calls) expect(call[0]).toBe(SAVEPOINT);
    expect(mockCreateAttachmentLink).toHaveBeenCalledTimes(1);
    expect(mockCreateAttachmentLink).toHaveBeenCalledWith(
      SAVEPOINT,
      "att-pdf",
      expect.any(String),
      expect.any(Date),
    );
    // The failed attachment is compensated on the outer transaction.
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    const [storageDb] = mockDecrementOrganizationStorageUsage.mock.calls[0] as [unknown];
    expect(storageDb).not.toBe(SAVEPOINT);
    const [, sent] = mockSendTelegram.mock.calls[0] as [unknown, { text: string }];
    expect(sent.text).toContain("report.pdf");
    expect(sent.text).not.toContain("broken.pdf");
  });

  it("releases reserved attachment storage when attachment persistence fails", async () => {
    mockCreateAttachment.mockRejectedValueOnce(new Error("insert failed"));
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Attachment failure",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [
            {
              filename: "report.pdf",
              contentType: "application/pdf",
              sizeBytes: 12,
              sha256: "pdf-hash",
              content: Buffer.from("pdf-bytes"),
            },
          ],
          rawSizeBytes: 12,
        },
        deliveryLog: { id: "log-attachment-fail" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(mockDeleteFile).toHaveBeenCalled();
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(
      expect.anything(),
      activeAlias.createdBy,
      { attachmentBytes: 12n },
    );
  });

  it("does not release attachment storage when rollback file deletion fails", async () => {
    mockCreateAttachment.mockRejectedValueOnce(new Error("insert failed"));
    mockDeleteFile.mockRejectedValueOnce(new Error("unlink failed"));
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Attachment rollback failure",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [
            {
              filename: "report.pdf",
              contentType: "application/pdf",
              sizeBytes: 12,
              sha256: "pdf-hash",
              content: Buffer.from("pdf-bytes"),
            },
          ],
          rawSizeBytes: 12,
        },
        deliveryLog: { id: "log-attachment-rollback-fail" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(mockDecrementOrganizationStorageUsage).not.toHaveBeenCalled();
  });

  it("does not release attachment storage after the attachment row already exists", async () => {
    mockCreateAttachment.mockResolvedValueOnce({
      id: "att-uuid-1",
      encryptionMode: "none",
      wrappedDek: null,
      kekKeyId: null,
    });
    mockCreateAttachmentLink.mockRejectedValueOnce(new Error("link insert failed"));
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Attachment link failure",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [
            {
              filename: "report.pdf",
              contentType: "application/pdf",
              sizeBytes: 12,
              sha256: "pdf-hash",
              content: Buffer.from("pdf-bytes"),
            },
          ],
          rawSizeBytes: 12,
        },
        deliveryLog: { id: "log-attachment-link-fail" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockDecrementOrganizationStorageUsage).not.toHaveBeenCalled();
  });

  it("persists attachment encryption metadata returned by storage", async () => {
    mockWriteAttachment.mockResolvedValueOnce({
      encryptionMode: "local-v1",
      wrappedDek: "wrapped-dek",
      kekKeyId: "test-key",
      encryptedAt: new Date("2026-04-07T12:30:00.000Z"),
    });
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });

    await deliverQueuedEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Encrypted attachment",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          headerFromDisplay: "Sender <sender@example.com>",
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [
            {
              filename: "report.pdf",
              contentType: "application/pdf",
              sizeBytes: 12,
              sha256: "pdf-hash",
              content: Buffer.from("pdf-bytes"),
            },
          ],
          rawSizeBytes: 12,
        },
        deliveryLog: { id: "log-encrypted" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(mockCreateAttachment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        encryptionMode: "local-v1",
        wrappedDek: "wrapped-dek",
        kekKeyId: "test-key",
        encryptedAt: new Date("2026-04-07T12:30:00.000Z"),
      }),
    );
  });

  describe("delivery metrics", () => {
    const latencyJob = (
      deliveryLog: object,
      attachments: Array<Record<string, unknown>> = [],
    ): Parameters<typeof deliverQueuedEmail>[2] => ({
      alias: activeAlias,
      parsed: {
        messageId: "<id@test>",
        subject: "Hi",
        envelopeFrom: "sender@example.com",
        headerFrom: "Sender <sender@example.com>",
        headerFromDisplay: "Sender <sender@example.com>",
        headerFromEmail: "sender@example.com",
        headerFromDomain: "example.com",
        textBody: "hello",
        htmlBody: null,
        bodySha256: "hash",
        attachments,
        rawSizeBytes: 10,
      },
      deliveryLog: deliveryLog as never,
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });

    const initialLatency = async (): Promise<{ count: number; sum: number }> => {
      const text = await metricsRegistry.getSingleMetricAsString(
        "email_to_telegram_delivery_latency_seconds",
      );
      return {
        count: Number(/_count\{[^}]*path="initial"[^}]*\} ([\d.]+)/.exec(text)?.[1]),
        sum: Number(/_sum\{[^}]*path="initial"[^}]*\} ([\d.]+)/.exec(text)?.[1]),
      };
    };

    beforeEach(() => {
      resetMetricsForTests();
    });

    it("still delivers when received_at is missing", async () => {
      mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 77 });

      const result = await deliverQueuedEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        latencyJob({ id: "log-latency-no-received-at" }),
      );

      expect(result).toEqual({ ok: true });
      expect((await initialLatency()).count).toBe(0);
    });

    /** Sum of the series of `name` whose labels include `labels`. */
    const metricValue = async (
      name: string,
      labels: Record<string, string> = {},
    ): Promise<number> => {
      const metric = await metricsRegistry.getSingleMetric(name)?.get();
      return (metric?.values ?? [])
        .filter((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value))
        .reduce((sum, v) => sum + v.value, 0);
    };

    // The first-attempt wiring of the shared attempt module: its path label
    // and its afterCommit counters.
    it("observes received_at → Telegram accepted on the initial path", async () => {
      mockSettleLog.mockResolvedValue(undefined);
      mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 77 });

      const result = await deliverQueuedEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        latencyJob({ id: "log-latency", receivedAt: new Date(Date.now() - 90_000) }),
      );

      expect(result).toEqual({ ok: true });
      const latency = await initialLatency();
      expect(latency.count).toBe(1);
      expect(latency.sum).toBeGreaterThanOrEqual(90);
      expect(latency.sum).toBeLessThan(120);
      expect(
        await metricValue("email_to_telegram_delivery_attempts_total", { result: "succeeded" }),
      ).toBe(1);
      expect(await metricValue("email_to_telegram_telegram_send_failures_total")).toBe(0);
    });

    it("counts a first attempt to a blocked chat as lost (stage initial)", async () => {
      mockSettleLog.mockResolvedValue(undefined);
      mockSendTelegram.mockResolvedValue({
        ok: false,
        error: "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
      });

      const result = await deliverQueuedEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        latencyJob({ id: "log-lost-blocked", receivedAt: new Date() }),
      );

      expect(result).toEqual({ ok: false, reason: "send_failed" });
      expect(mockSettleLog).toHaveBeenCalledWith(
        expect.anything(),
        "log-lost-blocked",
        "permanently_failed",
      );
      expect(
        await metricValue("email_to_telegram_deliveries_lost_total", { stage: "initial" }),
      ).toBe(1);
      expect(
        await metricValue("email_to_telegram_delivery_attempts_total", { result: "failed" }),
      ).toBe(1);
      expect(await metricValue("email_to_telegram_telegram_send_failures_total")).toBe(1);
    });

    // A counted failure only spends retry budget, which the retry worker
    // enforces; the first attempt never closes the log on it.
    it.each([
      ["bad_request", "Call to 'sendMessage' failed! (400: Bad Request: message is too long)"],
      ["other", "something odd happened"],
    ])("leaves a first attempt's %s failure failed, not lost or refunded", async (_, error) => {
      mockSettleLog.mockResolvedValue(undefined);
      mockDecrementUserUsageMonth.mockResolvedValue(undefined);
      mockSendTelegram.mockResolvedValue({ ok: false, error });

      const result = await deliverQueuedEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        latencyJob({ id: "log-counted", userId: 1n, receivedAt: new Date() }),
      );

      expect(result).toEqual({ ok: false, reason: "send_failed" });
      expect(mockSettleLog).toHaveBeenCalledWith(expect.anything(), "log-counted", "failed");
      expect(await metricValue("email_to_telegram_deliveries_lost_total")).toBe(0);
      expect(mockDecrementUserUsageMonth).not.toHaveBeenCalled();
    });
  });
});
