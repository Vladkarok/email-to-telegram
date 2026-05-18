import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({
  getDb: () => ({}),
}));

vi.mock("../../../../src/i18n/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/i18n/index.js")>(
    "../../../../src/i18n/index.js",
  );
  return { ...actual, resolveLocale: vi.fn(() => Promise.resolve("en")) };
});

const mockFindUserById = vi.fn();
const mockGetSummary = vi.fn();
vi.mock("../../../../src/db/repos/users.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/db/repos/users.js")>(
    "../../../../src/db/repos/users.js",
  );
  return {
    ...actual,
    findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
    getUserDeletionSummary: (...args: unknown[]): unknown => mockGetSummary(...args),
  };
});

const mockDeleteHostedUser = vi.fn();
vi.mock("../../../../src/dataLifecycle/deleteUser.js", () => ({
  deleteHostedUser: (...args: unknown[]): unknown => mockDeleteHostedUser(...args),
}));

const { deleteMeHandler, deleteMeConfirmCallback, deleteMeCancelCallback } =
  await import("../../../../src/telegram/commands/deleteme.js");

function baseUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 123456789n,
    username: "alice",
    locale: "en",
    isAllowed: true,
    planCode: "free",
    subscriptionStatus: "free",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    paidThroughAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("/delete_me command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores invocations outside private chat", async () => {
    const ctx = createMockCtx({ chatType: "supergroup" });
    await deleteMeHandler(ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("replies with success when the user has no row to delete", async () => {
    mockFindUserById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });

    await deleteMeHandler(ctx);

    expect(mockGetSummary).not.toHaveBeenCalled();
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("deleted");
  });

  it("refuses when the user has a live paid subscription", async () => {
    mockFindUserById.mockResolvedValue(
      baseUser({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active" }),
    );
    const ctx = createMockCtx({ chatType: "private" });

    await deleteMeHandler(ctx);

    expect(mockGetSummary).not.toHaveBeenCalled();
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("/portal");
  });

  it("shows a confirmation prompt with counts and confirm/cancel buttons", async () => {
    mockFindUserById.mockResolvedValue(baseUser());
    mockGetSummary.mockResolvedValue({
      aliasCount: 3,
      deliveryLogCount: 42,
      billingEventCount: 1,
    });
    const ctx = createMockCtx({ chatType: "private" });

    await deleteMeHandler(ctx);

    const [text, options] = ctx.reply.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } },
    ];
    expect(text).toContain("3");
    expect(text).toContain("42");
    expect(text).toContain("1");
    const buttons = options.reply_markup.inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual(["delme:c", "delme:x"]);
  });

  it("confirm callback deletes the user and shows success", async () => {
    mockFindUserById.mockResolvedValue(baseUser());
    mockDeleteHostedUser.mockResolvedValue({
      deleted: true,
      rawEmailFiles: 0,
      attachmentFiles: 0,
      failedFileDeletes: [],
    });
    const ctx = createMockCtx({ chatType: "private" });

    await deleteMeConfirmCallback(ctx);

    expect(mockDeleteHostedUser).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const [text] = ctx.editMessageText.mock.calls[0] as [string];
    expect(text).toContain("deleted");
  });

  it("confirm callback surfaces a partial-failure message when files could not be removed", async () => {
    mockFindUserById.mockResolvedValue(baseUser());
    mockDeleteHostedUser.mockResolvedValue({
      deleted: true,
      rawEmailFiles: 2,
      attachmentFiles: 1,
      failedFileDeletes: ["/raw/a.eml"],
    });
    const ctx = createMockCtx({ chatType: "private" });

    await deleteMeConfirmCallback(ctx);

    const [text] = ctx.editMessageText.mock.calls[0] as [string];
    expect(text).not.toContain("Thanks for using");
    expect(text).toContain("could not be deleted");
  });

  it("confirm callback re-checks subscription and aborts if it became active", async () => {
    mockFindUserById.mockResolvedValue(
      baseUser({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active" }),
    );
    const ctx = createMockCtx({ chatType: "private" });

    await deleteMeConfirmCallback(ctx);

    expect(mockDeleteHostedUser).not.toHaveBeenCalled();
    const [text] = ctx.editMessageText.mock.calls[0] as [string];
    expect(text).toContain("/portal");
  });

  it("confirm callback shows failure when deletion throws", async () => {
    mockFindUserById.mockResolvedValue(baseUser());
    mockDeleteHostedUser.mockRejectedValue(new Error("boom"));
    const ctx = createMockCtx({ chatType: "private" });

    await deleteMeConfirmCallback(ctx);

    const [text] = ctx.editMessageText.mock.calls[0] as [string];
    expect(text).toContain("failed");
  });

  it("cancel callback leaves data alone and shows cancelled message", async () => {
    const ctx = createMockCtx({ chatType: "private" });

    await deleteMeCancelCallback(ctx);

    expect(mockDeleteHostedUser).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const [text] = ctx.editMessageText.mock.calls[0] as [string];
    expect(text).toContain("cancelled");
  });
});
