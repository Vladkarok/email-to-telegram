import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindAliasById = vi.fn();
const mockFindAliasesByCreator = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
  findAliasesByCreator: (...args: unknown[]): unknown => mockFindAliasesByCreator(...args),
}));

const mockProbe = vi.fn();
vi.mock("../../../src/telegram/orphanProbe.js", () => ({
  probeChatReachability: (...args: unknown[]): unknown => mockProbe(...args),
}));

const { canRecoverOrphanAlias, listRecoverableOrphans } =
  await import("../../../src/telegram/orphanRecovery.js");

const CREATOR = 42;
const OTHER_USER = 99;
const db = {} as never;
const api = {} as never;

const alias = {
  id: "alias-1",
  createdBy: BigInt(CREATOR),
  chatId: -100n,
  status: "active",
};

describe("canRecoverOrphanAlias", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAliasById.mockResolvedValue(alias);
    mockProbe.mockResolvedValue("dead");
  });

  it("allows the creator when the chat is definitively dead", async () => {
    await expect(canRecoverOrphanAlias(db, api, CREATOR, "alias-1")).resolves.toBe(true);
  });

  it("denies a non-creator admin of the same dead chat", async () => {
    await expect(canRecoverOrphanAlias(db, api, OTHER_USER, "alias-1")).resolves.toBe(false);
  });

  it("denies the creator while the chat is still reachable", async () => {
    mockProbe.mockResolvedValue("reachable");
    await expect(canRecoverOrphanAlias(db, api, CREATOR, "alias-1")).resolves.toBe(false);
  });

  it("denies on an unknown verdict — a transient outage grants nothing", async () => {
    mockProbe.mockResolvedValue("unknown");
    await expect(canRecoverOrphanAlias(db, api, CREATOR, "alias-1")).resolves.toBe(false);
  });

  it("denies for a deleted alias", async () => {
    mockFindAliasById.mockResolvedValue({ ...alias, status: "deleted" });
    await expect(canRecoverOrphanAlias(db, api, CREATOR, "alias-1")).resolves.toBe(false);
  });

  it("denies for a missing alias", async () => {
    mockFindAliasById.mockResolvedValue(null);
    await expect(canRecoverOrphanAlias(db, api, CREATOR, "alias-1")).resolves.toBe(false);
  });

  it("forwards a fresh probe request for mutation confirmations", async () => {
    await canRecoverOrphanAlias(db, api, CREATOR, "alias-1", { fresh: true });

    const [, chatId, options] = mockProbe.mock.calls[0] as [
      unknown,
      bigint,
      { fresh?: boolean; onMigrate?: unknown },
    ];
    expect(chatId).toBe(-100n);
    expect(options.fresh).toBe(true);
  });

  it("always supplies the migration-repair hook so a migrated chat gets fixed", async () => {
    await canRecoverOrphanAlias(db, api, CREATOR, "alias-1");

    const [, , options] = mockProbe.mock.calls[0] as [unknown, bigint, { onMigrate?: unknown }];
    expect(typeof options.onMigrate).toBe("function");
  });
});

describe("listRecoverableOrphans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only aliases whose chat is dead, probing each chat once", async () => {
    mockFindAliasesByCreator.mockResolvedValue([
      { id: "a1", chatId: -100n, status: "active", createdBy: BigInt(CREATOR) },
      { id: "a2", chatId: -100n, status: "active", createdBy: BigInt(CREATOR) },
      { id: "a3", chatId: -200n, status: "active", createdBy: BigInt(CREATOR) },
    ]);
    mockProbe.mockImplementation((_api: unknown, chatId: bigint) =>
      Promise.resolve(chatId === -100n ? "dead" : "reachable"),
    );

    const orphans = await listRecoverableOrphans(db, api, CREATOR);

    expect(orphans.map((a) => a.id)).toEqual(["a1", "a2"]);
    // Two aliases share a chat: one probe covers both.
    expect(mockProbe).toHaveBeenCalledTimes(2);
  });

  it("excludes deleted aliases and returns empty when the user has none", async () => {
    mockFindAliasesByCreator.mockResolvedValue([
      { id: "a1", chatId: -100n, status: "deleted", createdBy: BigInt(CREATOR) },
    ]);
    mockProbe.mockResolvedValue("dead");

    await expect(listRecoverableOrphans(db, api, CREATOR)).resolves.toEqual([]);
    expect(mockProbe).not.toHaveBeenCalled();
  });
});
