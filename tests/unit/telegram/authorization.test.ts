import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindActiveChats = vi.fn();
const mockFindChatById = vi.fn();
const mockFindAliasById = vi.fn();
const mockLoadConfig = vi.fn(() => ({ appMode: "self-hosted" }));
const mockUserHasOrganizationRole = vi.fn();

vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock("../../../src/db/repos/chats.js", () => ({
  findActiveChats: (...args: unknown[]): unknown => mockFindActiveChats(...args),
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
}));

vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
}));

vi.mock("../../../src/db/repos/organizationMembers.js", () => ({
  userHasOrganizationRole: (...args: unknown[]): unknown => mockUserHasOrganizationRole(...args),
}));

const { canManageAlias, canManageChat, getAccessibleChats } =
  await import("../../../src/telegram/authorization.js");

describe("telegram authorization", () => {
  beforeEach(() => {
    mockFindActiveChats.mockReset();
    mockFindChatById.mockReset();
    mockFindAliasById.mockReset();
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    mockUserHasOrganizationRole.mockReset();
  });

  it("always allows a user to manage their own DM chat", async () => {
    const api = { getChatMember: vi.fn() };

    await expect(canManageChat(api as never, 42, 42n)).resolves.toBe(true);
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it("in hosted mode: requires the user's DM chat to belong to their organization", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindChatById.mockResolvedValue({
      id: 42n,
      title: "DM",
      organizationId: "org-1",
    });
    mockUserHasOrganizationRole.mockResolvedValue(true);
    const api = { getChatMember: vi.fn() };

    await expect(canManageChat(api as never, 42, 42n)).resolves.toBe(true);

    expect(mockUserHasOrganizationRole).toHaveBeenCalledWith(expect.anything(), "org-1", 42n, [
      "owner",
      "admin",
      "member",
    ]);
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it("in hosted mode: denies an unregistered own DM chat", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindChatById.mockResolvedValue(null);
    const api = { getChatMember: vi.fn() };

    await expect(canManageChat(api as never, 43, 43n)).resolves.toBe(false);

    expect(mockUserHasOrganizationRole).not.toHaveBeenCalled();
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

  it("in hosted mode: requires organization membership before Telegram chat access", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindChatById.mockResolvedValue({
      id: -2101n,
      title: "Hosted",
      organizationId: "org-1",
    });
    mockUserHasOrganizationRole.mockResolvedValue(false);
    const api = {
      getChatMember: vi.fn().mockResolvedValue({ status: "member" }),
    };

    await expect(canManageChat(api as never, 201, -2101n, { fresh: true })).resolves.toBe(false);

    expect(mockUserHasOrganizationRole).toHaveBeenCalledWith(expect.anything(), "org-1", 201n, [
      "owner",
      "admin",
      "member",
    ]);
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it("in hosted mode: allows chat access when organization and Telegram membership both pass", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindChatById.mockResolvedValue({
      id: -2102n,
      title: "Hosted",
      organizationId: "org-1",
    });
    mockUserHasOrganizationRole.mockResolvedValue(true);
    const api = {
      getChatMember: vi.fn().mockResolvedValue({ status: "member" }),
    };

    await expect(canManageChat(api as never, 202, -2102n, { fresh: true })).resolves.toBe(true);

    expect(api.getChatMember).toHaveBeenCalledWith("-2102", 202);
  });

  it("in hosted mode: hides unowned legacy group chats", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindActiveChats.mockResolvedValue([{ id: -2201n, title: "Legacy" }]);
    mockFindChatById.mockResolvedValue({ id: -2201n, title: "Legacy", organizationId: null });
    const api = {
      getChatMember: vi.fn().mockResolvedValue({ status: "member" }),
    };

    await expect(getAccessibleChats({} as never, api as never, 220)).resolves.toEqual([]);

    expect(api.getChatMember).not.toHaveBeenCalled();
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

  it("in hosted mode: denies alias creator access without current organization membership", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindAliasById.mockResolvedValue({
      id: "alias-creator",
      status: "active",
      organizationId: "org-1",
      createdBy: 301n,
      chatId: -4001n,
    });
    mockUserHasOrganizationRole.mockResolvedValue(false);
    const api = {
      getChatMember: vi.fn().mockResolvedValue({ status: "administrator" }),
    };

    await expect(canManageAlias({} as never, api as never, 301, "alias-creator")).resolves.toBe(
      false,
    );

    expect(mockUserHasOrganizationRole).toHaveBeenCalledWith(expect.anything(), "org-1", 301n, [
      "owner",
      "admin",
      "member",
    ]);
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it("in hosted mode: denies tenantless aliases even for their creator", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindAliasById.mockResolvedValue({
      id: "alias-tenantless",
      status: "active",
      organizationId: null,
      createdBy: 301n,
      chatId: 301n,
    });
    const api = { getChatMember: vi.fn() };

    await expect(canManageAlias({} as never, api as never, 301, "alias-tenantless")).resolves.toBe(
      false,
    );

    expect(mockUserHasOrganizationRole).not.toHaveBeenCalled();
    expect(api.getChatMember).not.toHaveBeenCalled();
  });
});
