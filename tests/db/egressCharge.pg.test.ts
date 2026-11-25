/**
 * The plan-limit egress charge (src/billing/egressCharge.ts) against a real
 * Postgres (TEST_DATABASE_URL, see tests/helpers/pgTestDb.ts): what commits
 * together, what a refusal rolls back, the owner lock under concurrency, and
 * the self-hosted pass-through. The claims are the real one-time link claims.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import {
  createPgTestDatabase,
  hasTestDatabase,
  waitForAdvisoryLockWaiters,
  type PgTestDatabase,
} from "../helpers/pgTestDb.js";
import { seedDeliveryLog, seedOwnerAndAlias } from "../helpers/deliveryFixtures.js";
import { applyPlanLimitOverrides } from "../../src/billing/plans.js";
import { chargeEgress } from "../../src/billing/egressCharge.js";
import { createAttachmentLink, markLinkDownloaded } from "../../src/db/repos/attachmentLinks.js";
import { incrementUserUsageMonth, usageMonthForDate } from "../../src/db/repos/usage.js";

const OWNER = 7401n;
const EGRESS_LIMIT = 1_000;
const AT = new Date("2026-01-31T23:59:59.000Z");
const MONTH = "2026-01";

let pgdb: PgTestDatabase;
const savedAppMode = process.env["APP_MODE"];

beforeAll(async () => {
  if (!hasTestDatabase) return;
  pgdb = await createPgTestDatabase();
  await pgdb.migrate();
});

afterAll(async () => {
  if (!hasTestDatabase) return;
  await pgdb.drop();
});

afterEach(() => {
  if (savedAppMode === undefined) delete process.env["APP_MODE"];
  else process.env["APP_MODE"] = savedAppMode;
  applyPlanLimitOverrides({});
});

describe.skipIf(!hasTestDatabase)("egress charge on Postgres", () => {
  let attachmentId: string;
  let tokenCounter = 0;

  async function seed({ hosted }: { hosted: boolean }): Promise<void> {
    process.env["APP_MODE"] = hosted ? "hosted" : "self-hosted";
    applyPlanLimitOverrides({ free: { egressBytesMonth: EGRESS_LIMIT } });
    await pgdb.db.execute(sql`truncate user_usage_months cascade`);
    const alias = await seedOwnerAndAlias(pgdb.db, { owner: OWNER });
    const log = await seedDeliveryLog(pgdb.db, alias);
    const [attachment] = await pgdb.db
      .insert(schema.attachments)
      .values({ deliveryLogId: log.id, storagePath: "/data/attachments/a.bin", sizeBytes: 10 })
      .returning();
    attachmentId = attachment.id;
  }

  /** A one-time link to claim; returns its id. */
  async function newLink(): Promise<string> {
    const [row] = await pgdb.db
      .insert(schema.attachmentLinks)
      .values({
        attachmentId,
        tokenHash: `hash-${++tokenCounter}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: schema.attachmentLinks.id });
    return row.id;
  }

  async function linkCount(): Promise<number> {
    const rows = await pgdb.db.select().from(schema.attachmentLinks);
    return rows.length;
  }

  async function isClaimed(linkId: string): Promise<boolean> {
    const [row] = await pgdb.db
      .select({ downloadedAt: schema.attachmentLinks.downloadedAt })
      .from(schema.attachmentLinks)
      .where(eq(schema.attachmentLinks.id, linkId));
    return row.downloadedAt !== null;
  }

  async function egressUsed(month = MONTH): Promise<bigint | null> {
    const [row] = await pgdb.db
      .select({ egressBytes: schema.userUsageMonths.egressBytes })
      .from(schema.userUsageMonths)
      .where(
        and(eq(schema.userUsageMonths.userId, OWNER), eq(schema.userUsageMonths.month, month)),
      );
    return row?.egressBytes ?? null;
  }

  async function presetEgress(bytes: bigint, month = MONTH): Promise<void> {
    await incrementUserUsageMonth(pgdb.db, { userId: OWNER, month, egressBytes: bytes });
  }

  /** A charge whose prepare step also writes a link, the way the privacy view does. */
  function chargeWithPreparedWrite(
    linkId: string,
    egressBytes: bigint,
    ownerUserId: bigint | null = OWNER,
    onRefusal: "commit" | "rollback" = "rollback",
  ): ReturnType<typeof chargeEgress<string>> {
    return chargeEgress(pgdb.db, {
      ownerUserId,
      at: AT,
      onRefusal,
      prepare: async (tx) => {
        await createAttachmentLink(tx, attachmentId, `prepared-${++tokenCounter}`, AT);
        return { egressBytes, value: "page" };
      },
      claim: (tx) => markLinkDownloaded(tx, linkId, AT),
    });
  }

  describe("hosted", () => {
    beforeEach(() => seed({ hosted: true }));

    it("under the limit commits the prepared writes, the claim and the usage together", async () => {
      const linkId = await newLink();

      const result = await chargeWithPreparedWrite(linkId, 400n);

      expect(result).toEqual({ status: "charged", month: MONTH, egressBytes: 400n, value: "page" });
      expect(await isClaimed(linkId)).toBe(true);
      expect(await linkCount()).toBe(2);
      expect(await egressUsed()).toBe(400n);
    });

    it("over the limit charges nothing and rolls back the prepared writes", async () => {
      await presetEgress(900n);
      const linkId = await newLink();

      const result = await chargeWithPreparedWrite(linkId, 200n);

      expect(result).toEqual({
        status: "over_limit",
        month: MONTH,
        limit: { ok: false, code: "egress_limit", limit: EGRESS_LIMIT, used: 900 },
      });
      expect(await isClaimed(linkId)).toBe(false);
      expect(await linkCount()).toBe(1);
      expect(await egressUsed()).toBe(900n);
    });

    it("a lost claim charges nothing and rolls back the prepared writes", async () => {
      const linkId = await newLink();
      await markLinkDownloaded(pgdb.db, linkId, AT);

      const result = await chargeWithPreparedWrite(linkId, 400n);

      expect(result).toEqual({ status: "claim_lost", month: MONTH });
      expect(await linkCount()).toBe(1);
      expect(await egressUsed()).toBeNull();
    });

    it("with onRefusal commit, an over-limit refusal keeps the prepared writes", async () => {
      await presetEgress(900n);
      const linkId = await newLink();

      const result = await chargeWithPreparedWrite(linkId, 200n, OWNER, "commit");

      expect(result.status).toBe("over_limit");
      expect(await isClaimed(linkId)).toBe(false);
      expect(await linkCount()).toBe(2);
      expect(await egressUsed()).toBe(900n);
    });

    it("with onRefusal commit, a lost claim keeps the prepared writes", async () => {
      const linkId = await newLink();
      await markLinkDownloaded(pgdb.db, linkId, AT);

      const result = await chargeWithPreparedWrite(linkId, 400n, OWNER, "commit");

      expect(result).toEqual({ status: "claim_lost", month: MONTH });
      expect(await linkCount()).toBe(2);
      expect(await egressUsed()).toBeNull();
    });

    it("over the limit with the claim already taken answers over_limit, not claim_lost", async () => {
      // The limit is checked before the claim, as the routes did at HEAD: a
      // full account gets 403 even for a link that is already used.
      await presetEgress(900n);
      const linkId = await newLink();
      await markLinkDownloaded(pgdb.db, linkId, AT);

      const result = await chargeWithPreparedWrite(linkId, 200n);

      expect(result.status).toBe("over_limit");
      expect(await linkCount()).toBe(1);
      expect(await egressUsed()).toBe(900n);
    });

    it("rethrows a failure and rolls back what ran before it", async () => {
      const linkId = await newLink();
      const failure = new Error("claim failed");

      await expect(
        chargeEgress(pgdb.db, {
          ownerUserId: OWNER,
          at: AT,
          onRefusal: "commit",
          prepare: async (tx) => {
            await createAttachmentLink(tx, attachmentId, "prepared-then-failed", AT);
            return { egressBytes: 100n, value: undefined };
          },
          claim: () => Promise.reject(failure),
        }),
      ).rejects.toBe(failure);
      expect(await linkCount()).toBe(1);
      expect(await isClaimed(linkId)).toBe(false);
    });

    it("checks and counts in the month of `at`, not the current month", async () => {
      // The current month is already full; January has room.
      await presetEgress(BigInt(EGRESS_LIMIT), usageMonthForDate());
      const linkId = await newLink();

      const result = await chargeWithPreparedWrite(linkId, 300n);

      expect(result.status).toBe("charged");
      expect(result.month).toBe(MONTH);
      expect(await egressUsed(MONTH)).toBe(300n);
      expect(await egressUsed(usageMonthForDate())).toBe(BigInt(EGRESS_LIMIT));
    });

    it("lets exactly one of two concurrent charges at the edge of the limit through", async () => {
      const [first, second] = [await newLink(), await newLink()];
      // Hold the owner lock so both charges are queued behind it before either
      // reads the usage row; without the lock both would see zero and pass.
      const holder = await pgdb.client();
      try {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock($1)", [OWNER.toString()]);
        const charges = Promise.all([
          chargeWithPreparedWrite(first, 600n),
          chargeWithPreparedWrite(second, 600n),
        ]);
        await waitForAdvisoryLockWaiters(holder, 2);
        await holder.query("commit");

        const statuses = (await charges).map((result) => result.status).sort();
        expect(statuses).toEqual(["charged", "over_limit"]);
      } finally {
        await holder.end();
      }
      expect(await egressUsed()).toBe(600n);
      expect([await isClaimed(first), await isClaimed(second)].filter(Boolean)).toHaveLength(1);
      // The refused charge's prepared link is gone; the charged one's stays.
      expect(await linkCount()).toBe(3);
    });

    it("with a null owner runs on the handle as given and refuses as inactive", async () => {
      const linkId = await newLink();

      const result = await chargeWithPreparedWrite(linkId, 100n, null);

      expect(result).toEqual({
        status: "over_limit",
        month: MONTH,
        limit: { ok: false, code: "subscription_inactive" },
      });
      // No transaction: the prepared write was autocommitted and stays.
      expect(await linkCount()).toBe(2);
      expect(await isClaimed(linkId)).toBe(false);
    });
  });

  describe("self-hosted", () => {
    beforeEach(() => seed({ hosted: false }));

    it("enforces no limit and still records positive egress for a known owner", async () => {
      await presetEgress(BigInt(EGRESS_LIMIT));
      const linkId = await newLink();

      const result = await chargeWithPreparedWrite(linkId, 500n);

      expect(result).toEqual({ status: "charged", month: MONTH, egressBytes: 500n, value: "page" });
      expect(await isClaimed(linkId)).toBe(true);
      expect(await egressUsed()).toBe(BigInt(EGRESS_LIMIT) + 500n);
    });

    it("records nothing for zero bytes", async () => {
      const linkId = await newLink();

      const result = await chargeWithPreparedWrite(linkId, 0n);

      expect(result.status).toBe("charged");
      expect(await egressUsed()).toBeNull();
    });

    it("passes a null owner through without counting", async () => {
      const linkId = await newLink();

      const result = await chargeWithPreparedWrite(linkId, 500n, null);

      expect(result.status).toBe("charged");
      expect(await isClaimed(linkId)).toBe(true);
      expect(await pgdb.db.select().from(schema.userUsageMonths)).toEqual([]);
    });

    it("runs without a transaction, so a lost claim keeps the prepared writes", async () => {
      const linkId = await newLink();
      await markLinkDownloaded(pgdb.db, linkId, AT);

      const result = await chargeWithPreparedWrite(linkId, 500n);

      expect(result).toEqual({ status: "claim_lost", month: MONTH });
      expect(await linkCount()).toBe(2);
      expect(await egressUsed()).toBeNull();
    });
  });
});
