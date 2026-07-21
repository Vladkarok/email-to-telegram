/**
 * Acceptance-criteria oracle for the version-CAS
 * (docs/plans/2026-07-19-alias-chat-mobility.md § Acceptance criteria, Move).
 *
 * Rather than mocking a fixed CAS outcome, these tests run the real helpers
 * against a tiny in-memory row whose `routing_version` behaves like the
 * database's: the UPDATE matches only when the expected version equals the
 * current one. That makes "exactly one winner" an emergent property of the
 * code under test, not of the fixture.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  moveAliasWithCas,
  setAliasTopicWithCas,
  softDeleteAliasWithCas,
} from "../../../../src/db/repos/aliasRouting.js";

const dialect = new PgDialect();

/**
 * Pulls the expected routing version out of the helper's REAL where clause,
 * so the fixture honours the actual CAS predicate rather than a value the
 * test re-injects.
 */
function expectedVersionOf(condition: unknown): number | null {
  const params = dialect.sqlToQuery(condition as SQL).params;
  const version = params.find((p) => typeof p === "number");
  return typeof version === "number" ? version : null;
}

interface Row {
  id: string;
  chatId: bigint;
  messageThreadId: bigint | null;
  routingVersion: number;
  status: string;
  createdBy: bigint;
}

/**
 * Minimal drizzle stand-in implementing exactly the CAS semantics:
 * `WHERE id = ? AND routing_version = ? AND status <> 'deleted'`.
 */
function makeCasDb(row: Row) {
  const auditRows: Record<string, unknown>[] = [];

  const applyUpdate = (expectedVersion: number, mutate: (current: Row) => Partial<Row>): Row[] => {
    if (row.routingVersion !== expectedVersion || row.status === "deleted") return [];
    Object.assign(row, mutate(row));
    return [{ ...row }];
  };

  const db = {
    execute: () => Promise.resolve(undefined),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => ({
          returning: () => {
            const expected = expectedVersionOf(condition);
            if (expected === null) return Promise.resolve([]);
            return Promise.resolve(
              applyUpdate(expected, () => {
                const next: Partial<Row> = {};
                if ("chatId" in values) next.chatId = values["chatId"] as bigint;
                if ("messageThreadId" in values) {
                  next.messageThreadId = values["messageThreadId"] as bigint | null;
                }
                if ("status" in values) next.status = values["status"] as string;
                // A `routingVersion` in a set clause is always the `+ 1` SQL.
                if ("routingVersion" in values) next.routingVersion = row.routingVersion + 1;
                return next;
              }),
            );
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        auditRows.push(values);
        return Promise.resolve(undefined);
      },
    }),
  };
  return { db: db as never, row, auditRows };
}

const baseRow = (): Row => ({
  id: "alias-1",
  chatId: -100n,
  messageThreadId: null,
  routingVersion: 0,
  status: "active",
  createdBy: 7n,
});

function moveParams(expectedVersion: number, newChatId: bigint) {
  return {
    aliasId: "alias-1",
    expectedVersion,
    newChatId,
    oldChatId: -100n,
    oldThreadId: null,
    actorId: 7n,
    aliasOwnerId: 7n,
    authzPath: "admin" as const,
  };
}

describe("version-CAS concurrency oracle", () => {
  let fixture: ReturnType<typeof makeCasDb>;

  beforeEach(() => {
    fixture = makeCasDb(baseRow());
  });

  it("move vs move on the same version: exactly one wins", async () => {
    const first = await moveAliasWithCas(fixture.db, moveParams(0, -200n));
    const second = await moveAliasWithCas(fixture.db, moveParams(0, -300n));

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "version_conflict" });
    expect(fixture.row.chatId).toBe(-200n);
    // The loser wrote no audit row.
    expect(fixture.auditRows).toHaveLength(1);
  });

  it("move vs delete on the same version: the delete loses, not silently wins", async () => {
    const moved = await moveAliasWithCas(fixture.db, moveParams(0, -200n));
    const deleted = await softDeleteAliasWithCas(fixture.db, {
      aliasId: "alias-1",
      expectedVersion: 0,
    });

    expect(moved.ok).toBe(true);
    expect(deleted).toEqual({ ok: false, reason: "version_conflict" });
    expect(fixture.row.status).toBe("active");
  });

  it("A→B→A: a confirmation expecting the original chat is rejected after the round trip", async () => {
    // The user opens a confirm screen while the alias is in A (version 0).
    const staleVersion = 0;

    await moveAliasWithCas(fixture.db, moveParams(0, -200n));
    await moveAliasWithCas(fixture.db, { ...moveParams(1, -100n), oldChatId: -200n });

    // The alias is back in chat A, so a chat-id check would pass — the
    // version must still reject the stale confirmation.
    expect(fixture.row.chatId).toBe(-100n);
    const stale = await moveAliasWithCas(fixture.db, moveParams(staleVersion, -999n));

    expect(stale).toEqual({ ok: false, reason: "version_conflict" });
    expect(fixture.row.chatId).toBe(-100n);
  });

  it("a stale topic callback from the pre-move chat cannot install a foreign topic", async () => {
    const staleVersion = 0;
    await moveAliasWithCas(fixture.db, moveParams(0, -200n));

    const stale = await setAliasTopicWithCas(fixture.db, {
      aliasId: "alias-1",
      expectedVersion: staleVersion,
      threadId: 42n,
    });

    expect(stale).toEqual({ ok: false, reason: "version_conflict" });
    expect(fixture.row.messageThreadId).toBeNull();
  });

  it("repeating the same confirmation twice moves the alias once", async () => {
    const first = await moveAliasWithCas(fixture.db, moveParams(0, -200n));
    const replay = await moveAliasWithCas(fixture.db, moveParams(0, -200n));

    expect(first.ok).toBe(true);
    expect(replay).toEqual({ ok: false, reason: "version_conflict" });
    expect(fixture.auditRows).toHaveLength(1);
  });

  it("a move bumps the version, and the topic set that follows it succeeds", async () => {
    await moveAliasWithCas(fixture.db, moveParams(0, -200n));
    expect(fixture.row.routingVersion).toBe(1);

    const topic = await setAliasTopicWithCas(fixture.db, {
      aliasId: "alias-1",
      expectedVersion: 1,
      threadId: 9n,
    });

    expect(topic.ok).toBe(true);
    expect(fixture.row.messageThreadId).toBe(9n);
    expect(fixture.row.routingVersion).toBe(2);
  });

  it("a deleted alias rejects every further routing mutation", async () => {
    await softDeleteAliasWithCas(fixture.db, { aliasId: "alias-1", expectedVersion: 0 });
    expect(fixture.row.status).toBe("deleted");

    const move = await moveAliasWithCas(fixture.db, moveParams(0, -200n));
    expect(move).toEqual({ ok: false, reason: "version_conflict" });
  });
});
