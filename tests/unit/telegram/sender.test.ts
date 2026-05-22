import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import { sendTelegramMessage, sendTelegramPhotos } from "../../../src/telegram/sender.js";
import type { Api } from "grammy";

const mockOpenAttachmentStream = vi.fn();
vi.mock("../../../src/storage/disk.js", () => ({
  openAttachmentStream: (...args: unknown[]): unknown => mockOpenAttachmentStream(...args),
}));

// Each openAttachmentStream call yields a fresh stream + a dispose spy; the
// spies are collected so tests can assert temp files are released.
let disposeSpies: ReturnType<typeof vi.fn>[] = [];
function stubAttachmentStreams(): void {
  disposeSpies = [];
  mockOpenAttachmentStream.mockImplementation(() => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    disposeSpies.push(dispose);
    return Promise.resolve({
      stream: Readable.from(Buffer.from("decrypted-image")),
      size: 15,
      dispose,
    });
  });
}

interface MockApi extends Api {
  sendMessage: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
  sendMediaGroup: ReturnType<typeof vi.fn>;
}

function makeApi(sendFn: () => Promise<unknown>): MockApi {
  return {
    sendMessage: vi.fn(sendFn),
    sendPhoto: vi.fn(),
    sendMediaGroup: vi.fn(),
  } as unknown as MockApi;
}

describe("sendTelegramMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sends a message successfully on first attempt", async () => {
    const api = makeApi(() => Promise.resolve({ message_id: 1 }));
    const result = await sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: "Hello",
      parseMode: "HTML",
    });
    expect(result.ok).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("includes message_thread_id when threadId is set", async () => {
    const api = makeApi(() => Promise.resolve({ message_id: 42 }));
    await sendTelegramMessage(api, {
      chatId: 100n,
      threadId: 5n,
      text: "Thread msg",
      parseMode: "HTML",
    });
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ message_thread_id: 5 }),
    );
  });

  it("disables Telegram link previews for delivery messages", async () => {
    const api = makeApi(() => Promise.resolve({ message_id: 42 }));
    await sendTelegramMessage(api, {
      chatId: 100n,
      threadId: null,
      text: "https://example.com/file",
      parseMode: "HTML",
    });
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ link_preview_options: { is_disabled: true } }),
    );
  });

  it("retries on failure and succeeds on second attempt", async () => {
    let calls = 0;
    const api = makeApi(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("rate limited"));
      return Promise.resolve({ message_id: 7 });
    });

    const promise = sendTelegramMessage(api, {
      chatId: 200n,
      threadId: null,
      text: "Retry me",
      parseMode: "HTML",
    });
    // Advance past the first retry delay (1 second)
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("returns error after 3 failed attempts", async () => {
    const api = makeApi(() => Promise.reject(new Error("telegram down")));

    const promise = sendTelegramMessage(api, {
      chatId: 300n,
      threadId: null,
      text: "Always fails",
      parseMode: "HTML",
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/telegram down/i);
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not throw even when all retries fail", async () => {
    const api = makeApi(() => Promise.reject(new Error("fatal")));
    const promise = sendTelegramMessage(api, {
      chatId: 400n,
      threadId: null,
      text: "Fatal",
      parseMode: "HTML",
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ ok: false });
  });

  it("returns an error when Telegram send attempts time out", async () => {
    const api = makeApi(() => new Promise(() => {}));
    const promise = sendTelegramMessage(api, {
      chatId: 400n,
      threadId: null,
      text: "Timeout",
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({
      ok: false,
      error: "sendMessage timed out",
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("omits parse_mode when one is not provided", async () => {
    const api = makeApi(() => Promise.resolve({ message_id: 8 }));

    await sendTelegramMessage(api, {
      chatId: 500n,
      threadId: null,
      text: "No parse mode",
    });

    const [, text, options] = vi.mocked(api.sendMessage).mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];

    expect(text).toBe("No parse mode");
    expect(options).not.toHaveProperty("parse_mode");
  });
});

describe("sendTelegramPhotos", () => {
  beforeEach(() => {
    mockOpenAttachmentStream.mockReset();
    stubAttachmentStreams();
  });

  it("streams the decrypted attachment before sending a single photo", async () => {
    const api = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(() => Promise.resolve({ message_id: 1 })),
      sendMediaGroup: vi.fn(),
    } as unknown as MockApi;

    const result = await sendTelegramPhotos(api, {
      chatId: 100n,
      threadId: null,
      photos: [
        {
          id: "att-1",
          storagePath: "/data/attachments/att-1.bin",
          filename: "graph.png",
          encryptionMode: "local-v1",
          wrappedDek: "wrapped",
          kekKeyId: "test-key",
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(mockOpenAttachmentStream).toHaveBeenCalledWith(
      expect.objectContaining({ id: "att-1", encryptionMode: "local-v1" }),
    );
    expect(api.sendPhoto).toHaveBeenCalledOnce();
    // Temp file released after the send.
    expect(disposeSpies).toHaveLength(1);
    expect(disposeSpies[0]).toHaveBeenCalledOnce();
  });

  it("sends multiple photos as a media group with thread and reply metadata", async () => {
    const api = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
      sendMediaGroup: vi.fn(() => Promise.resolve([{ message_id: 1 }])),
    } as unknown as MockApi;

    const result = await sendTelegramPhotos(api, {
      chatId: 100n,
      threadId: 7n,
      replyToMessageId: 55,
      photos: [
        {
          id: "att-1",
          storagePath: "/data/attachments/att-1.bin",
          filename: "graph-1.png",
          encryptionMode: "local-v1",
          wrappedDek: "wrapped",
          kekKeyId: "test-key",
        },
        {
          id: "att-2",
          storagePath: "/data/attachments/att-2.bin",
          filename: "graph-2.png",
          encryptionMode: "local-v1",
          wrappedDek: "wrapped",
          kekKeyId: "test-key",
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(api.sendMediaGroup).toHaveBeenCalledWith(
      100,
      expect.any(Array),
      expect.objectContaining({
        message_thread_id: 7,
        reply_parameters: { message_id: 55 },
      }),
    );
  });

  it("collects failed photo chunks without throwing", async () => {
    const api = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(() => Promise.reject(new Error("telegram down"))),
      sendMediaGroup: vi.fn(),
    } as unknown as MockApi;

    const result = await sendTelegramPhotos(api, {
      chatId: 100n,
      threadId: null,
      photos: [
        {
          id: "att-1",
          storagePath: "/data/attachments/att-1.bin",
          filename: "graph.png",
          encryptionMode: "local-v1",
          wrappedDek: "wrapped",
          kekKeyId: "test-key",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.failedPhotos).toHaveLength(1);
    expect(result.failedPhotos[0]?.id).toBe("att-1");
    // Temp file released even when the send fails.
    expect(disposeSpies[0]).toHaveBeenCalledOnce();
  });
});
