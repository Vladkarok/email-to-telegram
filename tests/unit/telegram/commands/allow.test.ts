import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAliasByLocalPartAnyDomain = vi.fn();
const mockFindAliasByFullAddress = vi.fn();
const mockAddAllowRule = vi.fn();
const mockFindAllowRuleByMatch = vi.fn();
const mockRemoveAllowRule = vi.fn();
const mockListAllowRules = vi.fn();

vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPartAnyDomain: (...args: unknown[]): unknown =>
    mockFindAliasByLocalPartAnyDomain(...args),
  findAliasByFullAddress: (...args: unknown[]): unknown => mockFindAliasByFullAddress(...args),
}));

vi.mock("../../../../src/db/repos/allowRules.js", () => ({
  addAllowRule: (...args: unknown[]): unknown => mockAddAllowRule(...args),
  findAllowRuleByMatch: (...args: unknown[]): unknown => mockFindAllowRuleByMatch(...args),
  removeAllowRule: (...args: unknown[]): unknown => mockRemoveAllowRule(...args),
  listAllowRules: (...args: unknown[]): unknown => mockListAllowRules(...args),
}));

const mockCanManageAlias = vi.fn().mockResolvedValue(true);
vi.mock("../../../../src/telegram/authorization.js", () => ({
  canManageAlias: (...args: unknown[]): unknown => mockCanManageAlias(...args),
  canManageChat: vi.fn().mockResolvedValue(true),
}));

const mockCheckAllowRuleCreateLimit = vi.fn().mockResolvedValue({ ok: true });
const mockHasActiveHostedOrganization = vi.fn().mockResolvedValue(true);
vi.mock("../../../../src/billing/limits.js", () => ({
  checkAllowRuleCreateLimit: (...args: unknown[]): unknown =>
    mockCheckAllowRuleCreateLimit(...args),
  hasActiveHostedOrganization: (...args: unknown[]): unknown =>
    mockHasActiveHostedOrganization(...args),
  withOrganizationQuotaLock: vi.fn(
    async (_db: unknown, _organizationId: string | null, work: (tx: unknown) => Promise<unknown>) =>
      work({}),
  ),
}));

const { allowHandler } = await import("../../../../src/telegram/commands/allow.js");

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
    mockCheckAllowRuleCreateLimit.mockResolvedValue({ ok: true });
    mockHasActiveHostedOrganization.mockResolvedValue(true);
    mockCanManageAlias.mockResolvedValue(true);
    mockFindAllowRuleByMatch.mockResolvedValue(null);
    mockFindAliasByLocalPartAnyDomain.mockResolvedValue(ALIAS);
    mockFindAliasByFullAddress.mockResolvedValue(ALIAS);
  });

  describe("add subcommand", () => {
    it("adds an exact email allow rule", async () => {
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd user@github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          emailAddressId: "uuid-1",
          matchType: "exact_email",
          matchValue: "user@github.com",
        }),
      );
      expect(ctx.reply).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/added|allow/i);
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
      expect(mockAddAllowRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          emailAddressId: "uuid-1",
          matchType: "domain",
          matchValue: "github.com",
        }),
      );
    });

    it("adds a domain allow rule", async () => {
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          matchType: "domain",
          matchValue: "github.com",
        }),
      );
    });

    it("replies with error when alias not found", async () => {
      mockFindAliasByLocalPartAnyDomain.mockResolvedValue(null);
      const ctx = createMockCtx({ commandMatch: "add nonexistent github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/not found/i);
    });

    it("rejects invalid allow values instead of storing them", async () => {
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd nope@@example" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).not.toHaveBeenCalled();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/invalid format/i);
    });

    it("rejects new rules when the plan allow-rule limit is reached", async () => {
      mockCheckAllowRuleCreateLimit.mockResolvedValue({
        ok: false,
        code: "allow_rule_limit",
        limit: 10,
        used: 10,
      });
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).not.toHaveBeenCalled();
      const [text, opts] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } },
      ];
      expect(text).toMatch(/limit reached|upgrade/i);
      // Should include an upgrade button
      const buttons = opts?.reply_markup?.inline_keyboard?.flat() ?? [];
      expect(buttons.some((b) => b.callback_data === "bill:upgrade")).toBe(true);
    });

    it("shows generic fallback for unrecognised limit codes without upgrade button", async () => {
      mockCheckAllowRuleCreateLimit.mockResolvedValue({
        ok: false,
        code: "monthly_email_limit",
        limit: 100,
        used: 100,
      });
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).not.toHaveBeenCalled();
      const [text, opts] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        {
          reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } | undefined;
        },
      ];
      expect(text).toMatch(/not available|try again/i);
      // No upgrade button for unrecognised codes
      const buttons = opts?.reply_markup?.inline_keyboard?.flat() ?? [];
      expect(buttons.some((b) => b.callback_data === "bill:upgrade")).toBe(false);
    });

    it("shows a hosted workspace error when the alias has no active organization", async () => {
      mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).not.toHaveBeenCalled();
      expect(mockCanManageAlias).not.toHaveBeenCalled();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
        /workspace|active hosted workspace|not attached/i,
      );
    });

    it("treats duplicate allow-rule adds as idempotent", async () => {
      mockFindAllowRuleByMatch.mockResolvedValueOnce({
        id: "rule-1",
        emailAddressId: "uuid-1",
        matchType: "domain",
        matchValue: "github.com",
      });
      const ctx = createMockCtx({ commandMatch: "add alerts-ab12cd github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).not.toHaveBeenCalled();
      expect(mockCheckAllowRuleCreateLimit).not.toHaveBeenCalled();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/already exists/i);
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
