import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../../../cloudflare-worker/src/worker";

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

interface TestWorker {
  email(message: TestMessage, env: TestEnv, ctx: TestContext): Promise<void>;
}

const emailWorker = worker as unknown as TestWorker;

const env: TestEnv = {
  WORKER_SECRET: "worker-secret-that-is-long-enough",
  VPS_URL: "https://mail.example.com",
};

function createMessage(): TestMessage {
  const setReject = vi.fn<(reason: string) => void>();
  return {
    from: "sender@example.com",
    to: "alerts@example.com",
    headers: new Headers(),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("From: sender@example.com\r\n\r\nHello"));
        controller.close();
      },
    }),
    rawSize: 34,
    setReject,
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

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Cloudflare Email Worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("permanently rejects aliases denied by preflight", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ accept: false }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage();

    await emailWorker.email(message, env, createContext());

    expect(message.setReject).toHaveBeenCalledWith("550 Mailbox unavailable");
  });

  it("throws instead of permanently rejecting when raw upload fetch fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accept: true }))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage();

    await expect(emailWorker.email(message, env, createContext())).rejects.toThrow(
      "Transient raw upload failure",
    );
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("throws instead of permanently rejecting transient raw upload statuses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accept: true }))
      .mockResolvedValueOnce(new Response("backend unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage();

    await expect(emailWorker.email(message, env, createContext())).rejects.toThrow(
      "Transient raw upload failure: 503",
    );
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("permanently rejects raw uploads that exceed the configured VPS body limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accept: true }))
      .mockResolvedValueOnce(new Response("too large", { status: 413 }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage();

    await emailWorker.email(message, env, createContext());

    expect(message.setReject).toHaveBeenCalledWith(
      "Message size exceeds fixed maximum message size",
    );
  });

  it("permanently rejects raw uploads that the VPS denies with hosted quota status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accept: true }))
      .mockResolvedValueOnce(new Response("rejected", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage();

    await emailWorker.email(message, env, createContext());

    expect(message.setReject).toHaveBeenCalledWith("550 Mailbox unavailable");
  });
});
