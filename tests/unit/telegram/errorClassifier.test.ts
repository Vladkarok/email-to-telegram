import { describe, it, expect } from "vitest";
import {
  classifyTelegramError,
  retryDispositionForError,
  UNCOUNTED_RETRY_ERROR_CLASSES,
} from "../../../src/telegram/errorClassifier.js";

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
  ])("classifies %j as %s", (error, expected) => {
    expect(classifyTelegramError(error)).toBe(expected);
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

  it("keeps every uncounted class out of the permanent set", () => {
    for (const errorClass of UNCOUNTED_RETRY_ERROR_CLASSES) {
      expect(["forbidden", "chat_not_found"]).not.toContain(errorClass);
    }
  });
});
