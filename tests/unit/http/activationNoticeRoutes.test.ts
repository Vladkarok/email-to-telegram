/**
 * Wire-response invariance: the first-bounce notice path runs after the
 * inbound response is sent, so status, headers and body are identical with
 * the path on, off, throwing or saturated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { registerRoutes, type RouteConfig } from "../../../src/http/routes/index.js";
import { signWorkerRequest } from "../../../src/utils/workerAuth.js";
import { markBotHealthy } from "../../../src/telegram/health.js";
import { resetMetricsForTests } from "../../../src/observability/metrics.js";
import {
  ActivationNoticeQueue,
  type ActivationNoticeJob,
} from "../../../src/activation/noticeQueue.js";
import { NOTICE_BOUNDS } from "../../../src/activation/bounds.js";
import { setActivationNoticeQueue } from "../../../src/activation/notice.js";

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../src/telegram/api.js", () => ({ getApi: vi.fn(() => null) }));

const mockQueueInboundEmail = vi.fn();
vi.mock("../../../src/email/pipeline.js", () => ({
  queueInboundEmail: (...args: unknown[]): unknown => mockQueueInboundEmail(...args),
  deliverQueuedEmail: vi.fn(),
}));
vi.mock("../../../src/storage/disk.js", () => ({
  writeRawEmail: vi.fn().mockResolvedValue({
    encryptionMode: "none",
    wrappedDek: null,
    kekKeyId: null,
    encryptedAt: null,
  }),
  writePendingRawEmailMeta: vi.fn().mockResolvedValue(undefined),
  deletePendingRawEmailMeta: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: vi.fn().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    status: "active",
    localPart: "alerts",
    createdBy: 1n,
  }),
  findAliasByLocalPartAndDomainId: vi.fn(),
}));
vi.mock("../../../src/db/repos/inboundDomains.js", () => ({
  findInboundDomainByDomain: vi.fn().mockResolvedValue(null),
}));
const mockCheckAllow = vi.fn();
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  checkPreflightAllowRules: (...args: unknown[]): unknown => mockCheckAllow(...args),
}));
vi.mock("../../../src/db/repos/workerRequestNonces.js", () => ({
  claimWorkerRequestNonce: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  countRecentDeliveriesByAlias: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../../src/billing/limits.js", async () => {
  const { getPlanDefinition } = await import("../../../src/billing/plans.js");
  return {
    checkInboundLimit: vi.fn().mockResolvedValue({ ok: true }),
    checkInboundLimitForPlan: vi.fn().mockResolvedValue({ ok: true }),
    resolveInboundPlan: vi.fn(() =>
      Promise.resolve({ hosted: false, user: null, plan: getPlanDefinition("free") }),
    ),
  };
});
vi.mock("../../../src/db/repos/hostedInboundBlocks.js", () => ({
  findHostedInboundBlock: vi.fn().mockResolvedValue(null),
}));

const WORKER_SECRET = "test-worker-secret-32chars-abcde";
const ALIAS_ID = "11111111-1111-4111-8111-111111111111";

const CONFIG: RouteConfig = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/attachments",
  attachmentTtlHours: 24,
  rawEmailDir: "/tmp/rawemails",
  rawEmailTtlHours: 24,
  maxSizeBytes: 1024 * 1024,
  maxInflightDeliveries: 100,
  telegramRichMessagesEnabled: true,
  adminEnabled: false,
  adminSecret: undefined,
  adminSessionSecret: undefined,
  nodeEnv: "test",
  adminSessionTtlMinutes: 60,
};

const order: string[] = [];

async function buildApp(): Promise<FastifyInstance> {
  markBotHealthy();
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );
  app.addHook("onSend", (_req, _reply, payload, done) => {
    order.push("response");
    done(null, payload);
  });
  await registerRoutes(app, CONFIG);
  return app;
}

async function rawBounce(app: FastifyInstance): Promise<LightMyRequestResponse> {
  mockQueueInboundEmail.mockResolvedValueOnce({
    queued: false,
    result: {
      ok: false,
      reason: "sender_not_allowed",
      senderRejection: { aliasId: ALIAS_ID, headerFromDomain: "github.com" },
    },
  });
  const rawEmail = Buffer.from("From: noreply@github.com\r\nSubject: Hi\r\n\r\nBody");
  const { signature, timestamp } = signWorkerRequest(rawEmail, { localPart: "alerts" });
  return app.inject({
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
}

async function preflightBounce(app: FastifyInstance): Promise<LightMyRequestResponse> {
  mockCheckAllow.mockResolvedValueOnce(false);
  const body = Buffer.from(JSON.stringify({ localPart: "alerts", envelopeFrom: "b@x.example" }));
  const { signature, timestamp } = signWorkerRequest(body);
  return app.inject({
    method: "POST",
    url: "/inbound/preflight",
    headers: {
      "content-type": "application/json",
      "x-worker-sig": signature,
      "x-worker-ts": timestamp,
    },
    payload: body,
  });
}

function wire(res: LightMyRequestResponse) {
  const { date: _date, ...headers } = res.headers;
  return { status: res.statusCode, headers, body: res.body };
}

type Mode = "off" | "on" | "throwing" | "admit-throws" | "saturated";

async function installQueue(mode: Mode): Promise<{ jobs: ActivationNoticeJob[] }> {
  const jobs: ActivationNoticeJob[] = [];
  switch (mode) {
    case "off": {
      const queue = new ActivationNoticeQueue(() => Promise.resolve("sent"));
      await queue.shutdown();
      setActivationNoticeQueue(queue);
      break;
    }
    case "on": {
      const queue = new ActivationNoticeQueue((job) => {
        order.push("notice");
        jobs.push(job);
        return Promise.resolve("sent");
      });
      const admit = queue.admit.bind(queue);
      vi.spyOn(queue, "admit").mockImplementation((request) => {
        order.push("admit");
        return admit(request);
      });
      setActivationNoticeQueue(queue);
      break;
    }
    case "throwing": {
      setActivationNoticeQueue(
        new ActivationNoticeQueue(() => {
          throw new Error("notice path exploded");
        }),
      );
      break;
    }
    case "admit-throws": {
      setActivationNoticeQueue({
        admit: () => {
          throw new Error("admission exploded");
        },
      } as unknown as ActivationNoticeQueue);
      break;
    }
    case "saturated": {
      const queue = new ActivationNoticeQueue(() => new Promise(() => {}), {
        ...NOTICE_BOUNDS,
        maxAdmittedJobs: 1,
      });
      queue.admit({
        stage: "raw",
        aliasId: ALIAS_ID,
        headerFromDomain: null,
        envelopeFrom: null,
        rawMime: null,
      });
      setActivationNoticeQueue(queue);
      break;
    }
  }
  return { jobs };
}

describe("inbound wire responses with the first-bounce notice path", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["WORKER_SECRET"];
    process.env["WORKER_SECRET"] = WORKER_SECRET;
    order.length = 0;
    resetMetricsForTests();
  });

  afterEach(() => {
    setActivationNoticeQueue(null);
    if (savedSecret === undefined) delete process.env["WORKER_SECRET"];
    else process.env["WORKER_SECRET"] = savedSecret;
  });

  const modes: Mode[] = ["on", "throwing", "admit-throws", "saturated"];

  it.each([
    ["raw sender_not_allowed", rawBounce],
    ["preflight with no rules", preflightBounce],
  ])("%s: identical status, headers and body in every mode", async (_label, bounce) => {
    await installQueue("off");
    const baseline = wire(await bounce(await buildApp()));

    for (const mode of modes) {
      await installQueue(mode);
      const res = await bounce(await buildApp());
      expect({ mode, ...wire(res) }).toEqual({ mode, ...baseline });
    }
    expect(baseline.status).toBe(bounce === rawBounce ? 403 : 200);
  });

  it("admits the raw job after the response, with only the fields the job needs", async () => {
    const { jobs } = await installQueue("on");
    const res = await rawBounce(await buildApp());
    expect(res.statusCode).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(order).toEqual(["response", "admit", "notice"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      stage: "raw",
      aliasId: ALIAS_ID,
      headerFromDomain: "github.com",
      envelopeFrom: null,
    });
    expect(jobs[0].mime?.toString()).toContain("From: noreply@github.com");
  });

  it("admits the preflight job after the response", async () => {
    const { jobs } = await installQueue("on");
    const res = await preflightBounce(await buildApp());
    expect(res.json()).toEqual({ accept: false });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(order).toEqual(["response", "admit", "notice"]);
    expect(jobs[0]).toMatchObject({ stage: "preflight", aliasId: ALIAS_ID, mime: null });
  });
});
