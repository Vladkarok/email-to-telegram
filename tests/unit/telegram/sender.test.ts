import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import {
  resetRichMessageAvailabilityForTests,
  sendTelegramMessage,
  sendTelegramPhotos,
} from "../../../src/telegram/sender.js";
import { GrammyError } from "grammy";
import type { Api } from "grammy";

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => loggerMocks,
}));

function migrateError(newChatId = -1002222333444): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed! (400: Bad Request: group chat was upgraded to a supergroup chat)",
    {
      ok: false,
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: newChatId },
    },
    "sendMessage",
    {},
  );
}

function botApiError(
  errorCode: number,
  description: string,
  extra: Record<string, unknown> = {},
): Error & { error_code: number; description: string } {
  return Object.assign(new Error(description), {
    error_code: errorCode,
    description,
    ...extra,
  });
}

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
  sendRichMessage: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
  sendMediaGroup: ReturnType<typeof vi.fn>;
}

function makeApi(
  sendFn: () => Promise<unknown>,
  richFn: () => Promise<unknown> = () => Promise.resolve({ message_id: 99 }),
): MockApi {
  return {
    sendMessage: vi.fn(sendFn),
    sendRichMessage: vi.fn(richFn),
    sendPhoto: vi.fn(),
    sendMediaGroup: vi.fn(),
  } as unknown as MockApi;
}

describe("sendTelegramMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRichMessageAvailabilityForTests();
    loggerMocks.warn.mockReset();
    loggerMocks.error.mockReset();
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

  it("stops retrying the old chat id immediately on a migrate error", async () => {
    const api = makeApi(() => Promise.reject(migrateError()));

    const promise = sendTelegramMessage(api, {
      chatId: -100200n,
      threadId: null,
      text: "Migrated away",
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.failure).toEqual({
      code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      transient: false,
      migrateToChatId: -1002222333444n,
    });
  });

  it("returns the structured failure alongside the error string", async () => {
    const api = makeApi(() => Promise.reject(new Error("telegram down")));

    const promise = sendTelegramMessage(api, {
      chatId: 300n,
      threadId: null,
      text: "Always fails",
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      code: null,
      description: "telegram down",
      transient: false,
      migrateToChatId: null,
    });
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

  it("sends preflighted rich HTML with thread metadata and entity detection disabled", async () => {
    const api = makeApi(
      () => Promise.resolve({ message_id: 1 }),
      () => Promise.resolve({ message_id: 77 }),
    );

    const result = await sendTelegramMessage(api, {
      chatId: 123n,
      threadId: 9n,
      text: "Classic fallback",
      parseMode: "HTML",
      richHtml: "<h2>Report</h2><table><tr><td>OK</td></tr></table>",
    });

    expect(result).toMatchObject({ ok: true, telegramMessageId: 77 });
    const [chatId, richMessage, options] = api.sendRichMessage.mock.calls[0] as [
      number,
      { html?: string; skip_entity_detection?: boolean },
      { message_thread_id?: number },
    ];
    expect(chatId).toBe(123);
    expect(richMessage.html).toContain("<table>");
    expect(richMessage.skip_entity_detection).toBe(true);
    expect(options).toEqual({ message_thread_id: 9 });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back exactly once after a structured rich-content 400", async () => {
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () => Promise.reject(botApiError(400, "Bad Request: can't parse rich message HTML")),
    );

    const result = await sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: "Classic fallback",
      parseMode: "HTML",
      richHtml: "<table><tr><td>Report</td></tr></table>",
    });

    expect(result).toMatchObject({ ok: true, telegramMessageId: 8 });
    expect(api.sendRichMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("returns the classic fallback failure rather than the rejected rich failure", async () => {
    const api = makeApi(
      () => Promise.reject(botApiError(403, "Forbidden: bot was blocked")),
      () => Promise.reject(botApiError(400, "Bad Request: can't parse rich message HTML")),
    );

    const result = await sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: "Classic fallback",
      richHtml: "<p>Rich</p>",
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 403, description: "Forbidden: bot was blocked" },
    });
    expect(api.sendRichMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("latches rich delivery off after a method-unavailable 404", async () => {
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () => Promise.reject(botApiError(404, "Not Found: method not found")),
    );
    const options = {
      chatId: 123n,
      threadId: null,
      text: "Classic fallback",
      richHtml: "<p>Rich</p>",
    } as const;

    await sendTelegramMessage(api, options);
    await sendTelegramMessage(api, options);

    expect(api.sendRichMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("honors the runtime rich-message kill switch", async () => {
    const api = makeApi(() => Promise.resolve({ message_id: 8 }));
    await sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: "Classic",
      richHtml: "<p>Rich</p>",
      richMessagesEnabled: false,
    });

    expect(api.sendRichMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ["migration", migrateError()],
    ["forbidden", botApiError(403, "Forbidden: bot was blocked")],
    ["chat not found", botApiError(400, "Bad Request: chat not found")],
    ["thread not found", botApiError(400, "Bad Request: message thread not found")],
    ["closed topic", botApiError(400, "Bad Request: topic was closed")],
  ])("does not switch transports for %s failures", async (_name, failure) => {
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () => Promise.reject(failure),
    );

    const result = await sendTelegramMessage(api, {
      chatId: -100n,
      threadId: null,
      text: "Classic",
      richHtml: "<p>Rich</p>",
    });

    expect(result.ok).toBe(false);
    expect(api.sendRichMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    [429, "Too Many Requests: retry after 1"],
    [500, "Internal Server Error"],
  ])("retries rich transient %s failures without a classic send", async (code, description) => {
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () => Promise.reject(botApiError(code, description)),
    );

    const promise = sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: "Classic",
      richHtml: "<p>Rich</p>",
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(api.sendRichMessage).toHaveBeenCalledTimes(3);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does not switch transports when a deterministic rejection follows an ambiguous attempt", async () => {
    let richCalls = 0;
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () => {
        richCalls++;
        return Promise.reject(
          richCalls === 1
            ? botApiError(500, "Internal Server Error")
            : botApiError(400, "Bad Request: can't parse rich message HTML"),
        );
      },
    );

    const promise = sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: "Classic",
      richHtml: "<p>Rich</p>",
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 400, description: "Bad Request: can't parse rich message HTML" },
    });
    expect(api.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("latches an unsupported rich method after an earlier ambiguous attempt", async () => {
    let richCalls = 0;
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () => {
        richCalls++;
        return Promise.reject(
          richCalls === 1
            ? botApiError(500, "Internal Server Error")
            : botApiError(404, "Not Found: method not found"),
        );
      },
    );
    const options = {
      chatId: 123n,
      threadId: null,
      text: "Classic",
      richHtml: "<p>Rich</p>",
    } as const;

    const first = sendTelegramMessage(api, options);
    await vi.runAllTimersAsync();
    await expect(first).resolves.toMatchObject({ ok: false, failure: { code: 404 } });
    expect(api.sendMessage).not.toHaveBeenCalled();

    await sendTelegramMessage(api, options);
    expect(api.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("retries an ambiguous rich network failure without switching transports", async () => {
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () => Promise.reject(new Error("network fetch failed")),
    );
    const promise = sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: "Classic",
      richHtml: "<p>Rich</p>",
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(api.sendRichMessage).toHaveBeenCalledTimes(3);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("times out rich attempts without risking a duplicate classic send", async () => {
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () => new Promise(() => {}),
    );
    const promise = sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: "Classic",
      richHtml: "<p>Rich</p>",
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ ok: false, error: "sendRichMessage timed out" });
    expect(api.sendRichMessage).toHaveBeenCalledTimes(3);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does not expose message content through Telegram failure logs", async () => {
    const sentinel = "PAYLOAD_SENTINEL_DO_NOT_LOG";
    const api = makeApi(
      () => Promise.resolve({ message_id: 8 }),
      () =>
        Promise.reject(
          botApiError(400, "Bad Request: can't parse rich message HTML", {
            request: { rich_message: { html: `<p>${sentinel}</p>` } },
          }),
        ),
    );

    await sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: sentinel,
      richHtml: `<p>${sentinel}</p>`,
    });

    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(sentinel);
  });

  it("does not expose classic message content through Telegram failure logs", async () => {
    const sentinel = "CLASSIC_PAYLOAD_SENTINEL_DO_NOT_LOG";
    const api = makeApi(() =>
      Promise.reject(
        botApiError(400, "Bad Request: can't parse entities", {
          request: { text: sentinel },
        }),
      ),
    );

    await sendTelegramMessage(api, {
      chatId: 123n,
      threadId: null,
      text: sentinel,
      parseMode: "HTML",
    });

    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(sentinel);
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

  function makePhotos(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `att-${i + 1}`,
      storagePath: `/data/attachments/att-${i + 1}.bin`,
      filename: `graph-${i + 1}.png`,
      encryptionMode: "local-v1",
      wrappedDek: "wrapped",
      kekKeyId: "test-key",
    }));
  }

  it("aborts remaining chunks and surfaces the migrate hint on a migrate error", async () => {
    const api = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
      sendMediaGroup: vi.fn(() => Promise.reject(migrateError())),
    } as unknown as MockApi;

    // 11 photos → two chunks (10 + 1); the first chunk hits the migrate error.
    const result = await sendTelegramPhotos(api, {
      chatId: -100200n,
      threadId: null,
      photos: makePhotos(11),
    });

    expect(result.ok).toBe(false);
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    // Every photo failed: the sent chunk plus the never-attempted remainder.
    expect(result.failedPhotos).toHaveLength(11);
    expect(result.failure).toMatchObject({
      code: 400,
      transient: false,
      migrateToChatId: -1002222333444n,
    });
    // Only the first chunk was ever opened; its temp files were released.
    expect(disposeSpies).toHaveLength(10);
    for (const dispose of disposeSpies) {
      expect(dispose).toHaveBeenCalledOnce();
    }
  });

  it("keeps sending later chunks on non-migrate failures and surfaces the first failure", async () => {
    const api = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(() => Promise.resolve({ message_id: 2 })),
      sendMediaGroup: vi.fn(() => Promise.reject(new Error("telegram down"))),
    } as unknown as MockApi;

    const result = await sendTelegramPhotos(api, {
      chatId: 100n,
      threadId: null,
      photos: makePhotos(11),
    });

    expect(result.ok).toBe(false);
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(result.failedPhotos).toHaveLength(10);
    expect(result.failure).toMatchObject({
      code: null,
      description: "telegram down",
      migrateToChatId: null,
    });
  });
});
