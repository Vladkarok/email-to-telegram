import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAliasByLocalPart = vi.fn();
const mockAddAllowRule = vi.fn();
const mockRemoveAllowRule = vi.fn();
const mockListAllowRules = vi.fn();

vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: (...args: unknown[]): unknown => mockFindAliasByLocalPart(...args),
}));

vi.mock("../../../../src/db/repos/allowRules.js", () => ({
  addAllowRule: (...args: unknown[]): unknown => mockAddAllowRule(...args),
  removeAllowRule: (...args: unknown[]): unknown => mockRemoveAllowRule(...args),
  listAllowRules: (...args: unknown[]): unknown => mockListAllowRules(...args),
}));

const { allowHandler } = await import("../../../../src/telegram/commands/allow.js");

const ALIAS = {
  id: "uuid-1",
  localPart: "alerts-ab12cd",
  fullAddress: "alerts-ab12cd@tgmail.example.com",
  chatId: -1001234567890n,
  status: "active",
};

describe("/allow command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAliasByLocalPart.mockResolvedValue(ALIAS);
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
      mockFindAliasByLocalPart.mockResolvedValue(null);
      const ctx = createMockCtx({ commandMatch: "add nonexistent github.com" });

      await allowHandler(ctx);

      expect(mockAddAllowRule).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledOnce();
      expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/not found/i);
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
