import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Api } from "grammy";

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runUptimeCheck } = await import("../../../src/utils/uptime.js");

function makeDb(healthy: boolean) {
  return {
    execute: healthy
      ? vi.fn().mockResolvedValue([])
      : vi.fn().mockRejectedValue(new Error("DB down")),
  } as unknown as Parameters<typeof runUptimeCheck>[0];
}

function makeApi(): { api: Api; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn().mockResolvedValue({});
  return { api: { sendMessage } as unknown as Api, sendMessage };
}

describe("runUptimeCheck", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not send alert when DB is healthy", async () => {
    const db = makeDb(true);
    const { api, sendMessage } = makeApi();
    await runUptimeCheck(db, api, { healthchecksUrl: undefined, alertChatId: undefined });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends Telegram alert when DB is down and alertChatId is set", async () => {
    const db = makeDb(false);
    const { api, sendMessage } = makeApi();
    await runUptimeCheck(db, api, { healthchecksUrl: undefined, alertChatId: 999n });
    expect(sendMessage).toHaveBeenCalledWith(
      999,
      expect.stringContaining("database connectivity"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("does not throw when DB is down and api is null", async () => {
    const db = makeDb(false);
    await expect(
      runUptimeCheck(db, null, { healthchecksUrl: undefined, alertChatId: undefined }),
    ).resolves.not.toThrow();
  });

  it("does not throw when DB is down and alertChatId is not set", async () => {
    const db = makeDb(false);
    const { api, sendMessage } = makeApi();
    await expect(
      runUptimeCheck(db, api, { healthchecksUrl: undefined, alertChatId: undefined }),
    ).resolves.not.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
