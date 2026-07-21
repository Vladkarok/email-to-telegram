import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  moveAliasWithCas,
  setAliasTopicWithCas,
  softDeleteAliasWithCas,
  insertAliasMoveEvent,
} from "../../../../src/db/repos/aliasRouting.js";
import { emailAddresses, aliasMoveEvents } from "../../../../src/db/schema.js";

const dialect = new PgDialect();

const movedAlias = {
  id: "alias-1",
  createdBy: 7n,
  chatId: -200n,
  messageThreadId: null,
  routingVersion: 4,
  status: "active",
};

/**
 * Fake drizzle handle recording update/insert chains. `updateRows` controls
 * what the CAS UPDATE ... RETURNING yields: [] simulates a lost race.
 */
function makeDb(updateRows: unknown[] = [movedAlias]) {
  const updateReturning = vi.fn().mockResolvedValue(updateRows);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  // moveAliasWithCas takes the per-user advisory lock that /delete_me holds.
  const execute = vi.fn().mockResolvedValue(undefined);

  const db = {
    update,
    insert,
    execute,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  return { db, update, set, updateWhere, insert, insertValues, execute };
}

/** The rendered WHERE clause of the CAS update. */
function casWhere(updateWhere: ReturnType<typeof vi.fn>): string {
  const [condition] = updateWhere.mock.calls[0] as [SQL];
  return dialect.sqlToQuery(condition).sql;
}

function casParams(updateWhere: ReturnType<typeof vi.fn>): unknown[] {
  const [condition] = updateWhere.mock.calls[0] as [SQL];
  return dialect.sqlToQuery(condition).params;
}

describe("moveAliasWithCas", () => {
  const params = {
    aliasId: "alias-1",
    expectedVersion: 4,
    newChatId: -200n,
    oldChatId: -100n,
    oldThreadId: null,
    actorId: 7n,
    aliasOwnerId: 7n,
    authzPath: "admin" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("guards on id, routing_version and non-deleted status", async () => {
    const { db, update, updateWhere } = makeDb();

    await moveAliasWithCas(db as never, params);

    expect(update).toHaveBeenCalledWith(emailAddresses);
    const where = casWhere(updateWhere);
    expect(where).toContain('"id"');
    expect(where).toContain('"routing_version"');
    expect(where).toContain('"status"');
    expect(casParams(updateWhere)).toContain(4);
    expect(casParams(updateWhere)).toContain("deleted");
  });

  it("re-points the chat, clears the thread and bumps the version", async () => {
    const { db, set } = makeDb();

    await moveAliasWithCas(db as never, params);

    const [setArg] = set.mock.calls[0] as [
      { chatId: bigint; messageThreadId: null; routingVersion: SQL; updatedAt: Date },
    ];
    expect(setArg.chatId).toBe(-200n);
    // Forum moves land in General; the thread never survives a move.
    expect(setArg.messageThreadId).toBeNull();
    const versionSql = dialect.sqlToQuery(setArg.routingVersion).sql;
    expect(versionSql).toContain('"routing_version"');
    expect(versionSql).toContain("+");
  });

  it("writes the audit event in the SAME transaction as the mutation", async () => {
    const { db, insert, insertValues, update } = makeDb();

    const result = await moveAliasWithCas(db as never, { ...params, operationId: "op-1" });

    expect(result).toEqual({ ok: true, alias: movedAlias });
    expect(insert).toHaveBeenCalledWith(aliasMoveEvents);
    const [event] = insertValues.mock.calls[0] as [Record<string, unknown>];
    expect(event).toMatchObject({
      operationId: "op-1",
      aliasId: "alias-1",
      aliasOwnerId: 7n,
      actorId: 7n,
      authzPath: "admin",
      newChatId: -200n,
      newThreadId: null,
      outcome: "succeeded",
    });
    // Same fake handle ⇒ same transaction scope.
    expect(update.mock.calls.length).toBe(1);
  });

  it("propagates an audit-insert failure so the move rolls back", async () => {
    const { db, insertValues } = makeDb();
    insertValues.mockRejectedValue(new Error("audit insert failed"));

    await expect(moveAliasWithCas(db as never, params)).rejects.toThrow("audit insert failed");
  });

  it("holds the per-user erasure lock before mutating, so /delete_me cannot interleave", async () => {
    const { db, execute, update } = makeDb();

    await moveAliasWithCas(db as never, params);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
  });

  it("locks BOTH owner and actor, ascending, when a third party performs the move", async () => {
    const { db, execute, update } = makeDb();

    // Actor 3 moves owner 7's alias. Both ids land in the audit row, so both
    // must be locked against their owners' concurrent /delete_me — and in a
    // fixed ascending order, or two such moves could deadlock each other.
    await moveAliasWithCas(db as never, { ...params, actorId: 3n, aliasOwnerId: 7n });

    expect(execute).toHaveBeenCalledTimes(2);
    const locked = execute.mock.calls.map(([sqlArg]) => {
      const rendered = dialect.sqlToQuery(sqlArg as SQL);
      return rendered.params[0];
    });
    expect(locked).toEqual([3n, 7n]);
    // Locks precede the row-level UPDATE — the order every other writer uses.
    for (const order of execute.mock.invocationCallOrder) {
      expect(order).toBeLessThan(update.mock.invocationCallOrder[0]);
    }
  });

  it("reports a version conflict without writing an audit row", async () => {
    const { db, insert } = makeDb([]);

    const result = await moveAliasWithCas(db as never, params);

    expect(result).toEqual({ ok: false, reason: "version_conflict" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("records the pre-move route from the caller's authorized snapshot", async () => {
    const { db, insertValues } = makeDb();

    // Whenever the CAS succeeds, the caller's snapshot WAS the current state —
    // that is what the version guard establishes — so it is safe forensics.
    await moveAliasWithCas(db as never, { ...params, oldChatId: -555n, oldThreadId: 42n });

    const [event] = insertValues.mock.calls[0] as [Record<string, unknown>];
    expect(event).toMatchObject({ oldChatId: -555n, oldThreadId: 42n });
  });
});

describe("setAliasTopicWithCas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bumps the version so a stale callback cannot install a foreign topic", async () => {
    const { db, set, updateWhere } = makeDb();

    const result = await setAliasTopicWithCas(db as never, {
      aliasId: "alias-1",
      expectedVersion: 4,
      threadId: 9n,
    });

    expect(result).toEqual({ ok: true, alias: movedAlias });
    const [setArg] = set.mock.calls[0] as [{ messageThreadId: bigint; routingVersion: SQL }];
    expect(setArg.messageThreadId).toBe(9n);
    expect(dialect.sqlToQuery(setArg.routingVersion).sql).toContain("+");
    expect(casParams(updateWhere)).toContain(4);
  });

  it("rejects a topic callback authorized against an older routing version", async () => {
    const { db } = makeDb([]);

    const result = await setAliasTopicWithCas(db as never, {
      aliasId: "alias-1",
      expectedVersion: 3,
      threadId: 9n,
    });

    expect(result).toEqual({ ok: false, reason: "version_conflict" });
  });

  it("does not write a move audit row for a topic change", async () => {
    const { db, insert } = makeDb();

    await setAliasTopicWithCas(db as never, {
      aliasId: "alias-1",
      expectedVersion: 4,
      threadId: null,
    });

    expect(insert).not.toHaveBeenCalled();
  });
});

describe("softDeleteAliasWithCas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tombstones the name under the same version guard", async () => {
    const { db, set, updateWhere } = makeDb();

    const result = await softDeleteAliasWithCas(db as never, {
      aliasId: "alias-1",
      expectedVersion: 4,
    });

    expect(result).toEqual({ ok: true, alias: movedAlias });
    const [setArg] = set.mock.calls[0] as [
      { localPart: SQL; fullAddress: SQL; status: string; routingVersion?: unknown },
    ];
    expect(setArg.status).toBe("deleted");
    const localPartSql = dialect.sqlToQuery(setArg.localPart);
    expect(localPartSql.params.some((p) => typeof p === "string" && p.includes("~del~"))).toBe(
      true,
    );
    // Deletion is terminal: nothing re-reads the version afterwards.
    expect(setArg.routingVersion).toBeUndefined();
    expect(casParams(updateWhere)).toContain(4);
  });

  it("loses a delete-vs-move race instead of silently winning", async () => {
    const { db } = makeDb([]);

    const result = await softDeleteAliasWithCas(db as never, {
      aliasId: "alias-1",
      expectedVersion: 4,
    });

    expect(result).toEqual({ ok: false, reason: "version_conflict" });
  });
});

describe("insertAliasMoveEvent", () => {
  it("defaults outcome to succeeded and accepts a null actor for migrations", async () => {
    const { db, insertValues } = makeDb();

    await insertAliasMoveEvent(db as never, {
      operationId: "op-9",
      aliasId: "alias-1",
      aliasOwnerId: 7n,
      actorId: null,
      authzPath: "migration",
      oldChatId: -100n,
      newChatId: -200n,
      oldThreadId: null,
      newThreadId: null,
    });

    const [event] = insertValues.mock.calls[0] as [Record<string, unknown>];
    expect(event).toMatchObject({ actorId: null, authzPath: "migration", outcome: "succeeded" });
  });
});
