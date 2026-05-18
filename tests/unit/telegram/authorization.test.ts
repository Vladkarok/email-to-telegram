import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindActiveChats = vi.fn();
const mockFindAliasById = vi.fn();

vi.mock("../../../src/db/repos/chats.js", () => ({
  findActiveChats: (...args: unknown[]): unknown => mockFindActiveChats(...args),
}));

vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
}));

const { canManageAlias, canManageChat, getAccessibleChats } =
  await import("../../../src/telegram/authorization.js");

describe("telegram authorization", () => {
  beforeEach(() => {
    mockFindActiveChats.mockReset();
    mockFindAliasById.mockReset();
  });

  describe("canManageChat", () => {
    it("always allows a user to manage their own DM chat", async () => {
      const api = { getChatMember: vi.fn() };
      await expect(canManageChat(api as never, 42, 42n)).resolves.toBe(true);
      expect(api.getChatMember).not.toHaveBeenCalled();
    });

    it("allows when the user is a chat creator/admin/member via Telegram", async () => {
      const api = {
        getChatMember: vi.fn().mockResolvedValue({ status: "administrator" }),
      };
      await expect(canManageChat(api as never, 42, -1n, { fresh: true })).resolves.toBe(true);
    });

    it("denies when Telegram reports the user is not a member", async () => {
      const api = {
        getChatMember: vi.fn().mockResolvedValue({ status: "left" }),
      };
      await expect(canManageChat(api as never, 42, -2n, { fresh: true })).resolves.toBe(false);
    });

    it("denies on Telegram API error (e.g. bot kicked, chat not found)", async () => {
      const api = {
        getChatMember: vi.fn().mockRejectedValue(new Error("Chat not found")),
      };
      await expect(canManageChat(api as never, 42, -3n, { fresh: true })).resolves.toBe(false);
    });
  });

  describe("canManageAlias", () => {
    it("denies access to deleted aliases", async () => {
      mockFindAliasById.mockResolvedValue({
        id: "a",
        status: "deleted",
        createdBy: 42n,
        chatId: 42n,
      });
      const api = { getChatMember: vi.fn() };
      await expect(canManageAlias({} as never, api as never, 42, "a")).resolves.toBe(false);
    });

    it("denies access to missing aliases", async () => {
      mockFindAliasById.mockResolvedValue(null);
      const api = { getChatMember: vi.fn() };
      await expect(canManageAlias({} as never, api as never, 42, "missing")).resolves.toBe(false);
    });

    it("allows access when the user is the alias creator", async () => {
      mockFindAliasById.mockResolvedValue({
        id: "a",
        status: "active",
        createdBy: 42n,
        chatId: -100n,
      });
      const api = { getChatMember: vi.fn() };
      await expect(canManageAlias({} as never, api as never, 42, "a")).resolves.toBe(true);
      expect(api.getChatMember).not.toHaveBeenCalled();
    });

    it("falls back to Telegram chat membership when the user is not the creator", async () => {
      mockFindAliasById.mockResolvedValue({
        id: "a",
        status: "active",
        createdBy: 99n,
        chatId: -200n,
      });
      const api = { getChatMember: vi.fn().mockResolvedValue({ status: "member" }) };
      await expect(
        canManageAlias({} as never, api as never, 42, "a", { fresh: true }),
      ).resolves.toBe(true);
    });
  });

  describe("getAccessibleChats", () => {
    // Unique chat IDs (4xx) to avoid cache collisions with chat IDs used in
    // other tests in this file (the module-level chatMemberCache persists
    // across tests).
    it("returns only chats the user can manage", async () => {
      mockFindActiveChats.mockResolvedValue([
        { id: 42n, title: "DM" }, // user's own DM
        { id: -400n, title: "Group A" }, // member
        { id: -500n, title: "Group B" }, // not a member
      ]);
      const api = {
        getChatMember: vi.fn().mockImplementation((chatId: string) => {
          if (chatId === "-400") return Promise.resolve({ status: "member" });
          return Promise.resolve({ status: "left" });
        }),
      };
      const accessible = await getAccessibleChats({} as never, api as never, 42);
      expect(accessible.map((c) => c.id)).toEqual([42n, -400n]);
    });
  });
});
