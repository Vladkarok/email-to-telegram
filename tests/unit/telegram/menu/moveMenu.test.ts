import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

const mockFindAliasById = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
}));

const mockMoveAliasWithCas = vi.fn();
vi.mock("../../../../src/db/repos/aliasRouting.js", () => ({
  moveAliasWithCas: (...args: unknown[]): unknown => mockMoveAliasWithCas(...args),
}));

const mockFindChatById = vi.fn();
vi.mock("../../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
}));

const mockGetAccessibleChats = vi.fn();
const mockCanManageAlias = vi.fn();
vi.mock("../../../../src/telegram/authorization.js", () => ({
  getAccessibleChats: (...args: unknown[]): unknown => mockGetAccessibleChats(...args),
  canManageAlias: (...args: unknown[]): unknown => mockCanManageAlias(...args),
}));

const mockCanActorUseMoveTarget = vi.fn();
vi.mock("../../../../src/telegram/moveTarget.js", () => ({
  canActorUseMoveTarget: (...args: unknown[]): unknown => mockCanActorUseMoveTarget(...args),
}));

// The move runs inside the TARGET chat's migration lock; pass the same handle
// through so the repo call still sees the test's db stub.
const mockWithChatMigrationLock = vi.fn(
  async (dbHandle: unknown, _chatId: bigint, work: (tx: unknown) => Promise<unknown>) =>
    work(dbHandle),
);
vi.mock("../../../../src/telegram/chatMigration.js", () => ({
  withChatMigrationLock: (...args: unknown[]): unknown =>
    mockWithChatMigrationLock(...(args as Parameters<typeof mockWithChatMigrationLock>)),
}));

vi.mock("../../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { editMovePickerMenu, editMoveConfirmMenu, executeAliasMove } =
  await import("../../../../src/telegram/menu/moveMenu.js");

const ALIAS_ID = "550e8400-e29b-41d4-a716-446655440000";
const alias = {
  id: ALIAS_ID,
  fullAddress: "alerts@example.com",
  chatId: -100n,
  messageThreadId: null as bigint | null,
  createdBy: 7n,
  routingVersion: 3,
  status: "active",
};

const db = {} as never;

describe("editMovePickerMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAliasById.mockResolvedValue(alias);
    mockGetAccessibleChats.mockResolvedValue([]);
  });

  it("lists other manageable chats and carries the routing version", async () => {
    mockGetAccessibleChats.mockResolvedValue([
      { id: -100n, title: "Current", type: "supergroup" },
      { id: -200n, title: "Other Group", type: "supergroup" },
      { id: -300n, title: "News", type: "channel" },
    ]);
    const ctx = createMockCtx({});

    await editMovePickerMenu(ctx, db, ALIAS_ID);

    const [, opts] = ctx.editMessageText.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } },
    ];
    const buttons = opts.reply_markup.inline_keyboard.flat();
    const targets = buttons.map((b) => b.callback_data).filter((d) => d.startsWith("mt:"));

    // The alias's current chat is never offered as a target.
    expect(targets.some((d) => d.includes(":-100:"))).toBe(false);
    expect(targets).toContain(`mt:${ALIAS_ID}:-200:3`);
    // Channels are offered, with their own icon.
    expect(targets).toContain(`mt:${ALIAS_ID}:-300:3`);
    expect(buttons.find((b) => b.callback_data === `mt:${ALIAS_ID}:-300:3`)?.text).toContain("📢");
  });

  it("offers the actor's own DM as an escape hatch when browsing FROM that DM", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    const actorId = ctx.from!.id;
    // createMockCtx keys the chat id off the group by default; a real DM has
    // chat.id === from.id, which is exactly the condition being tested.
    (ctx.chat as { id: number }).id = actorId;

    await editMovePickerMenu(ctx, db, ALIAS_ID);

    const [, opts] = ctx.editMessageText.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { callback_data: string }[][] } },
    ];
    const targets = opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(targets).toContain(`mt:${ALIAS_ID}:${actorId}:3`);
  });

  it("hides the own-DM option when browsing from a group", async () => {
    // The confirm step would reject it (the DM cannot be proven live from
    // here), so offering it would only produce a denial two taps later.
    const ctx = createMockCtx({});
    const actorId = ctx.from!.id;

    await editMovePickerMenu(ctx, db, ALIAS_ID);

    const [, opts] = ctx.editMessageText.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { callback_data: string }[][] } },
    ];
    const targets = opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(targets).not.toContain(`mt:${ALIAS_ID}:${actorId}:3`);
  });
});

describe("editMoveConfirmMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAliasById.mockResolvedValue(alias);
    mockFindChatById.mockResolvedValue({ id: -200n, title: "Other Group", type: "supergroup" });
  });

  it("builds a confirm button that carries alias, target and version", async () => {
    const ctx = createMockCtx({});

    await editMoveConfirmMenu(ctx, db, ALIAS_ID, -200n, 3);

    const [text, opts] = ctx.editMessageText.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { callback_data: string }[][] } },
    ];
    expect(text).toContain("Other Group");
    const data = opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toContain(`mc:${ALIAS_ID}:-200:3`);
  });
});

describe("executeAliasMove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAliasById.mockResolvedValue(alias);
    mockFindChatById.mockResolvedValue({ id: -200n, title: "Other Group", type: "supergroup" });
    mockCanManageAlias.mockResolvedValue(true);
    mockCanActorUseMoveTarget.mockResolvedValue({ ok: true });
    mockMoveAliasWithCas.mockResolvedValue({ ok: true, alias: { ...alias, chatId: -200n } });
    mockWithChatMigrationLock.mockImplementation(
      async (dbHandle: unknown, _chatId: bigint, work: (tx: unknown) => Promise<unknown>) =>
        work(dbHandle),
    );
  });

  it("holds the TARGET chat's migration lock across the move", async () => {
    const ctx = createMockCtx({});

    await executeAliasMove(ctx, db, ALIAS_ID, -200n, 3);

    expect(mockWithChatMigrationLock).toHaveBeenCalledWith(db, -200n, expect.any(Function));
  });

  it("refuses to land on a target the migration already deactivated", async () => {
    mockFindChatById.mockResolvedValue({
      id: -200n,
      title: "Gone",
      type: "supergroup",
      isActive: false,
    });
    const ctx = createMockCtx({});

    await executeAliasMove(ctx, db, ALIAS_ID, -200n, 3);

    expect(mockMoveAliasWithCas).not.toHaveBeenCalled();
  });

  it("re-checks the source alias FRESH before mutating", async () => {
    const ctx = createMockCtx({});

    await executeAliasMove(ctx, db, ALIAS_ID, -200n, 3);

    expect(mockCanManageAlias).toHaveBeenCalledWith(db, ctx.api, ctx.from!.id, ALIAS_ID, {
      fresh: true,
    });
  });

  it("passes the authorized version and pre-move route to the CAS move", async () => {
    const ctx = createMockCtx({});

    await executeAliasMove(ctx, db, ALIAS_ID, -200n, 3);

    expect(mockMoveAliasWithCas).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        aliasId: ALIAS_ID,
        expectedVersion: 3,
        newChatId: -200n,
        oldChatId: -100n,
        oldThreadId: null,
        aliasOwnerId: 7n,
        authzPath: "admin",
      }),
    );
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("Other Group"),
      expect.anything(),
    );
  });

  it("denies when the mover lost access to the source alias", async () => {
    mockCanManageAlias.mockResolvedValue(false);
    const ctx = createMockCtx({});

    await executeAliasMove(ctx, db, ALIAS_ID, -200n, 3);

    expect(mockMoveAliasWithCas).not.toHaveBeenCalled();
  });

  it("explains the denial and mutates nothing when the target rejects", async () => {
    mockCanActorUseMoveTarget.mockResolvedValue({ ok: false, reason: "cannot_post" });
    const ctx = createMockCtx({});

    await executeAliasMove(ctx, db, ALIAS_ID, -200n, 3);

    expect(mockMoveAliasWithCas).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("cannot post"),
      expect.anything(),
    );
  });

  it("treats the actor's own id as a private target and passes the interaction chat", async () => {
    mockFindChatById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    (ctx.chat as { id: number }).id = ctx.from!.id;

    await executeAliasMove(ctx, db, ALIAS_ID, BigInt(ctx.from!.id), 3);

    // interactionChatId is what lets the predicate accept an own-DM target.
    expect(mockCanActorUseMoveTarget).toHaveBeenCalledWith(
      ctx.api,
      expect.objectContaining({
        chatType: "private",
        actorId: ctx.from!.id,
        interactionChatId: BigInt(ctx.from!.id),
      }),
    );
  });

  it("reports a version conflict instead of claiming success", async () => {
    mockMoveAliasWithCas.mockResolvedValue({ ok: false, reason: "version_conflict" });
    const ctx = createMockCtx({});

    await executeAliasMove(ctx, db, ALIAS_ID, -200n, 3);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("changed"),
      expect.anything(),
    );
  });
});
