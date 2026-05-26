import { describe, it, expect, vi, beforeEach } from "vitest";

const { exportHostedUserData, EXPORT_SCHEMA_VERSION } =
  await import("../../../src/dataLifecycle/exportUser.js");

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

interface MockRows {
  aliases?: unknown[];
  allowRules?: unknown[];
  inboundDomains?: unknown[];
  chats?: unknown[];
  usageMonths?: unknown[];
  storageUsage?: unknown[];
  deliveryLogs?: unknown[];
  deliveryAttempts?: unknown[];
  attachments?: unknown[];
  manualBillingEvents?: unknown[];
}

function makeDb(userRow: Record<string, unknown> | null, rows: MockRows = {}) {
  // Order matches exportHostedUserData internals:
  // 1: user lookup
  // 2: aliases (awaited before the parallel batch)
  // 3-11: allowRules, inboundDomains, chats, usageMonths, storageUsage,
  //       deliveryLogs, deliveryAttempts, attachments, manualBillingEvents
  const selectResponses: unknown[][] = [
    userRow ? [userRow] : [],
    rows.aliases ?? [],
    rows.allowRules ?? [],
    rows.inboundDomains ?? [],
    rows.chats ?? [],
    rows.usageMonths ?? [],
    rows.storageUsage ?? [],
    rows.deliveryLogs ?? [],
    rows.deliveryAttempts ?? [],
    rows.attachments ?? [],
    rows.manualBillingEvents ?? [],
  ];
  let call = 0;
  const select = vi.fn(() => {
    const next = selectResponses[call] ?? [];
    call += 1;
    return selectChainResolvingTo(next);
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

  it("returns an export envelope with the v2 schema and full per-row data", async () => {
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
          label: "Ops alerts",
          renderMode: "plaintext",
          privacyModeEnabled: true,
          bodyDedupEnabled: false,
          createdAt: new Date("2025-01-03T00:00:00.000Z"),
        },
      ],
      allowRules: [
        {
          id: "rule-1",
          emailAddressId: "alias-1",
          matchType: "domain",
          matchValue: "example.com",
          authRequirement: "authenticated",
          createdAt: new Date("2025-01-04T00:00:00.000Z"),
        },
      ],
      inboundDomains: [
        {
          id: "dom-1",
          domain: "custom.example.com",
          kind: "custom",
          status: "active",
          verifiedAt: new Date("2025-01-05T00:00:00.000Z"),
          createdAt: new Date("2025-01-04T00:00:00.000Z"),
        },
      ],
      chats: [
        {
          id: -100n,
          title: "Ops chat",
          type: "supergroup",
          isActive: true,
          createdAt: new Date("2025-01-02T00:00:00.000Z"),
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
      deliveryLogs: [
        {
          id: "log-1",
          emailAddressId: "alias-1",
          messageIdHeader: "<abc@example.com>",
          envelopeFrom: "sender@example.com",
          headerFrom: "Sender <sender@example.com>",
          subject: "Hello",
          receivedAt: new Date("2026-05-10T00:00:00.000Z"),
          rawSizeBytes: 512,
          hasAttachments: true,
          bodyDedupApplied: false,
          finalStatus: "delivered",
          billable: true,
        },
      ],
      deliveryAttempts: [
        {
          id: "att-1",
          deliveryLogId: "log-1",
          attemptNo: 1,
          targetChatId: -100n,
          targetThreadId: 42n,
          telegramMessageId: 999n,
          status: "succeeded",
          errorText: null,
          createdAt: new Date("2026-05-10T00:00:01.000Z"),
        },
      ],
      attachments: [
        {
          id: "file-1",
          deliveryLogId: "log-1",
          originalFilename: "report.pdf",
          contentType: "application/pdf",
          sizeBytes: 1024,
          sha256: "deadbeef",
          createdAt: new Date("2026-05-10T00:00:00.500Z"),
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
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: "2026-05-18T00:00:00.000Z",
      user: { id: "1", username: "alice" },
      chats: [{ id: "-100", title: "Ops chat", type: "supergroup" }],
      aliases: [{ id: "alias-1", chatId: "-100", label: "Ops alerts" }],
      allowRules: [{ id: "rule-1", matchValue: "example.com", authRequirement: "authenticated" }],
      inboundDomains: [{ id: "dom-1", domain: "custom.example.com", kind: "custom" }],
      usageMonths: [{ month: "2026-05", egressBytes: "123" }],
      storageUsage: { rawEmailBytes: "100", attachmentBytes: "200" },
      deliveryLogs: [
        {
          id: "log-1",
          envelopeFrom: "sender@example.com",
          subject: "Hello",
          receivedAt: "2026-05-10T00:00:00.000Z",
          finalStatus: "delivered",
        },
      ],
      deliveryAttempts: [
        {
          id: "att-1",
          deliveryLogId: "log-1",
          targetChatId: "-100",
          telegramMessageId: "999",
          status: "succeeded",
        },
      ],
      attachments: [
        {
          id: "file-1",
          originalFilename: "report.pdf",
          contentType: "application/pdf",
          sizeBytes: 1024,
        },
      ],
      deliverySummary: {
        total: 1,
        billable: 1,
        withAttachments: 1,
        rawEmailBytes: 512,
        byFinalStatus: { delivered: 1 },
        byMonth: { "2026-05": 1 },
      },
      manualBillingEvents: [{ id: "event-1", paymentReference: "wise-1" }],
    });
  });
});
