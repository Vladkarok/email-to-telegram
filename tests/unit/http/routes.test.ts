import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";
import { signWorkerRequest } from "../../../src/utils/workerAuth.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../src/email/pipeline.js", () => ({
  processInboundEmail: vi.fn(() => Promise.resolve({ ok: true })),
}));

const mockFindAlias = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: (...args: unknown[]): unknown => mockFindAlias(...args),
}));

const mockCheckAllow = vi.fn();
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  checkAllowRule: (...args: unknown[]): unknown => mockCheckAllow(...args),
}));

const WORKER_SECRET = "test-worker-secret-32chars-abcde";

const TEST_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/attachments",
  attachmentTtlHours: 24,
};

async function buildApp() {
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
    mockFindAlias.mockReset();
    mockCheckAllow.mockReset();
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
});

describe("POST /inbound/raw", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["WORKER_SECRET"];
    process.env["WORKER_SECRET"] = WORKER_SECRET;
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
        "x-local-part": "alerts",
      },
      payload: rawEmail,
    });
    expect(res.statusCode).toBe(202);
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
