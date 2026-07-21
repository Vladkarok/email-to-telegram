import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

const mockFindAliasById = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
}));

const mockSoftDeleteAliasWithCas = vi.fn();
vi.mock("../../../../src/db/repos/aliasRouting.js", () => ({
  softDeleteAliasWithCas: (...args: unknown[]): unknown => mockSoftDeleteAliasWithCas(...args),
}));

const mockCanRecoverOrphanAlias = vi.fn();
vi.mock("../../../../src/telegram/orphanRecovery.js", () => ({
  canRecoverOrphanAlias: (...args: unknown[]): unknown => mockCanRecoverOrphanAlias(...args),
}));

vi.mock("../../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { editOrphanMenu, executeOrphanDelete } =
  await import("../../../../src/telegram/menu/orphanMenu.js");

const ALIAS_ID = "550e8400-e29b-41d4-a716-446655440000";
const alias = {
  id: ALIAS_ID,
  fullAddress: "alerts@example.com",
  chatId: -100n,
  createdBy: 7n,
  routingVersion: 2,
  status: "active",
};
const db = {} as never;

describe("editOrphanMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAliasById.mockResolvedValue(alias);
    mockCanRecoverOrphanAlias.mockResolvedValue(true);
  });

  it("exposes exactly two actions: move and delete", async () => {
    const ctx = createMockCtx({});

    await editOrphanMenu(ctx, db, ALIAS_ID);

    const [, opts] = ctx.editMessageText.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { callback_data: string }[][] } },
    ];
    const data = opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

    expect(data).toEqual([`mv:${ALIAS_ID}`, `orpd:${ALIAS_ID}:2`]);
    // No allow rules, settings, or pause/resume reachable from this surface.
    expect(
      data.some((d) => d.startsWith("al:") || d.startsWith("ac:") || d.startsWith("ap:")),
    ).toBe(false);
  });

  it("re-checks recovery eligibility FRESH", async () => {
    const ctx = createMockCtx({});

    await editOrphanMenu(ctx, db, ALIAS_ID);

    expect(mockCanRecoverOrphanAlias).toHaveBeenCalledWith(db, ctx.api, ctx.from!.id, ALIAS_ID, {
      fresh: true,
    });
  });

  it("denies when the chat became reachable again", async () => {
    mockCanRecoverOrphanAlias.mockResolvedValue(false);
    const ctx = createMockCtx({});

    await editOrphanMenu(ctx, db, ALIAS_ID);

    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.stringContaining("reachable"));
  });
});

describe("executeOrphanDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAliasById.mockResolvedValue(alias);
    mockCanRecoverOrphanAlias.mockResolvedValue(true);
    mockSoftDeleteAliasWithCas.mockResolvedValue({ ok: true, alias });
  });

  it("deletes under the version guard and confirms", async () => {
    const ctx = createMockCtx({});

    await executeOrphanDelete(ctx, db, ALIAS_ID, 2);

    expect(mockSoftDeleteAliasWithCas).toHaveBeenCalledWith(db, {
      aliasId: ALIAS_ID,
      expectedVersion: 2,
    });
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("deleted"),
      expect.anything(),
    );
  });

  it("refuses a stale orphan callback once the chat is reachable again", async () => {
    mockCanRecoverOrphanAlias.mockResolvedValue(false);
    const ctx = createMockCtx({});

    await executeOrphanDelete(ctx, db, ALIAS_ID, 2);

    expect(mockSoftDeleteAliasWithCas).not.toHaveBeenCalled();
  });

  it("reports a version conflict rather than claiming deletion", async () => {
    mockSoftDeleteAliasWithCas.mockResolvedValue({ ok: false, reason: "version_conflict" });
    const ctx = createMockCtx({});

    await executeOrphanDelete(ctx, db, ALIAS_ID, 2);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("changed"),
      expect.anything(),
    );
  });
});
