import { describe, it, expect, vi, beforeEach } from "vitest";
import { chats, deliveryLogs, emailAddresses, organizations } from "../../../src/db/schema.js";

const mockDeleteFile = vi.fn();

vi.mock("../../../src/storage/disk.js", () => ({
  deleteFile: (...args: unknown[]): unknown => mockDeleteFile(...args),
}));

const { deleteHostedOrganization } =
  await import("../../../src/dataLifecycle/deleteOrganization.js");

function makeDb({
  organizationExists = true,
  rawRows = [],
  attachmentRows = [],
}: {
  organizationExists?: boolean;
  rawRows?: { rawEmailPath: string | null }[];
  attachmentRows?: { storagePath: string }[];
}) {
  let selectCallCount = 0;
  const deletedTables: unknown[] = [];
  const deleteWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
  const tx = {
    delete: vi.fn((table: unknown) => {
      deletedTables.push(table);
      return { where: deleteWhere };
    }),
  };
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx));

  return {
    select: vi.fn(() => {
      selectCallCount += 1;

      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(organizationExists ? [{ id: "org-1" }] : []),
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
    }),
    transaction,
    _mocks: {
      deletedTables,
      deleteWhere,
      transaction,
    },
  } as unknown as Parameters<typeof deleteHostedOrganization>[0] & {
    _mocks: {
      deletedTables: unknown[];
      deleteWhere: ReturnType<typeof vi.fn>;
      transaction: ReturnType<typeof vi.fn>;
    };
  };
}

describe("deleteHostedOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteFile.mockResolvedValue(undefined);
  });

  it("returns without side effects when the organization does not exist", async () => {
    const db = makeDb({ organizationExists: false });

    await expect(deleteHostedOrganization(db, "org-1")).resolves.toEqual({
      deleted: false,
      rawEmailFiles: 0,
      attachmentFiles: 0,
    });

    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(db._mocks.transaction).not.toHaveBeenCalled();
  });

  it("deletes stored files before deleting organization data", async () => {
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

    await expect(deleteHostedOrganization(db, "org-1")).resolves.toEqual({
      deleted: true,
      rawEmailFiles: 1,
      attachmentFiles: 2,
    });

    expect(mockDeleteFile).toHaveBeenCalledWith("/data/raw/a.eml");
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/attachments/a.bin");
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/attachments/b.bin");
    expect(mockDeleteFile).toHaveBeenCalledTimes(3);
    expect(mockDeleteFile.mock.invocationCallOrder.at(-1)).toBeLessThan(
      db._mocks.transaction.mock.invocationCallOrder[0] ?? 0,
    );
    expect(db._mocks.deletedTables).toEqual([deliveryLogs, emailAddresses, chats, organizations]);
  });

  it("does not delete database rows when file deletion fails", async () => {
    const db = makeDb({
      rawRows: [{ rawEmailPath: "/data/raw/a.eml" }],
    });
    mockDeleteFile.mockRejectedValueOnce(new Error("disk busy"));

    await expect(deleteHostedOrganization(db, "org-1")).rejects.toThrow("disk busy");

    expect(db._mocks.transaction).not.toHaveBeenCalled();
  });
});
