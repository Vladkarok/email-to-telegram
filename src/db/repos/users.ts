import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, count, desc, eq, gte, inArray, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  users,
  emailAddresses,
  deliveryLogs,
  manualBillingEvents,
  type User,
  type NewUser,
} from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function countUsers(db: Db): Promise<{ total: number; allowed: number }> {
  const [row] = await db
    .select({
      total: count(),
      allowed: sql<number>`count(*) filter (where ${users.isAllowed} = true)`,
    })
    .from(users);
  return { total: Number(row?.total ?? 0), allowed: Number(row?.allowed ?? 0) };
}

export async function countUsersByPlan(
  db: Db,
): Promise<Array<{ planCode: string; count: number }>> {
  const rows = await db
    .select({ planCode: users.planCode, count: count() })
    .from(users)
    .groupBy(users.planCode);
  return rows.map((row) => ({ planCode: row.planCode, count: Number(row.count) }));
}

export interface SubscriptionDeadlineUser {
  id: bigint;
  username: string | null;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: Date | null;
  billingEndsAt: Date;
}

export interface BillingAttentionUser {
  id: bigint;
  username: string | null;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: Date | null;
  currentPeriodEnd: Date | null;
}

export interface RecentSignupUser {
  id: bigint;
  username: string | null;
  isAllowed: boolean;
  planCode: string;
  createdAt: Date;
}

export async function listSubscriptionDeadlines(
  db: Db,
  now: Date,
  horizon: Date,
  limit = 50,
): Promise<SubscriptionDeadlineUser[]> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      planCode: users.planCode,
      subscriptionStatus: users.subscriptionStatus,
      paidThroughAt: users.paidThroughAt,
      billingEndsAt: users.paidThroughAt,
    })
    .from(users)
    .where(
      and(
        ne(users.planCode, "free"),
        inArray(users.subscriptionStatus, ["active", "trialing", "past_due"]),
        isNotNull(users.paidThroughAt),
        gte(users.paidThroughAt, now),
        lte(users.paidThroughAt, horizon),
      ),
    )
    .orderBy(users.paidThroughAt)
    .limit(limit);

  return rows.map((row) => {
    const billingEndsAt = row.billingEndsAt ?? row.paidThroughAt;
    if (!billingEndsAt) {
      throw new Error("listSubscriptionDeadlines: row without paid-through deadline");
    }
    return { ...row, billingEndsAt };
  });
}

export async function listBillingAttentionUsers(
  db: Db,
  now: Date,
  limit = 50,
): Promise<BillingAttentionUser[]> {
  return db
    .select({
      id: users.id,
      username: users.username,
      planCode: users.planCode,
      subscriptionStatus: users.subscriptionStatus,
      paidThroughAt: users.paidThroughAt,
      currentPeriodEnd: users.currentPeriodEnd,
    })
    .from(users)
    .where(
      and(
        ne(users.planCode, "free"),
        or(
          and(isNotNull(users.paidThroughAt), lt(users.paidThroughAt, now)),
          inArray(users.subscriptionStatus, [
            "paused",
            "past_due",
            "unpaid",
            "incomplete",
            "incomplete_expired",
          ]),
          and(isNotNull(users.currentPeriodEnd), lt(users.currentPeriodEnd, now)),
        ),
      ),
    )
    .orderBy(users.paidThroughAt, users.currentPeriodEnd, users.id)
    .limit(limit);
}

export async function listRecentSignups(db: Db, limit = 10): Promise<RecentSignupUser[]> {
  return db
    .select({
      id: users.id,
      username: users.username,
      isAllowed: users.isAllowed,
      planCode: users.planCode,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(limit);
}

export class LocaleColumnUnavailableError extends Error {
  constructor() {
    super("users.locale column is unavailable; run migration 0019_users_locale");
  }
}

export function isLocaleColumnUnavailableError(err: unknown): boolean {
  return (
    err instanceof LocaleColumnUnavailableError ||
    (typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "42703" &&
      String("message" in err ? (err as { message?: unknown }).message : "").includes("locale"))
  );
}

export async function upsertUser(
  db: Db,
  data: Pick<NewUser, "id" | "username"> & { locale?: string | null },
): Promise<User> {
  const locale = normalizeSupportedLocale(data.locale);
  try {
    const [user] = await db
      .insert(users)
      .values({ id: data.id, username: data.username, locale, isAllowed: false })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          username: data.username,
          locale: sql`coalesce(${users.locale}, ${locale})`,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!user) throw new Error(`upsertUser: no row returned for id=${data.id}`);
    return user;
  } catch (err: unknown) {
    if (!isLocaleColumnUnavailableError(err)) throw err;
    return upsertUserWithoutLocaleColumn(db, data);
  }
}

export async function findUserById(db: Db, id: bigint): Promise<User | null> {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user ?? null;
  } catch (err: unknown) {
    if (!isLocaleColumnUnavailableError(err)) throw err;
    return findUserByIdWithoutLocaleColumn(db, id);
  }
}

export async function findUserByIdForUpdate(db: Db, id: bigint): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).for("update");
  return user ?? null;
}

export async function findUserByStripeCustomerId(
  db: Db,
  stripeCustomerId: string,
): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.stripeCustomerId, stripeCustomerId));
  return user ?? null;
}

export async function findUserByStripeSubscriptionId(
  db: Db,
  stripeSubscriptionId: string,
): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.stripeSubscriptionId, stripeSubscriptionId));
  return user ?? null;
}

export async function updateUserBillingState(
  db: Db,
  id: bigint,
  data: Partial<
    Pick<
      NewUser,
      | "planCode"
      | "subscriptionStatus"
      | "stripeCustomerId"
      | "stripeSubscriptionId"
      | "trialEndsAt"
      | "currentPeriodStart"
      | "currentPeriodEnd"
      | "paidThroughAt"
    >
  >,
): Promise<User | null> {
  const [user] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return user ?? null;
}

export async function updateUserPaidThroughAtIfLater(
  db: Db,
  id: bigint,
  paidThroughAt: Date,
): Promise<User | null> {
  const [user] = await db
    .update(users)
    .set({
      paidThroughAt: sql`case when ${users.paidThroughAt} is null or ${users.paidThroughAt} < ${paidThroughAt} then ${paidThroughAt} else ${users.paidThroughAt} end`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning();
  return user ?? null;
}

export async function allowUser(db: Db, id: bigint): Promise<void> {
  await db.update(users).set({ isAllowed: true, updatedAt: new Date() }).where(eq(users.id, id));
}

export async function upsertAllowedUser(db: Db, id: bigint): Promise<void> {
  await db
    .insert(users)
    .values({ id, username: null, isAllowed: true })
    .onConflictDoUpdate({
      target: users.id,
      set: { isAllowed: true, updatedAt: new Date() },
    });
}

export async function updateUserLocale(
  db: Db,
  id: bigint,
  locale: "en" | "uk" | "fr" | "it",
): Promise<void> {
  try {
    await db.update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, id));
  } catch (err: unknown) {
    if (isLocaleColumnUnavailableError(err)) throw new LocaleColumnUnavailableError();
    throw err;
  }
}

/**
 * Returns an existing user by id, or creates a minimal row when missing.
 *
 * Unlike `upsertUser`, this helper never overwrites an existing username and is
 * safe to call from operator-driven flows that only know the Telegram user id.
 * It uses INSERT ... ON CONFLICT DO NOTHING and re-reads on race so concurrent
 * inserts don't error.
 */
export async function findOrCreateUserById(db: Db, id: bigint): Promise<User> {
  const existing = await findUserById(db, id);
  if (existing) return existing;

  let created: User | undefined;
  try {
    [created] = await db
      .insert(users)
      .values({ id, username: null, isAllowed: false })
      .onConflictDoNothing({ target: users.id })
      .returning();
  } catch (err: unknown) {
    if (!isLocaleColumnUnavailableError(err)) throw err;
    created = undefined;
  }
  if (created) return created;

  const raced = await findUserById(db, id);
  if (!raced) throw new Error(`findOrCreateUserById: no row returned for id=${id}`);
  return raced;
}

async function upsertUserWithoutLocaleColumn(
  db: Db,
  data: Pick<NewUser, "id" | "username">,
): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ id: data.id, username: data.username, isAllowed: false })
    .onConflictDoUpdate({
      target: users.id,
      set: { username: data.username, updatedAt: new Date() },
    })
    .returning();
  if (!user) throw new Error(`upsertUser: no row returned for id=${data.id}`);
  return user;
}

async function findUserByIdWithoutLocaleColumn(db: Db, id: bigint): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user ?? null;
}

function normalizeSupportedLocale(locale: string | null | undefined): "en" | "uk" | null {
  if (!locale) return null;
  const language = locale.toLowerCase().replace("_", "-").split("-")[0];
  if (language === "en") return "en";
  if (language === "uk" || language === "ua") return "uk";
  return null;
}

export interface UserDeletionSummary {
  aliasCount: number;
  deliveryLogCount: number;
  billingEventCount: number;
}

/**
 * Counts what `deleteUserCompletely` would remove. Used to show the user a
 * preview before they confirm.
 */
export async function getUserDeletionSummary(db: Db, userId: bigint): Promise<UserDeletionSummary> {
  const [aliasRow] = await db
    .select({ c: count() })
    .from(emailAddresses)
    .where(eq(emailAddresses.createdBy, userId));
  const [deliveryRow] = await db
    .select({ c: count() })
    .from(deliveryLogs)
    .where(eq(deliveryLogs.userId, userId));
  const [billingRow] = await db
    .select({ c: count() })
    .from(manualBillingEvents)
    .where(eq(manualBillingEvents.telegramUserId, userId));
  return {
    aliasCount: Number(aliasRow?.c ?? 0),
    deliveryLogCount: Number(deliveryRow?.c ?? 0),
    billingEventCount: Number(billingRow?.c ?? 0),
  };
}

/**
 * True iff the user has any Stripe billing linkage that would be orphaned by
 * deleting the user row. Deletion must be refused until the user clears this
 * state via /portal — otherwise later Stripe webhook events arrive with no
 * matching user/customer/subscription row.
 *
 * We block on EITHER a customer id or a subscription id whose status is not
 * terminal. A customer id with status=free is still blocked: checkout creation
 * stores stripeCustomerId before Stripe returns a subscription/webhook, so that
 * state can represent an open checkout session.
 */
export function hasLivePaidSubscription(user: User): boolean {
  const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);
  const isNonTerminal = !TERMINAL_STATUSES.has(user.subscriptionStatus);
  const hasStripeLink = user.stripeCustomerId != null || user.stripeSubscriptionId != null;
  return hasStripeLink && isNonTerminal;
}
