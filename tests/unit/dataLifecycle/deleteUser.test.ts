import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDeleteFile = vi.fn();

vi.mock("../../../src/storage/disk.js", () => ({
  deleteFile: (...args: unknown[]): unknown => mockDeleteFile(...args),
}));

const { deleteHostedUser } = await import("../../../src/dataLifecycle/deleteUser.js");

function makeDb({
  userExists = true,
  rawRows = [] as { rawEmailPath: string | null }[],
  attachmentRows = [] as { storagePath: string }[],
}: {
  userExists?: boolean;
  rawRows?: { rawEmailPath: string | null }[];
  attachmentRows?: { storagePath: string }[];
}) {
  let selectCallCount = 0;
  const deleteWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
  const execute = vi.fn().mockResolvedValue(undefined);

  const select = vi.fn(() => {
    selectCallCount += 1;
    if (selectCallCount === 1) {
      // user exists check: .from().where().limit()
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(userExists ? [{ id: 1n }] : []),
          })),
        })),
      };
    }
    if (selectCallCount === 2) {
      // listRawEmailPaths: .from().where()
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(rawRows),
        })),
      };
    }
    // listAttachmentPaths: .from().innerJoin().where()
    return {
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(attachmentRows),
        })),
      })),
    };
  });

  const del = vi.fn(() => ({ where: deleteWhere }));
  const tx = { execute, select, delete: del };
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx));
  return { db: { transaction } as never };
}

describe("deleteHostedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteFile.mockResolvedValue(undefined);
  });

  it("returns deleted=false when the user does not exist", async () => {
    const { db } = makeDb({ userExists: false });
    const result = await deleteHostedUser(db, 1n);
    expect(result.deleted).toBe(false);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("deletes user data and removes referenced files", async () => {
    const { db } = makeDb({
      rawRows: [{ rawEmailPath: "/raw/a.eml" }, { rawEmailPath: "/raw/b.eml" }],
      attachmentRows: [{ storagePath: "/att/x.bin" }],
    });
    const result = await deleteHostedUser(db, 1n);
    expect(result.deleted).toBe(true);
    expect(result.rawEmailFiles).toBe(2);
    expect(result.attachmentFiles).toBe(1);
    expect(mockDeleteFile).toHaveBeenCalledTimes(3);
    expect(result.failedFileDeletes).toEqual([]);
  });

  it("reports failed file deletes without aborting", async () => {
    mockDeleteFile.mockImplementation((path: string) => {
      if (path === "/raw/b.eml") return Promise.reject(new Error("io"));
      return Promise.resolve();
    });
    const { db } = makeDb({
      rawRows: [{ rawEmailPath: "/raw/a.eml" }, { rawEmailPath: "/raw/b.eml" }],
      attachmentRows: [],
    });
    const result = await deleteHostedUser(db, 1n);
    expect(result.deleted).toBe(true);
    expect(result.failedFileDeletes).toEqual(["/raw/b.eml"]);
  });
});
