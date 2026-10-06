import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { attachments } from "../../../src/db/schema.js";

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => mockLogger,
}));

const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockDeleteFile = vi.fn();
const mockDeleteDir = vi.fn();
const mockDecrementOrganizationStorageUsage = vi.fn();

vi.mock("fs/promises", () => ({
  readdir: (...args: unknown[]): unknown => mockReaddir(...args),
  stat: (...args: unknown[]): unknown => mockStat(...args),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("")),
}));

vi.mock("../../../src/storage/disk.js", () => ({
  deleteFile: (...args: unknown[]): unknown => mockDeleteFile(...args),
  deleteDir: (...args: unknown[]): unknown => mockDeleteDir(...args),
}));

vi.mock("../../../src/db/repos/storageUsage.js", () => ({
  decrementUserStorageUsage: (...args: unknown[]): unknown =>
    mockDecrementOrganizationStorageUsage(...args),
}));

const mockDeleteExpiredDeliveryViewLinks = vi.fn().mockResolvedValue(0);
const mockDeleteExpiredAttachmentLinks = vi.fn().mockResolvedValue(0);

vi.mock("../../../src/db/repos/deliveryViewLinks.js", () => ({
  deleteExpiredDeliveryViewLinks: (...args: unknown[]): unknown =>
    mockDeleteExpiredDeliveryViewLinks(...args),
}));

vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  deleteExpiredAttachmentLinks: (...args: unknown[]): unknown =>
    mockDeleteExpiredAttachmentLinks(...args),
}));

const mockDeleteExpiredAliasTombstones = vi.fn().mockResolvedValue(0);

vi.mock("../../../src/db/repos/aliases.js", () => ({
  deleteExpiredAliasTombstones: (...args: unknown[]): unknown =>
    mockDeleteExpiredAliasTombstones(...args),
}));

const mockDeleteOldQuotaNotifications = vi.fn().mockResolvedValue(0);

vi.mock("../../../src/db/repos/quotaNotifications.js", () => ({
  deleteOldQuotaNotifications: (...args: unknown[]): unknown =>
    mockDeleteOldQuotaNotifications(...args),
}));

const mockReconcileFirstDeliveredMarkers = vi.fn().mockResolvedValue(0);
const mockClearExpiredActivationTokens = vi.fn().mockResolvedValue(0);

vi.mock("../../../src/db/repos/aliasActivation.js", () => ({
  reconcileFirstDeliveredMarkers: (...args: unknown[]): unknown =>
    mockReconcileFirstDeliveredMarkers(...args),
  clearExpiredActivationTokens: (...args: unknown[]): unknown =>
    mockClearExpiredActivationTokens(...args),
}));

const { runCleanup, deliveryLogHasNoAttachments, broadRetentionCandidateCutoff } =
  await import("../../../src/storage/cleanup.js");
const { applyPlanLimitOverrides } = await import("../../../src/billing/plans.js");
const { metricsRegistry, resetMetricsForTests } =
  await import("../../../src/observability/metrics.js");

function makeDb(
  expiredAttachments: {
    id: string;
    storagePath: string;
    sizeBytes?: number | null;
    userId?: bigint | null;
    createdAt?: Date;
    userPlanCode?: string | null;
    userSubscriptionStatus?: string | null;
    userCurrentPeriodEnd?: Date | null;
    userPaidThroughAt?: Date | null;
  }[] = [],
  expiredRawLogs: {
    id: string;
    rawEmailPath: string | null;
    rawSizeBytes?: number | null;
    userId?: bigint | null;
    receivedAt?: Date;
    userPlanCode?: string | null;
    userSubscriptionStatus?: string | null;
    userCurrentPeriodEnd?: Date | null;
    userPaidThroughAt?: Date | null;
  }[] = [],
  deliveryLogCandidates: {
    id: string;
    createdAt?: Date;
    rawEmailPath?: string | null;
    userPlanCode?: string | null;
    userSubscriptionStatus?: string | null;
    userCurrentPeriodEnd?: Date | null;
    userPaidThroughAt?: Date | null;
  }[] = [],
) {
  const defaultOldDate = new Date("2025-01-01T00:00:00.000Z");
  const attachmentRows = expiredAttachments.map((row) => ({
    createdAt: defaultOldDate,
    userPlanCode: null,
    userSubscriptionStatus: null,
    userCurrentPeriodEnd: null,
    userPaidThroughAt: null,
    ...row,
  }));
  const rawLogRows = expiredRawLogs.map((row) => ({
    receivedAt: defaultOldDate,
    userPlanCode: null,
    userSubscriptionStatus: null,
    userCurrentPeriodEnd: null,
    userPaidThroughAt: null,
    ...row,
  }));
  const deliveryLogRows = deliveryLogCandidates.map((row) => ({
    createdAt: defaultOldDate,
    rawEmailPath: null,
    userPlanCode: null,
    userSubscriptionStatus: null,
    userCurrentPeriodEnd: null,
    userPaidThroughAt: null,
    ...row,
  }));
  const attachmentDeleteWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
  const deliveryLogDeleteWhere = vi.fn().mockResolvedValue({ rowCount: 0 });
  const updateWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
  const updateSet = vi.fn(() => ({
    where: updateWhere,
  }));
  let selectCallCount = 0;
  const select = vi.fn().mockImplementation(() => {
    selectCallCount += 1;
    const runSelectIndex = ((selectCallCount - 1) % 3) + 1;
    if (runSelectIndex === 1) {
      return {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(attachmentRows),
            }),
          }),
        }),
      };
    }

    if (runSelectIndex === 2) {
      return {
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(rawLogRows),
          }),
        }),
      };
    }

    return {
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deliveryLogRows),
        }),
      }),
    };
  });
  return {
    select,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        delete: vi.fn().mockImplementation((table) => ({
          where: table === attachments ? attachmentDeleteWhere : deliveryLogDeleteWhere,
        })),
        update: vi.fn(() => ({
          set: updateSet,
        })),
      }),
    delete: vi.fn().mockImplementation((table) => ({
      where: table === attachments ? attachmentDeleteWhere : deliveryLogDeleteWhere,
    })),
    update: vi.fn(() => ({
      set: updateSet,
    })),
    _mocks: {
      attachmentDeleteWhere,
      deliveryLogDeleteWhere,
      updateSet,
      updateWhere,
    },
  } as unknown as Parameters<typeof runCleanup>[0] & {
    _mocks: {
      attachmentDeleteWhere: ReturnType<typeof vi.fn>;
      deliveryLogDeleteWhere: ReturnType<typeof vi.fn>;
      updateSet: ReturnType<typeof vi.fn>;
      updateWhere: ReturnType<typeof vi.fn>;
    };
  };
}

const config = {
  attachmentDir: "/data/attachments",
  rawEmailDir: "/data/rawemails",
  attachmentTtlHours: 336,
  rawEmailTtlHours: 336,
  deliveryLogRetentionDays: 30,
};

const longRetentionConfig = {
  ...config,
  attachmentTtlHours: 24 * 365,
  rawEmailTtlHours: 24 * 365,
};

describe("runCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockDeleteFile.mockResolvedValue(undefined);
    mockDeleteDir.mockResolvedValue(undefined);
    mockDecrementOrganizationStorageUsage.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ mtime: new Date(0) }); // very old
    mockDeleteExpiredDeliveryViewLinks.mockResolvedValue(0);
    mockDeleteExpiredAttachmentLinks.mockResolvedValue(0);
    mockDeleteExpiredAliasTombstones.mockResolvedValue(0);
  });

  it("runs without error when there is nothing to clean", async () => {
    const db = makeDb([]);
    await expect(runCleanup(db, config)).resolves.not.toThrow();
  });

  it("deletes files for expired attachments", async () => {
    const db = makeDb([
      {
        id: "att-1",
        storagePath: "/data/attachments/log-id/file.bin",
        sizeBytes: 10,
        userId: 1n,
      },
    ]);
    await runCleanup(db, config);
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/attachments/log-id/file.bin");
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), 1n, {
      attachmentBytes: 10n,
    });
  });

  it("removes old raw email directories", async () => {
    mockReaddir
      .mockResolvedValueOnce([]) // attachmentDir readdir (orphaned dirs check)
      .mockResolvedValueOnce([{ name: "2025-01-01", isDirectory: () => true }]) // rawEmailDir readdir
      .mockResolvedValueOnce([]); // rawEmailDir/2025-01-01 entries
    const db = makeDb([]);
    await runCleanup(db, config);
    expect(mockDeleteDir).toHaveBeenCalledWith("/data/rawemails/2025-01-01");
  });

  it("does not throw when directories do not exist", async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const db = makeDb([]);
    await expect(runCleanup(db, config)).resolves.not.toThrow();
  });

  it("clears expired raw email references after the raw-email TTL", async () => {
    const db = makeDb(
      [],
      [
        {
          id: "log-1",
          rawEmailPath: "/data/rawemails/2025-01-01/log-1.eml",
          rawSizeBytes: 42,
          userId: 1n,
        },
      ],
    );

    await runCleanup(db, config);

    expect(mockDeleteFile).toHaveBeenCalledWith("/data/rawemails/2025-01-01/log-1.eml");
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), 1n, {
      rawEmailBytes: 42n,
    });
    expect(db._mocks.updateSet).toHaveBeenCalledWith({
      rawEmailPath: null,
      rawEmailEncryptionMode: "none",
      rawEmailWrappedDek: null,
      rawEmailKekKeyId: null,
      rawEmailEncryptedAt: null,
      // SQL CASE closing undelivered logs as permanently_failed — the expired
      // raw file was their only retry source.
      finalStatus: expect.anything() as unknown,
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      { rows: 1 },
      "cleanup: cleared expired raw email references",
    );
  });

  describe("raw-email expiry closing undelivered logs", () => {
    const expiredLog = {
      id: "log-1",
      rawEmailPath: "/data/rawemails/2025-01-01/log-1.eml",
      rawSizeBytes: 42,
      userId: 1n,
    };
    const lostAtCleanup = async (): Promise<number> => {
      const text = await metricsRegistry.getSingleMetricAsString(
        "email_to_telegram_deliveries_lost_total",
      );
      return Number(/\{stage="cleanup"[^}]*\} ([\d.]+)/.exec(text)?.[1]);
    };

    beforeEach(() => {
      resetMetricsForTests();
    });

    it("counts a log it closes as lost (stage cleanup)", async () => {
      const db = makeDb([], [expiredLog]);

      await runCleanup(db, config);

      // One guarded statement both closes the log and clears the raw path.
      expect(db._mocks.updateWhere).toHaveBeenCalledTimes(1);
      expect(db._mocks.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ rawEmailPath: null, finalStatus: "permanently_failed" }),
      );
      expect(await lostAtCleanup()).toBe(1);
    });

    it("only clears the raw path of an already-final log, without counting a loss", async () => {
      const db = makeDb([], [expiredLog]);
      // The status guard matched nothing: the log was already delivered.
      db._mocks.updateWhere.mockResolvedValueOnce({ rowCount: 0 });

      await runCleanup(db, config);

      expect(db._mocks.updateSet).toHaveBeenCalledTimes(2);
      expect(db._mocks.updateSet).toHaveBeenLastCalledWith({
        rawEmailPath: null,
        rawEmailEncryptionMode: "none",
        rawEmailWrappedDek: null,
        rawEmailKekKeyId: null,
        rawEmailEncryptedAt: null,
      });
      expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), 1n, {
        rawEmailBytes: 42n,
      });
      expect(await lostAtCleanup()).toBe(0);
    });

    it("does not count a loss when the close is rolled back", async () => {
      const db = makeDb([], [expiredLog]);
      mockDecrementOrganizationStorageUsage.mockRejectedValueOnce(new Error("transient"));

      await runCleanup(db, config);

      expect(await lostAtCleanup()).toBe(0);
    });
  });

  it("applies free-plan retention before the global attachment TTL", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const db = makeDb([
      {
        id: "att-free",
        storagePath: "/data/attachments/free/file.bin",
        sizeBytes: 10,
        userId: "org-free",
        createdAt: eightDaysAgo,
        userPlanCode: "free",
        userSubscriptionStatus: "free",
      },
      {
        id: "att-personal",
        storagePath: "/data/attachments/personal/file.bin",
        sizeBytes: 10,
        userId: "org-personal",
        createdAt: eightDaysAgo,
        userPlanCode: "personal",
        userSubscriptionStatus: "active",
      },
      {
        id: "att-self-hosted",
        storagePath: "/data/attachments/self-hosted/file.bin",
        sizeBytes: 10,
        userId: null,
        createdAt: eightDaysAgo,
      },
    ]);

    await runCleanup(db, config);

    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/attachments/free/file.bin");
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(
      expect.anything(),
      "org-free",
      {
        attachmentBytes: 10n,
      },
    );
  });

  it("applies effective free retention to inactive paid raw emails", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const db = makeDb(
      [],
      [
        {
          id: "raw-canceled",
          rawEmailPath: "/data/rawemails/canceled/message.eml",
          rawSizeBytes: 42,
          userId: "org-canceled",
          receivedAt: eightDaysAgo,
          userPlanCode: "pro",
          userSubscriptionStatus: "canceled",
        },
        {
          id: "raw-active",
          rawEmailPath: "/data/rawemails/active/message.eml",
          rawSizeBytes: 42,
          userId: "org-active",
          receivedAt: eightDaysAgo,
          userPlanCode: "pro",
          userSubscriptionStatus: "active",
        },
      ],
    );

    await runCleanup(db, longRetentionConfig);

    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/rawemails/canceled/message.eml");
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(
      expect.anything(),
      "org-canceled",
      {
        rawEmailBytes: 42n,
      },
    );
  });

  it("keeps active paid storage through plan retention even when the global file TTL is shorter", async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    const db = makeDb(
      [
        {
          id: "att-pro",
          storagePath: "/data/attachments/pro/file.bin",
          sizeBytes: 10,
          userId: "org-pro",
          createdAt: twentyDaysAgo,
          userPlanCode: "pro",
          userSubscriptionStatus: "active",
        },
      ],
      [
        {
          id: "raw-pro",
          rawEmailPath: "/data/rawemails/pro/message.eml",
          rawSizeBytes: 42,
          userId: "org-pro",
          receivedAt: twentyDaysAgo,
          userPlanCode: "pro",
          userSubscriptionStatus: "active",
        },
      ],
    );

    await runCleanup(db, config);

    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockDecrementOrganizationStorageUsage).not.toHaveBeenCalled();
  });

  it("keeps attachment row and storage usage unchanged when file deletion fails", async () => {
    // File-first ordering: a failed unlink skips the row, so the next run
    // retries it (self-healing) rather than stranding the file.
    const db = makeDb([
      {
        id: "att-1",
        storagePath: "/data/attachments/log-id/file.bin",
        sizeBytes: 10,
        userId: 1n,
      },
    ]);
    mockDeleteFile.mockRejectedValueOnce(new Error("busy"));
    mockReaddir
      .mockResolvedValueOnce([{ name: "log-id", isDirectory: () => true }])
      .mockResolvedValueOnce(["file.bin"])
      .mockResolvedValueOnce([]);

    await runCleanup(db, config);

    expect(mockDecrementOrganizationStorageUsage).not.toHaveBeenCalled();
    expect(db._mocks.attachmentDeleteWhere).not.toHaveBeenCalled();
    expect(mockDeleteDir).not.toHaveBeenCalled();
  });

  it("keeps raw-email storage usage unchanged when raw email deletion fails", async () => {
    const db = makeDb(
      [],
      [
        {
          id: "log-1",
          rawEmailPath: "/data/rawemails/2025-01-01/log-1.eml",
          rawSizeBytes: 42,
          userId: 1n,
        },
      ],
    );
    mockDeleteFile.mockRejectedValueOnce(new Error("busy"));
    mockReaddir
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "2025-01-01", isDirectory: () => true }])
      .mockResolvedValueOnce(["log-1.eml"]);

    await runCleanup(db, config);

    expect(mockDecrementOrganizationStorageUsage).not.toHaveBeenCalled();
    expect(db._mocks.updateWhere).not.toHaveBeenCalled();
    expect(mockDeleteDir).not.toHaveBeenCalled();
  });

  it("decrements attachment storage only after the attachment row delete succeeds", async () => {
    const db = makeDb([
      {
        id: "att-1",
        storagePath: "/data/attachments/log-id/file.bin",
        sizeBytes: 10,
        userId: 1n,
      },
    ]);
    db._mocks.attachmentDeleteWhere
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ rowCount: 1 });

    await runCleanup(db, config);
    await runCleanup(db, config);

    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledTimes(1);
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), 1n, {
      attachmentBytes: 10n,
    });
  });

  it("decrements raw-email storage only after the delivery-log update succeeds", async () => {
    const db = makeDb(
      [],
      [
        {
          id: "log-1",
          rawEmailPath: "/data/rawemails/2025-01-01/log-1.eml",
          rawSizeBytes: 42,
          userId: 1n,
        },
      ],
    );
    db._mocks.updateWhere
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ rowCount: 1 });

    await runCleanup(db, config);
    await runCleanup(db, config);

    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledTimes(1);
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), 1n, {
      rawEmailBytes: 42n,
    });
  });

  it("retries attachment storage decrement when the transactional decrement fails", async () => {
    const db = makeDb([
      {
        id: "att-1",
        storagePath: "/data/attachments/log-id/file.bin",
        sizeBytes: 10,
        userId: 1n,
      },
    ]);
    mockDecrementOrganizationStorageUsage
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);

    await runCleanup(db, config);
    await runCleanup(db, config);

    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledTimes(2);
    expect(db._mocks.attachmentDeleteWhere).toHaveBeenCalledTimes(2);
  });

  it("retries raw-email storage decrement when the transactional decrement fails", async () => {
    const db = makeDb(
      [],
      [
        {
          id: "log-1",
          rawEmailPath: "/data/rawemails/2025-01-01/log-1.eml",
          rawSizeBytes: 42,
          userId: 1n,
        },
      ],
    );
    mockDecrementOrganizationStorageUsage
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);

    await runCleanup(db, config);
    await runCleanup(db, config);

    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledTimes(2);
    expect(db._mocks.updateWhere).toHaveBeenCalledTimes(2);
  });

  it("uses the configured delivery log retention when purging old rows", async () => {
    const db = makeDb([], [], [{ id: "log-old" }, { id: "log-older" }, { id: "log-oldest" }]);
    db._mocks.deliveryLogDeleteWhere.mockResolvedValue({ rowCount: 1 });

    await runCleanup(db, config);

    expect(mockLogger.info).toHaveBeenCalledWith(
      { rows: 3, retentionDays: config.deliveryLogRetentionDays },
      "cleanup: purged old delivery logs",
    );
  });

  it("keeps paid delivery logs inside their effective retention even after global log retention", async () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    const db = makeDb(
      [],
      [],
      [
        {
          id: "log-pro",
          createdAt: fortyDaysAgo,
          userPlanCode: "pro",
          userSubscriptionStatus: "active",
        },
        {
          id: "log-free",
          createdAt: fortyDaysAgo,
          userPlanCode: "free",
          userSubscriptionStatus: "free",
        },
      ],
    );

    await runCleanup(db, config);

    expect(db._mocks.deliveryLogDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it("does not purge delivery logs that still reference stored raw email", async () => {
    const db = makeDb(
      [],
      [],
      [
        {
          id: "log-with-raw",
          rawEmailPath: "/data/rawemails/log-with-raw.eml",
        },
      ],
    );

    await runCleanup(db, config);

    expect(db._mocks.deliveryLogDeleteWhere).not.toHaveBeenCalled();
  });

  it("sweeps expired delivery-view and attachment links each run", async () => {
    const db = makeDb();
    mockDeleteExpiredDeliveryViewLinks.mockResolvedValue(3);
    mockDeleteExpiredAttachmentLinks.mockResolvedValue(5);

    await runCleanup(db, config);

    expect(mockDeleteExpiredDeliveryViewLinks).toHaveBeenCalledTimes(1);
    expect(mockDeleteExpiredAttachmentLinks).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { deliveryViewLinks: 3, attachmentLinks: 5 },
      "cleanup: removed expired download links",
    );
  });

  it("isolates an expired-link cleanup failure from the rest of the run", async () => {
    const db = makeDb();
    mockDeleteExpiredDeliveryViewLinks.mockRejectedValueOnce(new Error("db down"));

    await expect(runCleanup(db, config)).resolves.toBeUndefined();

    const loggedLinkFailure = mockLogger.error.mock.calls.some(
      (call) => call[1] === "cleanup: expired link cleanup failed",
    );
    expect(loggedLinkFailure).toBe(true);
  });

  it("purges dead alias tombstones once per run with a min-age cutoff", async () => {
    const db = makeDb();
    mockDeleteExpiredAliasTombstones.mockResolvedValue(4);
    const before = Date.now();

    await runCleanup(db, config);

    expect(mockDeleteExpiredAliasTombstones).toHaveBeenCalledTimes(1);
    const [, cutoff] = mockDeleteExpiredAliasTombstones.mock.calls[0] as [unknown, Date];
    const sevenDaysMs = 7 * 24 * 3600 * 1000;
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(sevenDaysMs - 1000);
    expect(before - cutoff.getTime()).toBeLessThanOrEqual(sevenDaysMs + 60_000);
    expect(mockLogger.info).toHaveBeenCalledWith({ rows: 4 }, "cleanup: purged alias tombstones");
  });

  it("isolates a tombstone purge failure from the rest of the run", async () => {
    const db = makeDb();
    mockDeleteExpiredAliasTombstones.mockRejectedValueOnce(new Error("db down"));

    await expect(runCleanup(db, config)).resolves.toBeUndefined();

    const loggedFailure = mockLogger.error.mock.calls.some(
      (call) => call[1] === "cleanup: alias tombstone purge failed",
    );
    expect(loggedFailure).toBe(true);
  });

  describe("first-bounce notice state", () => {
    beforeEach(() => {
      mockReconcileFirstDeliveredMarkers.mockReset().mockResolvedValue(0);
      mockClearExpiredActivationTokens.mockReset().mockResolvedValue(0);
    });

    it("reconciles working-alias markers before any delivery log is purged", async () => {
      const db = makeDb([], [], [{ id: "log-old" }]);
      db._mocks.deliveryLogDeleteWhere.mockResolvedValue({ rowCount: 1 });
      mockReconcileFirstDeliveredMarkers.mockResolvedValue(2);

      await runCleanup(db, config);

      expect(mockReconcileFirstDeliveredMarkers).toHaveBeenCalledTimes(1);
      expect(mockReconcileFirstDeliveredMarkers.mock.invocationCallOrder[0]).toBeLessThan(
        db._mocks.deliveryLogDeleteWhere.mock.invocationCallOrder[0] ?? 0,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { rows: 2 },
        "cleanup: reconciled first-delivered markers",
      );
    });

    it("clears expired tokens and domains every run", async () => {
      mockClearExpiredActivationTokens.mockResolvedValue(3);

      await runCleanup(makeDb(), config);

      expect(mockClearExpiredActivationTokens).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { rows: 3 },
        "cleanup: cleared expired bounce-notice tokens",
      );
    });

    it("keeps delivery logs (the fallback evidence) when reconciliation fails, and runs the rest", async () => {
      const db = makeDb([], [], [{ id: "log-old" }]);
      db._mocks.deliveryLogDeleteWhere.mockResolvedValue({ rowCount: 1 });
      mockReconcileFirstDeliveredMarkers.mockRejectedValueOnce(new Error("db down"));
      mockClearExpiredActivationTokens.mockResolvedValue(2);

      await expect(runCleanup(db, config)).resolves.toBeUndefined();

      expect(db._mocks.deliveryLogDeleteWhere).not.toHaveBeenCalled();
      expect(mockDeleteExpiredAliasTombstones).toHaveBeenCalled();
      expect(mockDeleteOldQuotaNotifications).toHaveBeenCalled();
      expect(mockClearExpiredActivationTokens).toHaveBeenCalledTimes(1);
      const errors = mockLogger.error.mock.calls.map((call: unknown[]) => call[1]);
      expect(errors).toContain("cleanup: first-delivered marker reconciliation failed");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "cleanup: delivery log purge skipped until first-delivered markers reconcile",
      );

      // The next run reconciles, then purges.
      const nextRun = makeDb([], [], [{ id: "log-old" }]);
      nextRun._mocks.deliveryLogDeleteWhere.mockResolvedValue({ rowCount: 1 });
      await runCleanup(nextRun, config);
      expect(nextRun._mocks.deliveryLogDeleteWhere).toHaveBeenCalled();
    });

    it("isolates an expiry cleanup failure from the other passes", async () => {
      const db = makeDb([], [], [{ id: "log-old" }]);
      db._mocks.deliveryLogDeleteWhere.mockResolvedValue({ rowCount: 1 });
      mockClearExpiredActivationTokens.mockRejectedValueOnce(new Error("db down"));

      await expect(runCleanup(db, config)).resolves.toBeUndefined();

      expect(db._mocks.deliveryLogDeleteWhere).toHaveBeenCalled();
      const errors = mockLogger.error.mock.calls.map((call: unknown[]) => call[1]);
      expect(errors).toContain("cleanup: bounce-notice token cleanup failed");
    });
  });

  it("renders the no-attachments purge guard as a parenthesized NOT EXISTS subquery", () => {
    // Regression: notExists(sql`select …`) emitted `not exists select …`,
    // a syntax error that made every delivery-log purge cycle fail.
    const { sql } = new PgDialect().sqlToQuery(deliveryLogHasNoAttachments());

    expect(sql).toMatch(/not exists \(select 1/i);
  });
});

describe("broadRetentionCandidateCutoff", () => {
  const now = Date.UTC(2026, 9, 6);
  const day = 24 * 3600 * 1000;

  afterEach(() => {
    applyPlanLimitOverrides({});
  });

  it("follows the shortest plan retention, including operator overrides", () => {
    // 30-day global window; the free plan's 7 days is the shortest by default.
    expect(broadRetentionCandidateCutoff(now, 30 * 24).getTime()).toBe(now - 7 * day);

    applyPlanLimitOverrides({ free: { retentionDays: 3 } });
    expect(broadRetentionCandidateCutoff(now, 30 * 24).getTime()).toBe(now - 3 * day);
  });
});
