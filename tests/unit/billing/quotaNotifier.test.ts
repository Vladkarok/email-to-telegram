import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import {
  isQuotaNotificationReason,
  notifyApproachingMonthlyLimit,
  notifyQuotaExhausted,
} from "../../../src/billing/quotaNotifier.js";
import { getMessages } from "../../../src/i18n/index.js";

const mockClaimQuotaNotification = vi.fn();
const mockFindUserById = vi.fn();
const mockLoadConfig = vi.fn();

vi.mock("../../../src/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../src/config.js")>("../../../src/config.js");
  return { ...actual, loadConfig: (): unknown => mockLoadConfig() };
});

const STRIPE_CONFIG = { billingProvider: "stripe", supportContact: undefined };
const UPGRADE_LINE = getMessages("en").quotaNotice.higherLimitsUpgrade;

vi.mock("../../../src/db/repos/quotaNotifications.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/db/repos/quotaNotifications.js")
  >("../../../src/db/repos/quotaNotifications.js");
  return {
    ...actual,
    claimQuotaNotification: (...args: unknown[]): unknown => mockClaimQuotaNotification(...args),
  };
});
vi.mock("../../../src/db/repos/users.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/users.js")>(
    "../../../src/db/repos/users.js",
  );
  return {
    ...actual,
    findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
  };
});

const FREE_USER = {
  id: 42n,
  planCode: "free",
  subscriptionStatus: "free",
  currentPeriodEnd: null,
  paidThroughAt: null,
  locale: "en",
};

function makeApi(): { api: Api; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn().mockResolvedValue({});
  return { api: { sendMessage } as unknown as Api, sendMessage };
}

const DB = {} as never;

describe("isQuotaNotificationReason", () => {
  it("accepts exactly the persistent user-actionable rejection codes", () => {
    expect(isQuotaNotificationReason("monthly_email_limit")).toBe(true);
    expect(isQuotaNotificationReason("storage_limit")).toBe(true);
    expect(isQuotaNotificationReason("subscription_inactive")).toBe(true);
    expect(isQuotaNotificationReason("message_size_limit")).toBe(false);
    expect(isQuotaNotificationReason("rate_limited")).toBe(false);
    expect(isQuotaNotificationReason("duplicate")).toBe(false);
  });
});

describe("notifyQuotaExhausted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimQuotaNotification.mockResolvedValue(true);
    mockFindUserById.mockResolvedValue(FREE_USER);
    mockLoadConfig.mockReturnValue(STRIPE_CONFIG);
  });

  it("sends one Telegram notice to the owner's private chat when the claim wins", async () => {
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(DB, api, 42n, "monthly_email_limit", "2026-07");

    // The claim must use the caller's month (the rejection-decision month),
    // never a recomputed "now" — guards the UTC month-boundary race.
    expect(mockClaimQuotaNotification).toHaveBeenCalledWith(
      expect.anything(),
      42n,
      "monthly_email_limit",
      "2026-07",
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    const [chatId, text, options] = sendMessage.mock.calls[0] as [string, string, object];
    expect(chatId).toBe("42");
    // Free plan monthly limit is 100 — the notice must state the concrete number.
    expect(text).toContain("100");
    expect(options).toMatchObject({ parse_mode: "HTML" });
  });

  it("sends no reminder once the month's notice was already claimed", async () => {
    mockClaimQuotaNotification.mockResolvedValue(false);
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(DB, api, 42n, "monthly_email_limit", "2026-07");

    expect(mockClaimQuotaNotification).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing without a Telegram api (no claim burned)", async () => {
    await notifyQuotaExhausted(DB, null, 42n, "monthly_email_limit", "2026-07");
    expect(mockClaimQuotaNotification).not.toHaveBeenCalled();
  });

  it("never throws when the Telegram send fails", async () => {
    const { api, sendMessage } = makeApi();
    sendMessage.mockRejectedValue(new Error("403 blocked by user"));
    await expect(
      notifyQuotaExhausted(DB, api, 42n, "monthly_email_limit", "2026-07"),
    ).resolves.toBeUndefined();
  });

  it("never throws when the claim itself fails", async () => {
    mockClaimQuotaNotification.mockRejectedValue(new Error("db down"));
    const { api, sendMessage } = makeApi();
    await expect(
      notifyQuotaExhausted(DB, api, 42n, "monthly_email_limit", "2026-07"),
    ).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("skips silently when the user row vanished after the claim", async () => {
    mockFindUserById.mockResolvedValue(null);
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(DB, api, 42n, "monthly_email_limit", "2026-07");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("localizes the notice to the user's stored locale", async () => {
    mockFindUserById.mockResolvedValue({ ...FREE_USER, locale: "uk" });
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(DB, api, 42n, "monthly_email_limit", "2026-07");

    const [, text] = sendMessage.mock.calls[0] as [string, string];
    const expected = getMessages("uk").quotaNotice.monthlyEmailLimit(
      "Free",
      100,
      getMessages("uk").quotaNotice.higherLimitsUpgrade,
    );
    expect(text).toBe(expected);
  });

  it("covers storage_limit and subscription_inactive with their own copy", async () => {
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(DB, api, 42n, "storage_limit", "2026-07");
    await notifyQuotaExhausted(DB, api, 42n, "subscription_inactive", "2026-07");

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const texts = sendMessage.mock.calls.map((c) => (c as [string, string])[1]);
    expect(texts[0]).toBe(getMessages("en").quotaNotice.storageLimit("Free", UPGRADE_LINE));
    expect(texts[1]).toBe(getMessages("en").quotaNotice.subscriptionInactive());
  });

  it("names the operator contact instead of /upgrade in donation mode", async () => {
    mockLoadConfig.mockReturnValue({ billingProvider: "donation", supportContact: "@op<x>" });
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(DB, api, 42n, "monthly_email_limit", "2026-07");

    const [, text] = sendMessage.mock.calls[0] as [string, string];
    expect(text).toContain("Need higher limits? Message @op&lt;x&gt;.");
    expect(text).not.toContain("/upgrade");
    expect(text).not.toContain("/donate");
  });
});

describe("notifyApproachingMonthlyLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_MODE", "hosted");
    mockClaimQuotaNotification.mockResolvedValue(true);
    mockFindUserById.mockResolvedValue(FREE_USER);
    mockLoadConfig.mockReturnValue(STRIPE_CONFIG);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warns once when usage enters the 80% band", async () => {
    const { api, sendMessage } = makeApi();
    await notifyApproachingMonthlyLimit({} as never, api, 42n, "2026-07", 80);

    expect(mockClaimQuotaNotification).toHaveBeenCalledWith(
      expect.anything(),
      42n,
      "approaching_monthly_limit",
      "2026-07",
    );
    const [, text] = sendMessage.mock.calls[0] as [string, string];
    expect(text).toBe(
      getMessages("en").quotaNotice.approachingMonthlyLimit("Free", 80, 100, UPGRADE_LINE),
    );
  });

  it("stays silent below the threshold (no claim burned)", async () => {
    const { api, sendMessage } = makeApi();
    await notifyApproachingMonthlyLimit({} as never, api, 42n, "2026-07", 79);
    expect(mockClaimQuotaNotification).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stays silent at or above the limit — the exhaustion notice owns that", async () => {
    const { api, sendMessage } = makeApi();
    await notifyApproachingMonthlyLimit({} as never, api, 42n, "2026-07", 100);
    expect(mockClaimQuotaNotification).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stays silent when the monthly claim was already taken", async () => {
    mockClaimQuotaNotification.mockResolvedValue(false);
    const { api, sendMessage } = makeApi();
    await notifyApproachingMonthlyLimit({} as never, api, 42n, "2026-07", 80);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing outside hosted mode", async () => {
    vi.stubEnv("APP_MODE", "self-hosted");
    const { api, sendMessage } = makeApi();
    await notifyApproachingMonthlyLimit({} as never, api, 42n, "2026-07", 80);
    expect(mockFindUserById).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never throws when the send fails", async () => {
    const { api, sendMessage } = makeApi();
    sendMessage.mockRejectedValue(new Error("403 blocked by user"));
    await expect(
      notifyApproachingMonthlyLimit({} as never, api, 42n, "2026-07", 80),
    ).resolves.toBeUndefined();
  });
});
