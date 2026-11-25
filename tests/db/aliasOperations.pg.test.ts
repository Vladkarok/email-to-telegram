/**
 * Alias operations (src/aliases/) against a real Postgres (TEST_DATABASE_URL,
 * see tests/helpers/pgTestDb.ts): alias creation outcome by outcome in the
 * order its checks run, what a rolled-back outcome leaves behind, naming
 * retries under real unique violations, allow-rule insertion with its
 * plan limit, snapshot check and owner lock, and the alias menu's mutations.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import {
  createPgTestDatabase,
  hasTestDatabase,
  waitForAdvisoryLockWaiters,
  type PgTestDatabase,
} from "../helpers/pgTestDb.js";
import { applyPlanLimitOverrides } from "../../src/billing/plans.js";
import {
  createAliasForChat,
  type AliasCreationInput,
  type AliasDomainConfig,
} from "../../src/aliases/creation.js";
import { addAllowRuleForOwner, insertAllowRule } from "../../src/aliases/allowRules.js";
import {
  deleteAliasAtVersion,
  setAliasRenderMode,
  toggleAliasBodyDedup,
  toggleAliasPrivacyMode,
} from "../../src/aliases/settings.js";
import { softDeleteAliasWithCas } from "../../src/db/repos/aliasRouting.js";
import { reserveHostedAliasCreateAttempt } from "../../src/abuse/hostedAliasCreation.js";

// A fixed suffix lets a test make every automatic candidate collide; null
// keeps nanoid's random suffixes. `generated` counts suffixed candidates.
const suffix = vi.hoisted(() => ({ fixed: null as string | null, generated: 0 }));
vi.mock("nanoid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanoid")>();
  return {
    ...actual,
    customAlphabet: (alphabet: string, size?: number) => {
      const random = actual.customAlphabet(alphabet, size);
      return () => {
        if (suffix.fixed === null) return random();
        suffix.generated++;
        return suffix.fixed;
      };
    },
  };
});

const OWNER = 7501n;
const OTHER = 7502n;
const CHAT = -1007501n;
const OTHER_CHAT = -1007502n;

const SELF_HOSTED: AliasDomainConfig = {
  appMode: "self-hosted",
  mailDomain: "mail.example.com",
  hostedMailDomain: undefined,
};
const HOSTED: AliasDomainConfig = {
  appMode: "hosted",
  mailDomain: "legacy.example.com",
  hostedMailDomain: "inbox.example.com",
};

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
  suffix.fixed = null;
  suffix.generated = 0;
});

async function reset({ hosted }: { hosted: boolean }): Promise<void> {
  process.env["APP_MODE"] = hosted ? "hosted" : "self-hosted";
  // DELETE, not TRUNCATE: these tables hold a handful of rows, and TRUNCATE's
  // file syncs slow down the other Postgres suites running in parallel.
  await pgdb.db.execute(sql`delete from email_addresses`);
  await pgdb.db.execute(sql`delete from inbound_domains`);
  await pgdb.db.execute(sql`delete from hosted_onboarding_attempts`);
  await pgdb.db.execute(sql`delete from chats`);
  await pgdb.db.execute(sql`delete from users`);
  await pgdb.db.insert(schema.users).values([
    { id: OWNER, isAllowed: true, locale: "en" },
    { id: OTHER, isAllowed: true, locale: "en" },
  ]);
  await pgdb.db.insert(schema.chats).values([
    { id: CHAT, title: "Alerts", type: "supergroup" },
    { id: OTHER_CHAT, title: "Elsewhere", type: "supergroup" },
  ]);
}

/** An existing alias row, inserted directly. */
async function seedAlias(
  values: Partial<schema.NewEmailAddress> & { localPart: string },
): Promise<schema.EmailAddress> {
  const [alias] = await pgdb.db
    .insert(schema.emailAddresses)
    .values({
      fullAddress: `${values.localPart}@mail.example.com`,
      chatId: OTHER_CHAT,
      createdBy: OTHER,
      status: "active",
      ...values,
    })
    .returning();
  return alias;
}

function create(
  input: Partial<AliasCreationInput>,
  config: AliasDomainConfig,
): ReturnType<typeof createAliasForChat> {
  return createAliasForChat(
    pgdb.db,
    { createdBy: OWNER, chatId: CHAT, threadId: null, requestedName: null, ...input },
    config,
  );
}

async function ownerAliases(): Promise<schema.EmailAddress[]> {
  return pgdb.db
    .select()
    .from(schema.emailAddresses)
    .where(eq(schema.emailAddresses.createdBy, OWNER));
}

async function inboundDomains(): Promise<schema.InboundDomain[]> {
  return pgdb.db.select().from(schema.inboundDomains);
}

/** Today's hosted alias-creation attempts of OWNER (0 when no bucket row). */
async function creationAttempts(): Promise<number> {
  const rows = await pgdb.db
    .select({ attempts: schema.hostedOnboardingAttempts.attempts })
    .from(schema.hostedOnboardingAttempts)
    .where(eq(schema.hostedOnboardingAttempts.bucketKey, OWNER.toString()));
  return rows[0]?.attempts ?? 0;
}

/** Leaves a fresh tombstone of `localPart`, deleted by `createdBy`. */
async function tombstone(localPart: string, createdBy: bigint): Promise<void> {
  const alias = await seedAlias({ localPart, createdBy });
  const deleted = await softDeleteAliasWithCas(pgdb.db, {
    aliasId: alias.id,
    expectedVersion: alias.routingVersion,
  });
  expect(deleted.ok).toBe(true);
}

describe.skipIf(!hasTestDatabase)("alias creation on Postgres", () => {
  // Name length, characters and impersonation are refused before any query;
  // tests/unit/aliases/creation.test.ts pins them without a database.
  describe("checks before the transaction", () => {
    beforeEach(() => reset({ hosted: true }));

    it("refuses a requested name another owner deleted less than 24 hours ago", async () => {
      await tombstone("alerts", OTHER);

      expect(await create({ requestedName: "alerts" }, HOSTED)).toEqual({ kind: "name_cooldown" });
      expect(await ownerAliases()).toEqual([]);
      expect(await inboundDomains()).toEqual([]);
      expect(await creationAttempts()).toBe(0);
    });

    it("lets the owner who deleted a name take it back at once", async () => {
      await tombstone("alerts", OWNER);

      const result = await create({ requestedName: "alerts" }, HOSTED);

      expect(result).toMatchObject({ kind: "created", alias: { localPart: "alerts" } });
    });

    it("ignores a tombstone older than 24 hours", async () => {
      await tombstone("alerts", OTHER);
      await pgdb.db.execute(
        sql`update email_addresses set updated_at = now() - interval '25 hours' where status = 'deleted'`,
      );

      expect(await create({ requestedName: "alerts" }, HOSTED)).toMatchObject({
        kind: "created",
      });
    });

    it("moves an automatic name past a cooling-down default to a suffixed candidate", async () => {
      await tombstone("inbox", OTHER);

      const result = await create({}, HOSTED);

      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;
      expect(result.alias.localPart).toMatch(/^inbox-[a-z0-9]{6}$/);
    });
  });

  describe("self-hosted", () => {
    beforeEach(() => reset({ hosted: false }));

    it("creates the alias with its routing fields on the mail domain", async () => {
      const result = await create({ requestedName: "alerts", threadId: 42n }, SELF_HOSTED);

      expect(result.kind).toBe("created");
      const [row] = await ownerAliases();
      expect(row).toMatchObject({
        localPart: "alerts",
        fullAddress: "alerts@mail.example.com",
        domainId: null,
        chatId: CHAT,
        messageThreadId: 42n,
        createdBy: OWNER,
        renderMode: "html",
        privacyModeEnabled: false,
        bodyDedupEnabled: false,
        status: "active",
        routingVersion: 0,
      });
      expect(result).toEqual({ kind: "created", alias: row });
      expect(await inboundDomains()).toEqual([]);
    });

    it("has no alias limit and no impersonation guard", async () => {
      applyPlanLimitOverrides({ free: { aliases: 1 } });
      await seedAlias({ localPart: "first", createdBy: OWNER });

      expect(await create({ requestedName: "postmaster" }, SELF_HOSTED)).toMatchObject({
        kind: "created",
      });
      expect(await ownerAliases()).toHaveLength(2);
    });

    it("names automatic aliases inbox, then the next inbox-N in the chat", async () => {
      expect(await create({}, SELF_HOSTED)).toMatchObject({ alias: { localPart: "inbox" } });
      await seedAlias({ localPart: "inbox-3", chatId: CHAT, createdBy: OWNER });

      expect(await create({}, SELF_HOSTED)).toMatchObject({ alias: { localPart: "inbox-4" } });
    });

    it("answers name_taken for a requested name that already exists", async () => {
      await seedAlias({ localPart: "alerts" });

      expect(await create({ requestedName: "alerts" }, SELF_HOSTED)).toEqual({
        kind: "name_taken",
      });
      expect(await ownerAliases()).toEqual([]);
    });

    it("retries an automatic name with a suffix after a real unique violation", async () => {
      // "inbox" is free in CHAT, so it is the first candidate, but another
      // chat already holds it: the insert violates idx_alias_local_part.
      await seedAlias({ localPart: "inbox" });

      const result = await create({}, SELF_HOSTED);

      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;
      expect(result.alias.localPart).toMatch(/^inbox-[a-z0-9]{6}$/);
      expect(await ownerAliases()).toHaveLength(1);
    });

    it("gives up after five colliding candidates", async () => {
      suffix.fixed = "aaaaaa";
      await seedAlias({ localPart: "inbox" });
      await seedAlias({ localPart: "inbox-aaaaaa" });

      expect(await create({}, SELF_HOSTED)).toEqual({ kind: "no_unique_name" });
      expect(suffix.generated).toBe(4);
      expect(await ownerAliases()).toEqual([]);
    });

    it("refuses a chat that migration repair deactivated", async () => {
      await pgdb.db.update(schema.chats).set({ isActive: false }).where(eq(schema.chats.id, CHAT));

      expect(await create({ requestedName: "alerts" }, SELF_HOSTED)).toEqual({
        kind: "chat_migrated",
      });
      expect(await ownerAliases()).toEqual([]);
    });

    it("waits for the chat migration lock and sees a repair that committed meanwhile", async () => {
      // Repair holds the chat lock and deactivates the chat before it commits.
      // Creation must queue on that lock and then read the dead chat row; one
      // that skipped the lock would insert an alias pointing at it.
      const repair = await pgdb.client();
      try {
        await repair.query("begin");
        await repair.query("select pg_advisory_xact_lock($1)", [CHAT.toString()]);
        const creation = create({ requestedName: "alerts" }, SELF_HOSTED);
        await waitForAdvisoryLockWaiters(repair, 1);
        await repair.query("update chats set is_active = false where id = $1", [CHAT.toString()]);
        await repair.query("commit");

        expect(await creation).toEqual({ kind: "chat_migrated" });
      } finally {
        await repair.end();
      }
      expect(await ownerAliases()).toEqual([]);
    });

    it("propagates an unexpected insert failure instead of answering with a result", async () => {
      // No users row for this owner: the insert violates the created_by
      // foreign key, which is not a name conflict.
      await expect(
        create({ createdBy: 7599n, requestedName: "alerts" }, SELF_HOSTED),
      ).rejects.toThrow();
      await expect(create({ createdBy: 7599n }, SELF_HOSTED)).rejects.toThrow();
      expect(await pgdb.db.select().from(schema.emailAddresses)).toEqual([]);
    });
  });

  describe("hosted", () => {
    beforeEach(() => reset({ hosted: true }));

    it("creates on the shared domain, provisioning it and counting the attempt", async () => {
      const result = await create({ requestedName: "alerts" }, HOSTED);

      const [domain] = await inboundDomains();
      expect(domain).toMatchObject({
        domain: "inbox.example.com",
        kind: "shared",
        status: "active",
      });
      expect(result).toMatchObject({
        kind: "created",
        alias: {
          localPart: "alerts",
          fullAddress: "alerts@inbox.example.com",
          domainId: domain.id,
          chatId: CHAT,
          createdBy: OWNER,
        },
      });
      expect(await creationAttempts()).toBe(1);
    });

    it("chat_migrated rolls back before anything is provisioned", async () => {
      await pgdb.db.update(schema.chats).set({ isActive: false }).where(eq(schema.chats.id, CHAT));

      expect(await create({ requestedName: "alerts" }, HOSTED)).toEqual({
        kind: "chat_migrated",
      });
      expect(await inboundDomains()).toEqual([]);
      expect(await creationAttempts()).toBe(0);
    });

    it("the alias limit rolls back the domain it provisioned", async () => {
      applyPlanLimitOverrides({ free: { aliases: 1 } });
      await seedAlias({ localPart: "first", createdBy: OWNER });

      expect(await create({ requestedName: "alerts" }, HOSTED)).toEqual({
        kind: "limit",
        limit: { ok: false, code: "alias_limit", limit: 1, used: 1 },
      });
      expect(await ownerAliases()).toHaveLength(1);
      expect(await inboundDomains()).toEqual([]);
      expect(await creationAttempts()).toBe(0);
    });

    it("an owner without a hosted user row is refused as subscription_inactive", async () => {
      expect(await create({ createdBy: 7599n, requestedName: "alerts" }, HOSTED)).toEqual({
        kind: "limit",
        limit: { ok: false, code: "subscription_inactive" },
      });
      expect(await inboundDomains()).toEqual([]);
    });

    it("the creation rate limit rolls back the domain it provisioned", async () => {
      await pgdb.db.transaction(async (tx) => {
        for (let i = 0; i < 10; i++) await reserveHostedAliasCreateAttempt(tx, OWNER);
      });

      expect(await create({ requestedName: "alerts" }, HOSTED)).toEqual({ kind: "rate_limited" });
      expect(await ownerAliases()).toEqual([]);
      expect(await inboundDomains()).toEqual([]);
      expect(await creationAttempts()).toBe(10);
    });

    it("checks the alias limit before reserving a creation attempt", async () => {
      applyPlanLimitOverrides({ free: { aliases: 1 } });
      await seedAlias({ localPart: "first", createdBy: OWNER });
      await pgdb.db.transaction(async (tx) => {
        for (let i = 0; i < 10; i++) await reserveHostedAliasCreateAttempt(tx, OWNER);
      });

      expect(await create({ requestedName: "alerts" }, HOSTED)).toMatchObject({ kind: "limit" });
      expect(await creationAttempts()).toBe(10);
    });

    it("refuses a shared domain that is not active", async () => {
      await pgdb.db
        .insert(schema.inboundDomains)
        .values({ domain: "inbox.example.com", kind: "shared", status: "disabled" });

      expect(await create({ requestedName: "alerts" }, HOSTED)).toEqual({
        kind: "domain_unavailable",
      });
      expect(await ownerAliases()).toEqual([]);
      expect(await creationAttempts()).toBe(0);
    });

    it("a taken requested name rolls back the domain and the attempt reservation", async () => {
      // A legacy alias already owns the address, so the insert violates
      // idx_alias_full_address after the domain and the attempt were written.
      await seedAlias({ localPart: "alerts", fullAddress: "alerts@inbox.example.com" });

      expect(await create({ requestedName: "alerts" }, HOSTED)).toEqual({ kind: "name_taken" });
      expect(await ownerAliases()).toEqual([]);
      expect(await inboundDomains()).toEqual([]);
      expect(await creationAttempts()).toBe(0);
    });

    it("an automatic retry reserves one attempt per committed alias", async () => {
      await seedAlias({ localPart: "inbox", fullAddress: "inbox@inbox.example.com" });

      const result = await create({}, HOSTED);

      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;
      expect(result.alias.localPart).toMatch(/^inbox-[a-z0-9]{6}$/);
      expect(await creationAttempts()).toBe(1);
    });

    it("takes the chat migration lock before the owner's quota lock", async () => {
      // Hold the owner lock: creation must be queued on it while already
      // holding the chat lock (A3: the reverse order can deadlock with repair).
      const holder = await pgdb.client();
      try {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock($1)", [OWNER.toString()]);
        const creation = create({ requestedName: "alerts" }, HOSTED);
        await waitForAdvisoryLockWaiters(holder, 1);
        const { rows } = await holder.query<{ free: boolean }>(
          "select pg_try_advisory_xact_lock($1) as free",
          [CHAT.toString()],
        );
        expect(rows[0]?.free).toBe(false);
        await holder.query("commit");

        expect(await creation).toMatchObject({ kind: "created" });
      } finally {
        await holder.end();
      }
    });

    it("two creations at the alias-limit edge: exactly one succeeds", async () => {
      applyPlanLimitOverrides({ free: { aliases: 1 } });
      // Different chats, so the chat locks do not serialize them, and the
      // shared domain exists, so its first insert does not either: only the
      // owner's quota lock is left. Holding it queues both before either
      // counts the owner's aliases.
      await pgdb.db
        .insert(schema.inboundDomains)
        .values({ domain: HOSTED.hostedMailDomain!, kind: "shared", status: "active" });
      const holder = await pgdb.client();
      let results: Awaited<ReturnType<typeof create>>[];
      try {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock($1)", [OWNER.toString()]);
        const creations = Promise.all([
          create({ chatId: CHAT, requestedName: "first" }, HOSTED),
          create({ chatId: OTHER_CHAT, requestedName: "second" }, HOSTED),
        ]);
        await waitForAdvisoryLockWaiters(holder, 2);
        await holder.query("commit");
        results = await creations;
      } finally {
        await holder.end();
      }

      expect(results.map((r) => r.kind).sort()).toEqual(["created", "limit"]);
      expect(await ownerAliases()).toHaveLength(1);
      expect(await creationAttempts()).toBe(1);
    });
  });
});

describe.skipIf(!hasTestDatabase)("allow-rule insertion on Postgres", () => {
  const github = { matchType: "domain" as const, normalized: "github.com" };
  const gitlab = { matchType: "domain" as const, normalized: "gitlab.com" };
  let alias: schema.EmailAddress;

  async function seed({ hosted }: { hosted: boolean }): Promise<void> {
    await reset({ hosted });
    alias = await seedAlias({ localPart: "alerts", chatId: CHAT, createdBy: OWNER });
  }

  async function rules(): Promise<string[]> {
    const rows = await pgdb.db
      .select({ matchValue: schema.allowRules.matchValue })
      .from(schema.allowRules)
      .where(eq(schema.allowRules.emailAddressId, alias.id));
    return rows.map((row) => row.matchValue).sort();
  }

  describe("hosted", () => {
    beforeEach(async () => {
      await seed({ hosted: true });
      applyPlanLimitOverrides({ free: { allowRules: 1 } });
    });

    it("inserts a rule under the limit", async () => {
      expect(await addAllowRuleForOwner(pgdb.db, alias, github)).toEqual({ kind: "added" });
      const [row] = await pgdb.db.select().from(schema.allowRules);
      expect(row).toMatchObject({
        emailAddressId: alias.id,
        matchType: "domain",
        matchValue: "github.com",
      });
    });

    it("answers duplicate before the limit, so a repeat at the limit is not refused", async () => {
      await addAllowRuleForOwner(pgdb.db, alias, github);

      expect(await addAllowRuleForOwner(pgdb.db, alias, github)).toEqual({ kind: "duplicate" });
      expect(await rules()).toEqual(["github.com"]);
    });

    it("refuses a new rule at the limit", async () => {
      await addAllowRuleForOwner(pgdb.db, alias, github);

      expect(await addAllowRuleForOwner(pgdb.db, alias, gitlab)).toEqual({
        kind: "limit",
        limit: { ok: false, code: "allow_rule_limit", limit: 1, used: 1 },
      });
      expect(await rules()).toEqual(["github.com"]);
    });

    it("two inserts at the limit edge under the owner lock: exactly one is added", async () => {
      const results = await Promise.all([
        addAllowRuleForOwner(pgdb.db, alias, github),
        addAllowRuleForOwner(pgdb.db, alias, gitlab),
      ]);

      expect(results.map((r) => r.kind).sort()).toEqual(["added", "limit"]);
      expect(await rules()).toHaveLength(1);
    });
  });

  describe("self-hosted", () => {
    beforeEach(() => seed({ hosted: false }));

    it("has no allow-rule limit", async () => {
      applyPlanLimitOverrides({ free: { allowRules: 1 } });
      await addAllowRuleForOwner(pgdb.db, alias, github);

      expect(await addAllowRuleForOwner(pgdb.db, alias, gitlab)).toEqual({ kind: "added" });
      expect(await rules()).toEqual(["github.com", "gitlab.com"]);
    });

    it("with `expected`, writes nothing when the alias no longer matches the snapshot", async () => {
      const insert = (
        expected: { chatId: bigint; routingVersion: number },
        ownerId = OWNER,
      ): ReturnType<typeof insertAllowRule> =>
        pgdb.db.transaction((tx) =>
          insertAllowRule(tx, { aliasId: alias.id, ownerId, rule: github, expected }),
        );

      expect(await insert({ chatId: CHAT, routingVersion: 1 })).toEqual({ kind: "stale" });
      expect(await insert({ chatId: OTHER_CHAT, routingVersion: 0 })).toEqual({ kind: "stale" });
      expect(await insert({ chatId: CHAT, routingVersion: 0 }, OTHER)).toEqual({ kind: "stale" });
      await pgdb.db
        .update(schema.emailAddresses)
        .set({ status: "paused" })
        .where(eq(schema.emailAddresses.id, alias.id));
      expect(await insert({ chatId: CHAT, routingVersion: 0 })).toEqual({ kind: "stale" });
      expect(await rules()).toEqual([]);

      await pgdb.db
        .update(schema.emailAddresses)
        .set({ status: "active" })
        .where(eq(schema.emailAddresses.id, alias.id));
      expect(await insert({ chatId: CHAT, routingVersion: 0 })).toEqual({ kind: "added" });
      expect(await rules()).toEqual(["github.com"]);
    });
  });
});

describe.skipIf(!hasTestDatabase)("alias menu mutations on Postgres", () => {
  const MISSING = "00000000-0000-4000-8000-000000000000";
  let alias: schema.EmailAddress;

  beforeEach(async () => {
    await reset({ hosted: false });
    alias = await seedAlias({ localPart: "alerts", chatId: CHAT, createdBy: OWNER });
  });

  async function current(): Promise<schema.EmailAddress> {
    const [row] = await pgdb.db
      .select()
      .from(schema.emailAddresses)
      .where(eq(schema.emailAddresses.id, alias.id));
    return row;
  }

  it("deletes at the confirmed routing version and returns the row read before", async () => {
    expect(await deleteAliasAtVersion(pgdb.db, { aliasId: alias.id, expectedVersion: 0 })).toEqual({
      kind: "deleted",
      alias,
    });
    expect(await current()).toMatchObject({ status: "deleted" });
  });

  it("refuses a delete confirmed against an older routing version", async () => {
    await pgdb.db
      .update(schema.emailAddresses)
      .set({ routingVersion: 1 })
      .where(eq(schema.emailAddresses.id, alias.id));

    expect(await deleteAliasAtVersion(pgdb.db, { aliasId: alias.id, expectedVersion: 0 })).toEqual({
      kind: "routing_changed",
    });
    expect(await current()).toMatchObject({ status: "active", localPart: "alerts" });
  });

  it("answers not_found for a missing alias", async () => {
    expect(await deleteAliasAtVersion(pgdb.db, { aliasId: MISSING, expectedVersion: 0 })).toEqual({
      kind: "not_found",
    });
  });

  it("sets only the two supported render modes", async () => {
    expect(await setAliasRenderMode(pgdb.db, alias.id, "html")).toEqual({
      kind: "updated",
      mode: "html",
    });
    expect(await current()).toMatchObject({ renderMode: "html" });

    expect(await setAliasRenderMode(pgdb.db, alias.id, "markdown")).toEqual({
      kind: "invalid_mode",
    });
    expect(await current()).toMatchObject({ renderMode: "html" });
  });

  it("toggles body dedup and privacy mode, returning the value written", async () => {
    expect(await toggleAliasBodyDedup(pgdb.db, alias.id)).toEqual({
      kind: "toggled",
      enabled: true,
    });
    expect(await toggleAliasPrivacyMode(pgdb.db, alias.id)).toEqual({
      kind: "toggled",
      enabled: true,
    });
    expect(await current()).toMatchObject({ bodyDedupEnabled: true, privacyModeEnabled: true });

    expect(await toggleAliasBodyDedup(pgdb.db, alias.id)).toEqual({
      kind: "toggled",
      enabled: false,
    });
    expect(await toggleAliasPrivacyMode(pgdb.db, alias.id)).toEqual({
      kind: "toggled",
      enabled: false,
    });
    expect(await current()).toMatchObject({ bodyDedupEnabled: false, privacyModeEnabled: false });
  });

  it("toggles answer not_found for a missing alias", async () => {
    expect(await toggleAliasBodyDedup(pgdb.db, MISSING)).toEqual({ kind: "not_found" });
    expect(await toggleAliasPrivacyMode(pgdb.db, MISSING)).toEqual({ kind: "not_found" });
  });
});
