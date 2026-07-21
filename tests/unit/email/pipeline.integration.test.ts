/**
 * Integration test matrix for processInboundEmail.
 *
 * Tests the full pipeline logic end-to-end with real fixture .eml files
 * and real parser/cleaner/renderer. DB and Telegram API are mocked at
 * their boundary (repo functions + sendTelegramMessage), so no Postgres
 * or network is required.
 *
 * Matrix:
 *  ✓ plain text email — delivered, text forwarded
 *  ✓ HTML-rich email — rendered as plaintext (default mode)
 *  ✓ quoted-reply email — quoted block stripped by cleaner
 *  ✓ signature email — signature stripped by cleaner
 *  ✓ unicode subject/body — forwarded correctly
 *  ✓ oversized email — accepted (size enforcement is at HTTP layer)
 *  ✓ unknown alias — rejected alias_not_found
 *  ✓ paused alias — rejected alias_not_found
 *  ✓ blocked sender — rejected sender_not_allowed
 *  ✓ duplicate Message-ID — rejected duplicate
 *  ✓ duplicate body hash when body dedup is enabled — rejected duplicate
 *  ✓ forum topic delivery — messageThreadId set on send call
 *  ✓ rawEmailPath stored in delivery log
 *  ✓ delivery_attempt recorded on success
 *  ✓ delivery_attempt recorded on failure
 *  ✓ finalStatus = delivered on success
 *  ✓ finalStatus = failed on send error
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { processInboundEmail } from "../../../src/email/pipeline.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockFindAlias = vi.fn();
const mockFindAliasById = vi.fn();
const mockListAllowRules = vi.fn();
const mockAuthenticateSender = vi.fn();
const mockIsDuplicate = vi.fn();
const mockCreateLog = vi.fn();
const mockUpdateLogStatus = vi.fn();
const mockMarkProcessing = vi.fn();
const mockCountRecentDeliveries = vi.fn();
const mockInsertAttempt = vi.fn();
const mockSendTelegram = vi.fn();
const mockCreateDeliveryViewLink = vi.fn();
const mockWriteAttachment = vi.fn();

vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...a: unknown[]): unknown => mockFindAliasById(...a),
  findAliasByLocalPart: (...a: unknown[]): unknown => mockFindAlias(...a),
  findAliasByLocalPartAndDomainId: (...a: unknown[]): unknown => mockFindAlias(...a),
}));
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  listAllowRules: (...a: unknown[]): unknown => mockListAllowRules(...a),
}));
vi.mock("../../../src/email/authenticateSender.js", () => ({
  authenticateSender: (...a: unknown[]): unknown => mockAuthenticateSender(...a),
}));
vi.mock("../../../src/email/dedup.js", () => ({
  isDuplicate: (...a: unknown[]): unknown => mockIsDuplicate(...a),
}));
vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  createDeliveryLog: (...a: unknown[]): unknown => mockCreateLog(...a),
  updateDeliveryLogStatus: (...a: unknown[]): unknown => mockUpdateLogStatus(...a),
  markDeliveryLogProcessing: (...a: unknown[]): unknown => mockMarkProcessing(...a),
  countRecentDeliveriesByAlias: (...a: unknown[]): unknown => mockCountRecentDeliveries(...a),
}));
vi.mock("../../../src/db/repos/deliveryAttempts.js", () => ({
  insertDeliveryAttempt: (...a: unknown[]): unknown => mockInsertAttempt(...a),
}));
vi.mock("../../../src/db/repos/attachments.js", () => ({
  createAttachment: vi.fn().mockResolvedValue({ id: "att-1" }),
}));
vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  createAttachmentLink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/db/repos/deliveryViewLinks.js", () => ({
  createDeliveryViewLink: (...a: unknown[]): unknown => mockCreateDeliveryViewLink(...a),
}));
vi.mock("../../../src/storage/disk.js", () => ({
  writeAttachment: (...a: unknown[]): unknown => mockWriteAttachment(...a),
}));
vi.mock("../../../src/telegram/sender.js", () => ({
  sendTelegramMessage: (...a: unknown[]): unknown => mockSendTelegram(...a),
  sendTelegramPhotos: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/db/repos/usage.js", () => ({
  incrementUserUsageMonth: vi.fn().mockResolvedValue({ deliveredCount: 1, rejectedCount: 0 }),
  usageMonthForDate: () => "2026-04",
}));
vi.mock("../../../src/db/repos/storageUsage.js", () => ({
  incrementUserStorageUsage: vi.fn().mockResolvedValue(undefined),
  decrementUserStorageUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/billing/limits.js", () => ({
  checkInboundLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dirname, "../../fixtures");

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

const PIPELINE_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/att",
  attachmentTtlHours: 24,
  rawEmailTtlHours: 24,
};

function makeAlias(overrides: Partial<typeof baseAlias> = {}) {
  return { ...baseAlias, ...overrides };
}

const baseAlias = {
  id: "alias-uuid",
  localPart: "alerts",
  fullAddress: "alerts@example.com",
  createdBy: 1n,
  chatId: -100n,
  messageThreadId: null as bigint | null,
  status: "active",
  renderMode: "plaintext",
  privacyModeEnabled: false,
  bodyDedupEnabled: false,
  maxEmailsHour: 60,
};

const authenticatedExampleRules = [{ matchType: "domain", matchValue: "example.com" }];

const fakeDb = {
  transaction: async <T>(fn: (tx: { execute: ReturnType<typeof vi.fn> }) => Promise<T>) =>
    fn({ execute: vi.fn().mockResolvedValue(undefined) }),
} as Parameters<typeof processInboundEmail>[0];
const fakeApi = {} as NonNullable<Parameters<typeof processInboundEmail>[1]>;

function setupHappyPath(logId = "log-1") {
  const alias = makeAlias();
  mockFindAlias.mockResolvedValue(alias);
  mockFindAliasById.mockResolvedValue(alias);
  mockListAllowRules.mockResolvedValue(authenticatedExampleRules);
  mockAuthenticateSender.mockResolvedValue({
    headerFromEmail: "sender@example.com",
    headerFromDomain: "example.com",
    authenticatedDomains: ["example.com"],
    status: "pass",
  });
  mockIsDuplicate.mockResolvedValue(false);
  mockCreateLog.mockResolvedValue({ id: logId });
  mockUpdateLogStatus.mockResolvedValue(undefined);
  mockInsertAttempt.mockResolvedValue(undefined);
  mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });
  mockCreateDeliveryViewLink.mockResolvedValue(undefined);
  mockWriteAttachment.mockResolvedValue({
    encryptionMode: "none",
    wrappedDek: null,
    kekKeyId: null,
    encryptedAt: null,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pipeline integration matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCountRecentDeliveries.mockResolvedValue(0);
    mockListAllowRules.mockResolvedValue(authenticatedExampleRules);
    mockAuthenticateSender.mockResolvedValue({
      headerFromEmail: "sender@example.com",
      headerFromDomain: "example.com",
      authenticatedDomains: ["example.com"],
      status: "pass",
    });
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
  });

  // ── Delivery scenarios ──────────────────────────────────────────────────

  it("plain text: delivers and returns ok:true", async () => {
    setupHappyPath();
    const result = await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(result).toEqual({ ok: true });
    expect(mockSendTelegram).toHaveBeenCalledOnce();
    const [, opts] = mockSendTelegram.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("CPU usage");
  });

  it("HTML-rich email: rendered as plaintext by default", async () => {
    setupHappyPath();
    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("html-rich.eml"),
      localPart: "alerts",
      envelopeFrom: "newsletter@example.com",
      ...PIPELINE_CONFIG,
    });
    const [, opts] = mockSendTelegram.mock.calls[0] as [
      unknown,
      { text: string; parseMode?: string },
    ];
    expect(opts.parseMode).toBeUndefined();
    expect(typeof opts.text).toBe("string");
    expect(opts.text.length).toBeGreaterThan(0);
  });

  it("quoted-reply: quoted block stripped from forwarded text", async () => {
    setupHappyPath();
    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("quoted-reply.eml"),
      localPart: "alerts",
      envelopeFrom: "colleague@example.com",
      ...PIPELINE_CONFIG,
    });
    const [, opts] = mockSendTelegram.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("Sounds good");
    expect(opts.text).not.toContain("Can everyone join");
  });

  it("signature email: signature stripped from forwarded text", async () => {
    setupHappyPath();
    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("with-signature.eml"),
      localPart: "alerts",
      envelopeFrom: "support@example.com",
      ...PIPELINE_CONFIG,
    });
    const [, opts] = mockSendTelegram.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("Ticket #1234");
    expect(opts.text).not.toContain("John Smith");
  });

  it("unicode subject and body: forwarded without corruption", async () => {
    setupHappyPath();
    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("unicode.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    const [, opts] = mockSendTelegram.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("Сервер");
  });

  it("oversized email body: still processed (size gate is at HTTP layer)", async () => {
    setupHappyPath();
    // Build a large email that exceeds MAX_SIZE_BYTES (10 MiB)
    const bigBody = "X".repeat(11 * 1024 * 1024);
    const oversized = Buffer.from(
      `From: sender@example.com\r\nTo: alerts@example.com\r\nSubject: Big\r\nMessage-ID: <big@test>\r\n\r\n${bigBody}`,
    );
    const result = await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: oversized,
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    // Pipeline itself does not enforce size; it processes whatever it receives
    expect(result.ok).toBe(true);
  });

  it("forum topic: message_thread_id passed to Telegram send", async () => {
    mockFindAlias.mockResolvedValue(makeAlias({ messageThreadId: 42n }));
    // The attempt route comes from the fresh by-id read, not the queued alias.
    mockFindAliasById.mockResolvedValue(makeAlias({ messageThreadId: 42n }));
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-topic" });
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockInsertAttempt.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 55 });

    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });

    const [, opts] = mockSendTelegram.mock.calls[0] as [unknown, { threadId: bigint | null }];
    expect(opts.threadId).toBe(42n);
  });

  it("privacy mode: sends a one-time web view link instead of message content", async () => {
    mockFindAlias.mockResolvedValue(makeAlias({ privacyModeEnabled: true }));
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({
      id: "log-privacy",
      rawEmailPath: "/tmp/raw/privacy.eml",
      receivedAt: new Date("2026-04-07T12:00:00.000Z"),
    });
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockInsertAttempt.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 55 });

    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      rawEmailPath: "/tmp/raw/privacy.eml",
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });

    const [, opts] = mockSendTelegram.mock.calls[0] as [unknown, { text: string }];
    expect(opts.text).toContain("/view/");
    expect(opts.text).not.toContain("CPU usage");
    expect(mockCreateDeliveryViewLink).toHaveBeenCalledWith(
      expect.anything(),
      "log-privacy",
      expect.any(String),
      expect.any(Date),
    );
  });

  // ── Rejection scenarios ─────────────────────────────────────────────────

  it("unknown alias: returns alias_not_found", async () => {
    mockFindAlias.mockResolvedValue(null);
    const result = await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "nonexistent",
      ...PIPELINE_CONFIG,
    });
    expect(result).toEqual({ ok: false, reason: "alias_not_found" });
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("paused alias: returns alias_not_found", async () => {
    mockFindAlias.mockResolvedValue(makeAlias({ status: "paused" }));
    const result = await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      ...PIPELINE_CONFIG,
    });
    expect(result).toEqual({ ok: false, reason: "alias_not_found" });
  });

  it("blocked sender: returns sender_not_allowed", async () => {
    mockFindAlias.mockResolvedValue(makeAlias());
    mockListAllowRules.mockResolvedValue([{ matchType: "domain", matchValue: "trusted.example" }]);
    const result = await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "spam@attacker.com",
      ...PIPELINE_CONFIG,
    });
    expect(result).toEqual({ ok: false, reason: "sender_not_allowed" });
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("duplicate Message-ID: returns duplicate, no send", async () => {
    mockFindAlias.mockResolvedValue(makeAlias());
    mockIsDuplicate.mockResolvedValue(true);
    const result = await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate" });
    expect(mockCreateLog).not.toHaveBeenCalled();
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("duplicate body hash with body dedup enabled: returns duplicate", async () => {
    mockFindAlias.mockResolvedValue(makeAlias({ bodyDedupEnabled: true }));
    mockIsDuplicate.mockResolvedValue(true);
    const result = await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("unicode.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate" });
  });

  // ── DB recording ────────────────────────────────────────────────────────

  it("rawEmailPath stored in delivery log when provided", async () => {
    setupHappyPath();
    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      rawEmailPath: "/data/rawemails/2026-01-01/test.eml",
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(mockCreateLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rawEmailPath: "/data/rawemails/2026-01-01/test.eml" }),
    );
  });

  it("delivery_attempt recorded with succeeded status on success", async () => {
    setupHappyPath("log-attempt-ok");
    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(mockInsertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deliveryLogId: "log-attempt-ok",
        attemptNo: 1,
        status: "succeeded",
        telegramMessageId: 99n,
      }),
    );
  });

  it("delivery_attempt recorded with failed status on send error", async () => {
    mockFindAlias.mockResolvedValue(makeAlias());
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-attempt-fail" });
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockInsertAttempt.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: false, error: "flood wait 30" });

    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(mockInsertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", errorText: "flood wait 30" }),
    );
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-attempt-fail",
      "failed",
    );
  });

  it("finalStatus = delivered on successful send", async () => {
    setupHappyPath("log-status-ok");
    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-status-ok",
      "delivered",
    );
  });

  it("finalStatus = failed on transient send error", async () => {
    mockFindAlias.mockResolvedValue(makeAlias());
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-status-fail" });
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockInsertAttempt.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: false, error: "fetch failed" });

    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(mockInsertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", errorClass: "network" }),
    );
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-status-fail",
      "failed",
    );
  });

  it("finalStatus = permanently_failed when the chat is gone", async () => {
    mockFindAlias.mockResolvedValue(makeAlias());
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-status-gone" });
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockInsertAttempt.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({
      ok: false,
      error: "Call to 'sendMessage' failed! (400: Bad Request: chat not found)",
    });

    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(mockInsertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", errorClass: "chat_not_found" }),
    );
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-status-gone",
      "permanently_failed",
    );
  });

  it("finalStatus = permanently_failed when the bot is blocked", async () => {
    mockFindAlias.mockResolvedValue(makeAlias());
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-status-blocked" });
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockInsertAttempt.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({
      ok: false,
      error: "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
    });

    await processInboundEmail(fakeDb, fakeApi, {
      rawEmail: fixture("simple.eml"),
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      ...PIPELINE_CONFIG,
    });
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(
      expect.anything(),
      "log-status-blocked",
      "permanently_failed",
    );
  });
});
