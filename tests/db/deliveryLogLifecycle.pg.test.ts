/**
 * The delivery-log status lifecycle against a real Postgres (TEST_DATABASE_URL,
 * see tests/helpers/pgTestDb.ts): each named transition in
 * src/db/repos/deliveryLogs.ts, the retry claim, and cleanup's raw-expiry
 * close. The guards live in WHERE clauses, so only real SQL shows which rows
 * a statement touches.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type * as schema from "../../src/db/schema.js";
import { createPgTestDatabase, hasTestDatabase, type PgTestDatabase } from "../helpers/pgTestDb.js";
import {
  DELIVERY_RAW_PATH as RAW_PATH,
  readDeliveryLog,
  seedDeliveryLog,
  seedOwnerAndAlias,
} from "../helpers/deliveryFixtures.js";
import {
  NON_FINAL_DELIVERY_STATUSES,
  claimDeliveryLogForRetry,
  closeDeliveryLogOnRawExpiry,
  closeDeliveryLogPermanentlyFailed,
  createDeliveryLog,
  findLogsNeedingRetry,
  markDeliveryLogProcessing,
  reopenDeliveryLogAfterMigration,
  resetDeliveryLogAfterError,
  settleDeliveryLogAfterSend,
  type ClearedRawEmailColumns,
  type DeliveryLogStatus,
  type FinalDeliveryStatus,
} from "../../src/db/repos/deliveryLogs.js";

const OWNER = 7101n;
const FINAL_STATUSES: FinalDeliveryStatus[] = ["delivered", "permanently_failed"];
const CLEARED_RAW: ClearedRawEmailColumns = {
  rawEmailPath: null,
  rawEmailEncryptionMode: "none",
  rawEmailWrappedDek: null,
  rawEmailKekKeyId: null,
  rawEmailEncryptedAt: null,
};

describe.skipIf(!hasTestDatabase)("delivery-log lifecycle on real Postgres", () => {
  let t: PgTestDatabase;
  let alias: schema.EmailAddress;

  beforeAll(async () => {
    t = await createPgTestDatabase();
    await t.migrate();
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    alias = await seedOwnerAndAlias(t.db, { owner: OWNER });
  });

  async function seedLog(finalStatus: DeliveryLogStatus): Promise<string> {
    return (await seedDeliveryLog(t.db, alias, { finalStatus })).id;
  }

  function readLog(id: string): Promise<schema.DeliveryLog> {
    return readDeliveryLog(t.db, id);
  }

  it("inserts a new log as received", async () => {
    const log = await createDeliveryLog(t.db, {
      emailAddressId: alias.id,
      userId: OWNER,
      finalStatus: "received",
    });
    expect((await readLog(log!.id)).finalStatus).toBe("received");
  });

  it("marks a log processing and stamps processing_started_at", async () => {
    const id = await seedLog("received");
    await markDeliveryLogProcessing(t.db, id);
    const log = await readLog(id);
    expect(log.finalStatus).toBe("processing");
    expect(log.processingStartedAt).toBeInstanceOf(Date);
  });

  describe("claimDeliveryLogForRetry", () => {
    it.each(NON_FINAL_DELIVERY_STATUSES)("claims a %s log as retrying", async (status) => {
      const id = await seedLog(status);
      expect(await claimDeliveryLogForRetry(t.db, id)).toBe(true);
      expect((await readLog(id)).finalStatus).toBe("retrying");
    });

    it.each(FINAL_STATUSES)("leaves a %s log alone", async (status) => {
      const id = await seedLog(status);
      expect(await claimDeliveryLogForRetry(t.db, id)).toBe(false);
      expect((await readLog(id)).finalStatus).toBe(status);
    });

    it("returns false for an unknown log", async () => {
      expect(await claimDeliveryLogForRetry(t.db, "00000000-0000-0000-0000-000000000000")).toBe(
        false,
      );
    });
  });

  it("finds exactly the retryable logs: non-final, old enough, raw kept, processing only when stale", async () => {
    const receivedBefore = new Date("2026-11-20T12:00:00.000Z");
    const staleBefore = new Date("2026-11-20T11:00:00.000Z");
    const minute = 60_000;
    const old = new Date(receivedBefore.getTime() - minute);
    const recent = new Date(receivedBefore.getTime() + minute);
    const stale = new Date(staleBefore.getTime() - minute);
    const fresh = new Date(staleBefore.getTime() + minute);
    const seed = async (values: Partial<schema.NewDeliveryLog>): Promise<string> =>
      (await seedDeliveryLog(t.db, alias, { processingStartedAt: null, ...values })).id;

    const expected = [
      await seed({ finalStatus: "received", receivedAt: old }),
      await seed({ finalStatus: "failed", receivedAt: old }),
      await seed({ finalStatus: "retrying", receivedAt: old }),
      await seed({ finalStatus: "processing", receivedAt: old }),
      await seed({ finalStatus: "processing", receivedAt: old, processingStartedAt: stale }),
    ];
    await seed({ finalStatus: "received", receivedAt: recent });
    await seed({ finalStatus: "failed", receivedAt: recent });
    await seed({ finalStatus: "retrying", receivedAt: recent });
    await seed({ finalStatus: "processing", receivedAt: recent });
    await seed({ finalStatus: "processing", receivedAt: recent, processingStartedAt: stale });
    await seed({ finalStatus: "processing", receivedAt: old, processingStartedAt: fresh });
    await seed({ finalStatus: "delivered", receivedAt: old });
    await seed({ finalStatus: "permanently_failed", receivedAt: old });
    await seed({ finalStatus: "failed", receivedAt: old, ...CLEARED_RAW });
    // Exactly at the cutoffs: both comparisons are strict.
    await seed({ finalStatus: "failed", receivedAt: receivedBefore });
    await seed({ finalStatus: "processing", receivedAt: old, processingStartedAt: staleBefore });

    const found = await findLogsNeedingRetry(t.db, receivedBefore, staleBefore);

    expect(found.map((log) => log.id).sort()).toEqual([...expected].sort());
  });

  describe("settleDeliveryLogAfterSend", () => {
    it.each(["delivered", "failed", "permanently_failed"] as const)(
      "records a %s send outcome",
      async (outcome) => {
        const id = await seedLog("retrying");
        await settleDeliveryLogAfterSend(t.db, id, outcome);
        expect((await readLog(id)).finalStatus).toBe(outcome);
      },
    );

    it("writes by id without a status guard", async () => {
      const id = await seedLog("permanently_failed");
      await settleDeliveryLogAfterSend(t.db, id, "delivered");
      expect((await readLog(id)).finalStatus).toBe("delivered");
    });

    it("rolls back with the transaction it runs in", async () => {
      const id = await seedLog("processing");
      await expect(
        t.db.transaction(async (tx) => {
          await settleDeliveryLogAfterSend(tx, id, "delivered");
          throw new Error("attempt insert failed");
        }),
      ).rejects.toThrow("attempt insert failed");
      expect((await readLog(id)).finalStatus).toBe("processing");
    });
  });

  it("closes a log permanently failed before a send", async () => {
    const id = await seedLog("retrying");
    await closeDeliveryLogPermanentlyFailed(t.db, id);
    expect((await readLog(id)).finalStatus).toBe("permanently_failed");
  });

  it("reopens a delivered log after a migration, and the retry worker can claim it", async () => {
    const id = await seedLog("delivered");
    await reopenDeliveryLogAfterMigration(t.db, id);
    expect((await readLog(id)).finalStatus).toBe("failed");
    expect(await claimDeliveryLogForRetry(t.db, id)).toBe(true);
  });

  it.each(["retrying", "processing", "delivered"] as const)(
    "resets a %s log to failed after an unexpected error",
    async (status) => {
      const id = await seedLog(status);
      await resetDeliveryLogAfterError(t.db, id);
      expect((await readLog(id)).finalStatus).toBe("failed");
    },
  );

  describe("closeDeliveryLogOnRawExpiry", () => {
    it.each(NON_FINAL_DELIVERY_STATUSES)(
      "closes a %s log and clears its raw columns",
      async (status) => {
        const id = await seedLog(status);
        const closed = await t.db.transaction((tx) =>
          closeDeliveryLogOnRawExpiry(tx, id, CLEARED_RAW),
        );
        expect(closed).toBe(true);
        const log = await readLog(id);
        expect(log.finalStatus).toBe("permanently_failed");
        expect(log.rawEmailPath).toBeNull();
        expect(log.rawEmailEncryptionMode).toBe("none");
        expect(log.rawEmailWrappedDek).toBeNull();
        expect(log.rawEmailKekKeyId).toBeNull();
        expect(log.rawEmailEncryptedAt).toBeNull();
      },
    );

    it.each(FINAL_STATUSES)("does not touch a %s log", async (status) => {
      const id = await seedLog(status);
      const closed = await t.db.transaction((tx) =>
        closeDeliveryLogOnRawExpiry(tx, id, CLEARED_RAW),
      );
      expect(closed).toBe(false);
      const log = await readLog(id);
      expect(log.finalStatus).toBe(status);
      expect(log.rawEmailPath).toBe(RAW_PATH);
      expect(log.rawEmailKekKeyId).toBe("kek-1");
    });

    it("only touches the log it is given", async () => {
      const id = await seedLog("failed");
      const other = await seedLog("failed");
      await t.db.transaction((tx) => closeDeliveryLogOnRawExpiry(tx, id, CLEARED_RAW));
      const untouched = await readLog(other);
      expect(untouched.finalStatus).toBe("failed");
      expect(untouched.rawEmailPath).toBe(RAW_PATH);
    });

    it("rolls back with the caller's transaction", async () => {
      const id = await seedLog("failed");
      await expect(
        t.db.transaction(async (tx) => {
          expect(await closeDeliveryLogOnRawExpiry(tx, id, CLEARED_RAW)).toBe(true);
          throw new Error("storage decrement failed");
        }),
      ).rejects.toThrow("storage decrement failed");
      const log = await readLog(id);
      expect(log.finalStatus).toBe("failed");
      expect(log.rawEmailPath).toBe(RAW_PATH);
    });
  });
});
