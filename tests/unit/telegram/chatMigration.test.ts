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
const mockListAliasOwnersByChat = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  repointAliasesToChat: (...args: unknown[]): unknown => mockRepointAliasesToChat(...args),
  listAliasOwnersByChat: (...args: unknown[]): unknown => mockListAliasOwnersByChat(...args),
}));

const mockInvalidateReachabilityCache = vi.fn();
vi.mock("../../../src/telegram/orphanProbe.js", () => ({
  invalidateReachabilityCache: (...args: unknown[]): unknown =>
    mockInvalidateReachabilityCache(...args),
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

const mockInvalidateChatAuthorizationCache = vi.fn();
vi.mock("../../../src/telegram/authorization.js", () => ({
  invalidateChatAuthorizationCache: (...args: unknown[]): unknown =>
    mockInvalidateChatAuthorizationCache(...args),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
  repairChatMigration,
  withChatMigrationLock,
  migrateToChatIdHandler,
  migrateFromChatIdHandler,
} = await import("../../../src/telegram/chatMigration.js");

const OLD_ID = -100123n;
const NEW_ID = -1002222333444n;

const oldRow = { id: OLD_ID, title: "Old Group", type: "group", isActive: true };
const newRow = { id: NEW_ID, title: "Already Registered", type: "supergroup", isActive: true };

function makeApi(getChat: () => Promise<unknown> = () => Promise.reject(new Error("unused"))) {
  return { getChat: vi.fn(getChat) } as never;
}

/** findChatById responder keyed by chat id. */
function stubChatRows(rows: { old?: unknown; new?: unknown }): void {
  mockFindChatById.mockImplementation((_db: unknown, id: bigint) => {
    if (id === OLD_ID) return Promise.resolve(rows.old ?? null);
    if (id === NEW_ID) return Promise.resolve(rows.new ?? null);
    return Promise.resolve(null);
  });
}

describe("repairChatMigration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue(undefined);
    mockRepointAliasesToChat.mockResolvedValue([
      { id: "alias-1", createdBy: 7n, messageThreadId: null },
      { id: "alias-2", createdBy: 8n, messageThreadId: 12n },
      { id: "alias-3", createdBy: 7n, messageThreadId: null },
    ]);
    mockInsertAliasMoveEvent.mockResolvedValue(undefined);
    mockUpsertChat.mockResolvedValue(undefined);
    mockDeactivateChat.mockResolvedValue(undefined);
    mockListAliasOwnersByChat.mockResolvedValue([8n, 7n]);
  });

  it("re-keys the chat and its aliases under the old-id migration lock", async () => {
    stubChatRows({ old: oldRow });
    const api = makeApi(() => Promise.resolve({ title: "Upgraded Group", type: "supergroup" }));

    const result = await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID);

    expect(result).toEqual({ aliasCount: 3 });
    // Advisory lock acquired before any repo work inside the transaction.
    expect(execute).toHaveBeenCalled();
    const lockOrder = execute.mock.invocationCallOrder[0];
    for (const call of mockRepointAliasesToChat.mock.invocationCallOrder) {
      expect(lockOrder).toBeLessThan(call);
    }
    expect(mockUpsertChat).toHaveBeenCalledWith(expect.anything(), {
      id: NEW_ID,
      title: "Upgraded Group",
      type: "supergroup",
    });
    expect(mockRepointAliasesToChat).toHaveBeenCalledWith(expect.anything(), OLD_ID, NEW_ID);
    expect(mockDeactivateChat).toHaveBeenCalledWith(expect.anything(), OLD_ID);
    expect(mockInvalidateChatAuthorizationCache).toHaveBeenCalledWith(OLD_ID);
    expect(mockInvalidateChatAuthorizationCache).toHaveBeenCalledWith(NEW_ID);
    // A stale reachability verdict for either id would otherwise keep
    // granting (or denying) orphan recovery for a chat that just moved.
    expect(mockInvalidateReachabilityCache).toHaveBeenCalledWith(OLD_ID);
    expect(mockInvalidateReachabilityCache).toHaveBeenCalledWith(NEW_ID);
  });

  it("locks every affected owner BEFORE re-keying, ascending", async () => {
    stubChatRows({ old: oldRow });

    await repairChatMigration(fakeDb as never, makeApi(), OLD_ID, NEW_ID, {
      title: "New",
      type: "supergroup",
    });

    // repointAliasesToChat is an UPDATE and takes alias row locks. Every other
    // writer locks owner-then-row, so taking the owner locks afterwards would
    // invert the order and deadlock against moves and /delete_me.
    const lockOrders = execute.mock.invocationCallOrder;
    const repointOrder = mockRepointAliasesToChat.mock.invocationCallOrder[0];
    expect(lockOrders.length).toBeGreaterThanOrEqual(3); // chat lock + 2 owners
    for (const order of lockOrders) {
      expect(order).toBeLessThan(repointOrder);
    }
    // Chat lock first, then one lock per distinct owner. The repo returned
    // them as [8n, 7n]; lockOrder sorts before they are acquired.
    expect(execute).toHaveBeenCalledTimes(3);
    expect(mockListAliasOwnersByChat).toHaveBeenCalledWith(expect.anything(), OLD_ID);
  });

  it("uses provided metadata (migrate_from context) without calling getChat", async () => {
    stubChatRows({ old: oldRow });
    const api = makeApi();

    await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID, {
      title: "New Chat",
      type: "supergroup",
    });

    expect((api as { getChat: ReturnType<typeof vi.fn> }).getChat).not.toHaveBeenCalled();
    expect(mockUpsertChat).toHaveBeenCalledWith(expect.anything(), {
      id: NEW_ID,
      title: "New Chat",
      type: "supergroup",
    });
  });

  it("preserves a pre-registered target chat row", async () => {
    stubChatRows({ old: oldRow, new: newRow });
    const api = makeApi();

    await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID);

    expect((api as { getChat: ReturnType<typeof vi.fn> }).getChat).not.toHaveBeenCalled();
    expect(mockUpsertChat).not.toHaveBeenCalled();
    expect(mockRepointAliasesToChat).toHaveBeenCalledWith(expect.anything(), OLD_ID, NEW_ID);
  });

  it("falls back to the old title and supergroup type when getChat fails", async () => {
    stubChatRows({ old: oldRow });
    const api = makeApi(() => Promise.reject(new Error("chat fetch failed")));

    await repairChatMigration(fakeDb as never, api, OLD_ID, NEW_ID);

    // Never records the new row as type "group" (contract: metadata precedence).
    expect(mockUpsertChat).toHaveBeenCalledWith(expect.anything(), {
      id: NEW_ID,
      title: "Old Group",
      type: "supergroup",
    });
  });

  it("writes one audit event per affected alias, sharing one operation id", async () => {
    stubChatRows({ old: oldRow });

    await repairChatMigration(fakeDb as never, makeApi(), OLD_ID, NEW_ID, {
      title: "New",
      type: "supergroup",
    });

    expect(mockInsertAliasMoveEvent).toHaveBeenCalledTimes(3);
    const events = mockInsertAliasMoveEvent.mock.calls.map(
      ([, event]) => event as Record<string, unknown>,
    );
    const operationIds = new Set(events.map((e) => e["operationId"]));
    expect(operationIds.size).toBe(1);
    expect([...operationIds][0]).toEqual(expect.any(String));

    // A migration has no human actor and its own authorization path.
    // `outcome` is left to insertAliasMoveEvent's default (covered by its own
    // test): a failed re-key rolls the transaction back, so no migration
    // event can exist with any outcome other than succeeded.
    for (const event of events) {
      expect(event).toMatchObject({
        actorId: null,
        authzPath: "migration",
        oldChatId: OLD_ID,
        newChatId: NEW_ID,
      });
    }
    // Owner is denormalized per alias, and the pre-migration thread is kept
    // for forensics (an id migration preserves topics — it is not a move).
    expect(events.map((e) => e["aliasOwnerId"])).toEqual([7n, 8n, 7n]);
    expect(events.map((e) => e["oldThreadId"])).toEqual([null, 12n, null]);
  });

  it("writes the audit inside the repair transaction", async () => {
    stubChatRows({ old: oldRow });
    mockInsertAliasMoveEvent.mockRejectedValue(new Error("audit insert failed"));

    await expect(
      repairChatMigration(fakeDb as never, makeApi(), OLD_ID, NEW_ID, {
        title: "New",
        type: "supergroup",
      }),
    ).rejects.toThrow("audit insert failed");
  });

  it("replaying a processed migration is a no-op-safe success", async () => {
    stubChatRows({ old: { ...oldRow, isActive: false }, new: newRow });
    mockRepointAliasesToChat.mockResolvedValue([]);

    const result = await repairChatMigration(fakeDb as never, makeApi(), OLD_ID, NEW_ID);

    expect(result).toEqual({ aliasCount: 0 });
    expect(mockUpsertChat).not.toHaveBeenCalled();
  });
});

describe("migration service-message handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue(undefined);
    mockRepointAliasesToChat.mockResolvedValue([
      { id: "alias-1", createdBy: 7n, messageThreadId: null },
    ]);
    mockInsertAliasMoveEvent.mockResolvedValue(undefined);
    stubChatRows({ old: oldRow });
  });

  it("migrate_to: repairs old→new without trusting the (old) update chat metadata", async () => {
    const api = makeApi(() => Promise.resolve({ title: "Fetched", type: "supergroup" }));
    const ctx = {
      message: { migrate_to_chat_id: Number(NEW_ID) },
      chat: { id: Number(OLD_ID), type: "group", title: "Old Group" },
      api,
    };

    await migrateToChatIdHandler(ctx as never);

    expect(mockRepointAliasesToChat).toHaveBeenCalledWith(expect.anything(), OLD_ID, NEW_ID);
    // Metadata came from getChat, not from the old chat's context.
    expect(mockUpsertChat).toHaveBeenCalledWith(expect.anything(), {
      id: NEW_ID,
      title: "Fetched",
      type: "supergroup",
    });
  });

  it("migrate_from: repairs old→new using the new chat's context as metadata", async () => {
    const api = makeApi();
    const ctx = {
      message: { migrate_from_chat_id: Number(OLD_ID) },
      chat: { id: Number(NEW_ID), type: "supergroup", title: "New Chat" },
      api,
    };

    await migrateFromChatIdHandler(ctx as never);

    expect((api as { getChat: ReturnType<typeof vi.fn> }).getChat).not.toHaveBeenCalled();
    expect(mockRepointAliasesToChat).toHaveBeenCalledWith(expect.anything(), OLD_ID, NEW_ID);
    expect(mockUpsertChat).toHaveBeenCalledWith(expect.anything(), {
      id: NEW_ID,
      title: "New Chat",
      type: "supergroup",
    });
  });

  it("ignores updates without a migration id", async () => {
    await migrateToChatIdHandler({ message: {}, chat: { id: 1 } } as never);
    await migrateFromChatIdHandler({ message: {}, chat: { id: 1 } } as never);
    expect(mockRepointAliasesToChat).not.toHaveBeenCalled();
  });
});

describe("withChatMigrationLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue(undefined);
  });

  it("acquires the per-chat advisory lock before running the work", async () => {
    const work = vi.fn().mockResolvedValue("done");

    const result = await withChatMigrationLock(fakeDb as never, OLD_ID, work);

    expect(result).toBe("done");
    expect(execute).toHaveBeenCalledOnce();
    const lockOrder = execute.mock.invocationCallOrder[0];
    const workOrder = work.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(workOrder);
  });
});
