import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processInboundEmail,
  queueInboundEmail,
  deliverQueuedEmail,
} from "../../../src/email/pipeline.js";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAlias = vi.fn();
const mockCheckAllow = vi.fn();
const mockIsDuplicate = vi.fn();
const mockCreateLog = vi.fn();
const mockUpdateLogStatus = vi.fn();
const mockCountRecentDeliveries = vi.fn();
const mockCreateAttachment = vi.fn();
const mockCreateAttachmentLink = vi.fn();
const mockCreateDeliveryViewLink = vi.fn();
const mockSendTelegramPhotos = vi.fn();

vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: (...args: unknown[]): unknown => mockFindAlias(...args),
}));
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  checkAllowRule: (...args: unknown[]): unknown => mockCheckAllow(...args),
}));
vi.mock("../../../src/email/dedup.js", () => ({
  isDuplicate: (...args: unknown[]): unknown => mockIsDuplicate(...args),
}));
vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  createDeliveryLog: (...args: unknown[]): unknown => mockCreateLog(...args),
  updateDeliveryLogStatus: (...args: unknown[]): unknown => mockUpdateLogStatus(...args),
  countRecentDeliveriesByAlias: (...args: unknown[]): unknown => mockCountRecentDeliveries(...args),
}));
vi.mock("../../../src/db/repos/deliveryAttempts.js", () => ({
  insertDeliveryAttempt: vi.fn().mockResolvedValue(undefined),
}));

const mockSendTelegram = vi.fn();
vi.mock("../../../src/telegram/sender.js", () => ({
  sendTelegramMessage: (...args: unknown[]): unknown => mockSendTelegram(...args),
  sendTelegramPhotos: (...args: unknown[]): unknown => mockSendTelegramPhotos(...args),
}));

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
  writeAttachment: vi.fn(() => Promise.resolve()),
}));

function simpleEmail() {
  return readFileSync(join(import.meta.dirname, "../../fixtures/simple.eml"));
}

const PIPELINE_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/att",
  attachmentTtlHours: 24,
  rawEmailTtlHours: 24,
};

const activeAlias = {
  id: "alias-uuid-1",
  localPart: "alerts",
  fullAddress: "alerts@example.com",
  chatId: 100n,
  messageThreadId: null,
  status: "active",
  renderMode: "plaintext",
  privacyModeEnabled: false,
  bodyDedupEnabled: false,
  maxEmailsHour: 60,
};

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
    mockCountRecentDeliveries.mockResolvedValue(0);
    mockCreateAttachment.mockResolvedValue({ id: "att-uuid-1" });
    mockCreateAttachmentLink.mockResolvedValue(undefined);
    mockCreateDeliveryViewLink.mockResolvedValue(undefined);
    mockSendTelegramPhotos.mockResolvedValue({ ok: true, failedPhotos: [] });
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
  });

  it("returns sender_not_allowed when envelopeFrom from PipelineInput is blocked", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(false);
    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        envelopeFrom: "blocked@attacker.com",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: false, reason: "sender_not_allowed" });
    expect(mockCheckAllow).toHaveBeenCalledWith(
      expect.anything(),
      activeAlias.id,
      "blocked@attacker.com",
    );
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
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: false, reason: "alias_not_found" });
  });

  it("returns duplicate when dedup check fails", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
    mockIsDuplicate.mockResolvedValue(true);
    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: false, reason: "duplicate" });
  });

  it("returns rate_limited when alias hourly cap is reached", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
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

  it("persists the authoritative envelopeFrom in the delivery log", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
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
    mockCheckAllow.mockResolvedValue(true);
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
    mockFindAlias.mockResolvedValue({ ...activeAlias, privacyModeEnabled: true });
    mockCheckAllow.mockResolvedValue(true);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({
      id: "log-privacy",
      rawEmailPath: "/tmp/raw/privacy.eml",
      receivedAt: new Date("2026-04-07T12:00:00.000Z"),
    });
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 321 });

    await processInboundEmail(fakeDb() as Parameters<typeof processInboundEmail>[0], {} as never, {
      rawEmail: simpleEmail(),
      rawEmailPath: "/tmp/raw/privacy.eml",
      localPart: "alerts",
      ...PIPELINE_CONFIG,
    });

    const [, opts] = mockSendTelegram.mock.calls[0] as [
      unknown,
      { text: string; parseMode?: string },
    ];
    expect(opts.parseMode).toBe("HTML");
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
    mockCheckAllow.mockResolvedValue(true);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-1" });
    mockUpdateLogStatus.mockResolvedValue(undefined);

    const result = await processInboundEmail(
      fakeDb() as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it("delivers and returns ok:true on successful send", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
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
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: true });
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-uuid-2", "delivered");
  });

  it("returns send_failed when Telegram delivery fails", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
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
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: false, reason: "send_failed" });
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-uuid-3", "failed");
  });
});

describe("queueInboundEmail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("queues a delivery log before async delivery begins", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
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
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it("returns duplicate when the delivery-log insert loses a DB race", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
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
});

describe("deliverQueuedEmail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUpdateLogStatus.mockResolvedValue(undefined);
    mockCreateAttachment.mockResolvedValue({ id: "att-uuid-1" });
    mockCreateAttachmentLink.mockResolvedValue(undefined);
    mockSendTelegramPhotos.mockResolvedValue({ ok: true, failedPhotos: [] });
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
  });

  it("marks the queued delivery failed when an unexpected error escapes", async () => {
    mockSendTelegram.mockRejectedValue(new Error("telegram exploded"));

    await expect(
      deliverQueuedEmail(
        {} as Parameters<typeof processInboundEmail>[0],
        {} as Parameters<typeof processInboundEmail>[1],
        {
          alias: activeAlias,
          parsed: {
            messageId: "<id@test>",
            subject: "Hi",
            envelopeFrom: "sender@example.com",
            headerFrom: "Sender <sender@example.com>",
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

    expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-failed", "processing");
    expect(mockUpdateLogStatus).toHaveBeenCalledWith(expect.anything(), "log-failed", "failed");
  });

  it("uses HTML parse mode for markdown-rendered deliveries", async () => {
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 77 });

    await deliverQueuedEmail(
      {} as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: { ...activeAlias, renderMode: "markdown" },
        parsed: {
          messageId: "<id@test>",
          subject: "Markdown",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          textBody: "# Heading\n\n**Bold**",
          htmlBody: "<div># Heading</div><div>**Bold**</div>",
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
      { parseMode?: string; text: string },
    ];
    expect(opts.parseMode).toBe("HTML");
    expect(opts.text).toContain("<b>Heading</b>");
    expect(opts.text).toContain("<b>Bold</b>");
  });

  it("omits image download links when the image is sent as a Telegram photo", async () => {
    mockCreateAttachment
      .mockResolvedValueOnce({ id: "att-image" })
      .mockResolvedValueOnce({ id: "att-pdf" });
    mockSendTelegram.mockResolvedValue({ ok: true, telegramMessageId: 99 });

    await deliverQueuedEmail(
      {} as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Hi",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
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
      {} as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Hi",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
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
      {} as Parameters<typeof processInboundEmail>[0],
      {} as Parameters<typeof processInboundEmail>[1],
      {
        alias: activeAlias,
        parsed: {
          messageId: "<id@test>",
          subject: "Hi",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
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
});
