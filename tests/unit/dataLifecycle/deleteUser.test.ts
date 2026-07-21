import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDeleteFile = vi.fn();

vi.mock("../../../src/storage/disk.js", () => ({
  deleteFile: (...args: unknown[]): unknown => mockDeleteFile(...args),
}));

const { deleteHostedUser } = await import("../../../src/dataLifecycle/deleteUser.js");
const { aliasMoveEvents } = await import("../../../src/db/schema.js");

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
  // Anonymising a third party's audit row is an UPDATE, not a DELETE.
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const tx = { execute, select, delete: del, update };
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx));
  return { db: { transaction } as never, update, updateSet };
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

  it("erases the user's own move-audit rows and anonymises them as a third-party actor", async () => {
    const { db, update, updateSet } = makeDb({ rawRows: [], attachmentRows: [] });

    await deleteHostedUser(db, 1n);

    // Rows they OWN are personal data and are deleted with the rest; rows
    // where they were merely the actor belong to another user's audit trail,
    // so only the actor id is nulled — deleting them would erase a third
    // party's record.
    expect(update).toHaveBeenCalledWith(aliasMoveEvents);
    expect(updateSet).toHaveBeenCalledWith({ actorId: null });
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
