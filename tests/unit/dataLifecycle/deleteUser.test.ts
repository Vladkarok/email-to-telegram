import { describe, it, expect, vi, beforeEach } from "vitest";
import { chats, deliveryLogs, emailAddresses, organizations } from "../../../src/db/schema.js";

const mockDeleteFile = vi.fn();

vi.mock("../../../src/storage/disk.js", () => ({
  deleteFile: (...args: unknown[]): unknown => mockDeleteFile(...args),
}));

const { deleteHostedUser } =
  await import("../../../src/dataLifecycle/deleteUser.js");

function makeDb({
  userExists = true,
  rawRows = [],
  attachmentRows = [],
}: {
  userExists?: boolean;
  rawRows?: { rawEmailPath: string | null }[];
  attachmentRows?: { storagePath: string }[];
}) {
  let selectCallCount = 0;
  const deletedTables: unknown[] = [];
  const deleteWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
  const execute = vi.fn().mockResolvedValue(undefined);
  const select = vi.fn(() => {
    selectCallCount += 1;

    if (selectCallCount === 1) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(userExists ? [{ id: 123n }] : []),
          }),
        }),
      };
    }

    if (selectCallCount === 2) {
      return {
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(rawRows),
          }),
        }),
      };
    }

    return {
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(attachmentRows),
          }),
        }),
      }),
    };
  });
  const tx = {
    execute,
    select,
    delete: vi.fn((table: unknown) => {
      deletedTables.push(table);
      return { where: deleteWhere };
    }),
  };
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx));

  return {
    transaction,
    _mocks: {
      deletedTables,
      deleteWhere,
      execute,
      transaction,
    },
  } as unknown as Parameters<typeof deleteHostedUser>[0] & {
    _mocks: {
      deletedTables: unknown[];
      deleteWhere: ReturnType<typeof vi.fn>;
      execute: ReturnType<typeof vi.fn>;
      transaction: ReturnType<typeof vi.fn>;
    };
  };
}

describe("deleteHostedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteFile.mockResolvedValue(undefined);
  });

  it("returns without side effects when the organization does not exist", async () => {
    const db = makeDb({ userExists: false });

    await expect(deleteHostedUser(db, 123n)).resolves.toEqual({
      deleted: false,
      rawEmailFiles: 0,
      attachmentFiles: 0,
      failedFileDeletes: [],
    });

    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(db._mocks.transaction).toHaveBeenCalledTimes(1);
    expect(db._mocks.execute).toHaveBeenCalledTimes(1);
    expect(db._mocks.deleteWhere).not.toHaveBeenCalled();
  });

  it("deletes organization data under lock before deleting stored files", async () => {
    const db = makeDb({
      rawRows: [
        { rawEmailPath: "/data/raw/a.eml" },
        { rawEmailPath: "/data/raw/a.eml" },
        { rawEmailPath: null },
      ],
      attachmentRows: [
        { storagePath: "/data/attachments/a.bin" },
        { storagePath: "/data/attachments/b.bin" },
      ],
    });

    await expect(deleteHostedUser(db, 123n)).resolves.toEqual({
      deleted: true,
      rawEmailFiles: 1,
      attachmentFiles: 2,
      failedFileDeletes: [],
    });

    expect(mockDeleteFile).toHaveBeenCalledWith("/data/raw/a.eml");
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/attachments/a.bin");
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/attachments/b.bin");
    expect(mockDeleteFile).toHaveBeenCalledTimes(3);
    expect(db._mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteFile.mock.invocationCallOrder[0] ?? 0,
    );
    expect(db._mocks.deleteWhere.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockDeleteFile.mock.invocationCallOrder[0] ?? 0,
    );
    expect(db._mocks.execute).toHaveBeenCalledTimes(1);
    expect(db._mocks.deletedTables).toEqual([deliveryLogs, emailAddresses, chats, organizations]);
  });

  it("does not delete files when database deletion fails", async () => {
    const db = makeDb({
      rawRows: [{ rawEmailPath: "/data/raw/a.eml" }],
    });
    db._mocks.deleteWhere.mockRejectedValueOnce(new Error("db down"));

    await expect(deleteHostedUser(db, 123n)).rejects.toThrow("db down");

    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("attempts every file and reports file deletion failures after database deletion commits", async () => {
    const db = makeDb({
      rawRows: [{ rawEmailPath: "/data/raw/a.eml" }],
      attachmentRows: [{ storagePath: "/data/attachments/a.bin" }],
    });
    mockDeleteFile.mockRejectedValueOnce(new Error("disk busy"));

    await expect(deleteHostedUser(db, 123n)).resolves.toEqual({
      deleted: true,
      rawEmailFiles: 1,
      attachmentFiles: 1,
      failedFileDeletes: ["/data/raw/a.eml"],
    });

    expect(db._mocks.transaction).toHaveBeenCalledTimes(1);
    expect(db._mocks.deleteWhere).toHaveBeenCalled();
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
  });
});
