import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  processInboundEmail,
  queueInboundEmail,
  deliverQueuedEmail,
} from "../../../src/email/pipeline.js";
import { insertDeliveryAttempt } from "../../../src/db/repos/deliveryAttempts.js";
import { applyPlanLimitOverrides, getPlanDefinition } from "../../../src/billing/plans.js";
import { metricsRegistry, resetMetricsForTests } from "../../../src/observability/metrics.js";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAlias = vi.fn();
const mockFindAliasById = vi.fn();
const mockListAllowRules = vi.fn();
const mockAuthenticateSender = vi.fn();
const mockIsDuplicate = vi.fn();
const mockCreateLog = vi.fn();
const mockUpdateLogStatus = vi.fn();
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
  updateDeliveryLogStatus: (...args: unknown[]): unknown => mockUpdateLogStatus(...args),
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
    // Tracked; falls back to the free plan, read at call time so
    // applyPlanLimitOverrides in a test takes effect.
    resolveInboundPlan: (...args: unknown[]): unknown =>
      mockResolveInboundPlan(...args) ??
      Promise.resolve({ hosted: true, user: null, plan: getPlanDefinition("free") }),
  };
});
vi.mock("../../../src/db/repos/usage.js", () => ({
  incrementUserUsageMonth: (...args: unknown[]): unknown =>
    mockIncrementOrganizationUsageMonth(...args),
  usageMonthForDate: (): unknown => mockUsageMonthForDate(),
}));
vi.mock("../../../src/db/repos/storageUsage.js", () => ({
  incrementUserStorageUsage: (...args: unknown[]): unknown =>
    mockIncrementOrganizationStorageUsage(...args),
  decrementUserStorageUsage: (...args: unknown[]): unknown =>
    mockDecrementOrganizationStorageUsage(...args),
}));

function simpleEmail() {
  return readFileSync(join(import.meta.dirname, "../../fixtures/simple.eml"));
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

function fakeDb() {
  return {
    transaction: async <T>(fn: (tx: { execute: ReturnType<typeof vi.fn> }) => Promise<T>) =>
      fn({ execute: vi.fn().mockResolvedValue(undefined) }),
  };
}

function fakeDbHarness() {
  const execute = vi.fn().mockResolvedValue(undefined);
  return {
    db: {
      transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) =>
        fn({ execute }),
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

  it("returns sender_not_allowed when RFC5322 From has no allow-rule candidate", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: Buffer.from("From: blocked@attacker.com\r\nSubject: blocked\r\n\r\nbody"),
        localPart: "alerts",
        envelopeFrom: "blocked@attacker.com",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({
      ok: false,
      reason: "sender_not_allowed",
      senderRejection: { aliasId: "alias-uuid-1", headerFromDomain: "attacker.com" },
    });
    expect(mockAuthenticateSender).not.toHaveBeenCalled();
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

  it("returns alias_not_found when alias is missing", async () => {
    mockFindAlias.mockResolvedValue(null);
    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: simpleEmail(),
        localPart: "unknown",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: false, reason: "alias_not_found" });
  });

  it("returns alias_not_found when alias is paused", async () => {
    mockFindAlias.mockResolvedValue({ ...activeAlias, status: "paused" });
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
    expect(result).toEqual({ ok: false, reason: "alias_not_found" });
  });

  it("returns duplicate when dedup check fails", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(true);
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
    expect(result).toEqual({ ok: false, reason: "duplicate" });
  });

  it("returns rate_limited when alias hourly cap is reached", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCountRecentDeliveries.mockResolvedValue(60);

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

    expect(result).toEqual({ ok: false, reason: "rate_limited" });
    expect(mockCreateLog).not.toHaveBeenCalled();
  });

  describe("hourly cap from the owner's plan", () => {
    afterEach(() => {
      applyPlanLimitOverrides({});
    });

    async function queueWith(recent: number) {
      mockFindAlias.mockResolvedValue(activeAlias);
      mockIsDuplicate.mockResolvedValue(false);
      mockCreateLog.mockResolvedValue({ id: "log-uuid-cap" });
      mockCountRecentDeliveries.mockResolvedValue(recent);
      return queueInboundEmail(fakeDb() as Parameters<typeof queueInboundEmail>[0], {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      });
    }

    it("rate-limits at the plan's cap and ignores the legacy column", async () => {
      applyPlanLimitOverrides({ free: { aliasEmailsPerHour: 5 } });
      const result = await queueWith(5);
      expect(result).toMatchObject({ queued: false, result: { reason: "rate_limited" } });
      expect(mockCreateLog).not.toHaveBeenCalled();
    });

    it("queues one below the plan's cap", async () => {
      applyPlanLimitOverrides({ free: { aliasEmailsPerHour: 5 } });
      const result = await queueWith(4);
      expect(result).toMatchObject({ queued: true });
    });

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
    mockUpdateLogStatus.mockResolvedValue(undefined);

    await processInboundEmail(fakeDb() as Parameters<typeof processInboundEmail>[0], null, {
      rawEmail: simpleEmail(),
      localPart: "alerts",
      envelopeFrom: "real-sender@sender.example.com",
      ...PIPELINE_CONFIG,
    });

    expect(mockCreateLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        envelopeFrom: "real-sender@sender.example.com",
        bodyDedupApplied: false,
      }),
    );
  });

  it("passes the alias body dedup setting into the duplicate check and delivery log", async () => {
    mockFindAlias.mockResolvedValue({ ...activeAlias, bodyDedupEnabled: true });
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-dedup-enabled" });
    mockUpdateLogStatus.mockResolvedValue(undefined);

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
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 321 });

    await processInboundEmail(fakeDb() as Parameters<typeof processInboundEmail>[0], {} as never, {
      // Rich-capable body: without privacy mode this delivery would carry richHtml.
      rawEmail: Buffer.from(
        "From: sender@example.com\r\nTo: alerts@example.com\r\nSubject: Private\r\n\r\n# Heading\r\n\r\nCPU usage is high",
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
    expect(opts.text).toContain("Private email alert");
    expect(opts.text).toContain("/view/");
    expect(opts.text).not.toContain("CPU usage");
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
    mockUpdateLogStatus.mockResolvedValue(undefined);

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
    mockUpdateLogStatus.mockResolvedValue(undefined);
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
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-uuid-2", "delivered");
    // The alias is now working: the first-delivered marker follows the
    // persisted success.
    expect(mockMarkAliasFirstDelivered).toHaveBeenCalledWith(expect.anything(), activeAlias.id);
    expect(mockMarkAliasFirstDelivered.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockUpdateLogStatus.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("keeps a delivery successful, with one send, when the marker write fails", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-marker" });
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 42 });
    mockMarkAliasFirstDelivered.mockRejectedValue(new Error("db down"));

    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: true });
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-uuid-marker",
      "delivered",
    );
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      "log-uuid-marker",
      "failed",
    );
  });

  it("returns send_failed when Telegram delivery fails", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-3" });
    mockUpdateLogStatus.mockResolvedValue(undefined);
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
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-uuid-3", "failed");
    expect(mockMarkAliasFirstDelivered).not.toHaveBeenCalled();
    expect(mockIncrementOrganizationUsageMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: activeAlias.createdBy,
        deliveredCount: 1,
      }),
    );
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

  it("queues a delivery log before async delivery begins", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-queued" });
    const harness = fakeDbHarness();

    const result = await queueInboundEmail(harness.db, {
      rawEmail: simpleEmail(),
      rawEmailPath: "/data/rawemails/test.eml",
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });

    expect(result).toMatchObject({ queued: true });
    expect(mockCreateLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawEmailPath: "/data/rawemails/test.eml",
        finalStatus: "received",
      }),
    );
    expect(mockIncrementOrganizationUsageMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: activeAlias.createdBy,
        month: "2026-04",
        deliveredCount: 1,
      }),
    );
    expect(mockIncrementOrganizationStorageUsage).toHaveBeenCalledWith(
      expect.anything(),
      activeAlias.createdBy,
      {
        rawEmailBytes: BigInt(simpleEmail().length),
        attachmentBytes: 0n,
      },
    );
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it("returns the inbound limit reason before creating a delivery log", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckInboundLimit.mockResolvedValueOnce({
      ok: false,
      code: "monthly_email_limit",
      limit: 100,
      used: 100,
    });
    const harness = fakeDbHarness();

    const result = await queueInboundEmail(harness.db, {
      rawEmail: simpleEmail(),
      rawEmailPath: "/data/rawemails/test.eml",
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });

    expect(result).toEqual({
      queued: false,
      // userId and month are resolved inside the queue transaction so the
      // route can notify the effective owner against the decision month, not
      // its own possibly-stale lookup or a recomputed "now".
      result: { ok: false, reason: "monthly_email_limit", userId: 1n, month: "2026-04" },
    });
    expect(mockCreateLog).not.toHaveBeenCalled();
    // Quota-exhaustion rejections charge rejected_count (lost-mail tracking);
    // delivered_count stays untouched.
    expect(mockIncrementOrganizationUsageMonth).toHaveBeenCalledOnce();
    expect(mockIncrementOrganizationUsageMonth).toHaveBeenCalledWith(expect.anything(), {
      userId: 1n,
      month: expect.stringMatching(/^\d{4}-\d{2}$/) as unknown as string,
      rejectedCount: 1,
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
  });

  it("queues authenticated allow-rule deliveries when DKIM/DMARC aligned identity passes", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockListAllowRules.mockResolvedValue([
      {
        matchType: "domain",
        matchValue: "example.com",
      },
    ]);
    mockAuthenticateSender.mockResolvedValue({
      headerFromEmail: "sender@example.com",
      headerFromDomain: "example.com",
      authenticatedDomains: ["example.com"],
      status: "pass",
    });
    mockIsDuplicate.mockResolvedValue(false);
    mockCountRecentDeliveries.mockResolvedValue(0);
    mockCreateLog.mockResolvedValue({ id: "log-auth" });

    const result = await queueInboundEmail(fakeDbHarness().db, {
      rawEmail: simpleEmail(),
      rawEmailPath: "/data/rawemails/auth.eml",
      localPart: "alerts",
      envelopeFrom: "bounce@mailer.example",
      ...PIPELINE_CONFIG,
    });

    expect(result).toMatchObject({ queued: true });
    expect(mockAuthenticateSender).toHaveBeenCalledWith(simpleEmail(), "bounce@mailer.example");
  });

  it("rejects authenticated allow-rule candidates when sender auth fails", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockListAllowRules.mockResolvedValue([
      {
        matchType: "domain",
        matchValue: "example.com",
      },
    ]);
    mockAuthenticateSender.mockResolvedValue({
      headerFromEmail: "sender@example.com",
      headerFromDomain: "example.com",
      authenticatedDomains: [],
      status: "fail",
    });

    const result = await queueInboundEmail(fakeDbHarness().db, {
      rawEmail: simpleEmail(),
      rawEmailPath: "/data/rawemails/auth-fail.eml",
      localPart: "alerts",
      envelopeFrom: "bounce@mailer.example",
      ...PIPELINE_CONFIG,
    });

    expect(result).toEqual({ queued: false, result: { ok: false, reason: "sender_auth_failed" } });
    expect(mockCreateLog).not.toHaveBeenCalled();
  });
});

describe("deliverQueuedEmail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUpdateLogStatus.mockResolvedValue(undefined);
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
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-failed", "failed");
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
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      "log-deleted",
      "processing",
    );
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      "log-deleted",
      "delivered",
    );
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

  it("repairs the migration and stays retryable when the text send hits a migrate error", async () => {
    mockRepairChatMigration.mockResolvedValue({ aliasCount: 1 });
    mockSendTelegram.mockResolvedValue({
      ok: false,
      error: MIGRATE_FAILURE.description,
      failure: MIGRATE_FAILURE,
    });

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
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [],
          rawSizeBytes: 5,
        },
        deliveryLog: { id: "log-migrate" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(result).toEqual({ ok: false, reason: "send_failed" });
    expect(mockRepairChatMigration).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      100n,
      -1002222333444n,
    );
    // Retryable, never permanently failed: repair failure must not burn the
    // budget or trigger a premature refund.
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-migrate", "failed");
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      "log-migrate",
      "permanently_failed",
    );
  });

  it("still returns send_failed (retryable) when the migrate repair itself fails", async () => {
    mockRepairChatMigration.mockRejectedValue(new Error("repair exploded"));
    mockSendTelegram.mockResolvedValue({
      ok: false,
      error: MIGRATE_FAILURE.description,
      failure: MIGRATE_FAILURE,
    });

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
          headerFromEmail: "sender@example.com",
          headerFromDomain: "example.com",
          textBody: "hello",
          htmlBody: null,
          bodySha256: "hash",
          attachments: [],
          rawSizeBytes: 5,
        },
        deliveryLog: { id: "log-migrate-repair-fail" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(result).toEqual({ ok: false, reason: "send_failed" });
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-migrate-repair-fail",
      "failed",
    );
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
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-photo-migrate",
      "failed",
    );
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

  it("keeps the delivery successful when image fallback link creation fails", async () => {
    mockCreateAttachment.mockResolvedValueOnce({ id: "att-image" });
    mockSendTelegram.mockResolvedValueOnce({ ok: true, telegramMessageId: 99 });
    mockSendTelegramPhotos.mockImplementationOnce((_api, opts: { photos: unknown[] }) =>
      Promise.resolve({
        ok: false,
        failedPhotos: opts.photos,
      }),
    );
    mockCreateAttachmentLink.mockRejectedValueOnce(new Error("db exploded"));

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
        deliveryLog: { id: "log-fallback-nonfatal" } as never,
        envelopeFrom: "sender@example.com",
        ...PIPELINE_CONFIG,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-fallback-nonfatal",
      "delivered",
    );
    expect(mockUpdateLogStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      "log-fallback-nonfatal",
      "failed",
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

    it("observes received_at → Telegram accepted on a successful delivery", async () => {
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
    });

    it("observes nothing when the send fails", async () => {
      mockSendTelegram.mockResolvedValue({ ok: false, error: "Bad Request: oops" });

      await deliverQueuedEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        latencyJob({ id: "log-latency-failed", receivedAt: new Date() }),
      );

      expect((await initialLatency()).count).toBe(0);
    });

    it("observes nothing when the attempt is handed back for a chat migration", async () => {
      mockRepairChatMigration.mockResolvedValue({ aliasCount: 1 });
      mockCreateAttachment.mockResolvedValueOnce({ id: "att-image" });
      mockSendTelegram.mockResolvedValueOnce({ ok: true, telegramMessageId: 99 });
      mockSendTelegramPhotos.mockImplementationOnce((_api, opts: { photos: unknown[] }) =>
        Promise.resolve({ ok: false, failedPhotos: opts.photos, failure: MIGRATE_FAILURE }),
      );

      const result = await deliverQueuedEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        latencyJob({ id: "log-latency-migrated", receivedAt: new Date() }, [
          {
            filename: "image.png",
            contentType: "image/png",
            sizeBytes: 10,
            sha256: "img-hash",
            content: Buffer.from("image-bytes"),
          },
        ]),
      );

      expect(result).toEqual({ ok: false, reason: "chat_migrated" });
      expect((await initialLatency()).count).toBe(0);
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

    const lostAt = async (stage: string): Promise<number> => {
      const text = await metricsRegistry.getSingleMetricAsString(
        "email_to_telegram_deliveries_lost_total",
      );
      return Number(new RegExp(`\\{stage="${stage}"[^}]*\\} ([\\d.]+)`).exec(text)?.[1]);
    };

    it("counts a first attempt to a blocked chat as lost (stage initial)", async () => {
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
      expect(mockUpdateLogStatus).toHaveBeenCalledWith(
        expect.anything(),
        "log-lost-blocked",
        "permanently_failed",
      );
      expect(await lostAt("initial")).toBe(1);
    });

    it("does not count a retryable first-attempt failure as lost", async () => {
      mockSendTelegram.mockResolvedValue({ ok: false, error: "Bad Request: oops" });

      await deliverQueuedEmail(
        fakeDb() as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        latencyJob({ id: "log-not-lost", receivedAt: new Date() }),
      );

      expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-not-lost", "failed");
      expect(await lostAt("initial")).toBe(0);
    });

    it("does not count a loss when persisting permanently_failed fails", async () => {
      mockSendTelegram.mockResolvedValue({
        ok: false,
        error: "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
      });
      mockUpdateLogStatus.mockRejectedValue(new Error("db down"));

      await expect(
        deliverQueuedEmail(
          fakeDb() as Parameters<typeof processInboundEmail>[0],
          {} as Parameters<typeof processInboundEmail>[1],
          latencyJob({ id: "log-lost-unpersisted", receivedAt: new Date() }),
        ),
      ).rejects.toThrow("db down");

      expect(await lostAt("initial")).toBe(0);
    });
  });
});
