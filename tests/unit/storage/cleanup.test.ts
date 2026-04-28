import { describe, it, expect, vi, beforeEach } from "vitest";
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
  decrementOrganizationStorageUsage: (...args: unknown[]): unknown =>
    mockDecrementOrganizationStorageUsage(...args),
}));

const { runCleanup } = await import("../../../src/storage/cleanup.js");

function makeDb(
  expiredAttachments: {
    id: string;
    storagePath: string;
    sizeBytes?: number | null;
    organizationId?: string | null;
    createdAt?: Date;
    organizationPlanCode?: string | null;
    organizationSubscriptionStatus?: string | null;
    organizationCurrentPeriodEnd?: Date | null;
  }[] = [],
  expiredRawLogs: {
    id: string;
    rawEmailPath: string | null;
    rawSizeBytes?: number | null;
    organizationId?: string | null;
    receivedAt?: Date;
    organizationPlanCode?: string | null;
    organizationSubscriptionStatus?: string | null;
    organizationCurrentPeriodEnd?: Date | null;
  }[] = [],
  deliveryLogCandidates: {
    id: string;
    createdAt?: Date;
    rawEmailPath?: string | null;
    organizationPlanCode?: string | null;
    organizationSubscriptionStatus?: string | null;
    organizationCurrentPeriodEnd?: Date | null;
  }[] = [],
) {
  const defaultOldDate = new Date("2025-01-01T00:00:00.000Z");
  const attachmentRows = expiredAttachments.map((row) => ({
    createdAt: defaultOldDate,
    organizationPlanCode: null,
    organizationSubscriptionStatus: null,
    organizationCurrentPeriodEnd: null,
    ...row,
  }));
  const rawLogRows = expiredRawLogs.map((row) => ({
    receivedAt: defaultOldDate,
    organizationPlanCode: null,
    organizationSubscriptionStatus: null,
    organizationCurrentPeriodEnd: null,
    ...row,
  }));
  const deliveryLogRows = deliveryLogCandidates.map((row) => ({
    createdAt: defaultOldDate,
    rawEmailPath: null,
    organizationPlanCode: null,
    organizationSubscriptionStatus: null,
    organizationCurrentPeriodEnd: null,
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
        organizationId: "org-1",
      },
    ]);
    await runCleanup(db, config);
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/attachments/log-id/file.bin");
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), "org-1", {
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
          organizationId: "org-1",
        },
      ],
    );

    await runCleanup(db, config);

    expect(mockDeleteFile).toHaveBeenCalledWith("/data/rawemails/2025-01-01/log-1.eml");
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), "org-1", {
      rawEmailBytes: 42n,
    });
    expect(db._mocks.updateSet).toHaveBeenCalledWith({
      rawEmailPath: null,
      rawEmailEncryptionMode: "none",
      rawEmailWrappedDek: null,
      rawEmailKekKeyId: null,
      rawEmailEncryptedAt: null,
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      { rows: 1 },
      "cleanup: cleared expired raw email references",
    );
  });

  it("applies free-plan retention before the global attachment TTL", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const db = makeDb([
      {
        id: "att-free",
        storagePath: "/data/attachments/free/file.bin",
        sizeBytes: 10,
        organizationId: "org-free",
        createdAt: eightDaysAgo,
        organizationPlanCode: "free",
        organizationSubscriptionStatus: "free",
      },
      {
        id: "att-personal",
        storagePath: "/data/attachments/personal/file.bin",
        sizeBytes: 10,
        organizationId: "org-personal",
        createdAt: eightDaysAgo,
        organizationPlanCode: "personal",
        organizationSubscriptionStatus: "active",
      },
      {
        id: "att-self-hosted",
        storagePath: "/data/attachments/self-hosted/file.bin",
        sizeBytes: 10,
        organizationId: null,
        createdAt: eightDaysAgo,
      },
    ]);

    await runCleanup(db, longRetentionConfig);

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
          organizationId: "org-canceled",
          receivedAt: eightDaysAgo,
          organizationPlanCode: "pro",
          organizationSubscriptionStatus: "canceled",
        },
        {
          id: "raw-active",
          rawEmailPath: "/data/rawemails/active/message.eml",
          rawSizeBytes: 42,
          organizationId: "org-active",
          receivedAt: eightDaysAgo,
          organizationPlanCode: "pro",
          organizationSubscriptionStatus: "active",
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

  it("keeps attachment row and storage usage unchanged when attachment file deletion fails", async () => {
    const db = makeDb([
      {
        id: "att-1",
        storagePath: "/data/attachments/log-id/file.bin",
        sizeBytes: 10,
        organizationId: "org-1",
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
          organizationId: "org-1",
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
        organizationId: "org-1",
      },
    ]);
    db._mocks.attachmentDeleteWhere
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ rowCount: 1 });

    await runCleanup(db, config);
    await runCleanup(db, config);

    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledTimes(1);
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), "org-1", {
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
          organizationId: "org-1",
        },
      ],
    );
    db._mocks.updateWhere
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ rowCount: 1 });

    await runCleanup(db, config);
    await runCleanup(db, config);

    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledTimes(1);
    expect(mockDecrementOrganizationStorageUsage).toHaveBeenCalledWith(expect.anything(), "org-1", {
      rawEmailBytes: 42n,
    });
  });

  it("retries attachment storage decrement when the transactional decrement fails", async () => {
    const db = makeDb([
      {
        id: "att-1",
        storagePath: "/data/attachments/log-id/file.bin",
        sizeBytes: 10,
        organizationId: "org-1",
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
          organizationId: "org-1",
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
          organizationPlanCode: "pro",
          organizationSubscriptionStatus: "active",
        },
        {
          id: "log-free",
          createdAt: fortyDaysAgo,
          organizationPlanCode: "free",
          organizationSubscriptionStatus: "free",
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
});
