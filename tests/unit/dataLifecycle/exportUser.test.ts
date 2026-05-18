import { describe, it, expect, vi, beforeEach } from "vitest";

const { exportHostedUserData } = await import("../../../src/dataLifecycle/exportUser.js");

function thenable(rows: unknown[]) {
  const obj: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  obj["limit"] = vi.fn().mockResolvedValue(rows);
  obj["orderBy"] = vi.fn(() => thenable(rows));
  return obj;
}

function selectChainResolvingTo(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => thenable(rows)),
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => thenable(rows)),
      })),
      orderBy: vi.fn().mockResolvedValue(rows),
    })),
  };
}

function makeDb(userRow: unknown | null) {
  let call = 0;
  // Order matches exportHostedUserData internals:
  // 1: user lookup (.from().where().limit())
  // 2-N: aliases / usage months / storage usage / delivery summary / manual events
  const selectResponses: unknown[][] = [
    userRow ? [userRow] : [], // user
    [], // aliases
    [], // usage months
    [], // storage usage
    [], // delivery summary
    [], // manual billing events
  ];
  const select = vi.fn(() => {
    const rows = selectResponses[call] ?? [];
    call += 1;
    return selectChainResolvingTo(rows);
  });
  return { select } as never;
}

describe("exportHostedUserData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the user does not exist", async () => {
    const db = makeDb(null);
    await expect(exportHostedUserData(db, 1n)).resolves.toBeNull();
  });

  it("returns an export envelope keyed by the user", async () => {
    const userRow = {
      id: 1n,
      username: "alice",
      planCode: "free",
      subscriptionStatus: "free",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-02T00:00:00.000Z"),
    };
    const db = makeDb(userRow);
    const result = await exportHostedUserData(db, 1n, new Date("2026-05-18T00:00:00.000Z"));

    expect(result).toMatchObject({
      exportedAt: "2026-05-18T00:00:00.000Z",
      user: {
        id: "1",
        username: "alice",
        planCode: "free",
        subscriptionStatus: "free",
      },
      aliases: [],
      usageMonths: [],
    });
  });
});
