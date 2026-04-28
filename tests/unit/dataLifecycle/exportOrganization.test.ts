import { describe, it, expect, vi } from "vitest";

const { exportHostedOrganizationData } =
  await import("../../../src/dataLifecycle/exportOrganization.js");

function chain<T>(value: T) {
  const builder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(value),
    limit: vi.fn().mockResolvedValue(value),
    then: (resolve: (value: T) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
  return builder;
}

function makeDb(results: unknown[]) {
  let index = 0;
  return {
    select: vi.fn(() => chain(results[index++])),
  } as unknown as Parameters<typeof exportHostedOrganizationData>[0];
}

describe("exportHostedOrganizationData", () => {
  it("returns null when the organization does not exist", async () => {
    const db = makeDb([[]]);

    await expect(exportHostedOrganizationData(db, "org-1")).resolves.toBeNull();
  });

  it("exports organization metadata, aliases, usage, storage, and delivery summaries", async () => {
    const db = makeDb([
      [
        {
          id: "org-1",
          name: "Acme",
          planCode: "pro",
          subscriptionStatus: "active",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
      [
        {
          id: "alias-1",
          localPart: "alerts",
          fullAddress: "alerts@example.com",
          status: "active",
          chatId: 123n,
          messageThreadId: 456n,
          renderMode: "html",
          privacyModeEnabled: true,
          bodyDedupEnabled: false,
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      ],
      [
        {
          month: "2026-04",
          deliveredCount: 10,
          rejectedCount: 2,
          egressBytes: 1234n,
        },
      ],
      [{ rawEmailBytes: 100n, attachmentBytes: 200n }],
      [
        {
          finalStatus: "delivered",
          billable: true,
          hasAttachments: true,
          rawSizeBytes: 42,
          receivedAt: new Date("2026-04-10T12:00:00.000Z"),
        },
        {
          finalStatus: "failed",
          billable: false,
          hasAttachments: false,
          rawSizeBytes: null,
          receivedAt: new Date("2026-04-11T12:00:00.000Z"),
        },
      ],
    ]);

    await expect(
      exportHostedOrganizationData(db, "org-1", new Date("2026-04-28T07:00:00.000Z")),
    ).resolves.toEqual({
      exportedAt: "2026-04-28T07:00:00.000Z",
      organization: {
        id: "org-1",
        name: "Acme",
        planCode: "pro",
        subscriptionStatus: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      aliases: [
        {
          id: "alias-1",
          localPart: "alerts",
          fullAddress: "alerts@example.com",
          status: "active",
          chatId: "123",
          messageThreadId: "456",
          renderMode: "html",
          privacyModeEnabled: true,
          bodyDedupEnabled: false,
          createdAt: "2026-01-03T00:00:00.000Z",
        },
      ],
      usageMonths: [
        {
          month: "2026-04",
          deliveredCount: 10,
          rejectedCount: 2,
          egressBytes: "1234",
        },
      ],
      storageUsage: {
        rawEmailBytes: "100",
        attachmentBytes: "200",
      },
      deliverySummary: {
        total: 2,
        billable: 1,
        withAttachments: 1,
        rawEmailBytes: 42,
        byFinalStatus: {
          delivered: 1,
          failed: 1,
        },
        byMonth: {
          "2026-04": 2,
        },
      },
    });
  });

  it("defaults missing storage usage to zero", async () => {
    const db = makeDb([
      [
        {
          id: "org-1",
          name: "Acme",
          planCode: "free",
          subscriptionStatus: "free",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
      [],
      [],
      [],
      [],
    ]);

    const result = await exportHostedOrganizationData(
      db,
      "org-1",
      new Date("2026-04-28T07:00:00.000Z"),
    );

    expect(result?.storageUsage).toEqual({
      rawEmailBytes: "0",
      attachmentBytes: "0",
    });
  });
});
