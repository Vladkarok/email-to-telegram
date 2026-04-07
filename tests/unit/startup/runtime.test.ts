import { describe, expect, it } from "vitest";
import { buildRetryWorkerOptions, nextPollingStartOptions } from "../../../src/startup/runtime.js";

describe("startup runtime helpers", () => {
  it("drops pending updates only on the first polling start", () => {
    const first = nextPollingStartOptions(true);
    const second = nextPollingStartOptions(first.nextIsInitialPollingStart);

    expect(first).toEqual({ dropPendingUpdates: true, nextIsInitialPollingStart: false });
    expect(second).toEqual({ dropPendingUpdates: false, nextIsInitialPollingStart: false });
  });

  it("builds retry worker options with the recovery directories", () => {
    expect(
      buildRetryWorkerOptions({
        attachmentDir: "/data/attachments",
        attachmentTtlHours: 24,
        publicBaseUrl: "https://mail.example.com",
        rawEmailDir: "/data/rawemails",
        rawEmailTtlHours: 48,
      }),
    ).toEqual({
      attachmentDir: "/data/attachments",
      attachmentTtlHours: 24,
      publicBaseUrl: "https://mail.example.com",
      rawEmailDir: "/data/rawemails",
      rawEmailTtlHours: 48,
    });
  });
});
