import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockDeleteFile = vi.fn();
const mockDeleteDir = vi.fn();

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

const { runCleanup } = await import("../../../src/storage/cleanup.js");

function makeDb(expiredAttachments: { storagePath: string }[] = []) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(expiredAttachments),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({ rowCount: expiredAttachments.length }),
    }),
  } as unknown as Parameters<typeof runCleanup>[0];
}

const config = {
  attachmentDir: "/data/attachments",
  rawEmailDir: "/data/rawemails",
  attachmentTtlHours: 336,
  rawEmailTtlHours: 336,
};

describe("runCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteFile.mockResolvedValue(undefined);
    mockDeleteDir.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ mtime: new Date(0) }); // very old
  });

  it("runs without error when there is nothing to clean", async () => {
    const db = makeDb([]);
    await expect(runCleanup(db, config)).resolves.not.toThrow();
  });

  it("deletes files for expired attachments", async () => {
    const db = makeDb([{ storagePath: "/data/attachments/log-id/file.bin" }]);
    await runCleanup(db, config);
    expect(mockDeleteFile).toHaveBeenCalledWith("/data/attachments/log-id/file.bin");
  });

  it("removes old raw email directories", async () => {
    mockReaddir
      .mockResolvedValueOnce([]) // attachmentDir readdir (orphaned dirs check)
      .mockResolvedValueOnce([{ name: "2025-01-01", isDirectory: () => true }]); // rawEmailDir readdir
    const db = makeDb([]);
    await runCleanup(db, config);
    expect(mockDeleteDir).toHaveBeenCalledWith("/data/rawemails/2025-01-01");
  });

  it("does not throw when directories do not exist", async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const db = makeDb([]);
    await expect(runCleanup(db, config)).resolves.not.toThrow();
  });
});
