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
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  checkAllowRule: (...args: unknown[]): unknown => mockCheckAllow(...args),
}));
vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  countRecentDeliveriesByAlias: (...args: unknown[]): unknown => mockCountRecentDeliveries(...args),
}));
vi.mock("../../../src/billing/limits.js", () => ({
  checkInboundLimit: (...args: unknown[]): unknown => mockCheckInboundLimit(...args),
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

  beforeEach(() => {
    savedSecret = process.env["WORKER_SECRET"];
    process.env["WORKER_SECRET"] = WORKER_SECRET;
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
    mockCheckAllow.mockReset();
    mockCheckInboundLimit.mockReset();
    mockCheckInboundLimit.mockResolvedValue({ ok: true });
    mockCountRecentDeliveries.mockReset();
    mockCountRecentDeliveries.mockResolvedValue(0);
  });

  afterEach(() => {
    process.env["WORKER_SECRET"] = savedSecret;
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

  beforeEach(() => {
    savedSecret = process.env["WORKER_SECRET"];
    process.env["WORKER_SECRET"] = WORKER_SECRET;
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
    mockQueueInboundEmail.mockReset();
    mockQueueInboundEmail.mockResolvedValue({
      queued: true,
      job: { deliveryLog: { id: "log-1" } },
    });
    mockDeliverQueuedEmail.mockReset();
    mockDeliverQueuedEmail.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.env["WORKER_SECRET"] = savedSecret;
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
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
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
