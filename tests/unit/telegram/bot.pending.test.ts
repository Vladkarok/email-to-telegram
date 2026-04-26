import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx } from "../../helpers/mockContext.js";

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
  hasActiveHostedOrganization: (...args: unknown[]): unknown =>
    mockHasActiveHostedOrganization(...args),
}));

const mockFindAliasById = vi.fn();
const mockFindChatById = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
  updateAliasBodyDedup: vi.fn(),
  updateAliasPrivacyMode: vi.fn(),
  updateAliasStatus: vi.fn(),
  updateAliasRenderMode: vi.fn(),
}));

const mockAddAllowRuleForAlias = vi.fn();
vi.mock("../../../src/telegram/commands/allow.js", () => ({
  allowHandler: vi.fn(),
  addAllowRuleForAlias: (...args: unknown[]): unknown => mockAddAllowRuleForAlias(...args),
}));

const mockSendAllowRulesMenu = vi.fn();
vi.mock("../../../src/telegram/menu/allowRulesMenu.js", () => ({
  sendAllowRulesMenu: (...args: unknown[]): unknown => mockSendAllowRulesMenu(...args),
  editAllowRulesMenu: vi.fn(),
}));

vi.mock("../../../src/telegram/commands/start.js", () => ({ startHandler: vi.fn() }));
const mockCreateEmailAlias = vi.fn();
vi.mock("../../../src/telegram/commands/newemail.js", () => ({
  newemailHandler: vi.fn(),
  createEmailAlias: (...args: unknown[]): unknown => mockCreateEmailAlias(...args),
}));
vi.mock("../../../src/telegram/commands/listemail.js", () => ({ listemailHandler: vi.fn() }));
vi.mock("../../../src/telegram/commands/deleteemail.js", () => ({ deleteemailHandler: vi.fn() }));
vi.mock("../../../src/telegram/commands/pauseemail.js", () => ({ pauseemailHandler: vi.fn() }));
vi.mock("../../../src/telegram/commands/resumeemail.js", () => ({ resumeemailHandler: vi.fn() }));
vi.mock("../../../src/telegram/commands/settings.js", () => ({
  settingsHandler: vi.fn(),
  buildAliasSettingsKeyboard: vi.fn(),
  buildAliasSettingsText: vi.fn(),
}));
vi.mock("../../../src/telegram/commands/help.js", () => ({ helpHandler: vi.fn() }));
vi.mock("../../../src/telegram/handlers/chatMember.js", () => ({ chatMemberHandler: vi.fn() }));
vi.mock("../../../src/telegram/menu/chatMenu.js", () => ({
  editChatSelectionMenu: vi.fn(),
  editChatManagementMenu: vi.fn(),
}));
vi.mock("../../../src/telegram/menu/aliasMenu.js", () => ({
  editAliasListMenu: vi.fn(),
  editAliasDetailMenu: vi.fn(),
}));
vi.mock("../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
}));
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  findAllowRuleById: vi.fn(),
  removeAllowRule: vi.fn(),
}));
vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/telegram/middleware/auth.js", () => ({ authMiddleware: vi.fn() }));

const { handlePendingTextMessage } = await import("../../../src/telegram/bot.js");

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
      organizationId: "org-1",
    });
    mockAddAllowRuleForAlias.mockResolvedValue(true);
    mockCreateEmailAlias.mockResolvedValue(undefined);
  });

  it("creates a pending alias when the hosted workspace is active", async () => {
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

  it("shows the hosted workspace message before chat auth when pending alias creation has no active org", async () => {
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
      /workspace|not ready|active/i,
    );
  });

  it("sends the allow-rules menu on successful pending allow-rule creation", async () => {
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockAddAllowRuleForAlias).toHaveBeenCalled();
    expect(mockSendAllowRulesMenu).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "alias-1",
    );
  });

  it("does not reopen the menu when quota/inactive-org helper rejects the rule", async () => {
    mockAddAllowRuleForAlias.mockImplementation(
      async (ctx: { reply: (text: string) => Promise<void> }) => {
        await ctx.reply("⛔ alias is not attached to an active hosted workspace.");
        return false;
      },
    );
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockSendAllowRulesMenu).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /active hosted workspace/i,
    );
  });

  it("shows the hosted workspace message before alias auth when the alias org is inactive", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockCanManageAlias).not.toHaveBeenCalled();
    expect(mockAddAllowRuleForAlias).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /active hosted workspace/i,
    );
  });
});
