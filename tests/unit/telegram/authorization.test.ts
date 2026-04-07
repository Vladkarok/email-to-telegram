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

  it("always allows a user to manage their own DM chat", async () => {
    const api = { getChatMember: vi.fn() };

    await expect(canManageChat(api as never, 42, 42n)).resolves.toBe(true);
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it("caches non-fresh membership checks", async () => {
    const api = {
      getChatMember: vi
        .fn()
        .mockResolvedValueOnce({ status: "member" })
        .mockRejectedValueOnce(new Error("should not be called")),
    };

    await expect(canManageChat(api as never, 101, -1001n)).resolves.toBe(true);
    await expect(canManageChat(api as never, 101, -1001n)).resolves.toBe(true);

    expect(api.getChatMember).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache for fresh checks and denies unknown statuses or API errors", async () => {
    const api = {
      getChatMember: vi
        .fn()
        .mockResolvedValueOnce({ status: "member" })
        .mockResolvedValueOnce({ status: "left" })
        .mockRejectedValueOnce(new Error("bot removed")),
    };

    await expect(canManageChat(api as never, 102, -1002n)).resolves.toBe(true);
    await expect(canManageChat(api as never, 102, -1002n, { fresh: true })).resolves.toBe(false);
    await expect(canManageChat(api as never, 103, -1003n, { fresh: true })).resolves.toBe(false);

    expect(api.getChatMember).toHaveBeenCalledTimes(3);
  });

  it("filters accessible chats to the ones the user can manage", async () => {
    const api = {
      getChatMember: vi
        .fn()
        .mockResolvedValueOnce({ status: "member" })
        .mockResolvedValueOnce({ status: "left" }),
    };
    mockFindActiveChats.mockResolvedValue([
      { id: -2001n, title: "Allowed" },
      { id: -2002n, title: "Denied" },
    ]);

    await expect(getAccessibleChats({} as never, api as never, 201)).resolves.toEqual([
      { id: -2001n, title: "Allowed" },
    ]);
  });

  it("denies alias access when the alias is missing or deleted", async () => {
    const api = { getChatMember: vi.fn() };
    mockFindAliasById.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "alias-2",
      status: "deleted",
      createdBy: 7n,
      chatId: -3002n,
    });

    await expect(canManageAlias({} as never, api as never, 7, "alias-1")).resolves.toBe(false);
    await expect(canManageAlias({} as never, api as never, 7, "alias-2")).resolves.toBe(false);
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it("allows alias creators directly and otherwise checks chat management", async () => {
    const api = {
      getChatMember: vi.fn().mockResolvedValue({ status: "administrator" }),
    };
    mockFindAliasById
      .mockResolvedValueOnce({
        id: "alias-creator",
        status: "active",
        createdBy: 301n,
        chatId: -4001n,
      })
      .mockResolvedValueOnce({
        id: "alias-chat",
        status: "active",
        createdBy: 999n,
        chatId: -4002n,
      });

    await expect(canManageAlias({} as never, api as never, 301, "alias-creator")).resolves.toBe(
      true,
    );
    await expect(
      canManageAlias({} as never, api as never, 302, "alias-chat", { fresh: true }),
    ).resolves.toBe(true);

    expect(api.getChatMember).toHaveBeenCalledOnce();
    expect(api.getChatMember).toHaveBeenCalledWith("-4002", 302);
  });
});
