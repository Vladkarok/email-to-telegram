import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";
import { signWorkerRequest } from "../../../src/utils/workerAuth.js";
import { markBotHealthy, markBotUnhealthy } from "../../../src/telegram/health.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockQueueInboundEmail = vi.fn();
const mockDeliverQueuedEmail = vi.fn();
const mockWriteRawEmail = vi.fn();
const mockWritePendingRawEmailMeta = vi.fn();
const mockDeletePendingRawEmailMeta = vi.fn();
const mockDeleteFile = vi.fn();

vi.mock("../../../src/email/pipeline.js", () => ({
  queueInboundEmail: (...args: unknown[]): unknown => mockQueueInboundEmail(...args),
  deliverQueuedEmail: (...args: unknown[]): unknown => mockDeliverQueuedEmail(...args),
}));
vi.mock("../../../src/storage/disk.js", () => ({
  writeRawEmail: (...args: unknown[]): unknown => mockWriteRawEmail(...args),
  writePendingRawEmailMeta: (...args: unknown[]): unknown => mockWritePendingRawEmailMeta(...args),
  deletePendingRawEmailMeta: (...args: unknown[]): unknown =>
    mockDeletePendingRawEmailMeta(...args),
  deleteFile: (...args: unknown[]): unknown => mockDeleteFile(...args),
}));

const mockFindAlias = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: (...args: unknown[]): unknown => mockFindAlias(...args),
}));

const mockCheckAllow = vi.fn();
const mockCountRecentDeliveries = vi.fn();
const mockCheckInboundLimit = vi.fn().mockResolvedValue({ ok: true });
const mockFindHostedInboundBlock = vi.fn().mockResolvedValue(null);
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  checkAllowRule: (...args: unknown[]): unknown => mockCheckAllow(...args),
}));
vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  countRecentDeliveriesByAlias: (...args: unknown[]): unknown => mockCountRecentDeliveries(...args),
}));
vi.mock("../../../src/billing/limits.js", () => ({
  checkInboundLimit: (...args: unknown[]): unknown => mockCheckInboundLimit(...args),
}));
vi.mock("../../../src/db/repos/hostedInboundBlocks.js", () => ({
  findHostedInboundBlock: (...args: unknown[]): unknown => mockFindHostedInboundBlock(...args),
}));

const WORKER_SECRET = "test-worker-secret-32chars-abcde";

const TEST_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/attachments",
  attachmentTtlHours: 24,
  rawEmailDir: "/tmp/rawemails",
  rawEmailTtlHours: 24,
  maxSizeBytes: 1024 * 1024,
};

async function buildApp(botHealthy = true) {
  if (botHealthy) {
    markBotHealthy();
  } else {
    markBotUnhealthy();
  }
  const app = Fastify({ logger: false });
  // Register octet-stream parser so raw route can receive binary bodies
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );
  registerRoutes(app, TEST_CONFIG);
  return app;
}

describe("GET /healthz", () => {
  it("returns 200 ok", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("returns 503 when the Telegram bot is unhealthy", async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded" });
  });
});

describe("GET /readyz", () => {
  it("returns 200 when DB responds", async () => {
    const { getDb } = await import("../../../src/db/client.js");
    vi.mocked(getDb).mockReturnValue({
      execute: vi.fn(() => Promise.resolve([{ "?column?": 1 }])),
    } as unknown as ReturnType<typeof getDb>);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /inbound/preflight", () => {
  let savedSecret: string | undefined;
  let savedAppMode: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["WORKER_SECRET"];
    savedAppMode = process.env["APP_MODE"];
    process.env["WORKER_SECRET"] = WORKER_SECRET;
    delete process.env["APP_MODE"];
    mockWriteRawEmail.mockResolvedValue({
      encryptionMode: "none",
      wrappedDek: null,
      kekKeyId: null,
      encryptedAt: null,
    });
    mockWritePendingRawEmailMeta.mockResolvedValue(undefined);
    mockDeletePendingRawEmailMeta.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockFindAlias.mockReset();
    mockFindAlias.mockResolvedValue(null);
    mockCheckAllow.mockReset();
    mockCheckInboundLimit.mockReset();
    mockCheckInboundLimit.mockResolvedValue({ ok: true });
    mockFindHostedInboundBlock.mockReset();
    mockFindHostedInboundBlock.mockResolvedValue(null);
    mockCountRecentDeliveries.mockReset();
    mockCountRecentDeliveries.mockResolvedValue(0);
  });

  afterEach(() => {
    restoreEnv("WORKER_SECRET", savedSecret);
    restoreEnv("APP_MODE", savedAppMode);
  });

  it("returns 200 with accept:true for an active alias", async () => {
    mockFindAlias.mockResolvedValue({ id: "uuid-1", status: "active", localPart: "alerts" });

    const body = Buffer.from(JSON.stringify({ localPart: "alerts" }));
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: true });
  });

  it("returns 200 with accept:false when alias is not found", async () => {
    mockFindAlias.mockResolvedValue(null);

    const body = Buffer.from(JSON.stringify({ localPart: "unknown" }));
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: false });
  });

  it("returns 401 when signature is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ localPart: "alerts" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns accept:false when envelopeFrom is not in allow list", async () => {
    mockFindAlias.mockResolvedValue({ id: "uuid-1", status: "active", localPart: "alerts" });
    mockCheckAllow.mockResolvedValue(false);

    const body = Buffer.from(
      JSON.stringify({ localPart: "alerts", envelopeFrom: "blocked@attacker.com" }),
    );
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: false });
    expect(mockCheckAllow).toHaveBeenCalledWith(
      expect.anything(),
      "uuid-1",
      "blocked@attacker.com",
    );
  });

  it("returns accept:true when envelopeFrom is in allow list", async () => {
    mockFindAlias.mockResolvedValue({ id: "uuid-1", status: "active", localPart: "alerts" });
    mockCheckAllow.mockResolvedValue(true);

    const body = Buffer.from(
      JSON.stringify({ localPart: "alerts", envelopeFrom: "allowed@example.com" }),
    );
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: true });
  });

  it("returns accept:false when alias hourly cap has been reached", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      maxEmailsHour: 2,
    });
    mockCheckAllow.mockResolvedValue(true);
    mockCountRecentDeliveries.mockResolvedValue(2);

    const body = Buffer.from(
      JSON.stringify({ localPart: "alerts", envelopeFrom: "allowed@example.com" }),
    );
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: false });
  });

  it("returns accept:false when the hosted subscription is inactive", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      organizationId: "org-1",
    });
    mockCheckInboundLimit.mockResolvedValueOnce({
      ok: false,
      code: "subscription_inactive",
    });

    const body = Buffer.from(JSON.stringify({ localPart: "alerts" }));
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: false });
    expect(mockCheckAllow).not.toHaveBeenCalled();
    expect(mockCountRecentDeliveries).not.toHaveBeenCalled();
  });

  it("returns accept:false when hosted blocklist matches before quota and allow checks", async () => {
    process.env["APP_MODE"] = "hosted";
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      organizationId: "org-1",
    });
    mockFindHostedInboundBlock.mockResolvedValueOnce({
      id: "block-1",
      blockType: "sender_domain",
      value: "attacker.com",
      reason: "abuse",
      createdAt: new Date(),
    });

    const body = Buffer.from(
      JSON.stringify({
        localPart: "alerts",
        recipientDomain: "mail.example.com",
        envelopeFrom: "spam@attacker.com",
      }),
    );
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: false });
    expect(mockFindHostedInboundBlock).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      localPart: "alerts",
      recipientDomain: "mail.example.com",
      envelopeFrom: "spam@attacker.com",
    });
    expect(mockCheckInboundLimit).not.toHaveBeenCalled();
    expect(mockCheckAllow).not.toHaveBeenCalled();
  });

  it("skips hosted blocklist in self-hosted mode", async () => {
    process.env["APP_MODE"] = "self-hosted";
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      organizationId: "org-1",
    });
    mockFindHostedInboundBlock.mockResolvedValueOnce({
      id: "block-1",
      blockType: "sender_domain",
      value: "attacker.com",
      createdAt: new Date(),
    });
    mockCheckAllow.mockResolvedValue(true);

    const body = Buffer.from(
      JSON.stringify({
        localPart: "alerts",
        recipientDomain: "mail.example.com",
        envelopeFrom: "spam@attacker.com",
      }),
    );
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: true });
    expect(mockFindHostedInboundBlock).not.toHaveBeenCalled();
  });

  it("returns accept:false when the hosted monthly quota has been reached", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      organizationId: "org-1",
    });
    mockCheckInboundLimit.mockResolvedValueOnce({
      ok: false,
      code: "monthly_email_limit",
      limit: 100,
      used: 100,
    });

    const body = Buffer.from(
      JSON.stringify({ localPart: "alerts", envelopeFrom: "allowed@example.com" }),
    );
    const { signature, timestamp } = signWorkerRequest(body);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accept: false });
    expect(mockCheckAllow).not.toHaveBeenCalled();
    expect(mockCountRecentDeliveries).not.toHaveBeenCalled();
  });
});

describe("POST /inbound/raw", () => {
  let savedSecret: string | undefined;
  let savedAppMode: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["WORKER_SECRET"];
    savedAppMode = process.env["APP_MODE"];
    process.env["WORKER_SECRET"] = WORKER_SECRET;
    delete process.env["APP_MODE"];
    mockWriteRawEmail.mockReset();
    mockWriteRawEmail.mockResolvedValue({
      encryptionMode: "none",
      wrappedDek: null,
      kekKeyId: null,
      encryptedAt: null,
    });
    mockWritePendingRawEmailMeta.mockReset();
    mockWritePendingRawEmailMeta.mockResolvedValue(undefined);
    mockDeletePendingRawEmailMeta.mockReset();
    mockDeletePendingRawEmailMeta.mockResolvedValue(undefined);
    mockDeleteFile.mockReset();
    mockDeleteFile.mockResolvedValue(undefined);
    mockFindAlias.mockReset();
    mockFindAlias.mockResolvedValue(null);
    mockCheckInboundLimit.mockReset();
    mockCheckInboundLimit.mockResolvedValue({ ok: true });
    mockFindHostedInboundBlock.mockReset();
    mockFindHostedInboundBlock.mockResolvedValue(null);
    mockQueueInboundEmail.mockReset();
    mockQueueInboundEmail.mockResolvedValue({
      queued: true,
      job: { deliveryLog: { id: "log-1" } },
    });
    mockDeliverQueuedEmail.mockReset();
    mockDeliverQueuedEmail.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    restoreEnv("WORKER_SECRET", savedSecret);
    restoreEnv("APP_MODE", savedAppMode);
  });

  it("returns 202 for a valid signed raw email", async () => {
    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });
    expect(res.statusCode).toBe(202);
    const [, queuedInput] = mockQueueInboundEmail.mock.calls[0] as [
      unknown,
      {
        rawEmail: Buffer;
        localPart: string;
        envelopeFrom: string;
        rawEmailEncryption: { encryptionMode: string };
      },
    ];
    expect(queuedInput.rawEmail).toEqual(rawEmail);
    expect(queuedInput.localPart).toBe("alerts");
    expect(queuedInput.envelopeFrom).toBe("sender@example.com");
    expect(queuedInput.rawEmailEncryption).toMatchObject({ encryptionMode: "none" });
    expect(mockWritePendingRawEmailMeta).toHaveBeenCalledOnce();
    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledOnce();
  });

  it("does not acknowledge raw mail before durable persistence succeeds", async () => {
    mockWriteRawEmail.mockRejectedValueOnce(new Error("disk full"));

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(500);
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
  });

  it("returns 403 when hosted inbound mail exceeds the storage quota before write", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      organizationId: "org-1",
    });
    mockCheckInboundLimit.mockResolvedValueOnce({
      ok: false,
      code: "storage_limit",
      limit: 100,
      used: 99,
    });

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(403);
    expect(mockWriteRawEmail).not.toHaveBeenCalled();
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
  });

  it("returns 403 when hosted blocklist matches before raw persistence", async () => {
    process.env["APP_MODE"] = "hosted";
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      organizationId: "org-1",
    });
    mockFindHostedInboundBlock.mockResolvedValueOnce({
      id: "block-1",
      blockType: "recipient_domain",
      value: "mail.example.com",
      createdAt: new Date(),
    });

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
        "x-recipient-domain": "mail.example.com",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(403);
    expect(mockFindHostedInboundBlock).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      localPart: "alerts",
      recipientDomain: "mail.example.com",
      envelopeFrom: "sender@example.com",
    });
    expect(mockCheckInboundLimit).not.toHaveBeenCalled();
    expect(mockWriteRawEmail).not.toHaveBeenCalled();
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
  });

  it("returns 413 when hosted inbound mail exceeds the plan message size", async () => {
    mockQueueInboundEmail.mockResolvedValue({
      queued: false,
      result: { ok: false, reason: "message_size_limit" },
    });

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(413);
    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledOnce();
    expect(mockDeleteFile).toHaveBeenCalledOnce();
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
  });

  it("returns 403 and deletes pending metadata when queue-time storage enforcement rejects", async () => {
    mockQueueInboundEmail.mockResolvedValue({
      queued: false,
      result: { ok: false, reason: "storage_limit" },
    });

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(403);
    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledOnce();
    expect(mockDeleteFile).toHaveBeenCalledOnce();
  });

  it("returns 403 when hosted inbound mail is rejected by subscription state", async () => {
    mockQueueInboundEmail.mockResolvedValue({
      queued: false,
      result: { ok: false, reason: "subscription_inactive" },
    });

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(403);
    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledOnce();
    expect(mockDeleteFile).toHaveBeenCalledOnce();
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
  });

  it("cleans up the raw email when pending metadata persistence fails", async () => {
    mockWritePendingRawEmailMeta.mockRejectedValueOnce(new Error("fs exploded"));

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(500);
    expect(mockDeleteFile).toHaveBeenCalledOnce();
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
  });

  it("keeps pending recovery metadata when queueing is deferred", async () => {
    mockQueueInboundEmail.mockResolvedValueOnce({
      queued: false,
      result: { ok: false, reason: "rate_limited" },
    });

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(202);
    expect(mockDeletePendingRawEmailMeta).not.toHaveBeenCalled();
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
  });

  it("drops pending recovery metadata for terminal queue rejections", async () => {
    mockQueueInboundEmail.mockResolvedValueOnce({
      queued: false,
      result: { ok: false, reason: "sender_not_allowed" },
    });

    const rawEmail = Buffer.from("From: blocked@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(202);
    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledOnce();
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
  });

  it("returns 401 for unsigned request", async () => {
    const rawEmail = Buffer.from("raw data");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });
    expect(res.statusCode).toBe(401);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
