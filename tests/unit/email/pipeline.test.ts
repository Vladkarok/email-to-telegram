import { describe, it, expect, vi, beforeEach } from "vitest";
import { processInboundEmail } from "../../../src/email/pipeline.js";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAlias = vi.fn();
const mockCheckAllow = vi.fn();
const mockIsDuplicate = vi.fn();
const mockCreateLog = vi.fn();
const mockUpdateLogStatus = vi.fn();

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
}));
vi.mock("../../../src/db/repos/deliveryAttempts.js", () => ({
  insertDeliveryAttempt: vi.fn().mockResolvedValue(undefined),
}));

const mockSendTelegram = vi.fn();
vi.mock("../../../src/telegram/sender.js", () => ({
  sendTelegramMessage: (...args: unknown[]): unknown => mockSendTelegram(...args),
  sendTelegramPhotos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/db/repos/attachments.js", () => ({
  createAttachment: vi.fn(() => Promise.resolve({ id: "att-uuid-1" })),
}));
vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  createAttachmentLink: vi.fn(() => Promise.resolve()),
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
};

const activeAlias = {
  id: "alias-uuid-1",
  localPart: "alerts",
  fullAddress: "alerts@example.com",
  chatId: 100n,
  messageThreadId: null,
  status: "active",
  renderMode: "plaintext",
};

describe("processInboundEmail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns sender_not_allowed when envelopeFrom from PipelineInput is blocked", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(false);
    const result = await processInboundEmail(
      {} as Parameters<typeof processInboundEmail>[0],
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
      {} as Parameters<typeof processInboundEmail>[0],
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
      {} as Parameters<typeof processInboundEmail>[0],
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
      {} as Parameters<typeof processInboundEmail>[0],
      null,
      {
        rawEmail: simpleEmail(),
        localPart: "alerts",
        ...PIPELINE_CONFIG,
      },
    );
    expect(result).toEqual({ ok: false, reason: "duplicate" });
  });

  it("persists the authoritative envelopeFrom in the delivery log", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-audit" });
    mockUpdateLogStatus.mockResolvedValue(undefined);

    await processInboundEmail({} as Parameters<typeof processInboundEmail>[0], null, {
      rawEmail: simpleEmail(),
      localPart: "alerts",
      envelopeFrom: "real-sender@smtp.example.com",
      ...PIPELINE_CONFIG,
    });

    expect(mockCreateLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ envelopeFrom: "real-sender@smtp.example.com" }),
    );
  });

  it("returns ok:true when api is null (no send)", async () => {
    mockFindAlias.mockResolvedValue(activeAlias);
    mockCheckAllow.mockResolvedValue(true);
    mockIsDuplicate.mockResolvedValue(false);
    mockCreateLog.mockResolvedValue({ id: "log-uuid-1" });
    mockUpdateLogStatus.mockResolvedValue(undefined);

    const result = await processInboundEmail(
      {} as Parameters<typeof processInboundEmail>[0],
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
      {} as Parameters<typeof processInboundEmail>[0],
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
      {} as Parameters<typeof processInboundEmail>[0],
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
