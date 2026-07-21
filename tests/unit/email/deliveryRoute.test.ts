import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindAliasById = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
}));

const { readAttemptRoute } = await import("../../../src/email/deliveryRoute.js");

const activeAlias = {
  id: "alias-uuid",
  status: "active",
  chatId: -100n,
  messageThreadId: 5n,
  createdBy: 1n,
};

describe("readAttemptRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("freezes the route from a single fresh alias read", async () => {
    mockFindAliasById.mockResolvedValue(activeAlias);

    const result = await readAttemptRoute({} as never, "alias-uuid");

    expect(mockFindAliasById).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      alias: activeAlias,
      route: { chatId: -100n, threadId: 5n },
    });
  });

  it("normalizes a missing thread id to null", async () => {
    mockFindAliasById.mockResolvedValue({ ...activeAlias, messageThreadId: null });

    const result = await readAttemptRoute({} as never, "alias-uuid");

    expect(result).toMatchObject({ ok: true, route: { chatId: -100n, threadId: null } });
  });

  it("reports the alias status when it is not deliverable", async () => {
    mockFindAliasById.mockResolvedValue({ ...activeAlias, status: "paused" });

    const result = await readAttemptRoute({} as never, "alias-uuid");

    expect(result).toEqual({ ok: false, aliasStatus: "paused" });
  });

  it("reports a missing alias", async () => {
    mockFindAliasById.mockResolvedValue(null);

    const result = await readAttemptRoute({} as never, "alias-uuid");

    expect(result).toEqual({ ok: false, aliasStatus: null });
  });
});
