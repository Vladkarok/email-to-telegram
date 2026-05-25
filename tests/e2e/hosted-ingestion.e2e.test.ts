import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  alias: {
    id: "alias-1",
    localPart: "alerts",
    fullAddress: "alerts@example.com",
    createdBy: 1n,
    domainId: "domain-1",
    chatId: 123n,
    messageThreadId: null,
    status: "active",
    renderMode: "plaintext",
    privacyModeEnabled: false,
    bodyDedupEnabled: false,
    maxEmailsHour: 60,
  },
  allow: true,
  hostedInboundBlock: null as Record<string, unknown> | null,
  inboundLimitResults: [] as Array<{ ok: boolean; code?: string }>,
  deliveryLogs: [] as Array<Record<string, unknown>>,
  deliveryAttempts: [] as Array<Record<string, unknown>>,
  attachments: [] as Array<Record<string, unknown>>,
  attachmentLinks: [] as Array<Record<string, unknown>>,
  usage: { deliveredCount: 0, rejectedCount: 0 },
  storage: { rawEmailBytes: 0n, attachmentBytes: 0n },
  telegramMessages: [] as Array<Record<string, unknown>>,
};

function resetState(): void {
  state.allow = true;
  state.hostedInboundBlock = null;
  state.inboundLimitResults = [];
  state.deliveryLogs = [];
  state.deliveryAttempts = [];
  state.attachments = [];
  state.attachmentLinks = [];
  state.usage = { deliveredCount: 0, rejectedCount: 0 };
  state.storage = { rawEmailBytes: 0n, attachmentBytes: 0n };
  state.telegramMessages = [];
}

const fakeDb = {
  transaction: async <T>(fn: (tx: { execute: ReturnType<typeof vi.fn> }) => Promise<T>) =>
    fn({ execute: vi.fn().mockResolvedValue(undefined) }),
} as Record<string, unknown>;

vi.mock("../../src/db/client.js", () => ({
  getDb: vi.fn(() => fakeDb),
}));

vi.mock("../../src/telegram/api.js", () => ({
  getApi: vi.fn(() => ({ token: "test-api" })),
}));

vi.mock("../../src/db/repos/aliases.js", () => ({
  findAliasById: vi.fn((_db: unknown, id: string) =>
    Promise.resolve(id === state.alias.id ? { ...state.alias } : null),
  ),
  findAliasByLocalPart: vi.fn((_db: unknown, localPart: string) =>
    Promise.resolve(localPart === state.alias.localPart ? { ...state.alias } : null),
  ),
  findAliasByLocalPartAndDomainId: vi.fn((_db: unknown, localPart: string, domainId: string) =>
    Promise.resolve(
      localPart === state.alias.localPart && domainId === state.alias.domainId
        ? { ...state.alias }
        : null,
    ),
  ),
}));

vi.mock("../../src/db/repos/inboundDomains.js", () => ({
  findInboundDomainByDomain: vi.fn((_db: unknown, domain: string) =>
    Promise.resolve(
      domain.toLowerCase() === "example.com"
        ? {
            id: "domain-1",
            domain: "example.com",
            kind: "shared",
            status: "active",
          }
        : null,
    ),
  ),
}));

vi.mock("../../src/db/repos/allowRules.js", () => ({
  checkAllowRule: vi.fn(() => Promise.resolve(state.allow)),
}));

vi.mock("../../src/db/repos/hostedInboundBlocks.js", () => ({
  findHostedInboundBlock: vi.fn(() => Promise.resolve(state.hostedInboundBlock)),
}));

vi.mock("../../src/db/repos/workerRequestNonces.js", () => ({
  claimWorkerRequestNonce: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../src/email/dedup.js", () => ({
  isDuplicate: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("../../src/db/repos/deliveryLogs.js", async () => {
  const actual = await vi.importActual<object>("../../src/db/repos/deliveryLogs.js");
  return {
    ...actual,
    createDeliveryLog: vi.fn((_db: unknown, data: Record<string, unknown>) => {
      const log = {
        ...data,
        id: String(data["id"]),
        finalStatus: data["finalStatus"] ?? "received",
        receivedAt: new Date(),
      };
      state.deliveryLogs.push(log);
      return Promise.resolve(log);
    }),
    updateDeliveryLogStatus: vi.fn((_db: unknown, id: string, finalStatus: string) => {
      const log = state.deliveryLogs.find((entry) => entry["id"] === id);
      if (log) {
        log["finalStatus"] = finalStatus;
      }
      return Promise.resolve();
    }),
    markDeliveryLogProcessing: vi.fn((_db: unknown, id: string) => {
      const log = state.deliveryLogs.find((entry) => entry["id"] === id);
      if (log) {
        log["finalStatus"] = "processing";
        log["processingStartedAt"] = new Date();
      }
      return Promise.resolve();
    }),
    countRecentDeliveriesByAlias: vi.fn(() => Promise.resolve(0)),
  };
});

vi.mock("../../src/db/repos/deliveryAttempts.js", () => ({
  insertDeliveryAttempt: vi.fn((_db: unknown, data: Record<string, unknown>) => {
    state.deliveryAttempts.push(data);
    return Promise.resolve();
  }),
}));

vi.mock("../../src/db/repos/attachments.js", () => ({
  createAttachment: vi.fn((_db: unknown, data: Record<string, unknown>) => {
    state.attachments.push(data);
    return Promise.resolve(data);
  }),
}));

vi.mock("../../src/db/repos/attachmentLinks.js", () => ({
  createAttachmentLink: vi.fn(
    (_db: unknown, attachmentId: string, token: string, expiresAt: Date) => {
      state.attachmentLinks.push({ attachmentId, token, expiresAt });
      return Promise.resolve();
    },
  ),
}));

vi.mock("../../src/db/repos/deliveryViewLinks.js", () => ({
  createDeliveryViewLink: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/db/repos/usage.js", async () => {
  const actual = await vi.importActual<object>("../../src/db/repos/usage.js");
  return {
    ...actual,
    incrementUserUsageMonth: vi.fn(
      (_db: unknown, data: { deliveredCount?: number; rejectedCount?: number }) => {
        state.usage.deliveredCount += data.deliveredCount ?? 0;
        state.usage.rejectedCount += data.rejectedCount ?? 0;
        return Promise.resolve({
          userId: state.alias.createdBy,
          month: "2026-04",
          deliveredCount: state.usage.deliveredCount,
          rejectedCount: state.usage.rejectedCount,
          egressBytes: 0n,
        });
      },
    ),
  };
});

vi.mock("../../src/db/repos/storageUsage.js", () => ({
  getUserStorageUsage: vi.fn(() =>
    Promise.resolve({
      userId: state.alias.createdBy,
      rawEmailBytes: state.storage.rawEmailBytes,
      attachmentBytes: state.storage.attachmentBytes,
    }),
  ),
  incrementUserStorageUsage: vi.fn(
    (_db: unknown, _userId: bigint, data: { rawEmailBytes?: bigint; attachmentBytes?: bigint }) => {
      state.storage.rawEmailBytes += data.rawEmailBytes ?? 0n;
      state.storage.attachmentBytes += data.attachmentBytes ?? 0n;
      return Promise.resolve({
        userId: state.alias.createdBy,
        rawEmailBytes: state.storage.rawEmailBytes,
        attachmentBytes: state.storage.attachmentBytes,
      });
    },
  ),
  decrementUserStorageUsage: vi.fn(
    (_db: unknown, _userId: bigint, data: { rawEmailBytes?: bigint; attachmentBytes?: bigint }) => {
      state.storage.rawEmailBytes -= data.rawEmailBytes ?? 0n;
      state.storage.attachmentBytes -= data.attachmentBytes ?? 0n;
      if (state.storage.rawEmailBytes < 0n) state.storage.rawEmailBytes = 0n;
      if (state.storage.attachmentBytes < 0n) state.storage.attachmentBytes = 0n;
      return Promise.resolve({
        userId: state.alias.createdBy,
        rawEmailBytes: state.storage.rawEmailBytes,
        attachmentBytes: state.storage.attachmentBytes,
      });
    },
  ),
}));

vi.mock("../../src/billing/limits.js", async () => {
  const actual = await vi.importActual<object>("../../src/billing/limits.js");
  return {
    ...actual,
    checkInboundLimit: vi.fn(() => {
      const next = state.inboundLimitResults.shift();
      return Promise.resolve(next ?? { ok: true });
    }),
  };
});

vi.mock("../../src/telegram/sender.js", () => ({
  sendTelegramMessage: vi.fn((_api: unknown, data: Record<string, unknown>) => {
    state.telegramMessages.push(data);
    return Promise.resolve({ ok: true, telegramMessageId: 999 });
  }),
  sendTelegramPhotos: vi.fn(() => Promise.resolve({ ok: true, failedPhotos: [] })),
}));

const { createHttpServer } = await import("../../src/http/server.js");
const { pipelineTracker } = await import("../../src/utils/inFlight.js");
const workerModule = await import("../../cloudflare-worker/src/worker.ts");

interface TestEnv {
  WORKER_SECRET: string;
  VPS_URL: string;
}

interface TestMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream;
  rawSize: number;
  setReject: ReturnType<typeof vi.fn<(reason: string) => void>>;
  forward: ReturnType<typeof vi.fn<(rcptTo: string, headers?: Headers) => Promise<void>>>;
  reply: ReturnType<typeof vi.fn<(message: unknown) => Promise<void>>>;
}

interface TestContext {
  waitUntil: ReturnType<typeof vi.fn<(promise: Promise<unknown>) => void>>;
  passThroughOnException: ReturnType<typeof vi.fn<() => void>>;
}

const emailWorker = workerModule.default as unknown as {
  email(message: TestMessage, env: TestEnv, ctx: TestContext): Promise<void>;
};

const env: TestEnv = {
  WORKER_SECRET: "worker-secret-that-is-long-enough",
  VPS_URL: "https://mail.example.com",
};

function createMessage(rawEmail: string): TestMessage {
  const bytes = new TextEncoder().encode(rawEmail);
  return {
    from: "sender@example.com",
    to: "alerts@example.com",
    headers: new Headers({ "Authentication-Results": "mx.cloudflare.net; spf=pass" }),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
    setReject: vi.fn<(reason: string) => void>(),
    forward: vi.fn<(rcptTo: string, headers?: Headers) => Promise<void>>(() => Promise.resolve()),
    reply: vi.fn<(message: unknown) => Promise<void>>(() => Promise.resolve()),
  };
}

function createContext(): TestContext {
  return {
    waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
    passThroughOnException: vi.fn<() => void>(),
  };
}

function toRequestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("hosted ingestion e2e", () => {
  let rawEmailDir: string;
  let attachmentDir: string;
  let app: Awaited<ReturnType<typeof createHttpServer>>;

  beforeEach(async () => {
    resetState();
    process.env["APP_MODE"] = "hosted";
    process.env["WORKER_SECRET"] = env.WORKER_SECRET;
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
    rawEmailDir = await mkdtemp(join(tmpdir(), "email-to-telegram-e2e-raw-"));
    attachmentDir = await mkdtemp(join(tmpdir(), "email-to-telegram-e2e-att-"));
    app = await createHttpServer({
      publicBaseUrl: "https://mail.example.com",
      attachmentDir,
      attachmentTtlHours: 24,
      rawEmailDir,
      rawEmailTtlHours: 24,
      maxSizeBytes: 1024 * 1024,
    } as Parameters<typeof createHttpServer>[0]);

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(toRequestUrl(input));
      const body = init?.body as unknown;
      let payload: Buffer | string | undefined;
      if (body instanceof Uint8Array) {
        payload = Buffer.from(body);
      } else if (typeof body === "string") {
        payload = body;
      } else if (body instanceof ArrayBuffer) {
        payload = Buffer.from(body);
      }

      const response = await app.inject({
        method: init?.method ?? "GET",
        url: url.pathname,
        headers: init?.headers as Record<string, string>,
        payload,
      });
      const typedResponse = response as {
        body: string;
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
      };
      const responseBody = Buffer.from(typedResponse.body);
      const responseStatus = typedResponse.statusCode;
      const responseHeaders = Object.fromEntries(
        Object.entries(typedResponse.headers).map(([key, value]) => [key, String(value)]),
      );
      return new Response(responseBody, {
        status: responseStatus,
        headers: responseHeaders,
      });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env["APP_MODE"];
    await app.close();
    await rm(rawEmailDir, { recursive: true, force: true });
    await rm(attachmentDir, { recursive: true, force: true });
  });

  it("accepts a hosted message through worker, raw route, and async delivery", async () => {
    state.inboundLimitResults = [{ ok: true }, { ok: true }, { ok: true }];
    const message = createMessage(
      "From: sender@example.com\r\nTo: alerts@example.com\r\nSubject: Hi\r\nMessage-ID: <e2e-accepted@test>\r\n\r\nHello from E2E",
    );

    await emailWorker.email(message, env, createContext());
    await pipelineTracker.drain(5_000);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(state.telegramMessages).toHaveLength(1);
    expect(state.deliveryLogs).toHaveLength(1);
    expect(state.deliveryLogs[0]?.["finalStatus"]).toBe("delivered");
    expect(state.usage.deliveredCount).toBe(1);
    expect(state.storage.rawEmailBytes).toBeGreaterThan(0n);
    expect(state.deliveryAttempts).toHaveLength(1);
  });

  it("permanently rejects a hosted message when queue-time quota enforcement denies raw upload", async () => {
    state.inboundLimitResults = [{ ok: true }, { ok: true }, { ok: false, code: "storage_limit" }];
    const message = createMessage(
      "From: sender@example.com\r\nTo: alerts@example.com\r\nSubject: Reject\r\nMessage-ID: <e2e-rejected@test>\r\n\r\nThis should be rejected",
    );

    await emailWorker.email(message, env, createContext());

    expect(message.setReject).toHaveBeenCalledWith("550 Mailbox unavailable");
    expect(state.telegramMessages).toHaveLength(0);
    expect(state.deliveryLogs).toHaveLength(0);

    const rawDateDirs = await readdir(rawEmailDir);
    if (rawDateDirs.length > 0) {
      const storedFiles = await readdir(join(rawEmailDir, rawDateDirs[0] ?? ""));
      expect(storedFiles).toHaveLength(0);
    }
  });

  it("permanently rejects a hosted message when preflight blocklist matches", async () => {
    state.hostedInboundBlock = {
      id: "block-1",
      blockType: "sender_domain",
      value: "sender.example.com",
      reason: "abuse",
      createdAt: new Date(),
    };
    const message = createMessage(
      "From: sender@sender.example.com\r\nTo: alerts@example.com\r\nSubject: Blocked\r\nMessage-ID: <e2e-blocked@test>\r\n\r\nThis should not be uploaded",
    );
    message.from = "sender@sender.example.com";

    await emailWorker.email(message, env, createContext());

    expect(message.setReject).toHaveBeenCalledWith("550 Mailbox unavailable");
    expect(state.telegramMessages).toHaveLength(0);
    expect(state.deliveryLogs).toHaveLength(0);
    expect(state.usage.deliveredCount).toBe(0);

    const rawDateDirs = await readdir(rawEmailDir);
    expect(rawDateDirs).toHaveLength(0);
  });
});
