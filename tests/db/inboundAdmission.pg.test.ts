/**
 * Inbound admission (src/email/inboundAdmission/) against a real Postgres
 * (TEST_DATABASE_URL, see tests/helpers/pgTestDb.ts): each stage's verdicts
 * in the order its checks run, the policy table against the contract's
 * matrix, and the rows each decision writes or leaves alone. Sender
 * authentication is faked at authenticateSender, the one external (DNS)
 * dependency; the quota notice is observed through its claim row.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import {
  createPgTestDatabase,
  hasTestDatabase,
  waitForAdvisoryLockWaiters,
  type PgTestDatabase,
} from "../helpers/pgTestDb.js";
import { seedDeliveryLog } from "../helpers/deliveryFixtures.js";
import { createLogger, getLogger, setLogger } from "../../src/utils/logger.js";
import { applyPlanLimitOverrides } from "../../src/billing/plans.js";
import { usageMonthForDate } from "../../src/db/repos/usage.js";
import type { SenderAuthResult } from "../../src/email/authenticateSender.js";
import { metricsRegistry } from "../../src/observability/metrics.js";

const mockAuthenticateSender = vi.fn<(...args: unknown[]) => Promise<SenderAuthResult>>();
vi.mock("../../src/email/authenticateSender.js", () => ({
  authenticateSender: (...args: unknown[]) => mockAuthenticateSender(...args),
}));

const {
  REJECTION_POLICY,
  UNKNOWN_REJECTION_POLICY,
  admitPreflight,
  admitRawPrecheck,
  isQuotaRejection,
  queueInboundEmail,
  rejectionPolicy,
  settlePlanLimitRejection,
} = await import("../../src/email/inboundAdmission/index.js");

setLogger(createLogger("silent"));

const OWNER = 7301n;
const MISSING_OWNER = 7399n;
const DOMAIN = "mail.example.com";
const ALLOWED_DOMAIN = "example.com";
const LIMITS = {
  aliasEmailsPerHour: 2,
  deliveredEmailsMonth: 3,
  maxMessageBytes: 2_000,
  storageBytes: 5_000,
};

function pass(status: SenderAuthResult["status"] = "pass"): SenderAuthResult {
  return {
    headerFromEmail: `alerts@${ALLOWED_DOMAIN}`,
    headerFromDomain: ALLOWED_DOMAIN,
    dkimPassDomains: status === "pass" ? [ALLOWED_DOMAIN] : [],
    dmarcPass: status === "pass",
    authenticatedDomains: status === "pass" ? [ALLOWED_DOMAIN] : [],
    status,
    reason: status,
  };
}

let mailCounter = 0;
function mail({
  from = `alerts@${ALLOWED_DOMAIN}`,
  messageId = `m${++mailCounter}@${ALLOWED_DOMAIN}`,
  body = "body",
}: { from?: string; messageId?: string; body?: string } = {}): Buffer {
  return Buffer.from(
    `From: ${from}\r\nTo: inbox@${DOMAIN}\r\nSubject: hi\r\nMessage-ID: <${messageId}>\r\n\r\n${body}`,
  );
}

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

// The contract's Appendix A2 matrix, row by row. HTTP is the raw route's
// answer after the queue; "quota" counts in rejectedCount and earns a notice.
describe("rejection policy", () => {
  const matrix = {
    subscription_inactive: [403, "delete", "delete", true],
    monthly_email_limit: [403, "delete", "delete", true],
    storage_limit: [403, "delete", "delete", true],
    message_size_limit: [413, "delete", "delete", false],
    sender_not_allowed: [403, "delete", "delete", false],
    sender_auth_failed: [403, "delete", "delete", false],
    sender_auth_temperror: [503, "delete", "keep", false],
    alias_not_found: [202, "delete", "delete", false],
    duplicate: [202, "delete", "delete", false],
    rate_limited: [202, "keep", "keep", false],
  } as const;

  function row([rawStatus, live, recovery, quota]: readonly [number, string, string, boolean]) {
    return {
      rawStatus,
      deleteLive: live === "delete",
      deleteInRecovery: recovery === "delete",
      quota,
    };
  }

  it("equals the A2 matrix for every queue reason", () => {
    expect(Object.keys(REJECTION_POLICY).sort()).toEqual(Object.keys(matrix).sort());
    for (const [reason, expected] of Object.entries(matrix)) {
      expect({ reason, ...rejectionPolicy(reason) }).toEqual({ reason, ...row(expected) });
    }
  });

  it("answers an unknown or missing reason with 202 and keeps the files in both paths", () => {
    const unknown = row([202, "keep", "keep", false]);
    expect(UNKNOWN_REJECTION_POLICY).toEqual(unknown);
    expect(rejectionPolicy(undefined)).toEqual(unknown);
    expect(rejectionPolicy("unknown")).toEqual(unknown);
    expect(rejectionPolicy("hosted_blocklist")).toEqual(unknown);
    // Inherited object keys are not reasons.
    expect(rejectionPolicy("toString")).toEqual(unknown);
  });

  it("derives the quota-notifiable reasons from the table", () => {
    const quota = Object.keys(matrix).filter((reason) => isQuotaRejection(reason));
    expect(quota.sort()).toEqual(["monthly_email_limit", "storage_limit", "subscription_inactive"]);
    expect(isQuotaRejection(undefined)).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase)("inbound admission on Postgres", () => {
  let alias: schema.EmailAddress;
  let domainId: string;
  const month = usageMonthForDate();

  async function seed({ hosted = true }: { hosted?: boolean } = {}): Promise<void> {
    process.env["APP_MODE"] = hosted ? "hosted" : "self-hosted";
    await pgdb.db.execute(
      sql`truncate users, chats, email_addresses, delivery_logs, inbound_domains,
        hosted_inbound_blocks, user_usage_months, user_storage_usage,
        user_quota_notifications cascade`,
    );
    await pgdb.db.insert(schema.users).values({ id: OWNER, isAllowed: true, locale: "en" });
    const [domain] = await pgdb.db
      .insert(schema.inboundDomains)
      .values({ domain: DOMAIN, kind: "shared", status: "active" })
      .returning();
    domainId = domain.id;
    [alias] = await pgdb.db
      .insert(schema.emailAddresses)
      .values({
        localPart: "inbox",
        fullAddress: `inbox@${DOMAIN}`,
        domainId: hosted ? domainId : null,
        chatId: OWNER,
        createdBy: OWNER,
        status: "active",
      })
      .returning();
    await pgdb.db
      .insert(schema.allowRules)
      .values({ emailAddressId: alias.id, matchType: "domain", matchValue: ALLOWED_DOMAIN });
    applyPlanLimitOverrides({ free: LIMITS });
    mockAuthenticateSender.mockReset();
    mockAuthenticateSender.mockResolvedValue(pass());
  }

  /** An alias whose owner has no users row: the hosted "subscription_inactive". */
  async function seedOwnerlessAlias(): Promise<schema.EmailAddress> {
    return pgdb.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.delete(schema.emailAddresses).where(eq(schema.emailAddresses.id, alias.id));
      const [row] = await tx
        .insert(schema.emailAddresses)
        .values({
          localPart: "inbox",
          fullAddress: `inbox@${DOMAIN}`,
          domainId,
          chatId: OWNER,
          createdBy: MISSING_OWNER,
          status: "active",
        })
        .returning();
      await tx
        .insert(schema.allowRules)
        .values({ emailAddressId: row.id, matchType: "domain", matchValue: ALLOWED_DOMAIN });
      return row;
    });
  }

  async function setUsage(values: { deliveredCount?: number; rejectedCount?: number }) {
    await pgdb.db
      .insert(schema.userUsageMonths)
      .values({ userId: OWNER, month, ...values })
      .onConflictDoUpdate({
        target: [schema.userUsageMonths.userId, schema.userUsageMonths.month],
        set: values,
      });
  }

  async function usage(userId = OWNER) {
    const [row] = await pgdb.db
      .select()
      .from(schema.userUsageMonths)
      .where(
        and(eq(schema.userUsageMonths.userId, userId), eq(schema.userUsageMonths.month, month)),
      );
    return row ? { deliveredCount: row.deliveredCount, rejectedCount: row.rejectedCount } : null;
  }

  async function storage() {
    const [row] = await pgdb.db
      .select()
      .from(schema.userStorageUsage)
      .where(eq(schema.userStorageUsage.userId, OWNER));
    return row ? { rawEmailBytes: row.rawEmailBytes, attachmentBytes: row.attachmentBytes } : null;
  }

  async function setStorage(rawEmailBytes: bigint) {
    await pgdb.db.insert(schema.userStorageUsage).values({ userId: OWNER, rawEmailBytes });
  }

  async function logs() {
    return pgdb.db
      .select()
      .from(schema.deliveryLogs)
      .where(eq(schema.deliveryLogs.emailAddressId, alias.id));
  }

  async function claims() {
    return pgdb.db
      .select({ reason: schema.userQuotaNotifications.reason })
      .from(schema.userQuotaNotifications);
  }

  async function block(blockType: string, value: string) {
    await pgdb.db.insert(schema.hostedInboundBlocks).values({ blockType, value });
  }

  async function seedRecentLogs(n: number, receivedAt = new Date()) {
    for (let i = 0; i < n; i++) {
      await seedDeliveryLog(pgdb.db, alias, {
        finalStatus: i % 2 === 0 ? "delivered" : "failed",
        rawEmailPath: null,
        receivedAt,
      });
    }
  }

  /** The rows a rejection must leave untouched. */
  async function expectNothingWritten() {
    expect(await logs()).toEqual([]);
    expect(await usage()).toBeNull();
    expect(await storage()).toBeNull();
    expect(await claims()).toEqual([]);
  }

  const preflightInput = {
    localPart: "inbox",
    recipientDomain: DOMAIN,
    envelopeFrom: "bounce@sender.example.net",
  };

  function rawInput(rawSizeBytes = 100) {
    return {
      localPart: "inbox",
      recipientDomain: DOMAIN,
      envelopeFrom: "bounce@sender.example.net",
      rawSizeBytes,
    };
  }

  function queueInput(rawEmail: Buffer) {
    return {
      rawEmail,
      rawEmailPath: `/data/rawemails/${randomName()}.eml`,
      localPart: "inbox",
      recipientDomain: DOMAIN,
      envelopeFrom: "bounce@sender.example.net",
      publicBaseUrl: "https://mail.example.com",
      attachmentDir: "/data/attachments",
      attachmentTtlHours: 24,
      rawEmailTtlHours: 24,
    };
  }

  const sendMessage = vi.fn(() => Promise.resolve({}));
  const api = { sendMessage } as unknown as Api;

  beforeEach(async () => {
    sendMessage.mockClear();
    await seed();
  });

  describe("preflight", () => {
    it("refuses a missing, paused or wrongly-routed alias", async () => {
      expect(await admitPreflight(pgdb.db, { ...preflightInput, localPart: "nobody" })).toEqual({
        kind: "alias_not_found",
      });
      expect(
        await admitPreflight(pgdb.db, { ...preflightInput, recipientDomain: "other.example" }),
      ).toEqual({ kind: "alias_not_found" });
      await pgdb.db
        .update(schema.inboundDomains)
        .set({ status: "disabled" })
        .where(eq(schema.inboundDomains.id, domainId));
      expect(await admitPreflight(pgdb.db, preflightInput)).toEqual({ kind: "alias_not_found" });
      await pgdb.db
        .update(schema.inboundDomains)
        .set({ status: "active" })
        .where(eq(schema.inboundDomains.id, domainId));
      await pgdb.db
        .update(schema.emailAddresses)
        .set({ status: "paused" })
        .where(eq(schema.emailAddresses.id, alias.id));
      expect(await admitPreflight(pgdb.db, preflightInput)).toEqual({ kind: "alias_not_found" });
      await expectNothingWritten();
    });

    it("checks the hosted blocklist before the plan limit", async () => {
      await block("sender_domain", "sender.example.net");
      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      const verdict = await admitPreflight(pgdb.db, preflightInput);
      expect(verdict).toMatchObject({
        kind: "hosted_blocklist",
        alias: { id: alias.id },
        block: { blockType: "sender_domain", value: "sender.example.net" },
      });
      expect(await usage()).toEqual({ deliveredCount: 3, rejectedCount: 0 });
    });

    it("skips the hosted blocklist and the monthly quota when self-hosted", async () => {
      await seed({ hosted: false });
      await block("sender_domain", "sender.example.net");
      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      expect(await admitPreflight(pgdb.db, preflightInput)).toMatchObject({ kind: "accepted" });
    });

    it("checks the plan limit before the allow rules, with neither size nor storage", async () => {
      await pgdb.db.delete(schema.allowRules);
      await setStorage(BigInt(LIMITS.storageBytes) * 2n);
      expect(await admitPreflight(pgdb.db, preflightInput)).toMatchObject({
        kind: "no_allow_rules",
      });

      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      expect(await admitPreflight(pgdb.db, preflightInput)).toEqual({
        kind: "plan_limit",
        reason: "monthly_email_limit",
        alias,
        userId: OWNER,
        month,
      });
      // The verdict alone writes nothing; the route settles it.
      expect(await usage()).toEqual({ deliveredCount: 3, rejectedCount: 0 });
    });

    it("refuses a missing hosted owner as subscription_inactive", async () => {
      const ownerless = await seedOwnerlessAlias();
      expect(await admitPreflight(pgdb.db, preflightInput)).toMatchObject({
        kind: "plan_limit",
        reason: "subscription_inactive",
        alias: { id: ownerless.id },
        userId: MISSING_OWNER,
      });
    });

    it("checks the allow rules before the hourly cap", async () => {
      await seedRecentLogs(LIMITS.aliasEmailsPerHour);
      await pgdb.db.delete(schema.allowRules);
      expect(await admitPreflight(pgdb.db, preflightInput)).toMatchObject({
        kind: "no_allow_rules",
        alias: { id: alias.id },
      });
    });

    it("defers at the hourly cap, counting every status inside the last hour", async () => {
      await seedRecentLogs(LIMITS.aliasEmailsPerHour - 1);
      await seedRecentLogs(3, new Date(Date.now() - 61 * 60 * 1000));
      expect(await admitPreflight(pgdb.db, preflightInput)).toMatchObject({ kind: "accepted" });

      await seedRecentLogs(1);
      expect(await admitPreflight(pgdb.db, preflightInput)).toMatchObject({
        kind: "hourly_cap",
        alias: { id: alias.id },
      });
    });

    it("keeps the hourly cap when self-hosted", async () => {
      await seed({ hosted: false });
      await seedRecentLogs(LIMITS.aliasEmailsPerHour);
      expect(await admitPreflight(pgdb.db, preflightInput)).toMatchObject({ kind: "hourly_cap" });
    });

    it("accepts without reserving, charging or logging anything", async () => {
      expect(await admitPreflight(pgdb.db, preflightInput)).toEqual({ kind: "accepted", alias });
      await expectNothingWritten();
    });
  });

  describe("raw precheck", () => {
    it("refuses a missing alias and a blocklisted one before the plan limit", async () => {
      expect(await admitRawPrecheck(pgdb.db, { ...rawInput(), localPart: "nobody" })).toEqual({
        kind: "alias_not_found",
      });
      await block("local_part", "inbox");
      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      expect(await admitRawPrecheck(pgdb.db, rawInput())).toMatchObject({
        kind: "hosted_blocklist",
        block: { blockType: "local_part" },
      });
    });

    it("checks message size, then projected storage, then the monthly count", async () => {
      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      await setStorage(BigInt(LIMITS.storageBytes - 50));
      expect(await admitRawPrecheck(pgdb.db, rawInput(LIMITS.maxMessageBytes + 1))).toMatchObject({
        kind: "plan_limit",
        status: 413,
        reason: "message_size_limit",
      });
      // The raw length is the storage delta: 100 bytes over the 50 left.
      expect(await admitRawPrecheck(pgdb.db, rawInput(100))).toMatchObject({
        kind: "plan_limit",
        status: 403,
        reason: "storage_limit",
      });
      expect(await admitRawPrecheck(pgdb.db, rawInput(50))).toEqual({
        kind: "plan_limit",
        status: 403,
        reason: "monthly_email_limit",
        alias,
        userId: OWNER,
        month,
      });
    });

    it("leaves sender, dedup and the hourly cap to the queue", async () => {
      await pgdb.db.delete(schema.allowRules);
      await seedRecentLogs(LIMITS.aliasEmailsPerHour);
      expect(await admitRawPrecheck(pgdb.db, rawInput())).toEqual({ kind: "accepted", alias });
      expect(mockAuthenticateSender).not.toHaveBeenCalled();
    });
  });

  describe("settling a route's plan-limit rejection", () => {
    async function quotaRejections(reason: string): Promise<number> {
      const metric = await metricsRegistry
        .getSingleMetric("email_to_telegram_quota_rejections_total")
        ?.get();
      return metric?.values.find((v) => v.labels["reason"] === reason)?.value ?? 0;
    }

    it("counts a quota rejection in its own statement and claims the notice", async () => {
      const before = await quotaRejections("monthly_email_limit");
      await settlePlanLimitRejection(pgdb.db, api, {
        userId: OWNER,
        reason: "monthly_email_limit",
        month,
      });
      expect(await usage()).toEqual({ deliveredCount: 0, rejectedCount: 1 });
      expect(await quotaRejections("monthly_email_limit")).toBe(before + 1);
      await vi.waitFor(async () =>
        expect(await claims()).toEqual([{ reason: "monthly_email_limit" }]),
      );
    });

    it("records the metric but neither counts nor notifies a message size rejection", async () => {
      const before = await quotaRejections("message_size_limit");
      await settlePlanLimitRejection(pgdb.db, api, {
        userId: OWNER,
        reason: "message_size_limit",
        month,
      });
      expect(await quotaRejections("message_size_limit")).toBe(before + 1);
      await expectNothingWritten();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("swallows a counter failure and still schedules the notice", async () => {
      // No users row: the counter's foreign key fails, and so does the claim.
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        await expect(
          settlePlanLimitRejection(pgdb.db, api, {
            userId: MISSING_OWNER,
            reason: "subscription_inactive",
            month,
          }),
        ).resolves.toBeUndefined();
        expect(warn.mock.calls.map(([, event]) => event)).toContain("quota.rejection.count_failed");
        await vi.waitFor(() =>
          expect(warn.mock.calls.map(([, event]) => event)).toContain("quota.notice.failed"),
        );
        expect(await usage(MISSING_OWNER)).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("queue", () => {
    it("refuses an alias missing at queue time", async () => {
      const result = await queueInboundEmail(pgdb.db, {
        ...queueInput(mail()),
        localPart: "nobody",
      });
      expect(result).toEqual({ queued: false, result: { ok: false, reason: "alias_not_found" } });
      await expectNothingWritten();
    });

    it("refuses a From with no rule candidate without authenticating it", async () => {
      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      const result = await queueInboundEmail(
        pgdb.db,
        queueInput(mail({ from: "someone@elsewhere.example" })),
      );
      // Sender authorization precedes the quota: no rejection is counted.
      expect(result).toEqual({
        queued: false,
        result: {
          ok: false,
          reason: "sender_not_allowed",
          senderRejection: { aliasId: alias.id, headerFromDomain: "elsewhere.example" },
        },
      });
      expect(mockAuthenticateSender).not.toHaveBeenCalled();
      expect(await usage()).toEqual({ deliveredCount: 3, rejectedCount: 0 });
      expect(await logs()).toEqual([]);
    });

    it.each([
      ["fail", "sender_auth_failed"],
      ["temperror", "sender_auth_temperror"],
    ] as const)("refuses a candidate whose authentication is %s", async (status, reason) => {
      mockAuthenticateSender.mockResolvedValue(pass(status));
      const result = await queueInboundEmail(pgdb.db, queueInput(mail()));
      expect(result).toEqual({ queued: false, result: { ok: false, reason } });
      await expectNothingWritten();
    });

    it("counts a quota rejection inside its transaction and reports owner and month", async () => {
      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      const result = await queueInboundEmail(pgdb.db, queueInput(mail()));
      expect(result).toEqual({
        queued: false,
        result: { ok: false, reason: "monthly_email_limit", userId: OWNER, month },
      });
      expect(await usage()).toEqual({ deliveredCount: 3, rejectedCount: 1 });
      expect(await logs()).toEqual([]);
      // The queue never notifies; the raw route does after commit.
      expect(await claims()).toEqual([]);
    });

    it("counts storage against raw plus parsed attachment bytes", async () => {
      const raw = mail();
      await setStorage(BigInt(LIMITS.storageBytes - raw.length));
      expect(await queueInboundEmail(pgdb.db, queueInput(raw))).toMatchObject({ queued: true });

      const withAttachment = Buffer.from(
        [
          `From: alerts@${ALLOWED_DOMAIN}`,
          "Subject: file",
          "Message-ID: <attach@example.com>",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="b"',
          "",
          "--b",
          "Content-Type: text/plain",
          "",
          "see attached",
          "--b",
          'Content-Type: application/octet-stream; name="a.bin"',
          'Content-Disposition: attachment; filename="a.bin"',
          "",
          "x".repeat(64),
          "--b--",
          "",
        ].join("\r\n"),
      );
      await pgdb.db
        .update(schema.userStorageUsage)
        .set({ rawEmailBytes: BigInt(LIMITS.storageBytes - withAttachment.length) });
      const result = await queueInboundEmail(pgdb.db, queueInput(withAttachment));
      expect(result).toMatchObject({ queued: false, result: { reason: "storage_limit" } });
      expect(await usage()).toEqual({ deliveredCount: 1, rejectedCount: 1 });
    });

    it("does not count a message size rejection", async () => {
      const big = mail({ body: "x".repeat(LIMITS.maxMessageBytes) });
      const result = await queueInboundEmail(pgdb.db, queueInput(big));
      expect(result).toMatchObject({ queued: false, result: { reason: "message_size_limit" } });
      await expectNothingWritten();
    });

    it("propagates a failed rejection counter and rolls back", async () => {
      await seedOwnerlessAlias();
      await expect(queueInboundEmail(pgdb.db, queueInput(mail()))).rejects.toThrow();
      expect(await usage(MISSING_OWNER)).toBeNull();
      expect(await pgdb.db.select().from(schema.deliveryLogs)).toEqual([]);
    });

    it("checks the quota before a duplicate and a duplicate before the hourly cap", async () => {
      const raw = mail({ messageId: "same@example.com" });
      expect(await queueInboundEmail(pgdb.db, queueInput(raw))).toMatchObject({ queued: true });

      await seedRecentLogs(LIMITS.aliasEmailsPerHour);
      expect(await queueInboundEmail(pgdb.db, queueInput(raw))).toEqual({
        queued: false,
        result: { ok: false, reason: "duplicate" },
      });

      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      expect(await queueInboundEmail(pgdb.db, queueInput(raw))).toMatchObject({
        queued: false,
        result: { reason: "monthly_email_limit" },
      });
      expect(await logs()).toHaveLength(1 + LIMITS.aliasEmailsPerHour);
    });

    it("refuses over the hourly cap without counting or charging", async () => {
      await seedRecentLogs(LIMITS.aliasEmailsPerHour);
      const result = await queueInboundEmail(pgdb.db, queueInput(mail()));
      expect(result).toEqual({ queued: false, result: { ok: false, reason: "rate_limited" } });
      expect(await usage()).toBeNull();
      expect(await storage()).toBeNull();
      expect(await logs()).toHaveLength(LIMITS.aliasEmailsPerHour);
    });

    it("skips the quota but keeps the hourly cap when self-hosted", async () => {
      await seed({ hosted: false });
      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth });
      const accepted = await queueInboundEmail(pgdb.db, queueInput(mail()));
      expect(accepted).toMatchObject({ queued: true, usage: { month, deliveredCount: 4 } });
      await seedRecentLogs(LIMITS.aliasEmailsPerHour);
      expect(await queueInboundEmail(pgdb.db, queueInput(mail()))).toMatchObject({
        queued: false,
        result: { reason: "rate_limited" },
      });
    });

    it("commits the log as received with its usage charge and storage reservation", async () => {
      const raw = mail();
      // Padded so the auth call shows the sender arrives trimmed, not as sent.
      const input = { ...queueInput(raw), envelopeFrom: "  bounce@sender.example.net " };
      const result = await queueInboundEmail(pgdb.db, input);
      if (!result.queued) throw new Error(`not queued: ${String(result.result.reason)}`);

      expect(result.usage).toEqual({ month, deliveredCount: 1 });
      const [log] = await logs();
      expect(log).toMatchObject({
        id: result.job.deliveryLog.id,
        userId: OWNER,
        finalStatus: "received",
        rawEmailPath: input.rawEmailPath,
        rawSizeBytes: raw.length,
      });
      expect(await usage()).toEqual({ deliveredCount: 1, rejectedCount: 0 });
      expect(await storage()).toEqual({ rawEmailBytes: BigInt(raw.length), attachmentBytes: 0n });
      expect(mockAuthenticateSender).toHaveBeenCalledOnce();
      expect(mockAuthenticateSender).toHaveBeenCalledWith(raw, "bounce@sender.example.net");
    });

    it("counts a rejection once when the precheck passes and the queue refuses", async () => {
      await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth - 1 });
      expect(await admitRawPrecheck(pgdb.db, rawInput())).toMatchObject({ kind: "accepted" });
      // Another mail takes the last slot between the precheck and the queue.
      expect(await queueInboundEmail(pgdb.db, queueInput(mail()))).toMatchObject({ queued: true });
      expect(await queueInboundEmail(pgdb.db, queueInput(mail()))).toMatchObject({
        result: { reason: "monthly_email_limit" },
      });
      expect(await usage()).toEqual({ deliveredCount: 3, rejectedCount: 1 });
    });

    it("takes the owner lock before the alias lock", async () => {
      // Hold the alias lock: the queue must wait on it while already holding
      // the owner's lock.
      const holder = await pgdb.client();
      try {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock(hashtext($1))", [alias.id]);
        const queued = queueInboundEmail(pgdb.db, queueInput(mail()));
        await waitForAdvisoryLockWaiters(holder, 1);
        const { rows } = await holder.query<{ free: boolean }>(
          "select pg_try_advisory_xact_lock($1) as free",
          [OWNER.toString()],
        );
        expect(rows[0]?.free).toBe(false);
        await holder.query("commit");

        expect(await queued).toMatchObject({ queued: true });
      } finally {
        await holder.end();
      }
    });

    describe("two mails racing for the alias's last slot", () => {
      async function race() {
        const results = await Promise.all([
          queueInboundEmail(pgdb.db, queueInput(mail())),
          queueInboundEmail(pgdb.db, queueInput(mail())),
        ]);
        return {
          queued: results.filter((r) => r.queued).length,
          reasons: results.flatMap((r) => (r.queued ? [] : [r.result.reason])),
        };
      }

      /** The race with both mails queued on the owner's lock before either counts. */
      async function lockedRace(): ReturnType<typeof race> {
        const holder = await pgdb.client();
        try {
          await holder.query("begin");
          await holder.query("select pg_advisory_xact_lock($1)", [OWNER.toString()]);
          const raced = race();
          await waitForAdvisoryLockWaiters(holder, 2);
          await holder.query("commit");
          return await raced;
        } finally {
          await holder.end();
        }
      }

      it("accepts exactly one at the hourly cap", async () => {
        await seedRecentLogs(LIMITS.aliasEmailsPerHour - 1);
        // Both mails must queue on the owner's lock, which serializes the
        // hourly count; if either skips it, lockedRace times out waiting.
        expect(await lockedRace()).toEqual({ queued: 1, reasons: ["rate_limited"] });
        expect(await logs()).toHaveLength(LIMITS.aliasEmailsPerHour);
        expect(await usage()).toEqual({ deliveredCount: 1, rejectedCount: 0 });
      });

      it("accepts exactly one at the monthly limit and counts the other", async () => {
        await setUsage({ deliveredCount: LIMITS.deliveredEmailsMonth - 1 });
        expect(await race()).toEqual({ queued: 1, reasons: ["monthly_email_limit"] });
        expect(await logs()).toHaveLength(1);
        expect(await usage()).toEqual({ deliveredCount: 3, rejectedCount: 1 });
      });
    });
  });
});

function randomName(): string {
  return Math.random().toString(36).slice(2);
}
