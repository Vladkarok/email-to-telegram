import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

const mockFindAliasById = vi.fn();
const mockListAllowRules = vi.fn();

vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
}));

vi.mock("../../../../src/db/repos/allowRules.js", () => ({
  listAllowRules: (...args: unknown[]): unknown => mockListAllowRules(...args),
}));

const { sendAllowRulesMenu, editAllowRulesMenu } =
  await import("../../../../src/telegram/menu/allowRulesMenu.js");

const fakeDb = {} as Parameters<typeof sendAllowRulesMenu>[1];

const fakeAlias = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  localPart: "alerts-ab12cd",
  fullAddress: "alerts-ab12cd@example.com",
  chatId: -100n,
  status: "active",
  renderMode: "plaintext",
  privacyModeEnabled: false,
  bodyDedupEnabled: false,
};

describe("sendAllowRulesMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends warning when no rules", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await sendAllowRulesMenu(ctx, fakeDb, fakeAlias.id);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toMatch(/all mail is rejected/i);
  });

  it("sends rule list when rules exist", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([
      { id: "rule-1", matchType: "domain", matchValue: "github.com" },
      { id: "rule-2", matchType: "exact_email", matchValue: "user@example.com" },
    ]);
    const ctx = createMockCtx({ chatType: "private" });
    await sendAllowRulesMenu(ctx, fakeDb, fakeAlias.id);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text, opts] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string }[][] } },
    ];
    expect(text).toContain("2 allow rule");
    // Each rule should be a delete button
    const buttons = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttons.some((t) => t.includes("github.com"))).toBe(true);
    expect(buttons.some((t) => t.includes("user@example.com"))).toBe(true);
  });

  it("does nothing if alias not found", async () => {
    mockFindAliasById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await sendAllowRulesMenu(ctx, fakeDb, "nonexistent");
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe("editAllowRulesMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("edits message with warning when no rules", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAllowRulesMenu(ctx, fakeDb, fakeAlias.id);
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toMatch(/all mail is rejected/i);
  });

  it("edits message with rule count and delete buttons when rules exist", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([
      { id: "rule-1", matchType: "domain", matchValue: "github.com" },
    ]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAllowRulesMenu(ctx, fakeDb, fakeAlias.id);
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toContain("1 allow rule");
  });

  it("calls answerCallbackQuery when alias not found", async () => {
    mockFindAliasById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await editAllowRulesMenu(ctx, fakeDb, "nonexistent");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it("includes Add Rule and Back buttons", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAllowRulesMenu(ctx, fakeDb, fakeAlias.id);
    const [, opts] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string }[][] } },
    ];
    const buttons = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttons.some((t) => t.includes("Add Rule"))).toBe(true);
    expect(buttons.some((t) => t.includes("Back"))).toBe(true);
  });
});
