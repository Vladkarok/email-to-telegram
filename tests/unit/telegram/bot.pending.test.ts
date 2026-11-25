import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Context, InlineKeyboard } from "grammy";
import { createMockCtx } from "../../helpers/mockContext.js";
import { getMessages } from "../../../src/i18n/index.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetPending = vi.fn();
const mockClearPending = vi.fn();
vi.mock("../../../src/telegram/session.js", () => ({
  getPending: (...args: unknown[]): unknown => mockGetPending(...args),
  clearPending: (...args: unknown[]): unknown => mockClearPending(...args),
  setPending: vi.fn(),
}));

const mockCanManageAlias = vi.fn().mockResolvedValue(true);
const mockCanManageChat = vi.fn().mockResolvedValue(true);
vi.mock("../../../src/telegram/authorization.js", () => ({
  canManageAlias: (...args: unknown[]): unknown => mockCanManageAlias(...args),
  canManageChat: (...args: unknown[]): unknown => mockCanManageChat(...args),
}));

const mockHasActiveHostedOrganization = vi.fn().mockResolvedValue(true);
vi.mock("../../../src/billing/limits.js", () => ({
  hasActiveHostedUser: (...args: unknown[]): unknown => mockHasActiveHostedOrganization(...args),
}));

const mockFindAliasById = vi.fn();
const mockFindChatById = vi.fn();
const mockUpdateAliasStatus = vi.fn();
const mockUpdateAliasLabel = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
  updateAliasStatus: (...args: unknown[]): unknown => mockUpdateAliasStatus(...args),
  updateAliasLabel: (...args: unknown[]): unknown => mockUpdateAliasLabel(...args),
}));

const mockAddAllowRuleForAlias = vi.fn();
vi.mock("../../../src/telegram/commands/allow.js", () => ({
  allowHandler: vi.fn(),
  addAllowRuleForAlias: (...args: unknown[]): unknown => mockAddAllowRuleForAlias(...args),
}));

// The mutation rules run on Postgres in tests/db/aliasOperations.pg.test.ts;
// the callbacks below pin only the toast and menu for each outcome.
const mockDeleteAliasAtVersion = vi.fn();
const mockSetAliasRenderMode = vi.fn();
const mockToggleAliasBodyDedup = vi.fn();
const mockToggleAliasPrivacyMode = vi.fn();
vi.mock("../../../src/aliases/settings.js", () => ({
  deleteAliasAtVersion: (...args: unknown[]): unknown => mockDeleteAliasAtVersion(...args),
  setAliasRenderMode: (...args: unknown[]): unknown => mockSetAliasRenderMode(...args),
  toggleAliasBodyDedup: (...args: unknown[]): unknown => mockToggleAliasBodyDedup(...args),
  toggleAliasPrivacyMode: (...args: unknown[]): unknown => mockToggleAliasPrivacyMode(...args),
}));

const mockSendAllowRulesMenu = vi.fn();
const mockEditAllowRulesMenu = vi.fn();
vi.mock("../../../src/telegram/menu/allowRulesMenu.js", () => ({
  sendAllowRulesMenu: (...args: unknown[]): unknown => mockSendAllowRulesMenu(...args),
  editAllowRulesMenu: (...args: unknown[]): unknown => mockEditAllowRulesMenu(...args),
}));

const mockCreateEmailAlias = vi.fn();
const mockPromptForEmailAliasName = vi.fn();
vi.mock("../../../src/telegram/commands/newemail.js", () => ({
  newemailHandler: vi.fn(),
  createEmailAlias: (...args: unknown[]): unknown => mockCreateEmailAlias(...args),
  promptForEmailAliasName: (...args: unknown[]): unknown => mockPromptForEmailAliasName(...args),
  buildQuickAllowKeyboard: (aliasId: string): InlineKeyboard =>
    new InlineKeyboard().text("✅ github.com", `qr:${aliasId}:github.com`),
}));
vi.mock("../../../src/telegram/commands/settings.js", () => ({
  settingsHandler: vi.fn(),
  buildAliasSettingsKeyboard: vi.fn(),
  buildAliasSettingsText: vi.fn(),
}));
const mockSendAliasDetailMenu = vi.fn();
const mockEditAliasListMenu = vi.fn();
vi.mock("../../../src/telegram/menu/aliasMenu.js", () => ({
  editAliasListMenu: (...args: unknown[]): unknown => mockEditAliasListMenu(...args),
  editAliasDetailMenu: vi.fn(),
  sendAliasDetailMenu: (...args: unknown[]): unknown => mockSendAliasDetailMenu(...args),
  editAliasDeleteConfirmMenu: vi.fn(),
}));
vi.mock("../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
}));
const mockFindAllowRuleById = vi.fn();
const mockRemoveAllowRule = vi.fn();
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  findAllowRuleById: (...args: unknown[]): unknown => mockFindAllowRuleById(...args),
  removeAllowRule: (...args: unknown[]): unknown => mockRemoveAllowRule(...args),
}));
vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
const mockAuthMiddleware = vi.fn(async (_ctx: unknown, next: () => Promise<void>) => next());
vi.mock("../../../src/telegram/middleware/auth.js", () => ({
  authMiddleware: (...args: unknown[]): unknown => mockAuthMiddleware(...args),
}));

const { createBot, handlePendingTextMessage, assertHostedAliasReady, assertHostedChatReady } =
  await import("../../../src/telegram/bot.js");

const mockAnswerCallbackQuery = vi
  .spyOn(Context.prototype, "answerCallbackQuery")
  .mockResolvedValue(true as never);
const mockEditMessageText = vi
  .spyOn(Context.prototype, "editMessageText")
  .mockResolvedValue({} as never);
const mockReply = vi.spyOn(Context.prototype, "reply").mockResolvedValue({} as never);

function buildCallbackUpdate(data: string) {
  return {
    update_id: 1,
    callback_query: {
      id: "cb-1",
      from: {
        id: 123,
        is_bot: false,
        first_name: "Test",
      },
      chat_instance: "ci-1",
      data,
      message: {
        message_id: 1,
        date: 0,
        chat: {
          id: 123,
          type: "private",
        },
      },
    },
  };
}

function createInitializedBot() {
  const bot = createBot("test-token");
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  return bot;
}

describe("pending text flow", () => {
  const next = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasActiveHostedOrganization.mockResolvedValue(true);
    mockCanManageChat.mockResolvedValue(true);
    mockCanManageAlias.mockResolvedValue(true);
    mockFindChatById.mockResolvedValue({
      id: -1001234567890n,
      title: "Alerts",
      organizationId: "org-1",
    });
    mockGetPending.mockReturnValue({
      action: "allowrule",
      aliasId: "alias-1",
      aliasLocalPart: "alerts",
    });
    mockFindAliasById.mockResolvedValue({
      id: "alias-1",
      localPart: "alerts",
      createdBy: 123456789n,
    });
    mockAddAllowRuleForAlias.mockResolvedValue(true);
    mockCreateEmailAlias.mockResolvedValue(undefined);
  });

  afterAll(() => {
    mockAnswerCallbackQuery.mockRestore();
    mockEditMessageText.mockRestore();
    mockReply.mockRestore();
  });

  it("creates a pending alias when the hosted account is active", async () => {
    mockGetPending.mockReturnValue({
      action: "newemail",
      chatId: -1001234567890n,
      chatTitle: "Alerts",
    });
    const ctx = createMockCtx({ text: "alerts" });

    await handlePendingTextMessage(ctx, next);

    expect(mockCanManageChat).toHaveBeenCalled();
    expect(mockCreateEmailAlias).toHaveBeenCalledWith(
      ctx,
      "alerts",
      -1001234567890n,
      null,
      "Alerts",
    );
  });

  it("shows the hosted account message before chat auth when pending alias creation has no active org", async () => {
    mockGetPending.mockReturnValue({
      action: "newemail",
      chatId: -1001234567890n,
      chatTitle: "Alerts",
    });
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = createMockCtx({ text: "alerts" });

    await handlePendingTextMessage(ctx, next);

    expect(mockCanManageChat).not.toHaveBeenCalled();
    expect(mockCreateEmailAlias).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /account|not ready|active/i,
    );
  });

  it("blocks the callback newemail entrypoint when the hosted account is inactive", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = {
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await expect(assertHostedChatReady(ctx as never, -1001234567890n)).resolves.toBe(false);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted account inactive/i),
    );
  });

  it("wires the cn callback through the hosted account guard before chat auth", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const bot = createInitializedBot();

    await bot.handleUpdate(buildCallbackUpdate("cn:-1001234567890") as never);

    expect(mockCanManageChat).not.toHaveBeenCalled();
    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted account inactive/i),
    );
  });

  it("wires the ns callback through the hosted account guard before chat auth", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const bot = createInitializedBot();

    await bot.handleUpdate(buildCallbackUpdate("ns:-1001234567890") as never);

    expect(mockCanManageChat).not.toHaveBeenCalled();
    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted account inactive/i),
    );
  });

  it("sends the allow-rules menu on successful pending allow-rule creation", async () => {
    // Reset is required because preceding tests use mockResolvedValueOnce(false)
    // queues that vi.clearAllMocks() doesn't drain.
    mockHasActiveHostedOrganization.mockReset();
    mockHasActiveHostedOrganization.mockResolvedValue(true);
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockAddAllowRuleForAlias).toHaveBeenCalled();
    expect(mockSendAllowRulesMenu).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "alias-1",
    );
  });

  it("sends the updated alias management menu after setting a pending label", async () => {
    mockGetPending.mockReturnValue({
      action: "alias_label",
      aliasId: "alias-1",
      promptChatId: 123456789,
      promptMessageId: 42,
    });
    mockFindAliasById.mockResolvedValue({
      id: "alias-1",
      localPart: "alerts",
      fullAddress: "alerts@example.com",
      organizationId: "org-1",
    });
    const ctx = createMockCtx({ chatType: "private", text: "alerts due" });

    await handlePendingTextMessage(ctx, next);

    expect(mockUpdateAliasLabel).toHaveBeenCalledWith(expect.anything(), "alias-1", "alerts due");
    const editMarkupCalls = (ctx.api.editMessageReplyMarkup as ReturnType<typeof vi.fn>).mock.calls;
    expect(editMarkupCalls).toContainEqual([
      123456789,
      42,
      {
        reply_markup: undefined,
      },
    ]);
    expect(mockSendAliasDetailMenu).toHaveBeenCalledWith(ctx, expect.anything(), "alias-1");
    expect(ctx.reply).not.toHaveBeenCalledWith(
      expect.stringMatching(/Label set/i),
      expect.anything(),
    );
  });

  it("keeps the pending label flow active when the label is invalid", async () => {
    mockGetPending.mockReturnValue({
      action: "alias_label",
      aliasId: "alias-1",
      promptChatId: 123456789,
      promptMessageId: 42,
    });
    const ctx = createMockCtx({ text: "   " });

    await handlePendingTextMessage(ctx, next);

    expect(mockClearPending).not.toHaveBeenCalled();
    expect(mockUpdateAliasLabel).not.toHaveBeenCalled();
    expect(mockSendAliasDetailMenu).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/cannot be empty/i));
  });

  it("does not reopen the menu when quota/inactive-org helper rejects the rule", async () => {
    mockAddAllowRuleForAlias.mockImplementation(
      async (ctx: { reply: (text: string) => Promise<void> }) => {
        await ctx.reply("⛔ alias is not attached to an active hosted account.");
        return false;
      },
    );
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockSendAllowRulesMenu).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /active hosted account/i,
    );
  });

  it("shows the hosted account message before alias auth when the alias org is inactive", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockCanManageAlias).not.toHaveBeenCalled();
    expect(mockAddAllowRuleForAlias).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /active hosted account/i,
    );
  });

  it("blocks the callback allow-rule entrypoint when the hosted account is inactive", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = {
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await expect(assertHostedAliasReady(ctx as never, "alias-1")).resolves.toBe(false);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted account inactive/i),
    );
  });

  it("wires the aa callback through the hosted account guard before alias auth", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const bot = createInitializedBot();

    await bot.handleUpdate(buildCallbackUpdate("aa:550e8400-e29b-41d4-a716-446655440000") as never);

    expect(mockCanManageAlias).not.toHaveBeenCalled();
    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted account inactive/i),
    );
  });

  it("shows quick allow buttons when starting add-rule flow from the menu", async () => {
    mockFindAliasById.mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440000",
      localPart: "alerts",
      organizationId: "org-1",
    });
    const bot = createInitializedBot();

    await bot.handleUpdate(buildCallbackUpdate("aa:550e8400-e29b-41d4-a716-446655440000") as never);

    expect(mockAnswerCallbackQuery).toHaveBeenCalled();
    const [, opts] = mockEditMessageText.mock.calls[0] as [
      string,
      {
        reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
      },
    ];
    const buttons = opts.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(
      buttons.some(
        (button) => button.callback_data === "qr:550e8400-e29b-41d4-a716-446655440000:github.com",
      ),
    ).toBe(true);
  });

  describe("dr: delete allow rule callback", () => {
    const ruleId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const rule = {
      id: ruleId,
      emailAddressId: "550e8400-e29b-41d4-a716-446655440000",
      matchValue: "github.com",
    };

    it("answers with access denied, not the removed toast, when the caller lost access", async () => {
      mockFindAllowRuleById.mockResolvedValue(rule);
      mockCanManageAlias.mockResolvedValue(false);
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`dr:${ruleId}`) as never);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(expect.stringMatching(/access denied/i));
      expect(mockRemoveAllowRule).not.toHaveBeenCalled();
      expect(mockEditAllowRulesMenu).not.toHaveBeenCalled();
    });

    it("runs the fresh access check before the removed toast, then removes the rule", async () => {
      mockFindAllowRuleById.mockResolvedValue(rule);
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`dr:${ruleId}`) as never);

      expect(mockCanManageAlias).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        123,
        rule.emailAddressId,
        { fresh: true },
      );
      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("Rule removed.");
      expect(mockCanManageAlias.mock.invocationCallOrder[0]).toBeLessThan(
        mockAnswerCallbackQuery.mock.invocationCallOrder[0],
      );
      expect(mockRemoveAllowRule).toHaveBeenCalledWith(expect.anything(), {
        emailAddressId: rule.emailAddressId,
        matchValue: rule.matchValue,
      });
      expect(mockAnswerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(
        mockRemoveAllowRule.mock.invocationCallOrder[0],
      );
      expect(mockEditAllowRulesMenu).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        rule.emailAddressId,
      );
    });

    it("answers rule not found without an access check when the rule is gone", async () => {
      mockFindAllowRuleById.mockResolvedValue(undefined);
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`dr:${ruleId}`) as never);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("Rule not found.");
      expect(mockCanManageAlias).not.toHaveBeenCalled();
      expect(mockRemoveAllowRule).not.toHaveBeenCalled();
    });
  });

  describe("alias menu mutation callbacks", () => {
    const aliasId = "550e8400-e29b-41d4-a716-446655440000";
    const alias = { id: aliasId, chatId: -1001234567890n, bodyDedupEnabled: true };

    describe.each([
      ["adc", `adc:${aliasId}:3`, mockDeleteAliasAtVersion, { kind: "not_found" }],
      ["set_mode", `set_mode:${aliasId}:html`, mockSetAliasRenderMode, { kind: "invalid_mode" }],
      [
        "toggle_body_dedup",
        `toggle_body_dedup:${aliasId}`,
        mockToggleAliasBodyDedup,
        { kind: "not_found" },
      ],
      [
        "toggle_privacy_mode",
        `toggle_privacy_mode:${aliasId}`,
        mockToggleAliasPrivacyMode,
        { kind: "not_found" },
      ],
    ] as const)("%s: the fresh access check", (_, data, mutation, outcome) => {
      it("refuses a caller who lost access without touching the alias", async () => {
        mockCanManageAlias.mockResolvedValue(false);
        const bot = createInitializedBot();

        await bot.handleUpdate(buildCallbackUpdate(data) as never);

        expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
          expect.stringMatching(/access denied/i),
        );
        expect(mutation).not.toHaveBeenCalled();
      });

      it("asks for fresh rights before the change", async () => {
        mutation.mockResolvedValue(outcome);
        const bot = createInitializedBot();

        await bot.handleUpdate(buildCallbackUpdate(data) as never);

        expect(mockCanManageAlias).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          123,
          aliasId,
          { fresh: true },
        );
        expect(mockCanManageAlias.mock.invocationCallOrder[0]).toBeLessThan(
          mutation.mock.invocationCallOrder[0],
        );
      });
    });

    it("adc: a confirmed delete toasts Deleted and reopens the chat's alias list", async () => {
      mockDeleteAliasAtVersion.mockResolvedValue({ kind: "deleted", alias });
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`adc:${aliasId}:3`) as never);

      expect(mockDeleteAliasAtVersion).toHaveBeenCalledWith(expect.anything(), {
        aliasId,
        expectedVersion: 3,
      });
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("Deleted.");
      expect(mockEditAliasListMenu).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        alias.chatId,
        "Alerts",
      );
    });

    it("adc: a stale confirmation answers without a toast and explains the change", async () => {
      mockDeleteAliasAtVersion.mockResolvedValue({ kind: "routing_changed" });
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`adc:${aliasId}:3`) as never);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith();
      expect(mockReply).toHaveBeenCalledWith(getMessages("en").aliasActions.routingChanged, {
        parse_mode: "HTML",
      });
      expect(mockEditAliasListMenu).not.toHaveBeenCalled();
    });

    it("adc: a missing alias toasts Alias not found", async () => {
      mockDeleteAliasAtVersion.mockResolvedValue({ kind: "not_found" });
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`adc:${aliasId}:3`) as never);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("Alias not found.");
      expect(mockReply).not.toHaveBeenCalled();
    });

    it("set_mode: an unsupported mode toasts Invalid mode and re-renders nothing", async () => {
      mockSetAliasRenderMode.mockResolvedValue({ kind: "invalid_mode" });
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`set_mode:${aliasId}:markdown`) as never);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("Invalid mode");
      expect(mockFindAliasById).not.toHaveBeenCalled();
    });

    it("set_mode: a supported mode toasts it and re-renders the settings", async () => {
      mockSetAliasRenderMode.mockResolvedValue({ kind: "updated", mode: "html" });
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`set_mode:${aliasId}:html`) as never);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("✅ Mode set to html");
      expect(mockEditMessageText).toHaveBeenCalledOnce();
    });

    it.each([
      ["toggle_body_dedup", mockToggleAliasBodyDedup, "Body dedup enabled"],
      ["toggle_privacy_mode", mockToggleAliasPrivacyMode, "Privacy mode enabled"],
    ] as const)("%s: toasts the value written, then re-renders", async (cb, toggle, toast) => {
      toggle.mockResolvedValue({ kind: "toggled", enabled: true });
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`${cb}:${aliasId}`) as never);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(toast);
      expect(mockFindAliasById).toHaveBeenCalledOnce();
      expect(mockEditMessageText).toHaveBeenCalledOnce();
    });

    it.each([
      ["toggle_body_dedup", mockToggleAliasBodyDedup],
      ["toggle_privacy_mode", mockToggleAliasPrivacyMode],
    ] as const)("%s: a missing alias toasts Alias not found", async (cb, toggle) => {
      toggle.mockResolvedValue({ kind: "not_found" });
      const bot = createInitializedBot();

      await bot.handleUpdate(buildCallbackUpdate(`${cb}:${aliasId}`) as never);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("Alias not found.");
      expect(mockEditMessageText).not.toHaveBeenCalled();
    });
  });
});
