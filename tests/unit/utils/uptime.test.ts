import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Api } from "grammy";

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runUptimeCheck, resetUptimeAlertStateForTests } =
  await import("../../../src/utils/uptime.js");
const { noteRawInboundOutcome, resetInboundHealthForTests } =
  await import("../../../src/observability/inboundHealth.js");

function makeDb(healthy: boolean) {
  return {
    execute: healthy
      ? vi.fn().mockResolvedValue([])
      : vi.fn().mockRejectedValue(new Error("DB down")),
  } as unknown as Parameters<typeof runUptimeCheck>[0];
}

function makeApi(): {
  api: Api;
  sendMessage: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue({});
  const getMe = vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: "Bot" });
  return { api: { sendMessage, getMe } as unknown as Api, sendMessage, getMe };
}

const NO_ALERT = { healthchecksUrl: undefined, alertChatId: undefined };
const ALERTING = { healthchecksUrl: undefined, alertChatId: 999n };

/** The alert threshold is 2 consecutive failures, so most cases need two runs. */
async function runTwice(...args: Parameters<typeof runUptimeCheck>) {
  await runUptimeCheck(...args);
  await runUptimeCheck(...args);
}

describe("runUptimeCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetInboundHealthForTests();
    resetUptimeAlertStateForTests();
  });

  it("alerts on inbound stall when the worker contract is failing with no accepts", async () => {
    const db = makeDb(true);
    const { api, sendMessage } = makeApi();
    noteRawInboundOutcome("rejected", "unsupported_signature_version");

    await runTwice(db, api, ALERTING);

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

    await runTwice(db, api, ALERTING);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not send alert when DB is healthy", async () => {
    const db = makeDb(true);
    const { api, sendMessage } = makeApi();
    await runUptimeCheck(db, api, NO_ALERT);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends Telegram alert when DB is down and alertChatId is set", async () => {
    const db = makeDb(false);
    const { api, sendMessage } = makeApi();
    await runTwice(db, api, ALERTING);
    expect(sendMessage).toHaveBeenCalledWith(
      999,
      expect.stringContaining("db"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("does not throw when DB is down and api is null", async () => {
    const db = makeDb(false);
    await expect(runUptimeCheck(db, null, NO_ALERT)).resolves.not.toThrow();
  });

  it("does not throw when DB is down and alertChatId is not set", async () => {
    const db = makeDb(false);
    const { api, sendMessage } = makeApi();
    await expect(runTwice(db, api, NO_ALERT)).resolves.not.toThrow();
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
    const config = {
      ...ALERTING,
      probeDirs: ["/definitely-missing-email-to-telegram-probe-dir"],
    };

    await runTwice(db, api, config);

    expect(sendMessage).toHaveBeenCalledWith(
      999,
      expect.stringContaining("disk"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("does not throw when sending the Telegram alert fails", async () => {
    const db = makeDb(false);
    const { api, sendMessage } = makeApi();
    sendMessage.mockRejectedValue(new Error("telegram down"));

    await expect(runTwice(db, api, ALERTING)).resolves.not.toThrow();
  });

  describe("alert debounce", () => {
    it("stays silent after a single failing check", async () => {
      const db = makeDb(false);
      const { api, sendMessage } = makeApi();

      await runUptimeCheck(db, api, ALERTING);

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("alerts exactly once across a sustained outage", async () => {
      const db = makeDb(false);
      const { api, sendMessage } = makeApi();

      for (let i = 0; i < 5; i++) await runUptimeCheck(db, api, ALERTING);

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("resets the failure count when a dimension recovers between blips", async () => {
      const { api, sendMessage } = makeApi();

      await runUptimeCheck(makeDb(false), api, ALERTING);
      await runUptimeCheck(makeDb(true), api, ALERTING);
      await runUptimeCheck(makeDb(false), api, ALERTING);

      // Two failures, but not consecutive, so neither reached the threshold.
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("tracks dimensions independently", async () => {
      const { api, sendMessage } = makeApi();
      const withDisk = {
        ...ALERTING,
        probeDirs: ["/definitely-missing-email-to-telegram-probe-dir"],
      };

      // db fails once then recovers; disk fails throughout.
      await runUptimeCheck(makeDb(false), api, withDisk);
      await runUptimeCheck(makeDb(true), api, withDisk);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [, text] = sendMessage.mock.calls[0] as [number, string];
      expect(text).toContain("disk");
      expect(text).not.toContain("db");
    });
  });

  describe("recovery notice", () => {
    it("announces recovery for a dimension that was alerted", async () => {
      const { api, sendMessage } = makeApi();

      await runTwice(makeDb(false), api, ALERTING);
      sendMessage.mockClear();
      await runUptimeCheck(makeDb(true), api, ALERTING);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [, text] = sendMessage.mock.calls[0] as [number, string];
      expect(text).toContain("recovered");
      expect(text).toContain("db");
    });

    it("stays silent when a dimension recovers without ever alerting", async () => {
      const { api, sendMessage } = makeApi();

      await runUptimeCheck(makeDb(false), api, ALERTING);
      await runUptimeCheck(makeDb(true), api, ALERTING);

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("does not repeat the recovery notice on later healthy checks", async () => {
      const { api, sendMessage } = makeApi();

      await runTwice(makeDb(false), api, ALERTING);
      sendMessage.mockClear();
      await runUptimeCheck(makeDb(true), api, ALERTING);
      await runUptimeCheck(makeDb(true), api, ALERTING);

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("retries the recovery notice when the all-clear failed to send", async () => {
      const { api, sendMessage } = makeApi();

      await runTwice(makeDb(false), api, ALERTING);
      sendMessage.mockClear();
      sendMessage.mockRejectedValueOnce(new Error("telegram down"));

      await runUptimeCheck(makeDb(true), api, ALERTING);
      await runUptimeCheck(makeDb(true), api, ALERTING);

      expect(sendMessage).toHaveBeenCalledTimes(2);
      const [, text] = sendMessage.mock.calls[1] as [number, string];
      expect(text).toContain("recovered");
    });

    it("still alerts if the dimension fails again before the all-clear was delivered", async () => {
      const { api, sendMessage } = makeApi();

      // Alert lands, then the recovery notice fails to send. A subsequent
      // outage must not be suppressed by the stale alert bookkeeping.
      sendMessage.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("telegram down"));

      await runTwice(makeDb(false), api, ALERTING);
      await runUptimeCheck(makeDb(true), api, ALERTING);
      sendMessage.mockClear();
      await runTwice(makeDb(false), api, ALERTING);

      const texts = sendMessage.mock.calls.map((call) => (call as [number, string])[1]);
      expect(texts.some((text) => text.includes("health probe failed"))).toBe(true);
    });
  });

  describe("failed alert delivery", () => {
    it("retries the alert on the next check when the send failed", async () => {
      const db = makeDb(false);
      const { api, sendMessage } = makeApi();
      sendMessage.mockRejectedValueOnce(new Error("telegram down"));

      // Reaches the threshold on run 2, where the send fails; run 3 must retry
      // rather than treat the outage as already reported.
      await runUptimeCheck(db, api, ALERTING);
      await runUptimeCheck(db, api, ALERTING);
      await runUptimeCheck(db, api, ALERTING);

      expect(sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("telegram probe retry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("treats a single transient getMe failure as healthy", async () => {
      const db = makeDb(true);
      const { api, sendMessage, getMe } = makeApi();
      getMe.mockRejectedValueOnce(new Error("502: Bad Gateway"));

      const first = runUptimeCheck(db, api, ALERTING);
      await vi.advanceTimersByTimeAsync(2000);
      await first;

      const second = runUptimeCheck(db, api, ALERTING);
      await vi.advanceTimersByTimeAsync(2000);
      await second;

      expect(getMe).toHaveBeenCalledTimes(3);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("reports telegram as down when every attempt fails", async () => {
      const db = makeDb(true);
      const { api, sendMessage, getMe } = makeApi();
      getMe.mockRejectedValue(new Error("502: Bad Gateway"));

      for (let i = 0; i < 2; i++) {
        const run = runUptimeCheck(db, api, ALERTING);
        await vi.advanceTimersByTimeAsync(2000);
        await run;
      }

      expect(sendMessage).toHaveBeenCalledWith(
        999,
        expect.stringContaining("telegram"),
        expect.objectContaining({ parse_mode: "HTML" }),
      );
    });
  });
});
