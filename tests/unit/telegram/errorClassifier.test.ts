import { describe, it, expect } from "vitest";
import { GrammyError } from "grammy";
import {
  classifyTelegramError,
  describeSendError,
  retryDispositionForError,
  UNCOUNTED_RETRY_ERROR_CLASSES,
} from "../../../src/telegram/errorClassifier.js";

function makeGrammyError(
  errorCode: number,
  description: string,
  parameters: { migrate_to_chat_id?: number; retry_after?: number } = {},
): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed! (${errorCode}: ${description})`,
    { ok: false, error_code: errorCode, description, parameters },
    "sendMessage",
    {},
  );
}

describe("classifyTelegramError", () => {
  it.each([
    [null, "unknown"],
    [undefined, "unknown"],
    ["", "unknown"],
    ["Call to 'sendMessage' failed! (429: Too Many Requests: retry after 14)", "flood_wait"],
    ["FLOOD_WAIT_30", "flood_wait"],
    ["Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)", "forbidden"],
    ["Call to 'sendMessage' failed! (403: Forbidden: user is deactivated)", "forbidden"],
    ["Call to 'sendMessage' failed! (400: Bad Request: chat not found)", "chat_not_found"],
    [
      "Call to 'sendMessage' failed! (400: Bad Request: message thread not found)",
      "chat_not_found",
    ],
    ["Call to 'sendMessage' failed! (400: Bad Request: can't parse entities)", "bad_request"],
    ["sendMessage timed out", "timeout"],
    ["Network request for 'sendMessage' failed!", "network"],
    ["fetch failed", "network"],
    ["connect ECONNREFUSED 149.154.167.220:443", "network"],
    ["Call to 'sendMessage' failed! (502: Bad Gateway)", "server"],
    ["Call to 'sendMessage' failed! (500: Internal Server Error)", "server"],
    ["Call to 'sendMessage' failed! (503: Service Unavailable)", "server"],
    ["something inexplicable", "other"],
    [
      "Call to 'sendMessage' failed! (400: Bad Request: group chat was upgraded to a supergroup chat)",
      "migrated",
    ],
  ])("classifies %j as %s", (error, expected) => {
    expect(classifyTelegramError(error)).toBe(expected);
  });

  it.each([
    ["429 flood", makeGrammyError(429, "Too Many Requests: retry after 14"), "flood_wait"],
    ["403 blocked", makeGrammyError(403, "Forbidden: bot was blocked by the user"), "forbidden"],
    ["400 chat gone", makeGrammyError(400, "Bad Request: chat not found"), "chat_not_found"],
    ["400 entities", makeGrammyError(400, "Bad Request: can't parse entities"), "bad_request"],
    ["502", makeGrammyError(502, "Bad Gateway"), "server"],
    ["timeout", new Error("sendMessage timed out"), "timeout"],
    ["fetch", new Error("fetch failed"), "network"],
    [
      "migrate",
      makeGrammyError(400, "Bad Request: group chat was upgraded to a supergroup chat", {
        migrate_to_chat_id: -1002222333444,
      }),
      "migrated",
    ],
  ])("classifies the structured %s failure", (_name, err, expected) => {
    expect(classifyTelegramError(describeSendError(err))).toBe(expected);
  });
});

describe("describeSendError", () => {
  it("extracts code, description and migrate hint from a Bot API migrate error", () => {
    const failure = describeSendError(
      makeGrammyError(400, "Bad Request: group chat was upgraded to a supergroup chat", {
        migrate_to_chat_id: -1002222333444,
      }),
    );
    expect(failure).toEqual({
      code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      transient: false,
      migrateToChatId: -1002222333444n,
    });
  });

  it("marks global-transient Bot API failures as transient without a migrate hint", () => {
    const failure = describeSendError(
      makeGrammyError(429, "Too Many Requests: retry after 14", { retry_after: 14 }),
    );
    expect(failure).toEqual({
      code: 429,
      description: "Too Many Requests: retry after 14",
      transient: true,
      migrateToChatId: null,
    });
  });

  it("marks permanent Bot API failures as non-transient", () => {
    const failure = describeSendError(
      makeGrammyError(403, "Forbidden: bot was blocked by the user"),
    );
    expect(failure).toMatchObject({ code: 403, transient: false, migrateToChatId: null });
  });

  it("falls back to string classification for non-API errors", () => {
    expect(describeSendError(new Error("sendMessage timed out"))).toEqual({
      code: null,
      description: "sendMessage timed out",
      transient: true,
      migrateToChatId: null,
    });
    expect(describeSendError(new Error("something inexplicable"))).toEqual({
      code: null,
      description: "something inexplicable",
      transient: false,
      migrateToChatId: null,
    });
  });
});

describe("retryDispositionForError", () => {
  it("fails permanently for chat-level errors that no retry can fix", () => {
    expect(retryDispositionForError("403: Forbidden: bot was blocked by the user")).toBe(
      "fail_permanently",
    );
    expect(retryDispositionForError("400: Bad Request: chat not found")).toBe("fail_permanently");
  });

  it("retries without consuming budget for global-transient failures", () => {
    expect(retryDispositionForError("fetch failed")).toBe("retry_uncounted");
    expect(retryDispositionForError("sendMessage timed out")).toBe("retry_uncounted");
    expect(retryDispositionForError("429: Too Many Requests: retry after 5")).toBe(
      "retry_uncounted",
    );
    expect(retryDispositionForError("502: Bad Gateway")).toBe("retry_uncounted");
  });

  it("retries within the bounded budget for possibly message-specific failures", () => {
    expect(retryDispositionForError("400: Bad Request: can't parse entities")).toBe(
      "retry_counted",
    );
    expect(retryDispositionForError("something inexplicable")).toBe("retry_counted");
    expect(retryDispositionForError("")).toBe("retry_counted");
  });

  it("retries a migrate failure without consuming budget (repair happens upstream)", () => {
    const failure = describeSendError(
      makeGrammyError(400, "Bad Request: group chat was upgraded to a supergroup chat", {
        migrate_to_chat_id: -1002222333444,
      }),
    );
    expect(retryDispositionForError(failure)).toBe("retry_uncounted");
    expect(UNCOUNTED_RETRY_ERROR_CLASSES).toContain("migrated");
  });

  it("keeps every uncounted class out of the permanent set", () => {
    for (const errorClass of UNCOUNTED_RETRY_ERROR_CLASSES) {
      expect(["forbidden", "chat_not_found"]).not.toContain(errorClass);
    }
  });
});
