import { describe, expect, it, vi } from "vitest";
import {
  createManualBillingEvent,
  findLatestManualBillingEventForOrganization,
  findOrCreateManualBillingEvent,
  findManualBillingEventByPaymentReference,
  listManualBillingEventsForOrganization,
} from "../../../../src/db/repos/manualBillingEvents.js";

function makeInsertingDb(returned: unknown) {
  const returning = vi.fn().mockResolvedValue([returned]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return {
    db: { insert } as unknown as Parameters<typeof createManualBillingEvent>[0],
    mocks: { insert, values, returning },
  };
}

function makeSelectingDb(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ orderBy, limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select } as unknown as Parameters<typeof listManualBillingEventsForOrganization>[0],
    mocks: { select, from, where, orderBy, limit },
  };
}

describe("manual billing events repo", () => {
  describe("createManualBillingEvent", () => {
    it("inserts and returns a manual billing event", async () => {
      const created = {
        id: "event-1",
        organizationId: "org-1",
        telegramUserId: 123n,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
        paymentReference: "wise-2026-04-001",
        note: "Manual Wise payment",
        keptStripeLink: false,
        operatorSource: "cli",
        createdAt: new Date(),
      };
      const { db, mocks } = makeInsertingDb(created);

      const result = await createManualBillingEvent(db, {
        organizationId: "org-1",
        telegramUserId: 123n,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
        paymentReference: "wise-2026-04-001",
        note: "Manual Wise payment",
        keptStripeLink: false,
      });

      expect(result).toBe(created);
      expect(mocks.values).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          telegramUserId: 123n,
          planCode: "pro",
          subscriptionStatus: "active",
          paymentReference: "wise-2026-04-001",
          keptStripeLink: false,
        }),
      );
    });

    it("throws when no row is returned (insert lost)", async () => {
      const { db } = makeInsertingDb(undefined);
      await expect(
        createManualBillingEvent(db, {
          organizationId: "org-1",
          telegramUserId: null,
          planCode: "free",
          subscriptionStatus: "free",
          paidThroughAt: null,
          paymentReference: null,
          note: null,
          keptStripeLink: false,
        }),
      ).rejects.toThrow(/no row returned/i);
    });
  });

  describe("findOrCreateManualBillingEvent", () => {
    it("returns { created: true } when insert succeeds", async () => {
      const row = { id: "event-1", organizationId: "org-1", paymentReference: "ref-1" };
      const onConflictDoNothing = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([row]) }));
      const values = vi.fn(() => ({ onConflictDoNothing }));
      const insert = vi.fn(() => ({ values }));
      const db = { insert } as unknown as Parameters<typeof findOrCreateManualBillingEvent>[0];

      const result = await findOrCreateManualBillingEvent(db, {
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: null,
        paymentReference: "ref-1",
        note: null,
        keptStripeLink: false,
      });

      expect(result).toEqual({ event: row, created: true });
    });

    it("returns { created: false } when conflict yields existing row", async () => {
      const existing = { id: "event-old", organizationId: "org-1", paymentReference: "ref-1" };
      const onConflictDoNothing = vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      }));
      const values = vi.fn(() => ({ onConflictDoNothing }));
      const insert = vi.fn(() => ({ values }));
      // SELECT path for the fallback read
      const limit = vi.fn().mockResolvedValue([existing]);
      const where = vi.fn(() => ({ limit }));
      const from = vi.fn(() => ({ where }));
      const select = vi.fn(() => ({ from }));
      const db = { insert, select } as unknown as Parameters<
        typeof findOrCreateManualBillingEvent
      >[0];

      const result = await findOrCreateManualBillingEvent(db, {
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: null,
        paymentReference: "ref-1",
        note: null,
        keptStripeLink: false,
      });

      expect(result).toEqual({ event: existing, created: false });
    });
  });

  describe("findManualBillingEventByPaymentReference", () => {
    it("returns the row when one exists", async () => {
      const row = {
        id: "event-1",
        organizationId: "org-1",
        paymentReference: "wise-2026-04-001",
      };
      const { db } = makeSelectingDb([row]);
      await expect(
        findManualBillingEventByPaymentReference(db, "org-1", "wise-2026-04-001"),
      ).resolves.toBe(row);
    });

    it("returns null when nothing matches", async () => {
      const { db } = makeSelectingDb([]);
      await expect(
        findManualBillingEventByPaymentReference(db, "org-1", "missing"),
      ).resolves.toBeNull();
    });
  });

  describe("listManualBillingEventsForOrganization", () => {
    it("returns events for an organization ordered by created_at desc", async () => {
      const rows = [
        { id: "event-2", organizationId: "org-1", createdAt: new Date(2_000_000_000_000) },
        { id: "event-1", organizationId: "org-1", createdAt: new Date(1_000_000_000_000) },
      ];
      const { db, mocks } = makeSelectingDb(rows);

      await expect(listManualBillingEventsForOrganization(db, "org-1")).resolves.toEqual(rows);
      expect(mocks.select).toHaveBeenCalled();
      expect(mocks.from).toHaveBeenCalled();
    });
  });

  describe("findLatestManualBillingEventForOrganization", () => {
    it("returns the latest event for an organization", async () => {
      const row = { id: "event-2", organizationId: "org-1", createdAt: new Date() };
      const limit = vi.fn().mockResolvedValue([row]);
      const orderBy = vi.fn(() => ({ limit }));
      const where = vi.fn(() => ({ orderBy }));
      const from = vi.fn(() => ({ where }));
      const select = vi.fn(() => ({ from }));
      const db = { select } as unknown as Parameters<
        typeof findLatestManualBillingEventForOrganization
      >[0];

      await expect(findLatestManualBillingEventForOrganization(db, "org-1")).resolves.toBe(row);
    });

    it("returns null when the organization has no manual billing events", async () => {
      const limit = vi.fn().mockResolvedValue([]);
      const orderBy = vi.fn(() => ({ limit }));
      const where = vi.fn(() => ({ orderBy }));
      const from = vi.fn(() => ({ where }));
      const select = vi.fn(() => ({ from }));
      const db = { select } as unknown as Parameters<
        typeof findLatestManualBillingEventForOrganization
      >[0];

      await expect(findLatestManualBillingEventForOrganization(db, "org-1")).resolves.toBeNull();
    });
  });
});
