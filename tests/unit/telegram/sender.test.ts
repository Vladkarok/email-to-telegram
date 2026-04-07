import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendTelegramMessage, sendTelegramPhotos } from "../../../src/telegram/sender.js";
import type { Api } from "grammy";

const mockReadAttachmentBytes = vi.fn();
vi.mock("../../../src/storage/disk.js", () => ({
  readAttachmentBytes: (...args: unknown[]): unknown => mockReadAttachmentBytes(...args),
}));

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
});

describe("sendTelegramPhotos", () => {
  beforeEach(() => {
    mockReadAttachmentBytes.mockReset();
  });

  it("reads decrypted attachment bytes before sending a single photo", async () => {
    const api = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(() => Promise.resolve({ message_id: 1 })),
      sendMediaGroup: vi.fn(),
    } as unknown as MockApi;
    mockReadAttachmentBytes.mockResolvedValue(Buffer.from("decrypted-image"));

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
    expect(mockReadAttachmentBytes).toHaveBeenCalledWith(
      expect.objectContaining({ id: "att-1", encryptionMode: "local-v1" }),
    );
    expect(api.sendPhoto).toHaveBeenCalledOnce();
  });
});
