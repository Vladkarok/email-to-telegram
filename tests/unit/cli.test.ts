import { describe, expect, it, vi } from "vitest";
import { parseStartupOptions } from "../../src/cli.js";

const FUTURE_DATE = "2099-01-01";

describe("parseStartupOptions", () => {
  it("defaults to normal startup", () => {
    const opts = parseStartupOptions([]);
    expect(opts.migrateOnly).toBe(false);
    expect(opts.rewrapStorageKeys).toBe(false);
    expect(opts.backfillStorageEncryption).toBe(false);
    expect(opts.hostedExportUserId).toBeNull();
    expect(opts.hostedExportOutputPath).toBeNull();
    expect(opts.hostedDeleteUserId).toBeNull();
    expect(opts.hostedSetUserPlanTelegramUserId).toBeNull();
    expect(opts.warnings).toEqual([]);
  });

  it("accepts --migrate-only", () => {
    expect(parseStartupOptions(["--migrate-only"]).migrateOnly).toBe(true);
  });

  it("accepts --rewrap-storage-keys", () => {
    expect(parseStartupOptions(["--rewrap-storage-keys"]).rewrapStorageKeys).toBe(true);
  });

  it("accepts --backfill-storage-encryption", () => {
    expect(parseStartupOptions(["--backfill-storage-encryption"]).backfillStorageEncryption).toBe(
      true,
    );
  });

  it("accepts hosted organization export arguments", () => {
    const opts = parseStartupOptions([
      "--hosted-export-user",
      "123",
      "--hosted-export-output",
      "/secure/user_123.json",
    ]);
    expect(opts.hostedExportUserId).toBe("123");
    expect(opts.hostedExportOutputPath).toBe("/secure/user_123.json");
  });

  it("accepts hosted organization delete arguments", () => {
    const opts = parseStartupOptions(["--hosted-delete-user", "123"]);
    expect(opts.hostedDeleteUserId).toBe("123");
  });

  it("rejects multiple startup operation flags", () => {
    expect(() => parseStartupOptions(["--migrate-only", "--rewrap-storage-keys"])).toThrow(
      /Choose only one startup operation flag/i,
    );
  });

  it("rejects combining hosted export and delete operations", () => {
    expect(() =>
      parseStartupOptions([
        "--hosted-export-user",
        "123",
        "--hosted-export-output",
        "/secure/user_123.json",
        "--hosted-delete-user",
        "123",
      ]),
    ).toThrow(/Choose only one startup operation flag/i);
  });

  it("rejects hosted export without an output path", () => {
    expect(() => parseStartupOptions(["--hosted-export-user", "123"])).toThrow(
      /--hosted-export-output is required/i,
    );
  });

  it("rejects hosted export output without an export operation", () => {
    expect(() => parseStartupOptions(["--hosted-export-output", "/secure/user_123.json"])).toThrow(
      /requires --hosted-export-user/i,
    );
  });

  it("rejects missing values for valued arguments", () => {
    expect(() => parseStartupOptions(["--hosted-delete-user"])).toThrow(
      "Missing value for CLI argument: --hosted-delete-user",
    );
  });

  it("rejects repeated valued arguments", () => {
    expect(() =>
      parseStartupOptions(["--hosted-delete-user", "123", "--hosted-delete-user", "456"]),
    ).toThrow("CLI argument cannot be repeated: --hosted-delete-user");
  });

  it("rejects unknown arguments", () => {
    expect(() => parseStartupOptions(["--wat"])).toThrow("Unknown CLI arguments: --wat");
  });
});

describe("parseStartupOptions: manual billing", () => {
  describe("--hosted-set-user-plan", () => {
    it("accepts a full org plan grant", () => {
      const opts = parseStartupOptions([
        "--hosted-set-user-plan",
        "123",
        "--plan",
        "pro",
        "--status",
        "active",
        "--paid-through",
        FUTURE_DATE,
        "--manual-payment-reference",
        "wise-2026-04-001",
        "--note",
        "Manual Wise payment",
      ]);
      expect(opts.hostedSetUserPlanTelegramUserId).toBe("123");
      expect(opts.manualPlanCode).toBe("pro");
      expect(opts.manualSubscriptionStatus).toBe("active");
      expect(opts.manualPaidThroughAt).toEqual(new Date(`${FUTURE_DATE}T00:00:00.000Z`));
      expect(opts.manualPaymentReference).toBe("wise-2026-04-001");
      expect(opts.manualNote).toBe("Manual Wise payment");
      expect(opts.warnings).toEqual([]);
    });

    it("defaults --status to active for paid plans", () => {
      const opts = parseStartupOptions([
        "--hosted-set-user-plan",
        "123",
        "--plan",
        "pro",
        "--paid-through",
        FUTURE_DATE,
      ]);
      expect(opts.manualSubscriptionStatus).toBe("active");
    });

    it("rejects plan without paid-through unless plan is business", () => {
      expect(() => parseStartupOptions(["--hosted-set-user-plan", "123", "--plan", "pro"])).toThrow(
        /--paid-through is required/i,
      );
    });

    it("allows business plan without paid-through", () => {
      const opts = parseStartupOptions(["--hosted-set-user-plan", "123", "--plan", "business"]);
      expect(opts.manualPlanCode).toBe("business");
      expect(opts.manualSubscriptionStatus).toBe("active");
      expect(opts.manualPaidThroughAt).toBeNull();
    });

    it("rejects --plan free with --status active", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "free",
          "--status",
          "active",
        ]),
      ).toThrow(/--plan free.*--status free/i);
    });

    it("rejects --plan free with --keep-stripe-link", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "free",
          "--keep-stripe-link",
        ]),
      ).toThrow(/--keep-stripe-link/i);
    });

    it("rejects --keep-stripe-link for non-business plans", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "pro",
          "--paid-through",
          FUTURE_DATE,
          "--keep-stripe-link",
        ]),
      ).toThrow(/--keep-stripe-link.*business/i);
    });

    it("allows --keep-stripe-link with --plan business", () => {
      const opts = parseStartupOptions([
        "--hosted-set-user-plan",
        "123",
        "--plan",
        "business",
        "--keep-stripe-link",
      ]);
      expect(opts.manualKeepStripeLink).toBe(true);
    });

    it("accepts paid-through inside the 7-day backfill window with a warning", () => {
      const today = new Date();
      const sixDaysAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
      const isoDate = sixDaysAgo.toISOString().slice(0, 10);
      const opts = parseStartupOptions([
        "--hosted-set-user-plan",
        "123",
        "--plan",
        "pro",
        "--paid-through",
        isoDate,
      ]);
      expect(opts.manualPaidThroughAt).not.toBeNull();
      expect(opts.warnings.some((w) => w.match(/paid-through.*backfill/i))).toBe(true);
    });

    it("rejects paid-through older than 7 days", () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const isoDate = tenDaysAgo.toISOString().slice(0, 10);
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "pro",
          "--paid-through",
          isoDate,
        ]),
      ).toThrow(/--paid-through.*7 days/i);
    });

    it("rejects unparseable --paid-through", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "pro",
          "--paid-through",
          "not-a-date",
        ]),
      ).toThrow(/--paid-through/i);
    });

    it("rejects normalized invalid calendar dates for --paid-through", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "pro",
          "--paid-through",
          "2026-02-31",
        ]),
      ).toThrow(/valid calendar date/i);
    });

    it("rejects non-ISO date formats for --paid-through", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "pro",
          "--paid-through",
          "05/30/2026",
        ]),
      ).toThrow(/YYYY-MM-DD or ISO 8601/i);
    });

    it("rejects unknown --plan value", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "platinum",
          "--paid-through",
          FUTURE_DATE,
        ]),
      ).toThrow(/--plan/i);
    });

    it("rejects unknown --status value", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "pro",
          "--status",
          "trialing",
          "--paid-through",
          FUTURE_DATE,
        ]),
      ).toThrow(/--status/i);
    });

    it("rejects --note longer than 1000 characters", () => {
      expect(() =>
        parseStartupOptions([
          "--hosted-set-user-plan",
          "123",
          "--plan",
          "pro",
          "--paid-through",
          FUTURE_DATE,
          "--note",
          "x".repeat(1001),
        ]),
      ).toThrow(/--note/i);
    });
  });
});

// Suppress unused warning when running individual blocks
void vi;
