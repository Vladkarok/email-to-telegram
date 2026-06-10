import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  softDeleteAlias,
  findRecentAliasTombstone,
  deleteExpiredAliasTombstones,
} from "../../../../src/db/repos/aliases.js";
import { emailAddresses } from "../../../../src/db/schema.js";

const dialect = new PgDialect();

describe("softDeleteAlias", () => {
  it("renames local_part and full_address with a tombstone suffix in one update", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update } as unknown as Parameters<typeof softDeleteAlias>[0];

    await softDeleteAlias(db, "uuid-1");

    expect(update).toHaveBeenCalledWith(emailAddresses);
    expect(set).toHaveBeenCalledOnce();
    const [setArg] = set.mock.calls[0] as [
      { localPart: SQL; fullAddress: SQL; status: string; updatedAt: Date },
    ];
    expect(setArg.status).toBe("deleted");
    expect(setArg.updatedAt).toBeInstanceOf(Date);

    const localPartSql = dialect.sqlToQuery(setArg.localPart);
    expect(localPartSql.sql).toContain('"local_part"');
    const marker = localPartSql.params.find(
      (p) => typeof p === "string" && /^~del~[a-z0-9]{8}$/.test(p),
    );
    expect(marker).toBeDefined();

    // full_address must reuse the SAME suffix and keep the domain part
    const fullAddressSql = dialect.sqlToQuery(setArg.fullAddress);
    expect(fullAddressSql.sql).toMatch(
      /split_part\((?:"email_addresses"\.)?"full_address", '@', 2\)/,
    );
    expect(fullAddressSql.params).toContain(marker);
  });
});

describe("findRecentAliasTombstone", () => {
  function makeSelectDb(rows: unknown[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    return { db: { select } as unknown as Parameters<typeof findRecentAliasTombstone>[0], where };
  }

  it("matches tombstones of the given name and returns the newest", async () => {
    const tombstone = { id: "t-1", createdBy: 42n };
    const { db } = makeSelectDb([tombstone]);

    const found = await findRecentAliasTombstone(db, "inbox", new Date());

    expect(found).toEqual(tombstone);
  });

  it("returns null when no tombstone exists", async () => {
    const { db } = makeSelectDb([]);

    expect(await findRecentAliasTombstone(db, "inbox", new Date())).toBeNull();
  });

  it("escapes LIKE wildcards in the name", async () => {
    const { db, where } = makeSelectDb([]);

    await findRecentAliasTombstone(db, "a_b%c", new Date());

    const [condition] = where.mock.calls[0] as [SQL];
    const rendered = dialect.sqlToQuery(condition);
    const pattern = rendered.params.find((p) => typeof p === "string" && p.includes("~del~"));
    expect(pattern).toBe("a\\_b\\%c~del~%");
  });
});

describe("deleteExpiredAliasTombstones", () => {
  it("hard-deletes only old tombstones with no remaining delivery logs", async () => {
    const where = vi.fn().mockResolvedValue({ rowCount: 2 });
    const del = vi.fn(() => ({ where }));
    const db = { delete: del } as unknown as Parameters<typeof deleteExpiredAliasTombstones>[0];
    const cutoff = new Date("2026-06-01T00:00:00Z");

    const purged = await deleteExpiredAliasTombstones(db, cutoff);

    expect(purged).toBe(2);
    expect(del).toHaveBeenCalledWith(emailAddresses);

    const [condition] = where.mock.calls[0] as [SQL];
    const rendered = dialect.sqlToQuery(condition);
    // Subquery must be parenthesized — notExists() does not wrap raw SQL.
    expect(rendered.sql).toMatch(/not exists \(select 1/i);
    expect(rendered.params).toContain("deleted");
    expect(rendered.params).toContain("%~del~%");
    // drizzle maps the Date through the column driver type (string param)
    expect(rendered.params.some((p) => typeof p === "string" && p.startsWith("2026-06-01"))).toBe(
      true,
    );
  });

  it("returns 0 when the driver reports no rowCount", async () => {
    const where = vi.fn().mockResolvedValue({});
    const del = vi.fn(() => ({ where }));
    const db = { delete: del } as unknown as Parameters<typeof deleteExpiredAliasTombstones>[0];

    expect(await deleteExpiredAliasTombstones(db, new Date())).toBe(0);
  });
});
