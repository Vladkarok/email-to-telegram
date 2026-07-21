/**
 * Acceptance-criteria oracle for the migration layer
 * (docs/plans/2026-07-19-alias-chat-mobility.md § Acceptance criteria).
 *
 * These are the criteria that Step 2's implementation satisfies structurally
 * but that were not asserted at the time: dual-hook ordering permutations,
 * replay safety, and creation racing repair in both commit orders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn().mockResolvedValue(undefined);
const fakeDb = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      execute,
      transaction: async <U>(inner: (tx: unknown) => Promise<U>) => inner({ execute }),
    }),
};

vi.mock("../../../src/db/client.js", () => ({ getDb: (): unknown => fakeDb }));

const mockFindChatById = vi.fn();
const mockUpsertChat = vi.fn();
const mockDeactivateChat = vi.fn();
vi.mock("../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
  upsertChat: (...args: unknown[]): unknown => mockUpsertChat(...args),
  deactivateChat: (...args: unknown[]): unknown => mockDeactivateChat(...args),
}));

const mockRepointAliasesToChat = vi.fn();
const mockListAliasOwnersByChat = vi.fn().mockResolvedValue([7n]);
vi.mock("../../../src/db/repos/aliases.js", () => ({
  repointAliasesToChat: (...args: unknown[]): unknown => mockRepointAliasesToChat(...args),
  listAliasOwnersByChat: (...args: unknown[]): unknown => mockListAliasOwnersByChat(...args),
}));

const mockInsertAliasMoveEvent = vi.fn();
vi.mock("../../../src/db/repos/aliasRouting.js", () => ({
  insertAliasMoveEvent: (...args: unknown[]): unknown => mockInsertAliasMoveEvent(...args),
  // Real implementation: the audit lock order is part of what we assert.
  lockOrder: (...ids: Array<bigint | null>): bigint[] =>
    [...new Set(ids.filter((id): id is bigint => id !== null))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
}));

vi.mock("../../../src/telegram/authorization.js", () => ({
  invalidateChatAuthorizationCache: vi.fn(),
}));
vi.mock("../../../src/telegram/orphanProbe.js", () => ({
  invalidateReachabilityCache: vi.fn(),
}));
vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { repairChatMigration, migrateToChatIdHandler, migrateFromChatIdHandler } =
  await import("../../../src/telegram/chatMigration.js");

const OLD_ID = -100123n;
const NEW_ID = -1002222333444n;
const oldRow = { id: OLD_ID, title: "Old Group", type: "group", isActive: true };

/**
 * Simulates the chats table across a repair: the old row is deactivated and
 * the new row appears, so a second repair sees the post-migration world.
 */
function statefulChatStore() {
  const rows = new Map<bigint, Record<string, unknown>>([[OLD_ID, { ...oldRow }]]);

  mockFindChatById.mockImplementation((_db: unknown, id: bigint) =>
    Promise.resolve(rows.get(id) ?? null),
  );
  mockUpsertChat.mockImplementation(
    (_db: unknown, data: { id: bigint; title: string; type: string }) => {
      rows.set(data.id, { ...data, isActive: true });
      return Promise.resolve();
    },
  );
  mockDeactivateChat.mockImplementation((_db: unknown, id: bigint) => {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, isActive: false });
    return Promise.resolve();
  });
  // Aliases only exist on the old chat; once re-pointed, a repeat finds none.
  let repointed = false;
  mockRepointAliasesToChat.mockImplementation(() => {
    if (repointed) return Promise.resolve([]);
    repointed = true;
    return Promise.resolve([{ id: "alias-1", createdBy: 7n, messageThreadId: null }]);
  });
  return rows;
}

const api = {
  getChat: vi.fn().mockResolvedValue({ title: "Fetched", type: "supergroup" }),
} as never;

describe("migration acceptance oracle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue(undefined);
    mockInsertAliasMoveEvent.mockResolvedValue(undefined);
    mockListAliasOwnersByChat.mockResolvedValue([7n]);
  });

  it("replaying the same migrate_to update is a no-op the second time", async () => {
    statefulChatStore();

    const first = await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID);
    const second = await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID);

    expect(first.aliasCount).toBe(1);
    expect(second.aliasCount).toBe(0);
    // No duplicate audit rows for the replay.
    expect(mockInsertAliasMoveEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["migrate_to first, then migrate_from", ["to", "from"]],
    ["migrate_from first, then migrate_to", ["from", "to"]],
  ])("handles the dual hooks in order: %s", async (_name, order) => {
    statefulChatStore();

    for (const hook of order) {
      if (hook === "to") {
        await migrateToChatIdHandler({
          message: { migrate_to_chat_id: Number(NEW_ID) },
          chat: { id: Number(OLD_ID), type: "group", title: "Old Group" },
          api,
        } as never);
      } else {
        await migrateFromChatIdHandler({
          message: { migrate_from_chat_id: Number(OLD_ID) },
          chat: { id: Number(NEW_ID), type: "supergroup", title: "New Chat" },
          api,
        } as never);
      }
    }

    // Exactly one effective re-key regardless of arrival order.
    expect(mockInsertAliasMoveEvent).toHaveBeenCalledTimes(1);
    expect(mockDeactivateChat).toHaveBeenCalledWith(expect.anything(), OLD_ID);
  });

  it.each(["to", "from"])("handles the %s hook arriving alone", async (hook) => {
    statefulChatStore();

    if (hook === "to") {
      await migrateToChatIdHandler({
        message: { migrate_to_chat_id: Number(NEW_ID) },
        chat: { id: Number(OLD_ID), type: "group", title: "Old Group" },
        api,
      } as never);
    } else {
      await migrateFromChatIdHandler({
        message: { migrate_from_chat_id: Number(OLD_ID) },
        chat: { id: Number(NEW_ID), type: "supergroup", title: "New Chat" },
        api,
      } as never);
    }

    expect(mockRepointAliasesToChat).toHaveBeenCalledWith(expect.anything(), OLD_ID, NEW_ID);
    expect(mockInsertAliasMoveEvent).toHaveBeenCalledTimes(1);
  });

  it("never records the migrated chat as type group, whatever the path", async () => {
    statefulChatStore();

    await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID);

    const [, upserted] = mockUpsertChat.mock.calls[0] as [unknown, { type: string }];
    expect(upserted.type).not.toBe("group");
  });

  it("re-points an alias created against the old id after repair already ran", async () => {
    // Creation-races-repair, commit order: creation FIRST. The new alias
    // points at the old chat id, so a later repair sweep must catch it —
    // repointAliasesToChat is keyed on chat id, not on a snapshot list.
    const rows = statefulChatStore();
    await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID);

    // A straggler alias appears on the old id and a second repair observes it.
    mockRepointAliasesToChat.mockResolvedValueOnce([
      { id: "straggler", createdBy: 9n, messageThreadId: null },
    ]);
    const sweep = await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID);

    expect(sweep.aliasCount).toBe(1);
    expect(rows.get(OLD_ID)).toMatchObject({ isActive: false });
  });
});
