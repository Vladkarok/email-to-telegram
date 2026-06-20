import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Api } from "grammy";

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runUptimeCheck } = await import("../../../src/utils/uptime.js");
const { noteRawInboundOutcome, resetInboundHealthForTests } =
  await import("../../../src/observability/inboundHealth.js");

function makeDb(healthy: boolean) {
  return {
    execute: healthy
      ? vi.fn().mockResolvedValue([])
      : vi.fn().mockRejectedValue(new Error("DB down")),
  } as unknown as Parameters<typeof runUptimeCheck>[0];
}

function makeApi(): { api: Api; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn().mockResolvedValue({});
  const getMe = vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: "Bot" });
  return { api: { sendMessage, getMe } as unknown as Api, sendMessage };
}

describe("runUptimeCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetInboundHealthForTests();
  });

  it("alerts on inbound stall when the worker contract is failing with no accepts", async () => {
    const db = makeDb(true);
    const { api, sendMessage } = makeApi();
    noteRawInboundOutcome("rejected", "unsupported_signature_version");

    await runUptimeCheck(db, api, { healthchecksUrl: undefined, alertChatId: 999n });

    expect(sendMessage).toHaveBeenCalledWith(
      999,
      expect.stringContaining("inbound"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("does not alert on inbound when mail is flowing despite the app being otherwise healthy", async () => {
    const db = makeDb(true);
    const { api, sendMessage } = makeApi();
    noteRawInboundOutcome("accepted", "accepted");

    await runUptimeCheck(db, api, { healthchecksUrl: undefined, alertChatId: 999n });

    expect(sendMessage).not.toHaveBeenCalled();
  });

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
      expect.stringContaining("db"),
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

  it("pings the configured healthchecks URL when all probes are healthy", async () => {
    const db = makeDb(true);
    const { api, sendMessage } = makeApi();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await runUptimeCheck(db, api, {
      healthchecksUrl: "https://hc.example/ping",
      alertChatId: 999n,
    });

    expect(fetchMock).toHaveBeenCalledWith("https://hc.example/ping");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not throw when the healthchecks ping fails", async () => {
    const db = makeDb(true);
    const { api } = makeApi();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(
      runUptimeCheck(db, api, {
        healthchecksUrl: "https://hc.example/ping",
        alertChatId: undefined,
      }),
    ).resolves.not.toThrow();
  });

  it("reports disk probe failures through the alert channel", async () => {
    const db = makeDb(true);
    const { api, sendMessage } = makeApi();

    await runUptimeCheck(db, api, {
      healthchecksUrl: undefined,
      alertChatId: 999n,
      probeDirs: ["/definitely-missing-email-to-telegram-probe-dir"],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      999,
      expect.stringContaining("disk"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("does not throw when sending the Telegram alert fails", async () => {
    const db = makeDb(false);
    const { api, sendMessage } = makeApi();
    sendMessage.mockRejectedValueOnce(new Error("telegram down"));

    await expect(
      runUptimeCheck(db, api, { healthchecksUrl: undefined, alertChatId: 999n }),
    ).resolves.not.toThrow();
  });
});
