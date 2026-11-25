import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";
import { signWorkerRequest } from "../../../src/utils/workerAuth.js";
import { markBotHealthy, markBotUnhealthy } from "../../../src/telegram/health.js";
import { metricsRegistry, resetMetricsForTests } from "../../../src/observability/metrics.js";
import { getLogger } from "../../../src/utils/logger.js";
import { applyPlanLimitOverrides, getPlanDefinition } from "../../../src/billing/plans.js";
import { REJECTION_POLICY, rejectionPolicy } from "../../../src/email/inboundAdmission/policy.js";
import { pipelineTracker } from "../../../src/utils/inFlight.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockQueueInboundEmail = vi.fn();
const mockDeliverQueuedEmail = vi.fn();
const mockWriteRawEmail = vi.fn();
const mockWritePendingRawEmailMeta = vi.fn();
const mockDeletePendingRawEmailMeta = vi.fn();
const mockDeleteFile = vi.fn();

vi.mock("../../../src/email/inboundAdmission/queue.js", () => ({
  queueInboundEmail: (...args: unknown[]): unknown => mockQueueInboundEmail(...args),
}));
vi.mock("../../../src/email/pipeline.js", () => ({
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
const mockFindAliasByDomain = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: (...args: unknown[]): unknown => mockFindAlias(...args),
  findAliasByLocalPartAndDomainId: (...args: unknown[]): unknown => mockFindAliasByDomain(...args),
}));
const mockFindInboundDomain = vi.fn();
vi.mock("../../../src/db/repos/inboundDomains.js", () => ({
  findInboundDomainByDomain: (...args: unknown[]): unknown => mockFindInboundDomain(...args),
}));

const mockCheckAllow = vi.fn();
const mockCountRecentDeliveries = vi.fn();
const mockCheckInboundLimit = vi.fn().mockResolvedValue({ ok: true });
const mockFindHostedInboundBlock = vi.fn().mockResolvedValue(null);
const mockClaimWorkerRequestNonce = vi.fn().mockResolvedValue(true);
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  checkPreflightAllowRules: (...args: unknown[]): unknown => mockCheckAllow(...args),
}));
vi.mock("../../../src/db/repos/workerRequestNonces.js", () => ({
  claimWorkerRequestNonce: (...args: unknown[]): unknown => mockClaimWorkerRequestNonce(...args),
}));
vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  countRecentDeliveriesByAlias: (...args: unknown[]): unknown => mockCountRecentDeliveries(...args),
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
vi.mock("../../../src/db/repos/hostedInboundBlocks.js", () => ({
  findHostedInboundBlock: (...args: unknown[]): unknown => mockFindHostedInboundBlock(...args),
}));
const mockIncrementUserUsageMonth = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/db/repos/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db/repos/usage.js")>()),
  incrementUserUsageMonth: (...args: unknown[]): unknown => mockIncrementUserUsageMonth(...args),
}));
const mockNotifyQuotaExhausted = vi.fn().mockResolvedValue(undefined);
const mockNotifyApproachingMonthlyLimit = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/billing/quotaNotifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/billing/quotaNotifier.js")>()),
  notifyQuotaExhausted: (...args: unknown[]): unknown => mockNotifyQuotaExhausted(...args),
  notifyApproachingMonthlyLimit: (...args: unknown[]): unknown =>
    mockNotifyApproachingMonthlyLimit(...args),
}));

const mockAdmitRawSenderRejection = vi.fn();
const mockAdmitPreflightNoRules = vi.fn();
vi.mock("../../../src/activation/notice.js", () => ({
  admitRawSenderRejection: (...args: unknown[]): unknown => mockAdmitRawSenderRejection(...args),
  admitPreflightNoRules: (...args: unknown[]): unknown => mockAdmitPreflightNoRules(...args),
}));

const WORKER_SECRET = "test-worker-secret-32chars-abcde";

const TEST_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/attachments",
  attachmentTtlHours: 24,
  rawEmailDir: "/tmp/rawemails",
  rawEmailTtlHours: 24,
  maxSizeBytes: 1024 * 1024,
  maxInflightDeliveries: 100,
  adminEnabled: false,
  adminSecret: undefined,
  adminSessionSecret: undefined,
  nodeEnv: "test",
  adminSessionTtlMinutes: 60,
};

async function buildApp(botHealthy = true, configOverride: Partial<typeof TEST_CONFIG> = {}) {
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
  await registerRoutes(app, { ...TEST_CONFIG, ...configOverride });
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
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      createdBy: 1n,
    });
    mockFindAliasByDomain.mockReset();
    mockFindAliasByDomain.mockImplementation((...args: unknown[]) => {
      void args[2];
      return Promise.resolve(mockFindAlias(args[0], args[1]));
    });
    mockFindInboundDomain.mockReset();
    mockFindInboundDomain.mockResolvedValue({
      id: "domain-1",
      domain: "mail.example.com",
      kind: "shared",
      status: "active",
    });
    mockCheckAllow.mockReset();
    mockCheckAllow.mockResolvedValue(true);
    mockClaimWorkerRequestNonce.mockReset();
    mockClaimWorkerRequestNonce.mockResolvedValue(true);
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
    applyPlanLimitOverrides({});
  });

  it("returns 200 with accept:true for an active alias", async () => {
    mockFindAlias.mockResolvedValue({ id: "uuid-1", status: "active", localPart: "alerts" });

    const body = Buffer.from(
      JSON.stringify({ localPart: "alerts", envelopeFrom: "sender@example.com" }),
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

  it("returns accept:false when the alias has no allow rules", async () => {
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
    expect(mockCheckAllow).toHaveBeenCalledWith(expect.anything(), "uuid-1");
    // The owner hears why: the no-rules notice is admitted after the answer.
    expect(mockAdmitPreflightNoRules).toHaveBeenCalledWith("uuid-1");
  });

  it("defers with 429 once the alias hourly cap has been reached", async () => {
    resetMetricsForTests();
    mockIncrementUserUsageMonth.mockClear();
    mockNotifyQuotaExhausted.mockClear();
    applyPlanLimitOverrides({ free: { aliasEmailsPerHour: 2 } });
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      createdBy: 1n,
    });
    mockCheckAllow.mockResolvedValue(true);
    mockCountRecentDeliveries.mockResolvedValue(2);
    const infoSpy = vi.spyOn(getLogger(), "info");

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

    // Non-2xx, not {accept:false}: the Worker must throw (temporary SMTP
    // failure) instead of bouncing with a permanent 550.
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "rate limited" });
    expect(mockIncrementUserUsageMonth).not.toHaveBeenCalled();
    expect(mockNotifyQuotaExhausted).not.toHaveBeenCalled();

    // The Worker logs this and the per-IP limit alike ("preflight non-2xx
    // 429"); only this app log line tells them apart. No sender data.
    const deferred = infoSpy.mock.calls.find(([, msg]) => msg === "inbound.preflight.deferred");
    infoSpy.mockRestore();
    expect(deferred?.[0]).toEqual({ localPart: "alerts", aliasId: "uuid-1", userId: "1" });

    // A deferral, not a bounce: the sender retries, nothing is lost.
    const metrics = await metricsRegistry.metrics();
    expect(
      findMetricLine(metrics, "email_to_telegram_inbound_preflight_total", [
        'result="deferred"',
        'reason="rate_limited"',
      ]),
    ).toBeDefined();
    expect(
      findMetricLine(metrics, "email_to_telegram_inbound_preflight_total", ['result="rejected"']),
    ).toBeUndefined();
  });

  it("uses one resolved plan for the quota check and the hourly cap", async () => {
    const pro = getPlanDefinition("pro");
    const snapshot = {
      hosted: true,
      user: { id: 1n },
      plan: { ...pro, limits: { ...pro.limits, aliasEmailsPerHour: 2 } },
    };
    // Only the first resolution gets the snapshot; a second one would see the
    // free plan's 60 and accept.
    mockResolveInboundPlan.mockReset();
    mockResolveInboundPlan.mockResolvedValueOnce(snapshot);
    mockCheckInboundLimit.mockClear();
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      createdBy: 1n,
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

    expect(res.statusCode).toBe(429);
    expect(mockResolveInboundPlan).toHaveBeenCalledOnce();
    expect(mockResolveInboundPlan.mock.calls[0]?.[1]).toBe(1n);
    expect(mockCheckInboundLimit.mock.calls[0]?.[1]).toBe(snapshot);
  });

  it("returns accept:false and logs the block when the hosted blocklist matches", async () => {
    process.env["APP_MODE"] = "hosted";
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      createdBy: 1n,
    });
    mockFindHostedInboundBlock.mockResolvedValueOnce({
      id: "block-1",
      blockType: "sender_domain",
      value: "attacker.com",
      reason: "abuse",
      createdAt: new Date(),
    });
    resetMetricsForTests();
    const infoSpy = vi.spyOn(getLogger(), "info");

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
    expect(res.json()).toEqual({ accept: false });
    const rejected = infoSpy.mock.calls.find(([, msg]) => msg === "inbound.preflight.rejected");
    infoSpy.mockRestore();
    expect(rejected?.[0]).toEqual({
      localPart: "alerts",
      aliasId: "uuid-1",
      userId: "1",
      blockType: "sender_domain",
      blockId: "block-1",
    });
    const metrics = await metricsRegistry.metrics();
    expect(
      findMetricLine(metrics, "email_to_telegram_inbound_preflight_total", [
        'result="rejected"',
        'reason="hosted_blocklist"',
      ]),
    ).toBeDefined();
  });

  it("bounces a plan-limit rejection, counting it and notifying the owner", async () => {
    resetMetricsForTests();
    mockIncrementUserUsageMonth.mockClear();
    mockNotifyQuotaExhausted.mockClear();
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      createdBy: 1n,
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
    expect(res.json()).toEqual({ accept: false });
    // Counted and notified against the month the check used.
    const [, counted] = mockIncrementUserUsageMonth.mock.calls[0] as [
      unknown,
      { userId: bigint; month: string; rejectedCount: number },
    ];
    expect(counted).toMatchObject({ userId: 1n, rejectedCount: 1 });
    expect(mockCheckInboundLimit.mock.calls[0]?.[4]).toBe(counted.month);
    expect(mockNotifyQuotaExhausted).toHaveBeenCalledWith(
      expect.anything(),
      null,
      1n,
      "monthly_email_limit",
      counted.month,
    );
    const metrics = await metricsRegistry.metrics();
    expect(
      findMetricLine(metrics, "email_to_telegram_inbound_preflight_total", [
        'result="rejected"',
        'reason="monthly_email_limit"',
      ]),
    ).toBeDefined();
  });

  it("still bounces and notifies when the rejection counter fails", async () => {
    mockIncrementUserUsageMonth.mockClear();
    mockIncrementUserUsageMonth.mockRejectedValueOnce(new Error("db down"));
    mockNotifyQuotaExhausted.mockClear();
    mockCheckInboundLimit.mockResolvedValueOnce({ ok: false, code: "subscription_inactive" });
    const warnSpy = vi.spyOn(getLogger(), "warn");

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
    expect(res.json()).toEqual({ accept: false });
    expect(warnSpy.mock.calls.map(([, msg]) => msg)).toContain("quota.rejection.count_failed");
    warnSpy.mockRestore();
    expect(mockNotifyQuotaExhausted).toHaveBeenCalledOnce();
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
    mockClaimWorkerRequestNonce.mockReset();
    mockClaimWorkerRequestNonce.mockResolvedValue(true);
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
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      status: "active",
      localPart: "alerts",
      createdBy: 1n,
    });
    mockFindAliasByDomain.mockReset();
    mockFindAliasByDomain.mockImplementation((...args: unknown[]) => {
      void args[2];
      return Promise.resolve(mockFindAlias(args[0], args[1]));
    });
    mockFindInboundDomain.mockReset();
    mockFindInboundDomain.mockResolvedValue({
      id: "domain-1",
      domain: "mail.example.com",
      kind: "shared",
      status: "active",
    });
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
    resetMetricsForTests();
  });

  afterEach(() => {
    restoreEnv("WORKER_SECRET", savedSecret);
    restoreEnv("APP_MODE", savedAppMode);
  });

  it("returns 202 for a valid signed raw email", async () => {
    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const routing = {
      localPart: "alerts",
      recipientDomain: "mail.example.com",
      envelopeFrom: "sender@example.com",
    };
    const { signature, timestamp } = signWorkerRequest(rawEmail, routing);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": "v2",
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
        "x-recipient-domain": "mail.example.com",
      },
      payload: rawEmail,
    });
    expect(res.statusCode).toBe(202);
    const [, queuedInput] = mockQueueInboundEmail.mock.calls[0] as [
      unknown,
      {
        rawEmail: Buffer;
        localPart: string;
        recipientDomain: string;
        envelopeFrom: string;
        rawEmailEncryption: { encryptionMode: string };
      },
    ];
    expect(queuedInput.rawEmail).toEqual(rawEmail);
    expect(queuedInput.localPart).toBe("alerts");
    expect(queuedInput.recipientDomain).toBe("mail.example.com");
    expect(queuedInput.envelopeFrom).toBe("sender@example.com");
    expect(queuedInput.rawEmailEncryption).toMatchObject({ encryptionMode: "none" });
    expect(mockWritePendingRawEmailMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        localPart: "alerts",
        recipientDomain: "mail.example.com",
        envelopeFrom: "sender@example.com",
      }),
    );
    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledOnce();
    const metrics = await metricsRegistry.metrics();
    expect(
      findMetricLine(metrics, "email_to_telegram_raw_inbound_total", [
        'result="accepted"',
        'reason="accepted"',
      ]),
    ).toBeDefined();
  });

  it("rejects v2 raw uploads when signed routing headers are tampered", async () => {
    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail, {
      localPart: "alerts",
      recipientDomain: "mail.example.com",
      envelopeFrom: "sender@example.com",
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": "v2",
        "x-worker-ts": timestamp,
        "x-envelope-from": "trusted@github.com",
        "x-local-part": "billing",
        "x-recipient-domain": "mail.example.com",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(401);
    expect(mockWriteRawEmail).not.toHaveBeenCalled();
  });

  it("rejects replayed raw upload signatures", async () => {
    mockClaimWorkerRequestNonce.mockResolvedValueOnce(false);
    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail, {
      localPart: "alerts",
      recipientDomain: "mail.example.com",
      envelopeFrom: "sender@example.com",
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": "v2",
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
        "x-recipient-domain": "mail.example.com",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(401);
    expect(mockWriteRawEmail).not.toHaveBeenCalled();
  });

  it("rejects raw uploads without the v2 signature version", async () => {
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

    expect(res.statusCode).toBe(401);
    expect(mockClaimWorkerRequestNonce).not.toHaveBeenCalled();
    expect(mockWriteRawEmail).not.toHaveBeenCalled();
    const metrics = await metricsRegistry.metrics();
    expect(
      findMetricLine(metrics, "email_to_telegram_raw_inbound_total", [
        'result="rejected"',
        'reason="unsupported_signature_version"',
      ]),
    ).toBeDefined();
  });

  it("does not acknowledge raw mail before durable persistence succeeds", async () => {
    mockWriteRawEmail.mockRejectedValueOnce(new Error("disk full"));

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail, { localPart: "alerts" });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": "v2",
        "x-worker-ts": timestamp,
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(500);
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
  });

  async function postRaw(rawEmail: Buffer) {
    const { signature, timestamp } = signWorkerRequest(rawEmail, {
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
    });
    const app = await buildApp();
    return app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": "v2",
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });
  }

  const RAW = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");

  it("hands an accepted mail to the tracker under its log id and warns with the queue's usage", async () => {
    mockQueueInboundEmail.mockResolvedValue({
      queued: true,
      job: { deliveryLog: { id: "log-accepted", userId: 7n } },
      usage: { month: "2026-04", deliveredCount: 42 },
    });
    // Not running the delivery shows the route starts it only through the tracker.
    const runFor = vi.spyOn(pipelineTracker, "runFor").mockResolvedValue(undefined);
    mockNotifyApproachingMonthlyLimit.mockClear();
    try {
      const res = await postRaw(RAW);

      expect(res.statusCode).toBe(202);
      expect(runFor).toHaveBeenCalledWith("log-accepted", expect.any(Function));
      expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
      // The post-increment count from the queue, not a re-read.
      expect(mockNotifyApproachingMonthlyLimit).toHaveBeenCalledWith(
        expect.anything(),
        null, // no bot API in tests
        7n,
        "2026-04",
        42,
      );
    } finally {
      runFor.mockRestore();
    }
  });

  it.each([
    ["storage_limit", 403, true],
    ["monthly_email_limit", 403, true],
    ["message_size_limit", 413, false],
  ] as const)(
    "answers a %s precheck with %i before storing, counting only quota reasons",
    async (code, status, counts) => {
      mockIncrementUserUsageMonth.mockClear();
      mockNotifyQuotaExhausted.mockClear();
      mockCheckInboundLimit.mockResolvedValueOnce({ ok: false, code });

      const res = await postRaw(RAW);

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: "rejected" });
      // The raw length is both the message size and the storage delta.
      expect(mockCheckInboundLimit.mock.calls[0]?.slice(2, 4)).toEqual([
        RAW.length,
        BigInt(RAW.length),
      ]);
      expect(mockWriteRawEmail).not.toHaveBeenCalled();
      expect(mockQueueInboundEmail).not.toHaveBeenCalled();
      const month = mockCheckInboundLimit.mock.calls[0]?.[4] as string;
      if (counts) {
        expect(mockIncrementUserUsageMonth).toHaveBeenCalledWith(expect.anything(), {
          userId: 1n,
          month,
          rejectedCount: 1,
        });
        expect(mockNotifyQuotaExhausted).toHaveBeenCalledWith(
          expect.anything(),
          null,
          1n,
          code,
          month,
        );
      } else {
        expect(mockIncrementUserUsageMonth).not.toHaveBeenCalled();
        expect(mockNotifyQuotaExhausted).not.toHaveBeenCalled();
      }
      const metrics = await metricsRegistry.metrics();
      expect(
        findMetricLine(metrics, "email_to_telegram_raw_inbound_total", [
          'result="rejected"',
          `reason="${code}"`,
        ]),
      ).toBeDefined();
    },
  );

  it("returns 403 when hosted blocklist matches before raw persistence", async () => {
    process.env["APP_MODE"] = "hosted";
    mockFindHostedInboundBlock.mockResolvedValueOnce({
      id: "block-1",
      blockType: "recipient_domain",
      value: "mail.example.com",
      createdAt: new Date(),
    });
    const infoSpy = vi.spyOn(getLogger(), "info");

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail, {
      localPart: "alerts",
      recipientDomain: "mail.example.com",
      envelopeFrom: "sender@example.com",
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": "v2",
        "x-worker-ts": timestamp,
        "x-envelope-from": "sender@example.com",
        "x-local-part": "alerts",
        "x-recipient-domain": "mail.example.com",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "rejected" });
    const rejected = infoSpy.mock.calls.find(([, msg]) => msg === "inbound.raw.rejected");
    infoSpy.mockRestore();
    expect(rejected?.[0]).toEqual({
      localPart: "alerts",
      aliasId: "uuid-1",
      userId: "1",
      blockType: "recipient_domain",
      blockId: "block-1",
    });
    expect(mockWriteRawEmail).not.toHaveBeenCalled();
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
  });

  it("returns 403 before raw persistence when the alias is missing", async () => {
    mockFindAlias.mockResolvedValue(null);

    const res = await postRaw(RAW);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "rejected" });
    expect(mockWriteRawEmail).not.toHaveBeenCalled();
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
    const metrics = await metricsRegistry.metrics();
    expect(
      findMetricLine(metrics, "email_to_telegram_raw_inbound_total", [
        'result="rejected"',
        'reason="alias_not_found"',
      ]),
    ).toBeDefined();
  });

  // Every queue reason answers and keeps or drops the stored mail as its
  // policy row says; the rows themselves are pinned in the Postgres suite.
  it.each([...Object.keys(REJECTION_POLICY), undefined])(
    "translates a queue rejection (%s) through its policy",
    async (reason) => {
      mockQueueInboundEmail.mockResolvedValueOnce({ queued: false, result: { ok: false, reason } });
      const policy = rejectionPolicy(reason);

      const res = await postRaw(RAW);

      expect(res.statusCode).toBe(policy.rawStatus);
      expect(res.json()).toEqual(
        policy.rawStatus === 202 ? { status: "accepted" } : { error: "rejected" },
      );
      const deleted = policy.deleteLive ? 1 : 0;
      expect(mockDeleteFile).toHaveBeenCalledTimes(deleted);
      expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledTimes(deleted);
      if (policy.deleteLive) {
        // The .eml goes first: a stale .pending.json alone is harmless.
        expect(mockDeleteFile.mock.invocationCallOrder[0]).toBeLessThan(
          mockDeletePendingRawEmailMeta.mock.invocationCallOrder[0] ?? 0,
        );
      }
      expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
      const metrics = await metricsRegistry.metrics();
      expect(
        findMetricLine(metrics, "email_to_telegram_raw_inbound_total", [
          'result="rejected"',
          `reason="${reason ?? "unknown"}"`,
        ]),
      ).toBeDefined();
      expect(
        findMetricLine(metrics, "email_to_telegram_raw_inbound_total", ['result="accepted"']),
      ).toBeUndefined();
    },
  );

  it("still answers when deleting a rejected mail's files fails", async () => {
    mockQueueInboundEmail.mockResolvedValueOnce({
      queued: false,
      result: { ok: false, reason: "duplicate" },
    });
    mockDeleteFile.mockRejectedValueOnce(new Error("EIO"));
    mockDeletePendingRawEmailMeta.mockRejectedValueOnce(new Error("EIO"));

    const res = await postRaw(RAW);

    expect(res.statusCode).toBe(202);
    expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledOnce();
  });

  it("notifies a queue quota rejection with the queue's owner and month, without counting", async () => {
    mockIncrementUserUsageMonth.mockClear();
    mockNotifyQuotaExhausted.mockClear();
    mockQueueInboundEmail.mockResolvedValueOnce({
      queued: false,
      result: { ok: false, reason: "subscription_inactive", userId: 9n, month: "2026-10" },
    });

    const res = await postRaw(RAW);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "rejected" });
    // The queue already counted it inside its transaction.
    expect(mockIncrementUserUsageMonth).not.toHaveBeenCalled();
    expect(mockNotifyQuotaExhausted).toHaveBeenCalledWith(
      expect.anything(),
      null,
      9n,
      "subscription_inactive",
      "2026-10",
    );
  });

  it("falls back to the route's owner and the current month when the queue gives none", async () => {
    mockNotifyQuotaExhausted.mockClear();
    mockQueueInboundEmail.mockResolvedValueOnce({
      queued: false,
      result: { ok: false, reason: "storage_limit" },
    });

    const res = await postRaw(RAW);

    expect(res.statusCode).toBe(403);
    expect(mockNotifyQuotaExhausted).toHaveBeenCalledWith(
      expect.anything(),
      null,
      1n,
      "storage_limit",
      expect.stringMatching(/^\d{4}-\d{2}$/),
    );
  });

  it("cleans up the raw email when pending metadata persistence fails", async () => {
    mockWritePendingRawEmailMeta.mockRejectedValueOnce(new Error("fs exploded"));

    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail, { localPart: "alerts" });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": "v2",
        "x-worker-ts": timestamp,
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(500);
    expect(mockDeleteFile).toHaveBeenCalledOnce();
    expect(mockQueueInboundEmail).not.toHaveBeenCalled();
  });

  // Identical answers for both sender rejections: a 202/403 split would tell
  // a prober which From domains the alias allows.
  it.each(["sender_not_allowed", "sender_auth_failed"])(
    "rejects %s with 403 and drops the stored raw email",
    async (reason) => {
      mockAdmitRawSenderRejection.mockClear();
      mockQueueInboundEmail.mockResolvedValueOnce({
        queued: false,
        result: {
          ok: false,
          reason,
          ...(reason === "sender_not_allowed"
            ? { senderRejection: { aliasId: "uuid-from-queue", headerFromDomain: "example.com" } }
            : {}),
        },
      });

      const rawEmail = Buffer.from("From: blocked@example.com\r\nSubject: Hi\r\n\r\nBody");
      const { signature, timestamp } = signWorkerRequest(rawEmail, { localPart: "alerts" });

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/inbound/raw",
        headers: {
          "content-type": "application/octet-stream",
          "x-worker-sig": signature,
          "x-worker-sig-v": "v2",
          "x-worker-ts": timestamp,
          "x-local-part": "alerts",
        },
        payload: rawEmail,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "rejected" });
      expect(mockDeleteFile).toHaveBeenCalledOnce();
      expect(mockDeletePendingRawEmailMeta).toHaveBeenCalledOnce();
      expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
      // Only a rule mismatch tells the owner; an authentication failure does not.
      if (reason === "sender_not_allowed") {
        expect(mockAdmitRawSenderRejection).toHaveBeenCalledWith({
          aliasId: "uuid-from-queue",
          headerFromDomain: "example.com",
          envelopeFrom: null,
          rawMime: rawEmail,
        });
      } else {
        expect(mockAdmitRawSenderRejection).not.toHaveBeenCalled();
      }

      const metrics = await metricsRegistry.metrics();
      expect(
        findMetricLine(metrics, "email_to_telegram_raw_inbound_total", [
          'result="rejected"',
          `reason="${reason}"`,
        ]),
      ).toBeDefined();
      expect(
        findMetricLine(metrics, "email_to_telegram_raw_inbound_total", ['result="accepted"']),
      ).toBeUndefined();
    },
  );

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

  it("defers immediate delivery to the retry worker once the in-flight cap is reached", async () => {
    // maxInflightDeliveries: 0 forces every accepted email past the cap, so the
    // route still acks 202 but does not dispatch deliverQueuedEmail itself.
    const rawEmail = Buffer.from("From: test@example.com\r\nSubject: Hi\r\n\r\nBody");
    const { signature, timestamp } = signWorkerRequest(rawEmail, {
      localPart: "alerts",
      recipientDomain: "mail.example.com",
    });

    const app = await buildApp(true, { maxInflightDeliveries: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": "v2",
        "x-worker-ts": timestamp,
        "x-local-part": "alerts",
        "x-recipient-domain": "mail.example.com",
      },
      payload: rawEmail,
    });

    expect(res.statusCode).toBe(202);
    expect(mockDeliverQueuedEmail).not.toHaveBeenCalled();
    const metrics = await metricsRegistry.metrics();
    expect(
      findMetricLine(metrics, "email_to_telegram_deliveries_deferred_total", []),
    ).toBeDefined();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// Known label sets are pre-initialised to 0, so a series merely existing
// proves nothing: only a non-zero sample counts as recorded.
function findMetricLine(metrics: string, name: string, labels: string[]): string | undefined {
  return metrics
    .split("\n")
    .find(
      (line) =>
        line.startsWith(name) &&
        labels.every((label) => line.includes(label)) &&
        Number(line.slice(line.lastIndexOf(" ") + 1)) > 0,
    );
}
