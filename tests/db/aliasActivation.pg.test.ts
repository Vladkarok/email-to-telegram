/**
 * First-bounce notice against a real Postgres (TEST_DATABASE_URL, see
 * tests/helpers/pgTestDb.ts): the claim race, the lifetime budget under
 * failed and unknown sends, click-before-send, the owner's private chat for
 * a group alias, the button against move/delete, a failed insert and a
 * failed commit, expiry cleanup, the marker under lock contention, marker
 * reconciliation (and the purge it guards) and the migration backfill,
 * export and erasure, and shutdown while a job holds or waits for a pool
 * client. Races are ordered by observed lock waits, not by sleeps.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/db/schema.js";
import { createPgTestDatabase, hasTestDatabase, type PgTestDatabase } from "../helpers/pgTestDb.js";
import { createLogger, setLogger } from "../../src/utils/logger.js";
import { ActivationNoticeQueue } from "../../src/activation/noticeQueue.js";
import { createNoticeRunner } from "../../src/activation/notice.js";
import { applyActivationAllow } from "../../src/activation/allowButton.js";
import { insertAllowRule } from "../../src/telegram/commands/allow.js";
import { NOTICE_BOUNDS, type NoticeBounds } from "../../src/activation/bounds.js";
import { sql } from "drizzle-orm";
import { runCleanup } from "../../src/storage/cleanup.js";
import {
  claimActivationNotice,
  clearExpiredActivationTokens,
  consumeActivationToken,
  readActivationGate,
  markAliasFirstDelivered,
  reconcileFirstDeliveredMarkers,
} from "../../src/db/repos/aliasActivation.js";
import { moveAliasWithCas, softDeleteAliasWithCas } from "../../src/db/repos/aliasRouting.js";
import { exportHostedUserData } from "../../src/dataLifecycle/exportUser.js";
import { deleteHostedUser } from "../../src/dataLifecycle/deleteUser.js";
import { applyPlanLimitOverrides } from "../../src/billing/plans.js";
import { metricsRegistry, resetMetricsForTests } from "../../src/observability/metrics.js";
import type { SenderAuthResult } from "../../src/email/authenticateSender.js";
import { CB_ACTIVATION_ALLOW } from "../../src/telegram/callbacks.js";

setLogger(createLogger("silent"));

const OWNER = 7001n;
const OTHER_OWNER = 7002n;
const DM_CHAT = OWNER;
const GROUP_CHAT = -1007001n;
const RAW = Buffer.from("From: noreply@github.com\r\nSubject: hi\r\n\r\nbody");

function passFor(domain: string): SenderAuthResult {
  return {
    headerFromEmail: `noreply@${domain}`,
    headerFromDomain: domain,
    dkimPassDomains: [domain],
    dmarcPass: true,
    authenticatedDomains: [domain],
    status: "pass",
    reason: "authenticated",
  };
}

interface SentMessage {
  chatId: string;
  text: string;
  buttons: Array<{ text: string; callback_data: string }>;
}

function fakeApi(send: (signal: AbortSignal) => Promise<unknown> = () => Promise.resolve({})) {
  const sent: SentMessage[] = [];
  const sendMessage = vi.fn(
    async (
      chatId: string,
      text: string,
      other: { reply_markup?: { inline_keyboard: SentMessage["buttons"][] } },
      signal: AbortSignal,
    ) => {
      const result = await send(signal);
      sent.push({ chatId, text, buttons: other.reply_markup?.inline_keyboard.flat() ?? [] });
      return result;
    },
  );
  return { api: { sendMessage } as unknown as Api, sendMessage, sent };
}

function tokenOf(message: SentMessage | undefined): string | null {
  const button = message?.buttons.find((b) => CB_ACTIVATION_ALLOW.pattern.test(b.callback_data));
  return button ? (CB_ACTIVATION_ALLOW.pattern.exec(button.callback_data)?.[2] ?? null) : null;
}

async function noticeCount(stage: string, result: string): Promise<number> {
  const text = await metricsRegistry.getSingleMetricAsString(
    "email_to_telegram_activation_notices_total",
  );
  const line = text
    .split("\n")
    .find((l) => l.includes(`stage="${stage}"`) && l.includes(`result="${result}"`));
  return Number(line?.split(" ").pop() ?? NaN);
}

describe.skipIf(!hasTestDatabase)("first-bounce notice on real Postgres", () => {
  let t: PgTestDatabase;
  const savedAppMode = process.env["APP_MODE"];

  beforeAll(async () => {
    t = await createPgTestDatabase();
    await t.migrate();
  });

  afterAll(async () => {
    await t?.drop();
    if (savedAppMode === undefined) delete process.env["APP_MODE"];
    else process.env["APP_MODE"] = savedAppMode;
  });

  beforeEach(async () => {
    resetMetricsForTests();
    process.env["APP_MODE"] = "self-hosted";
    await t.pool.query(
      "truncate users, email_addresses, alias_activation, delivery_logs, delivery_attempts, allow_rules, user_usage_months cascade",
    );
    await t.pool.query(
      "insert into users (id, is_allowed, locale) values ($1, true, 'en'), ($2, true, 'en')",
      [OWNER.toString(), OTHER_OWNER.toString()],
    );
  });

  afterEach(() => {
    applyPlanLimitOverrides({});
  });

  async function seedAlias(
    opts: {
      owner?: bigint;
      chatId?: bigint;
      ageDays?: number;
      status?: string;
      local?: string;
    } = {},
  ): Promise<string> {
    const local = opts.local ?? `inbox${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await t.pool.query<{ id: string }>(
      `insert into email_addresses (local_part, full_address, chat_id, created_by, status, created_at)
       values ($1, $2, $3, $4, $5, now() - make_interval(days => $6))
       returning id`,
      [
        local,
        `${local}@mail.example.com`,
        (opts.chatId ?? DM_CHAT).toString(),
        (opts.owner ?? OWNER).toString(),
        opts.status ?? "active",
        opts.ageDays ?? 0,
      ],
    );
    return rows[0].id;
  }

  async function seedDelivery(aliasId: string, status: "succeeded" | "failed", at?: string) {
    const { rows } = await t.pool.query<{ id: string }>(
      `insert into delivery_logs (email_address_id, user_id, final_status)
       values ($1, $2, $3) returning id`,
      [aliasId, OWNER.toString(), status === "succeeded" ? "delivered" : "failed"],
    );
    await t.pool.query(
      `insert into delivery_attempts (delivery_log_id, attempt_no, target_chat_id, status, created_at)
       values ($1, 1, $2, $3, coalesce($4::timestamptz, now()))`,
      [rows[0].id, DM_CHAT.toString(), status, at ?? null],
    );
  }

  async function activation(aliasId: string) {
    const { rows } = await t.pool.query<{
      claims_used: number;
      token: string | null;
      domain: string | null;
      first_delivered_at: Date | null;
      first_notice_at: Date | null;
      sent_at: Date | null;
      first_sent_at: Date | null;
      chat_id: string | null;
      routing_version: number | null;
    }>("select * from alias_activation where alias_id = $1", [aliasId]);
    return rows[0] ?? null;
  }

  /** Moves the latest claim back so the 24 h window is open again. */
  async function reopenWindow(aliasId: string): Promise<void> {
    await t.pool.query(
      "update alias_activation set last_claim_at = last_claim_at - interval '25 hours' where alias_id = $1",
      [aliasId],
    );
  }

  /** Polls until `check` holds; generous, so slow CI only waits longer. */
  async function waitUntil(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const giveUpAt = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Waits until `count` backends of this database are blocked on a lock. */
  async function waitForLockWaiters(count: number): Promise<void> {
    await waitUntil(async () => {
      const { rows } = await t.pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return (rows[0]?.n ?? 0) >= count;
    }, `${count} lock waiter(s)`);
  }

  function makeQueue(
    api: Api,
    opts: {
      authenticate?: (raw: Buffer, envelopeFrom: string | null) => Promise<SenderAuthResult>;
      bounds?: Partial<NoticeBounds>;
      db?: typeof t.db;
    } = {},
  ) {
    const bounds = { ...NOTICE_BOUNDS, ...opts.bounds };
    const runner = createNoticeRunner({
      getDb: () => opts.db ?? t.db,
      getApi: () => api,
      authenticate: opts.authenticate ?? (() => Promise.resolve(passFor("github.com"))),
      bounds,
    });
    return new ActivationNoticeQueue(runner, bounds);
  }

  function rawRequest(aliasId: string, headerFromDomain: string | null = "github.com") {
    return {
      stage: "raw" as const,
      aliasId,
      headerFromDomain,
      envelopeFrom: "bounce@github.com",
      rawMime: RAW,
    };
  }

  describe("gate", () => {
    async function runOnce(aliasId: string) {
      const { api, sent } = fakeApi();
      const queue = makeQueue(api);
      queue.admit(rawRequest(aliasId));
      await queue.whenIdle();
      return sent;
    }

    it("notifies for a new alias even when the owner had mail accepted", async () => {
      await t.pool.query(
        "insert into user_usage_months (user_id, month, delivered_count) values ($1, '2026-09', 4)",
        [OWNER.toString()],
      );
      const aliasId = await seedAlias({ ageDays: 6 });
      expect(await runOnce(aliasId)).toHaveLength(1);
    });

    it("notifies for an old alias whose owner never had mail accepted", async () => {
      await t.pool.query(
        "insert into user_usage_months (user_id, month, delivered_count) values ($1, '2026-09', 0)",
        [OWNER.toString()],
      );
      const aliasId = await seedAlias({ ageDays: 30 });
      expect(await runOnce(aliasId)).toHaveLength(1);
    });

    it("stays silent for an old alias whose owner had mail accepted", async () => {
      await t.pool.query(
        "insert into user_usage_months (user_id, month, delivered_count) values ($1, '2026-08', 1)",
        [OWNER.toString()],
      );
      const aliasId = await seedAlias({ ageDays: 8 });
      expect(await runOnce(aliasId)).toHaveLength(0);
      expect(await noticeCount("raw", "gated")).toBe(1);
      expect(await activation(aliasId)).toBeNull();
    });

    it("stays silent for a working alias: marker, or a succeeded attempt without one", async () => {
      const marked = await seedAlias();
      await markAliasFirstDelivered(t.db, marked);
      const unmarked = await seedAlias();
      await seedDelivery(unmarked, "succeeded");
      const failedOnly = await seedAlias();
      await seedDelivery(failedOnly, "failed");

      expect(await runOnce(marked)).toHaveLength(0);
      expect(await runOnce(unmarked)).toHaveLength(0);
      expect(await runOnce(failedOnly)).toHaveLength(1);
      expect(await noticeCount("raw", "gated")).toBe(2);
    });

    it("stays silent for a paused alias", async () => {
      const aliasId = await seedAlias({ status: "paused" });
      expect(await runOnce(aliasId)).toHaveLength(0);
    });
  });

  it("concurrent bounces on one alias: one authentication, one message", async () => {
    const aliasId = await seedAlias();
    const { api, sent } = fakeApi();
    let authentications = 0;
    const queue = makeQueue(api, {
      authenticate: async () => {
        authentications += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return passFor("github.com");
      },
    });
    for (let i = 0; i < 6; i++) expect(queue.admit(rawRequest(aliasId))).toBe(true);
    await queue.whenIdle();

    expect(authentications).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(OWNER.toString());
    expect(sent[0].text).toContain("from <code>github.com</code> bounced");
    expect(sent[0].buttons.map((b) => b.text)).toEqual(["Allow github.com", "📋 Allow Rules"]);
    const row = await activation(aliasId);
    expect(row).toMatchObject({ claims_used: 1, domain: "github.com" });
    expect(tokenOf(sent[0])).toBe(row.token);
    expect(row.sent_at).not.toBeNull();
    expect(row.first_sent_at).not.toBeNull();
    expect(await noticeCount("raw", "sent")).toBe(1);
    expect(await noticeCount("raw", "not_claimed")).toBe(5);
  });

  it("no one-tap and no stored domain when the From domain did not authenticate", async () => {
    const aliasId = await seedAlias();
    const { api, sent } = fakeApi();
    const queue = makeQueue(api, {
      authenticate: () =>
        Promise.resolve({ ...passFor("github.com"), status: "fail", authenticatedDomains: [] }),
    });
    queue.admit(rawRequest(aliasId));
    await queue.whenIdle();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("from <code>github.com</code> bounced");
    expect(tokenOf(sent[0])).toBeNull();
    expect((await activation(aliasId)).domain).toBeNull();
  });

  it("the 24 h window admits a claim at exactly 24 h", async () => {
    const aliasId = await seedAlias();
    const { api } = fakeApi();
    const queue = makeQueue(api);
    queue.admit(rawRequest(aliasId));
    await queue.whenIdle();

    // now() is the transaction start, so inside one transaction the previous
    // claim sits exactly 24 h before this one. Rolled back afterwards.
    const rollback = new Error("rollback");
    let claimedAtExactly24h: boolean | null = null;
    await t.db
      .transaction(async (tx) => {
        await tx.execute(
          sql`update alias_activation set last_claim_at = now() - interval '24 hours' where alias_id = ${aliasId}`,
        );
        claimedAtExactly24h = await claimActivationNotice(tx, {
          aliasId,
          token: "AAAAAAAAAAAAAAAAAAAAAA",
          chatId: DM_CHAT,
          routingVersion: 0,
        });
        throw rollback;
      })
      .catch((err: unknown) => {
        if (err !== rollback) throw err;
      });
    expect(claimedAtExactly24h).toBe(true);

    // The real claim: 23 h 59 min is still inside the window.
    await t.pool.query(
      "update alias_activation set last_claim_at = now() - interval '23 hours 59 minutes' where alias_id = $1",
      [aliasId],
    );
    queue.admit(rawRequest(aliasId));
    await queue.whenIdle();
    expect((await activation(aliasId)).claims_used).toBe(1);
    expect(await noticeCount("raw", "not_claimed")).toBe(1);
  });

  it("failed and unknown-outcome sends still spend the lifetime budget of 3", async () => {
    const aliasId = await seedAlias();
    const outcomes: Array<(signal: AbortSignal) => Promise<unknown>> = [
      () => Promise.reject(new Error("Forbidden: bot was blocked by the user")),
      // Unknown outcome: the send never answers and the 10 s signal (here
      // shortened) aborts it.
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      () => Promise.resolve({}),
    ];
    let call = 0;
    const { api, sendMessage } = fakeApi((signal) => outcomes[call++](signal));
    const queue = makeQueue(api, { bounds: { telegramSendTimeoutMs: 50 } });

    for (let i = 0; i < 4; i++) {
      queue.admit(rawRequest(aliasId));
      await queue.whenIdle();
      await reopenWindow(aliasId);
    }

    expect(sendMessage).toHaveBeenCalledTimes(3);
    const row = await activation(aliasId);
    expect(row.claims_used).toBe(3);
    expect(row.first_notice_at).not.toBeNull();
    expect(row.first_sent_at).not.toBeNull();
    expect(await noticeCount("raw", "failed")).toBe(2);
    expect(await noticeCount("raw", "sent")).toBe(1);
    expect(await noticeCount("raw", "not_claimed")).toBe(1);
  });

  it("a tap that spends the token before the send makes the job stop (click-before-send)", async () => {
    const aliasId = await seedAlias();
    const { api, sendMessage } = fakeApi();
    const queue = makeQueue(api, {
      authenticate: async () => {
        // Between the claim and the send, the current token gets spent.
        const token = (await activation(aliasId)).token!;
        expect(await consumeActivationToken(t.db, { aliasId, token })).not.toBeNull();
        return passFor("github.com");
      },
    });
    queue.admit(rawRequest(aliasId));
    await queue.whenIdle();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "stale")).toBe(1);
  });

  it("stops before the send when the alias moved after the claim", async () => {
    const aliasId = await seedAlias({ chatId: GROUP_CHAT });
    const { api, sendMessage } = fakeApi();
    const queue = makeQueue(api, {
      authenticate: async () => {
        await moveAliasWithCas(t.db, {
          aliasId,
          expectedVersion: 0,
          newChatId: DM_CHAT,
          oldChatId: GROUP_CHAT,
          oldThreadId: null,
          actorId: OWNER,
          authzPath: "admin",
          aliasOwnerId: OWNER,
        });
        return passFor("github.com");
      },
    });
    queue.admit(rawRequest(aliasId));
    await queue.whenIdle();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "stale")).toBe(1);
  });

  it("preflight with no rules: domainless notice without one-tap", async () => {
    const aliasId = await seedAlias();
    const { api, sent } = fakeApi();
    const queue = makeQueue(api);
    queue.admit({
      stage: "preflight",
      aliasId,
      headerFromDomain: null,
      envelopeFrom: null,
      rawMime: null,
    });
    await queue.whenIdle();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("this alias has no allow rules yet");
    expect(tokenOf(sent[0])).toBeNull();
    expect(await noticeCount("preflight", "sent")).toBe(1);
  });

  describe("one-tap button", () => {
    async function claimWithDomain(aliasId: string): Promise<string> {
      const { api, sent } = fakeApi();
      const queue = makeQueue(api);
      queue.admit(rawRequest(aliasId));
      await queue.whenIdle();
      const token = tokenOf(sent.at(-1));
      expect(token).not.toBeNull();
      return token!;
    }

    async function rules(aliasId: string): Promise<string[]> {
      const { rows } = await t.pool.query<{ match_value: string }>(
        "select match_value from allow_rules where email_address_id = $1 order by match_value",
        [aliasId],
      );
      return rows.map((r) => r.match_value);
    }

    it("adds the domain rule once; a second tap is expired", async () => {
      const aliasId = await seedAlias();
      const token = await claimWithDomain(aliasId);

      expect(await applyActivationAllow(t.db, { aliasId, token })).toMatchObject({
        kind: "added",
        domain: "github.com",
      });
      expect(await rules(aliasId)).toEqual(["github.com"]);
      expect(await applyActivationAllow(t.db, { aliasId, token })).toEqual({ kind: "expired" });
      expect(await rules(aliasId)).toEqual(["github.com"]);
    });

    it("a newer claim invalidates the previous button even when its send fails", async () => {
      const aliasId = await seedAlias();
      const firstToken = await claimWithDomain(aliasId);
      await reopenWindow(aliasId);
      const { api } = fakeApi(() => Promise.reject(new Error("network")));
      const queue = makeQueue(api);
      queue.admit(rawRequest(aliasId));
      await queue.whenIdle();

      expect((await activation(aliasId)).claims_used).toBe(2);
      expect(await applyActivationAllow(t.db, { aliasId, token: firstToken })).toEqual({
        kind: "expired",
      });
      expect(await rules(aliasId)).toEqual([]);
    });

    it("an expired button does nothing, and cleanup nulls the token and the domain", async () => {
      const aliasId = await seedAlias();
      const token = await claimWithDomain(aliasId);
      await t.pool.query(
        "update alias_activation set expires_at = now() - interval '1 second' where alias_id = $1",
        [aliasId],
      );

      expect(await applyActivationAllow(t.db, { aliasId, token })).toEqual({ kind: "expired" });
      expect(await clearExpiredActivationTokens(t.db)).toBe(1);
      const row = await activation(aliasId);
      expect(row).toMatchObject({ token: null, domain: null, claims_used: 1 });
      expect(await clearExpiredActivationTokens(t.db)).toBe(0);
    });

    it("cleanup leaves live claims alone", async () => {
      const aliasId = await seedAlias();
      await claimWithDomain(aliasId);
      expect(await clearExpiredActivationTokens(t.db)).toBe(0);
      expect((await activation(aliasId)).domain).toBe("github.com");
    });

    it("loses to a move that committed first: expired, spent, no rule", async () => {
      const aliasId = await seedAlias({ chatId: GROUP_CHAT });
      const token = await claimWithDomain(aliasId);

      // A move holding the owner lock (as moveAliasWithCas does) while the tap arrives.
      const mover = await t.client();
      try {
        await mover.query("begin");
        await mover.query("select pg_advisory_xact_lock($1)", [OWNER.toString()]);
        await mover.query(
          "update email_addresses set chat_id = $2, routing_version = routing_version + 1 where id = $1",
          [aliasId, DM_CHAT.toString()],
        );
        const tap = applyActivationAllow(t.db, { aliasId, token });
        // The tap is queued behind the mover's owner lock before the move commits.
        await waitForLockWaiters(1);
        await mover.query("commit");
        expect(await tap).toEqual({ kind: "expired" });
      } finally {
        await mover.end();
      }
      expect(await rules(aliasId)).toEqual([]);
      expect((await activation(aliasId)).token).toBeNull();
    });

    it("wins against a move that comes after it: the rule lands, the move still happens", async () => {
      const aliasId = await seedAlias({ chatId: GROUP_CHAT });
      const token = await claimWithDomain(aliasId);

      // A reader holding the alias row orders the two: the tap takes the
      // owner lock and waits for the row; the move then waits for the owner
      // lock behind the tap.
      const blocker = await t.client();
      await blocker.query("begin");
      await blocker.query("select id from email_addresses where id = $1 for update", [aliasId]);
      const tap = applyActivationAllow(t.db, { aliasId, token });
      const move = waitForLockWaiters(1).then(() =>
        moveAliasWithCas(t.db, {
          aliasId,
          expectedVersion: 0,
          newChatId: DM_CHAT,
          oldChatId: GROUP_CHAT,
          oldThreadId: null,
          actorId: OWNER,
          authzPath: "admin",
          aliasOwnerId: OWNER,
        }),
      );
      try {
        await waitForLockWaiters(2);
      } finally {
        await blocker.query("rollback");
        await blocker.end();
      }
      expect((await tap).kind).toBe("added");
      expect((await move).ok).toBe(true);
      expect(await rules(aliasId)).toEqual(["github.com"]);
    });

    it("an alias routed to a group: the notice goes to the owner's private chat, the one-tap works", async () => {
      const aliasId = await seedAlias({ chatId: GROUP_CHAT });
      const { api, sent } = fakeApi();
      const queue = makeQueue(api);
      queue.admit(rawRequest(aliasId));
      await queue.whenIdle();

      expect(sent).toHaveLength(1);
      expect(sent[0].chatId).toBe(OWNER.toString());
      expect((await activation(aliasId)).chat_id).toBe(GROUP_CHAT.toString());
      const token = tokenOf(sent[0]);
      expect(token).not.toBeNull();
      expect(await applyActivationAllow(t.db, { aliasId, token: token! })).toMatchObject({
        kind: "added",
        domain: "github.com",
      });
      expect(await rules(aliasId)).toEqual(["github.com"]);
    });

    it("fails closed after a delete or a pause", async () => {
      const deleted = await seedAlias();
      const deletedToken = await claimWithDomain(deleted);
      await softDeleteAliasWithCas(t.db, { aliasId: deleted, expectedVersion: 0 });
      expect(await applyActivationAllow(t.db, { aliasId: deleted, token: deletedToken })).toEqual({
        kind: "expired",
      });

      const paused = await seedAlias();
      const pausedToken = await claimWithDomain(paused);
      await t.pool.query("update email_addresses set status = 'paused' where id = $1", [paused]);
      expect(await applyActivationAllow(t.db, { aliasId: paused, token: pausedToken })).toEqual({
        kind: "expired",
      });
      expect(await rules(deleted)).toEqual([]);
      expect(await rules(paused)).toEqual([]);
    });

    it("a failed insert spends the button: the second tap is expired", async () => {
      const aliasId = await seedAlias();
      const token = await claimWithDomain(aliasId);
      await t.pool.query(`
        create function etg_test_refuse_rule() returns trigger language plpgsql
        as $$ begin raise exception 'insert refused'; end $$;
        create trigger etg_test_refuse_rule before insert on allow_rules
        for each row execute function etg_test_refuse_rule();
      `);
      try {
        expect(await applyActivationAllow(t.db, { aliasId, token })).toMatchObject({
          kind: "failed",
        });
      } finally {
        await t.pool.query(`
          drop trigger etg_test_refuse_rule on allow_rules;
          drop function etg_test_refuse_rule();
        `);
      }
      expect(await applyActivationAllow(t.db, { aliasId, token })).toEqual({ kind: "expired" });
      expect(await rules(aliasId)).toEqual([]);
    });

    it("the rule limit spends the button too (hosted)", async () => {
      process.env["APP_MODE"] = "hosted";
      applyPlanLimitOverrides({ free: { allowRules: 1 } });
      const aliasId = await seedAlias();
      await t.pool.query(
        "insert into allow_rules (email_address_id, match_type, match_value) values ($1, 'domain', 'example.org')",
        [aliasId],
      );
      const token = await claimWithDomain(aliasId);

      expect(await applyActivationAllow(t.db, { aliasId, token })).toMatchObject({
        kind: "limit",
        limit: 1,
      });
      expect(await applyActivationAllow(t.db, { aliasId, token })).toEqual({ kind: "expired" });
      expect(await rules(aliasId)).toEqual(["example.org"]);
    });

    it("the allow-rule helper writes nothing when the alias no longer matches the snapshot", async () => {
      const aliasId = await seedAlias();
      const rule = { matchType: "domain" as const, normalized: "github.com" };
      const stale = await t.db.transaction((tx) =>
        insertAllowRule(tx, {
          aliasId,
          ownerId: OWNER,
          rule,
          expected: { chatId: DM_CHAT, routingVersion: 1 },
        }),
      );
      expect(stale).toEqual({ kind: "stale" });
      expect(await rules(aliasId)).toEqual([]);
      const added = await t.db.transaction((tx) =>
        insertAllowRule(tx, {
          aliasId,
          ownerId: OWNER,
          rule,
          expected: { chatId: DM_CHAT, routingVersion: 0 },
        }),
      );
      expect(added).toEqual({ kind: "added" });
      expect(await rules(aliasId)).toEqual(["github.com"]);
    });

    it("a failed commit leaves the button usable", async () => {
      const aliasId = await seedAlias();
      const token = await claimWithDomain(aliasId);
      await t.pool.query(`
        create function etg_test_refuse_commit() returns trigger language plpgsql
        as $$ begin raise exception 'commit refused'; end $$;
        create constraint trigger etg_test_refuse_commit after update on alias_activation
        deferrable initially deferred for each row execute function etg_test_refuse_commit();
      `);
      try {
        await expect(applyActivationAllow(t.db, { aliasId, token })).rejects.toThrow();
      } finally {
        await t.pool.query(`
          drop trigger etg_test_refuse_commit on alias_activation;
          drop function etg_test_refuse_commit();
        `);
      }
      expect(await rules(aliasId)).toEqual([]);
      expect(await applyActivationAllow(t.db, { aliasId, token })).toMatchObject({
        kind: "added",
      });
      expect(await rules(aliasId)).toEqual(["github.com"]);
    });
  });

  describe("working-alias marker", () => {
    it("is written once and never moved", async () => {
      const aliasId = await seedAlias();
      await markAliasFirstDelivered(t.db, aliasId);
      const first = (await activation(aliasId)).first_delivered_at;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await markAliasFirstDelivered(t.db, aliasId);
      expect((await activation(aliasId)).first_delivered_at).toEqual(first);
    });

    it("gives up within its lock timeout while a claim or tap holds the row, then succeeds", async () => {
      const aliasId = await seedAlias();
      await t.pool.query("insert into alias_activation (alias_id) values ($1)", [aliasId]);
      const locker = await t.client();
      await locker.query("begin");
      await locker.query("select * from alias_activation where alias_id = $1 for update", [
        aliasId,
      ]);
      const started = Date.now();
      const failure: unknown = await markAliasFirstDelivered(t.db, aliasId)
        .then(
          () => null,
          (err: unknown) => err,
        )
        .finally(async () => {
          await locker.query("rollback");
          await locker.end();
        });
      const elapsed = Date.now() - started;
      // lock_timeout (55P03), not a hang: the delivery that called it logs and moves on.
      const pgError = (failure as { cause?: { code?: string } } | null)?.cause ?? failure;
      expect((pgError as { code?: string } | null)?.code).toBe("55P03");
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      expect(elapsed).toBeLessThan(10_000);
      expect((await activation(aliasId)).first_delivered_at).toBeNull();

      await markAliasFirstDelivered(t.db, aliasId);
      expect((await activation(aliasId)).first_delivered_at).not.toBeNull();
    }, 20_000);

    it("blocks a claim on an existing row", async () => {
      const aliasId = await seedAlias();
      const { api } = fakeApi();
      const queue = makeQueue(api);
      queue.admit(rawRequest(aliasId));
      await queue.whenIdle();
      await markAliasFirstDelivered(t.db, aliasId);
      await reopenWindow(aliasId);
      queue.admit(rawRequest(aliasId));
      await queue.whenIdle();
      expect((await activation(aliasId)).claims_used).toBe(1);
      expect(await noticeCount("raw", "gated")).toBe(1);
    });

    it("is reconciled from surviving succeeded attempts", async () => {
      const unmarked = await seedAlias();
      await seedDelivery(unmarked, "succeeded", "2026-09-01T10:00:00Z");
      await seedDelivery(unmarked, "succeeded", "2026-09-02T10:00:00Z");
      const claimedOnly = await seedAlias();
      await t.pool.query(
        "insert into alias_activation (alias_id, claims_used, last_claim_at) values ($1, 1, now())",
        [claimedOnly],
      );
      await seedDelivery(claimedOnly, "succeeded", "2026-09-03T10:00:00Z");
      const failedOnly = await seedAlias();
      await seedDelivery(failedOnly, "failed");

      expect(await reconcileFirstDeliveredMarkers(t.db)).toBe(2);
      expect((await activation(unmarked)).first_delivered_at).toEqual(
        new Date("2026-09-01T10:00:00Z"),
      );
      expect(await activation(claimedOnly)).toMatchObject({
        claims_used: 1,
        first_delivered_at: new Date("2026-09-03T10:00:00Z"),
      });
      expect(await activation(failedOnly)).toBeNull();
      expect(await reconcileFirstDeliveredMarkers(t.db)).toBe(0);
    });
  });

  describe("data rights", () => {
    it("/export_me lists every owned alias's row, deleted ones included, token redacted", async () => {
      const live = await seedAlias({ local: "liveone" });
      const gone = await seedAlias({ local: "goneone" });
      const foreign = await seedAlias({ owner: OTHER_OWNER, local: "foreign" });
      for (const aliasId of [live, gone, foreign]) {
        const { api } = fakeApi();
        const queue = makeQueue(api);
        queue.admit(rawRequest(aliasId));
        await queue.whenIdle();
      }
      await softDeleteAliasWithCas(t.db, { aliasId: gone, expectedVersion: 0 });
      await t.pool.query(
        "update alias_activation set expires_at = now() - interval '1 second' where alias_id = $1",
        [gone],
      );

      const exported = await exportHostedUserData(t.db, OWNER);
      const rows = exported!.aliasActivation;
      expect(rows.map((r) => r.aliasId).sort()).toEqual([live, gone].sort());
      const liveRow = rows.find((r) => r.aliasId === live)!;
      expect(liveRow).toMatchObject({ token: "[redacted]", domain: "github.com", claimsUsed: 1 });
      const goneRow = rows.find((r) => r.aliasId === gone)!;
      expect(goneRow).toMatchObject({ token: null, domain: null });
      expect(JSON.stringify(exported)).not.toContain((await activation(live)).token!);
    });

    it("/delete_me removes the rows through the alias cascade", async () => {
      const own = await seedAlias();
      const foreign = await seedAlias({ owner: OTHER_OWNER });
      await markAliasFirstDelivered(t.db, own);
      await markAliasFirstDelivered(t.db, foreign);

      expect((await deleteHostedUser(t.db, OWNER)).deleted).toBe(true);
      expect(await activation(own)).toBeNull();
      expect(await activation(foreign)).not.toBeNull();
    });
  });

  describe("shutdown", () => {
    it("with a notice transaction holding a pool client: bounded wait, then the pool drains", async () => {
      const aliasId = await seedAlias();
      await t.pool.query("insert into alias_activation (alias_id) values ($1)", [aliasId]);
      const pool = new pg.Pool({ connectionString: t.url, max: 2 });
      const db = drizzle(pool, { schema });
      const { api, sendMessage } = fakeApi();
      // A lock wait well past the 2 s shutdown wait, inside the 5 s statement bound.
      const queue = makeQueue(api, { db, bounds: { lockTimeout: "4s" } });

      const locker = await t.client();
      try {
        await locker.query("begin");
        await locker.query("select * from alias_activation where alias_id = $1 for update", [
          aliasId,
        ]);
        queue.admit(rawRequest(aliasId));
        // The claim is blocked on the row, holding its pool client.
        await waitForLockWaiters(1);
        expect(pool.totalCount - pool.idleCount).toBe(1);

        const shutdownStart = Date.now();
        await queue.shutdown();
        const shutdownMs = Date.now() - shutdownStart;
        expect(shutdownMs).toBeGreaterThanOrEqual(1_900);
        expect(shutdownMs).toBeLessThan(3_500);
        // Shutdown returned while the statement still holds the client …
        expect(pool.totalCount - pool.idleCount).toBe(1);
        expect(queue.admit(rawRequest(aliasId))).toBe(false);

        // … so closeDb waits for it, until the lock timeout ends the statement.
        await pool.end();
        expect(pool.totalCount).toBe(0);
      } finally {
        await locker.query("rollback").catch(() => {});
        await locker.end();
      }
      await queue.whenIdle();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(await noticeCount("raw", "failed")).toBe(1);
      expect((await activation(aliasId)).claims_used).toBe(0);
    }, 20_000);

    it("while the job waits for a pool client: it starts nothing, and no claim is spent", async () => {
      const aliasId = await seedAlias();
      const pool = new pg.Pool({ connectionString: t.url, max: 1 });
      const db = drizzle(pool, { schema });
      const { api, sendMessage } = fakeApi();
      const queue = makeQueue(api, { db });

      const held = await pool.connect();
      let released = false;
      try {
        queue.admit(rawRequest(aliasId));
        await waitUntil(() => pool.waitingCount === 1, "the job to wait for a client");
        const stopping = queue.shutdown();
        held.release();
        released = true;
        await stopping;
      } finally {
        if (!released) held.release();
      }
      await queue.whenIdle();
      await pool.end();

      expect(sendMessage).not.toHaveBeenCalled();
      expect(await activation(aliasId)).toBeNull();
      expect(await noticeCount("raw", "dropped")).toBe(1);
      expect(await noticeCount("raw", "failed")).toBe(0);
    });
  });

  describe("cleanup", () => {
    const cleanupConfig = {
      attachmentDir: "/nonexistent/etg-test-attachments",
      rawEmailDir: "/nonexistent/etg-test-rawemails",
      attachmentTtlHours: 24,
      rawEmailTtlHours: 24,
      deliveryLogRetentionDays: 7,
    };

    async function logsOf(aliasId: string): Promise<number> {
      const { rows } = await t.pool.query<{ n: number }>(
        "select count(*)::int as n from delivery_logs where email_address_id = $1",
        [aliasId],
      );
      return rows[0].n;
    }

    it("keeps the only working-alias evidence when reconciliation fails, and purges once it succeeds", async () => {
      const aliasId = await seedAlias({ ageDays: 40 });
      const deliveredAt = "2026-08-01T10:00:00Z";
      const { rows } = await t.pool.query<{ id: string }>(
        `insert into delivery_logs (email_address_id, user_id, final_status, received_at, created_at)
         values ($1, $2, 'delivered', $3, $3) returning id`,
        [aliasId, OWNER.toString(), deliveredAt],
      );
      await t.pool.query(
        `insert into delivery_attempts (delivery_log_id, attempt_no, target_chat_id, status, created_at)
         values ($1, 1, $2, 'succeeded', $3)`,
        [rows[0].id, DM_CHAT.toString(), deliveredAt],
      );

      await t.pool.query(`
        create function etg_test_refuse_marker() returns trigger language plpgsql
        as $$ begin raise exception 'marker refused'; end $$;
        create trigger etg_test_refuse_marker before insert on alias_activation
        for each row execute function etg_test_refuse_marker();
      `);
      try {
        await runCleanup(t.db, cleanupConfig);
      } finally {
        await t.pool.query(`
          drop trigger etg_test_refuse_marker on alias_activation;
          drop function etg_test_refuse_marker();
        `);
      }
      // The purge was skipped: the succeeded attempt still marks the alias working.
      expect(await logsOf(aliasId)).toBe(1);
      expect(await activation(aliasId)).toBeNull();
      expect((await readActivationGate(t.db, aliasId))!.working).toBe(true);

      // The next run reconciles first, then purges.
      await runCleanup(t.db, cleanupConfig);
      expect(await logsOf(aliasId)).toBe(0);
      expect((await activation(aliasId)).first_delivered_at).toEqual(new Date(deliveredAt));
      expect((await readActivationGate(t.db, aliasId))!.working).toBe(true);
    });
  });
});

describe.skipIf(!hasTestDatabase)("migration 0011 backfill", () => {
  let t: PgTestDatabase;

  beforeAll(async () => {
    t = await createPgTestDatabase();
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("marks every alias with a surviving succeeded attempt, at its first success", async () => {
    await t.migrate("0010_delivery-backlog-index");
    await t.pool.query("insert into users (id) values ($1)", [OWNER.toString()]);
    const alias = async (local: string): Promise<string> => {
      const { rows } = await t.pool.query<{ id: string }>(
        `insert into email_addresses (local_part, full_address, chat_id, created_by)
         values ($1, $2, $3, $3) returning id`,
        [local, `${local}@mail.example.com`, OWNER.toString()],
      );
      return rows[0].id;
    };
    const attempt = async (aliasId: string, status: string, at: string): Promise<void> => {
      const { rows } = await t.pool.query<{ id: string }>(
        "insert into delivery_logs (email_address_id) values ($1) returning id",
        [aliasId],
      );
      await t.pool.query(
        `insert into delivery_attempts (delivery_log_id, attempt_no, target_chat_id, status, created_at)
         values ($1, 1, 1, $2, $3)`,
        [rows[0].id, status, at],
      );
    };
    const working = await alias("working");
    await attempt(working, "failed", "2026-09-01T00:00:00Z");
    await attempt(working, "succeeded", "2026-09-02T00:00:00Z");
    await attempt(working, "succeeded", "2026-09-03T00:00:00Z");
    const silent = await alias("silent");
    await attempt(silent, "failed", "2026-09-01T00:00:00Z");
    await alias("untouched");

    await t.migrate();

    const { rows } = await t.pool.query<{ alias_id: string; first_delivered_at: Date }>(
      "select alias_id, first_delivered_at from alias_activation",
    );
    expect(rows).toEqual([
      { alias_id: working, first_delivered_at: new Date("2026-09-02T00:00:00Z") },
    ]);
    // The column a rollback image still reads survives this migration.
    const { rows: columns } = await t.pool.query(
      "select 1 from information_schema.columns where table_name = 'email_addresses' and column_name = 'max_emails_hour'",
    );
    expect(columns).toHaveLength(1);
  });
});
