import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  buildAliasTombstoneSet,
  findRecentAliasTombstone,
  deleteExpiredAliasTombstones,
  repointAliasesToChat,
} from "../../../../src/db/repos/aliases.js";
import { emailAddresses } from "../../../../src/db/schema.js";

const dialect = new PgDialect();

describe("buildAliasTombstoneSet", () => {
  it("renames local_part and full_address with a tombstone suffix in one update", () => {
    const setArg = buildAliasTombstoneSet();

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

describe("repointAliasesToChat", () => {
  function makeUpdateDb(rows: unknown[]) {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    return {
      db: { update } as unknown as Parameters<typeof repointAliasesToChat>[0],
      update,
      set,
      returning,
    };
  }

  it("re-points every alias of the old chat and returns the affected rows", async () => {
    const rows = [
      { id: "a-1", createdBy: 7n, messageThreadId: null },
      { id: "a-2", createdBy: 8n, messageThreadId: 12n },
    ];
    const { db, update, set } = makeUpdateDb(rows);

    const affected = await repointAliasesToChat(db, -100123n, -1002222333444n);

    // The caller needs owner + prior thread per alias to write the audit.
    expect(affected).toEqual(rows);
    expect(update).toHaveBeenCalledWith(emailAddresses);
    const [setArg] = set.mock.calls[0] as [
      { chatId: bigint; routingVersion: SQL; updatedAt: Date },
    ];
    expect(setArg.chatId).toBe(-1002222333444n);
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it("bumps routing_version so confirmations authorized against the old id lose", async () => {
    const { db, set } = makeUpdateDb([]);

    await repointAliasesToChat(db, -100123n, -1002222333444n);

    const [setArg] = set.mock.calls[0] as [{ routingVersion: SQL }];
    const versionSql = dialect.sqlToQuery(setArg.routingVersion).sql;
    expect(versionSql).toContain('"routing_version"');
    expect(versionSql).toContain("+");
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
