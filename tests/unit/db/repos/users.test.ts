import { describe, expect, it, vi } from "vitest";
import {
  findOrCreateUserById,
  LocaleColumnUnavailableError,
  updateUserLocale,
  upsertUser,
} from "../../../../src/db/repos/users.js";

function makeDb({ existing = null, inserted = null }: { existing?: unknown; inserted?: unknown }) {
  const where = vi.fn().mockResolvedValue(existing ? [existing] : []);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const insertReturning = vi.fn().mockResolvedValue(inserted ? [inserted] : []);
  const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
  const insertValues = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values: insertValues }));

  return {
    db: { select, insert } as unknown as Parameters<typeof findOrCreateUserById>[0],
    mocks: { select, where, insert, insertValues, onConflictDoNothing, insertReturning },
  };
}

describe("findOrCreateUserById", () => {
  it("returns the existing user without inserting when one exists", async () => {
    const existing = {
      id: 123n,
      username: "alice",
      isAllowed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { db, mocks } = makeDb({ existing });

    const result = await findOrCreateUserById(db, 123n);

    expect(result).toBe(existing);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("creates a new user with null username when none exists", async () => {
    const created = {
      id: 999n,
      username: null,
      isAllowed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { db, mocks } = makeDb({ existing: null, inserted: created });

    const result = await findOrCreateUserById(db, 999n);

    expect(result).toBe(created);
    expect(mocks.insertValues).toHaveBeenCalledWith({ id: 999n, username: null, isAllowed: false });
    expect(mocks.onConflictDoNothing).toHaveBeenCalled();
  });

  it("re-reads after insert race when on-conflict returns no row", async () => {
    const raced = {
      id: 555n,
      username: "bob",
      isAllowed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // First select: empty (decides to insert). Insert returning: empty (race). Second select: raced row.
    const where = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([raced]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const insertReturning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
    const insertValues = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values: insertValues }));
    const db = { select, insert } as unknown as Parameters<typeof findOrCreateUserById>[0];

    const result = await findOrCreateUserById(db, 555n);

    expect(result).toBe(raced);
    expect(insert).toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("throws when both insert and re-read return nothing", async () => {
    const where = vi.fn().mockResolvedValue([]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const insertReturning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
    const insertValues = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values: insertValues }));
    const db = { select, insert } as unknown as Parameters<typeof findOrCreateUserById>[0];

    await expect(findOrCreateUserById(db, 7n)).rejects.toThrow(/no row returned/i);
  });
});

describe("upsertUser", () => {
  it("stores a supported locale on first contact", async () => {
    const returned = {
      id: 123n,
      username: "alice",
      locale: "uk",
      isAllowed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const returning = vi.fn().mockResolvedValue([returned]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as unknown as Parameters<typeof upsertUser>[0];

    const result = await upsertUser(db, { id: 123n, username: "alice", locale: "uk-UA" });

    expect(result).toBe(returned);
    expect(values).toHaveBeenCalledWith({
      id: 123n,
      username: "alice",
      locale: "uk",
      isAllowed: false,
    });
  });

  it("falls back when users.locale has not been migrated yet", async () => {
    const legacyReturned = {
      id: 123n,
      username: "alice",
      isAllowed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const missingLocale = Object.assign(new Error('column "locale" does not exist'), {
      code: "42703",
    });
    const firstReturning = vi.fn().mockRejectedValue(missingLocale);
    const secondReturning = vi.fn().mockResolvedValue([legacyReturned]);
    const firstOnConflict = vi.fn(() => ({ returning: firstReturning }));
    const secondOnConflict = vi.fn(() => ({ returning: secondReturning }));
    const firstValues = vi.fn(() => ({ onConflictDoUpdate: firstOnConflict }));
    const secondValues = vi.fn(() => ({ onConflictDoUpdate: secondOnConflict }));
    const insert = vi
      .fn()
      .mockReturnValueOnce({ values: firstValues })
      .mockReturnValueOnce({ values: secondValues });
    const db = { insert } as unknown as Parameters<typeof upsertUser>[0];

    const result = await upsertUser(db, { id: 123n, username: "alice", locale: "uk" });

    expect(result).toEqual(legacyReturned);
    expect(firstValues).toHaveBeenCalledWith({
      id: 123n,
      username: "alice",
      locale: "uk",
      isAllowed: false,
    });
    expect(secondValues).toHaveBeenCalledWith({ id: 123n, username: "alice", isAllowed: false });
  });
});

describe("updateUserLocale", () => {
  it("surfaces a typed unavailable error when the locale column is missing", async () => {
    const missingLocale = Object.assign(new Error('column "locale" does not exist'), {
      code: "42703",
    });
    const where = vi.fn().mockRejectedValue(missingLocale);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update } as unknown as Parameters<typeof updateUserLocale>[0];

    await expect(updateUserLocale(db, 123n, "uk")).rejects.toBeInstanceOf(
      LocaleColumnUnavailableError,
    );
  });
});
