import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";
import { getMessages } from "../../../../src/i18n/index.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAliasByLocalPartAnyDomain = vi.fn();
const mockFindAliasByFullAddress = vi.fn();
const mockListAliasesByChat = vi.fn();
const mockFindAliasesByCreator = vi.fn();
const mockRemoveAllowRule = vi.fn();
const mockListAllowRules = vi.fn();

vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPartAnyDomain: (...args: unknown[]): unknown =>
    mockFindAliasByLocalPartAnyDomain(...args),
  findAliasByFullAddress: (...args: unknown[]): unknown => mockFindAliasByFullAddress(...args),
  listAliasesByChat: (...args: unknown[]): unknown => mockListAliasesByChat(...args),
  findAliasesByCreator: (...args: unknown[]): unknown => mockFindAliasesByCreator(...args),
}));

vi.mock("../../../../src/db/repos/allowRules.js", () => ({
  removeAllowRule: (...args: unknown[]): unknown => mockRemoveAllowRule(...args),
  listAllowRules: (...args: unknown[]): unknown => mockListAllowRules(...args),
}));

const mockCanManageAlias = vi.fn().mockResolvedValue(true);
vi.mock("../../../../src/telegram/authorization.js", () => ({
  canManageAlias: (...args: unknown[]): unknown => mockCanManageAlias(...args),
  canManageChat: vi.fn().mockResolvedValue(true),
}));

const mockHasActiveHostedOrganization = vi.fn().mockResolvedValue(true);
vi.mock("../../../../src/billing/limits.js", () => ({
  hasActiveHostedUser: (...args: unknown[]): unknown => mockHasActiveHostedOrganization(...args),
}));

// The insertion rules run on Postgres in tests/db/aliasOperations.pg.test.ts;
// here only the reply for each outcome is pinned.
const mockAddAllowRuleForOwner = vi.fn().mockResolvedValue({ kind: "added" });
vi.mock("../../../../src/aliases/allowRules.js", () => ({
  addAllowRuleForOwner: (...args: unknown[]): unknown => mockAddAllowRuleForOwner(...args),
}));

const { allowHandler } = await import("../../../../src/telegram/commands/allow.js");
const en = getMessages("en");

const ALIAS = {
  id: "uuid-1",
  localPart: "alerts-ab12cd",
  fullAddress: "alerts-ab12cd@tgmail.example.com",
  organizationId: "org-1",
  chatId: -1001234567890n,
  status: "active",
};

describe("/allow command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddAllowRuleForOwner.mockResolvedValue({ kind: "added" });
    mockHasActiveHostedOrganization.mockResolvedValue(true);
    mockCanManageAlias.mockResolvedValue(true);
    mockFindAliasByLocalPartAnyDomain.mockResolvedValue(ALIAS);
    mockFindAliasByFullAddress.mockResolvedValue(ALIAS);
    mockListAliasesByChat.mockResolvedValue([ALIAS]);
    mockFindAliasesByCreator.mockResolvedValue([ALIAS]);
  });

  describe("add subcommand", () => {
    it("adds an exact email allow rule and confirms it", async () => {
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd User@GitHub.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRuleForOwner).toHaveBeenCalledWith(expect.anything(), ALIAS, {
        matchType: "exact_email",
        normalized: "user@github.com",
      });
      expect(ctx.reply).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
        en.allowCommand.added("alerts-ab12cd", "🔐", "user@github.com"),
        { parse_mode: "HTML" },
      ]);
    });

    it("resolves hosted aliases by full address", async () => {
      const ctx = createMockCtx({
        commandMatch: "add alerts-ab12cd@inbox.example.com github.com",
      });

      await allowHandler(ctx);

      expect(mockFindAliasByFullAddress).toHaveBeenCalledWith(
        expect.anything(),
        "alerts-ab12cd@inbox.example.com",
      );
      expect(mockFindAliasByLocalPartAnyDomain).not.toHaveBeenCalled();
      expect(mockAddAllowRuleForOwner).toHaveBeenCalledWith(expect.anything(), ALIAS, {
        matchType: "domain",
        normalized: "github.com",
      });
    });

    it("replies with error when alias not found", async () => {
      mockFindAliasByLocalPartAnyDomain.mockResolvedValue(null);
      const ctx = createMockCtx({ commandMatch: "add nonexistent github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRuleForOwner).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/not found/i);
    });

    it("rejects invalid allow values instead of storing them", async () => {
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd nope@@example" });

      await allowHandler(ctx);

      expect(mockAddAllowRuleForOwner).not.toHaveBeenCalled();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
        en.allowCommand.invalidFormat,
        { parse_mode: "HTML" },
      ]);
    });

    it("a duplicate replies that the rule already exists", async () => {
      mockAddAllowRuleForOwner.mockResolvedValueOnce({ kind: "duplicate" });
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
        en.allowCommand.alreadyExists("alerts-ab12cd", "🔐", "github.com"),
        { parse_mode: "HTML" },
      ]);
    });

    it("the allow-rule limit offers an upgrade", async () => {
      mockAddAllowRuleForOwner.mockResolvedValueOnce({
        kind: "limit",
        limit: { ok: false, code: "allow_rule_limit", limit: 10, used: 10 },
      });
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      const [text, opts] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { parse_mode: string; reply_markup: { inline_keyboard: unknown[][] } },
      ];
      expect(text).toBe(en.allowCommand.limitReached("alerts-ab12cd", 10, 10));
      expect(opts.parse_mode).toBe("HTML");
      expect(opts.reply_markup.inline_keyboard).toEqual([
        [{ text: en.allowCommand.upgradePlanButton, callback_data: "bill:upgrade" }],
      ]);
    });

    it("a missing hosted user at insert time is the subscription reply", async () => {
      mockAddAllowRuleForOwner.mockResolvedValueOnce({
        kind: "limit",
        limit: { ok: false, code: "subscription_inactive" },
      });
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
        en.allowCommand.subscriptionInactive("alerts-ab12cd"),
        { parse_mode: "HTML" },
      ]);
    });

    it("any other limit code is the generic unavailable reply", async () => {
      mockAddAllowRuleForOwner.mockResolvedValueOnce({
        kind: "limit",
        limit: { ok: false, code: "monthly_email_limit", limit: 100, used: 100 },
      });
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
        en.allowCommand.createUnavailable,
      ]);
    });

    it("shows a hosted account error when the alias has no active organization", async () => {
      mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRuleForOwner).not.toHaveBeenCalled();
      expect(mockCanManageAlias).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
        /account|active hosted account|not attached/i,
      );
    });
  });

  describe("remove subcommand", () => {
    it("removes an allow rule", async () => {
      const ctx = createMockCtx({ commandMatch: "remove alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect(mockRemoveAllowRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          emailAddressId: "uuid-1",
          matchValue: "github.com",
        }),
      );
    });
  });

  describe("list subcommand", () => {
    it("lists allow rules for an alias", async () => {
      mockListAllowRules.mockResolvedValue([
        { matchType: "domain", matchValue: "github.com" },
        { matchType: "exact_email", matchValue: "alerts@pagerduty.com" },
      ]);
      const ctx = createMockCtx({ commandMatch: "list alerts-ab12cd" });

      await allowHandler(ctx);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(replyText).toContain("github.com");
      expect(replyText).toContain("alerts@pagerduty.com");
    });

    it("reports when there are no rules", async () => {
      mockListAllowRules.mockResolvedValue([]);
      const ctx = createMockCtx({ commandMatch: "list alerts-ab12cd" });

      await allowHandler(ctx);

      expect(ctx.reply).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
        /no.*rules|empty|none/i,
      );
    });
  });

  describe("invalid usage", () => {
    it("shows usage help when subcommand is missing", async () => {
      const ctx = createMockCtx({ commandMatch: "" });

      await allowHandler(ctx);

      expect(ctx.reply).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/usage|\/allow/i);
    });

    it("shows usage help for unknown subcommand", async () => {
      const ctx = createMockCtx({ commandMatch: "badcmd foo bar" });

      await allowHandler(ctx);

      expect(ctx.reply).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/usage|\/allow/i);
    });
  });
});
