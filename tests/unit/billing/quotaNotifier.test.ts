import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import {
  isQuotaNotificationReason,
  notifyApproachingMonthlyLimit,
  notifyQuotaExhausted,
} from "../../../src/billing/quotaNotifier.js";
import { quotaWeekForDate } from "../../../src/db/repos/quotaNotifications.js";
import { getMessages } from "../../../src/i18n/index.js";

const mockClaimQuotaNotification = vi.fn();
const mockFindUserById = vi.fn();
const mockGetUserUsageMonth = vi.fn();

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
vi.mock("../../../src/db/repos/usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/usage.js")>(
    "../../../src/db/repos/usage.js",
  );
  return {
    ...actual,
    getUserUsageMonth: (...args: unknown[]): unknown => mockGetUserUsageMonth(...args),
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

// The monthly path claims month + suppression week inside one transaction.
function makeDb(): { db: never; transaction: ReturnType<typeof vi.fn>; txHandle: object } {
  const txHandle = {};
  const transaction = vi.fn(async (fn: (tx: object) => Promise<unknown>) => fn(txHandle));
  return { db: { transaction } as never, transaction, txHandle };
}

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

describe("quotaWeekForDate", () => {
  it("formats as YYYY-Wnn with zero padding", () => {
    expect(quotaWeekForDate(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
  });

  it("assigns late-December days to the next ISO year when the week belongs there", () => {
    // Monday 2025-12-29 opens ISO week 1 of 2026 (Jan 1 2026 is a Thursday).
    expect(quotaWeekForDate(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01");
  });

  it("assigns early-January days to the previous ISO year when the week belongs there", () => {
    // Friday 2027-01-01 still belongs to ISO week 53 of 2026.
    expect(quotaWeekForDate(new Date("2026-12-31T23:59:59Z"))).toBe("2026-W53");
    expect(quotaWeekForDate(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});

describe("notifyQuotaExhausted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimQuotaNotification.mockResolvedValue(true);
    mockFindUserById.mockResolvedValue(FREE_USER);
    mockGetUserUsageMonth.mockResolvedValue(null);
  });

  it("sends one Telegram notice to the owner's private chat when the claim wins", async () => {
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07");

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

  it("pre-claims the current ISO week so no reminder follows in the same week", async () => {
    const { api } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07");

    expect(mockClaimQuotaNotification).toHaveBeenCalledTimes(2);
    expect(mockClaimQuotaNotification).toHaveBeenLastCalledWith(
      expect.anything(),
      42n,
      "monthly_email_limit_reminder",
      quotaWeekForDate(),
    );
  });

  it("claims month and suppression week atomically inside one transaction", async () => {
    const { api } = makeApi();
    const { db, transaction, txHandle } = makeDb();
    await notifyQuotaExhausted(db, api, 42n, "monthly_email_limit", "2026-07");

    // Both claims must run on the same transaction handle, not the outer db —
    // with separate inserts a concurrent loser of the month claim could win
    // the week claim in the gap and send the reminder next to the notice.
    expect(transaction).toHaveBeenCalledOnce();
    expect(mockClaimQuotaNotification).toHaveBeenCalledTimes(2);
    expect(mockClaimQuotaNotification.mock.calls[0]?.[0]).toBe(txHandle);
    expect(mockClaimQuotaNotification.mock.calls[1]?.[0]).toBe(txHandle);
  });

  it("does not pre-claim a week for storage/subscription notices", async () => {
    const { api } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "storage_limit", "2026-07");
    expect(mockClaimQuotaNotification).toHaveBeenCalledOnce();
  });

  it("does nothing without a Telegram api (no claim burned)", async () => {
    await notifyQuotaExhausted(makeDb().db, null, 42n, "monthly_email_limit", "2026-07");
    expect(mockClaimQuotaNotification).not.toHaveBeenCalled();
  });

  it("never throws when the Telegram send fails", async () => {
    const { api, sendMessage } = makeApi();
    sendMessage.mockRejectedValue(new Error("403 blocked by user"));
    await expect(
      notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07"),
    ).resolves.toBeUndefined();
  });

  it("never throws when the claim itself fails", async () => {
    mockClaimQuotaNotification.mockRejectedValue(new Error("db down"));
    const { api, sendMessage } = makeApi();
    await expect(
      notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07"),
    ).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("skips silently when the user row vanished after the claim", async () => {
    mockFindUserById.mockResolvedValue(null);
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("localizes the notice to the user's stored locale", async () => {
    mockFindUserById.mockResolvedValue({ ...FREE_USER, locale: "uk" });
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07");

    const [, text] = sendMessage.mock.calls[0] as [string, string];
    const expected = getMessages("uk").quotaNotice.monthlyEmailLimit("Free", 100);
    expect(text).toBe(expected);
  });

  it("covers storage_limit and subscription_inactive with their own copy", async () => {
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "storage_limit", "2026-07");
    await notifyQuotaExhausted(makeDb().db, api, 42n, "subscription_inactive", "2026-07");

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const texts = sendMessage.mock.calls.map((c) => (c as [string, string])[1]);
    expect(texts[0]).toBe(getMessages("en").quotaNotice.storageLimit("Free"));
    expect(texts[1]).toBe(getMessages("en").quotaNotice.subscriptionInactive());
  });
});

describe("notifyQuotaExhausted — weekly while-capped reminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserById.mockResolvedValue(FREE_USER);
    // Month claim already taken; week claim wins.
    mockClaimQuotaNotification.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockGetUserUsageMonth.mockResolvedValue({ deliveredCount: 100, rejectedCount: 37 });
  });

  it("sends the reminder with the month's rejected count when the week claim wins", async () => {
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07");

    expect(mockClaimQuotaNotification).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      42n,
      "monthly_email_limit_reminder",
      quotaWeekForDate(),
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    const [, text] = sendMessage.mock.calls[0] as [string, string];
    expect(text).toBe(getMessages("en").quotaNotice.monthlyLimitReminder(37));
  });

  it("stays silent when the week claim is already taken", async () => {
    mockClaimQuotaNotification.mockReset().mockResolvedValue(false);
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stays silent when no rejections were counted this month", async () => {
    mockGetUserUsageMonth.mockResolvedValue({ deliveredCount: 100, rejectedCount: 0 });
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "monthly_email_limit", "2026-07");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never reminds for storage/subscription exhaustion", async () => {
    mockClaimQuotaNotification.mockReset().mockResolvedValue(false);
    const { api, sendMessage } = makeApi();
    await notifyQuotaExhausted(makeDb().db, api, 42n, "storage_limit", "2026-07");
    expect(mockClaimQuotaNotification).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("notifyApproachingMonthlyLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_MODE", "hosted");
    mockClaimQuotaNotification.mockResolvedValue(true);
    mockFindUserById.mockResolvedValue(FREE_USER);
    mockGetUserUsageMonth.mockResolvedValue({ deliveredCount: 80, rejectedCount: 0 });
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
    expect(text).toBe(getMessages("en").quotaNotice.approachingMonthlyLimit("Free", 80, 100));
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
