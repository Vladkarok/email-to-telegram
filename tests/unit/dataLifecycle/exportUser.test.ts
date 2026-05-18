import { describe, it, expect, vi, beforeEach } from "vitest";

const { exportHostedUserData } = await import("../../../src/dataLifecycle/exportUser.js");

function thenable(rows: unknown[]) {
  const obj: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  obj["limit"] = vi.fn().mockResolvedValue(rows);
  obj["orderBy"] = vi.fn(() => thenable(rows));
  return obj;
}

function selectChainResolvingTo(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => thenable(rows)),
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => thenable(rows)),
      })),
      orderBy: vi.fn().mockResolvedValue(rows),
    })),
  };
}

function makeDb(
  userRow: Record<string, unknown> | null,
  rows: {
    aliases?: unknown[];
    usageMonths?: unknown[];
    storageUsage?: unknown[];
    deliverySummary?: unknown[];
    manualBillingEvents?: unknown[];
  } = {},
) {
  let call = 0;
  // Order matches exportHostedUserData internals:
  // 1: user lookup (.from().where().limit())
  // 2-N: aliases / usage months / storage usage / delivery summary / manual events
  const selectResponses: unknown[][] = [
    userRow ? [userRow] : [], // user
    rows.aliases ?? [],
    rows.usageMonths ?? [],
    rows.storageUsage ?? [],
    rows.deliverySummary ?? [],
    rows.manualBillingEvents ?? [],
  ];
  const select = vi.fn(() => {
    const rows = selectResponses[call] ?? [];
    call += 1;
    return selectChainResolvingTo(rows);
  });
  return { select } as never;
}

describe("exportHostedUserData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the user does not exist", async () => {
    const db = makeDb(null);
    await expect(exportHostedUserData(db, 1n)).resolves.toBeNull();
  });

  it("returns an export envelope keyed by the user", async () => {
    const userRow = {
      id: 1n,
      username: "alice",
      planCode: "free",
      subscriptionStatus: "free",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-02T00:00:00.000Z"),
    };
    const db = makeDb(userRow, {
      aliases: [
        {
          id: "alias-1",
          localPart: "alerts",
          fullAddress: "alerts@example.com",
          status: "active",
          chatId: -100n,
          messageThreadId: 42n,
          renderMode: "plaintext",
          privacyModeEnabled: true,
          bodyDedupEnabled: false,
          createdAt: new Date("2025-01-03T00:00:00.000Z"),
        },
      ],
      usageMonths: [
        {
          month: "2026-05",
          deliveredCount: 7,
          rejectedCount: 1,
          egressBytes: 123n,
        },
      ],
      storageUsage: [{ rawEmailBytes: 100n, attachmentBytes: 200n }],
      deliverySummary: [
        {
          finalStatus: "delivered",
          billable: true,
          hasAttachments: true,
          rawSizeBytes: 512,
          receivedAt: new Date("2026-05-10T00:00:00.000Z"),
        },
      ],
      manualBillingEvents: [
        {
          id: "event-1",
          telegramUserId: 1n,
          planCode: "pro",
          subscriptionStatus: "active",
          paidThroughAt: new Date("2026-06-01T00:00:00.000Z"),
          paymentReference: "wise-1",
          note: "paid",
          keptStripeLink: false,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
    });
    const result = await exportHostedUserData(db, 1n, new Date("2026-05-18T00:00:00.000Z"));

    expect(result).toMatchObject({
      exportedAt: "2026-05-18T00:00:00.000Z",
      user: {
        id: "1",
        username: "alice",
        planCode: "free",
        subscriptionStatus: "free",
      },
      aliases: [
        {
          id: "alias-1",
          chatId: "-100",
          messageThreadId: "42",
          privacyModeEnabled: true,
        },
      ],
      usageMonths: [{ month: "2026-05", egressBytes: "123" }],
      storageUsage: { rawEmailBytes: "100", attachmentBytes: "200" },
      deliverySummary: {
        total: 1,
        billable: 1,
        withAttachments: 1,
        rawEmailBytes: 512,
        byFinalStatus: { delivered: 1 },
        byMonth: { "2026-05": 1 },
      },
      manualBillingEvents: [
        {
          id: "event-1",
          telegramUserId: "1",
          paidThroughAt: "2026-06-01T00:00:00.000Z",
          paymentReference: "wise-1",
        },
      ],
    });
  });
});
