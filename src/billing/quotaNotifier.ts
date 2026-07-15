import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { findUserById } from "../db/repos/users.js";
import {
  claimQuotaNotification,
  quotaWeekForDate,
  type QuotaNotificationReason,
} from "../db/repos/quotaNotifications.js";
import { getUserUsageMonth } from "../db/repos/usage.js";
import { getEffectivePlan, shouldEnforceHostedLimits } from "./limits.js";
import { DEFAULT_LOCALE, getMessages, normalizeLocale } from "../i18n/index.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

const NOTIFIABLE_REASONS: ReadonlySet<string> = new Set([
  "monthly_email_limit",
  "storage_limit",
  "subscription_inactive",
] satisfies QuotaNotificationReason[]);

/** Fraction of the monthly email limit at which the early warning fires. */
export const APPROACHING_LIMIT_THRESHOLD = 0.8;

/**
 * Persistent, user-actionable rejections get a notice; per-message conditions
 * (size limit, rate limit, duplicates) do not — they would be spam.
 */
export function isQuotaNotificationReason(reason: string): reason is QuotaNotificationReason {
  return NOTIFIABLE_REASONS.has(reason);
}

/**
 * Tells the alias owner (private chat) that inbound mail is bouncing because a
 * quota is exhausted. At most one notice per user, per reason, per month —
 * enforced by the claim row's primary key, so concurrent rejections cannot
 * double-send.
 *
 * While the monthly email cap stays exhausted, later rejections fall through
 * to a weekly reminder ("N emails were rejected this month") — at most one per
 * ISO week, and never in the same week the exhaustion notice itself went out.
 *
 * Never throws: inbound handling must not depend on Telegram availability.
 * If the send fails after the claim was won, the notice is lost for the rest
 * of the period — deliberate: releasing the claim on failure would hammer the
 * Telegram API once per rejected email for users who blocked the bot.
 */
export async function notifyQuotaExhausted(
  db: Db,
  api: Api | null,
  userId: bigint,
  reason: QuotaNotificationReason,
  // The caller passes the month of the rejection decision so a request that
  // straddles the UTC month boundary cannot claim (and burn) the fresh
  // month's notification slot.
  month: string,
): Promise<void> {
  try {
    if (!api) return;

    const claimed =
      reason === "monthly_email_limit"
        ? await claimMonthlyWithWeekSuppression(db, userId, month)
        : await claimQuotaNotification(db, userId, reason, month);
    if (!claimed) {
      if (reason === "monthly_email_limit") {
        await sendCappedReminder(db, api, userId, month);
      }
      return;
    }

    const user = await findUserById(db, userId);
    if (!user) return;

    const plan = getEffectivePlan(user);
    const messages = getMessages(normalizeLocale(user.locale) ?? DEFAULT_LOCALE);
    const text =
      reason === "monthly_email_limit"
        ? messages.quotaNotice.monthlyEmailLimit(plan.name, plan.limits.deliveredEmailsMonth)
        : reason === "storage_limit"
          ? messages.quotaNotice.storageLimit(plan.name)
          : messages.quotaNotice.subscriptionInactive();

    await api.sendMessage(userId.toString(), text, { parse_mode: "HTML" });
    getLogger().info({ userId: userId.toString(), reason, month }, "quota.notice.sent");
  } catch (err: unknown) {
    getLogger().warn({ err, userId: userId.toString(), reason }, "quota.notice.failed");
  }
}

/**
 * Wins the monthly exhaustion claim and, in the same transaction, pre-claims
 * the current ISO week. Atomicity matters: with two separate inserts, a
 * concurrent rejection that loses the month claim could win the week claim
 * in the gap and send the "still capped" reminder right next to the
 * exhaustion notice itself. Inside one transaction the loser's conflicting
 * month insert waits for this commit, by which time the week is taken.
 */
async function claimMonthlyWithWeekSuppression(
  db: Db,
  userId: bigint,
  month: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const txDb = tx as Db;
    if (!(await claimQuotaNotification(txDb, userId, "monthly_email_limit", month))) {
      return false;
    }
    await claimQuotaNotification(txDb, userId, "monthly_email_limit_reminder", quotaWeekForDate());
    return true;
  });
}

/**
 * Weekly "still capped, you are losing mail" reminder. Runs only when the
 * month's exhaustion notice was already sent. The rejected count comes from
 * user_usage_months.rejected_count, which the ingress paths increment before
 * calling the notifier — so the current rejection is already included.
 * The count tallies bounce events: sender-side retries (and rare Worker
 * retries) each count. That is deliberate — every event is a real bounce —
 * so it is not a count of distinct messages.
 */
async function sendCappedReminder(db: Db, api: Api, userId: bigint, month: string): Promise<void> {
  if (
    !(await claimQuotaNotification(db, userId, "monthly_email_limit_reminder", quotaWeekForDate()))
  ) {
    return;
  }

  const user = await findUserById(db, userId);
  if (!user) return;

  const usage = await getUserUsageMonth(db, userId, month);
  const rejectedCount = usage?.rejectedCount ?? 0;
  if (rejectedCount <= 0) return;

  const messages = getMessages(normalizeLocale(user.locale) ?? DEFAULT_LOCALE);
  await api.sendMessage(
    userId.toString(),
    messages.quotaNotice.monthlyLimitReminder(rejectedCount),
    { parse_mode: "HTML" },
  );
  getLogger().info(
    { userId: userId.toString(), reason: "monthly_email_limit_reminder", month },
    "quota.notice.sent",
  );
}

/**
 * Early warning when an accepted email pushes the user into the top band of
 * the monthly limit (>= 80%, still under 100%). At most one per user per
 * month, claim-gated like the exhaustion notices. Fire-and-forget: never
 * throws, hosted mode only.
 *
 * `deliveredCount` is the post-increment count captured inside the locked
 * queue transaction. It must be passed, not re-read here: a fast burst can
 * drive usage from below 80% to the cap before any fire-and-forget re-read
 * runs, and every re-read would then see >= 100% and skip the warning.
 */
export async function notifyApproachingMonthlyLimit(
  db: Db,
  api: Api | null,
  userId: bigint,
  month: string,
  deliveredCount: number,
): Promise<void> {
  try {
    if (!api || !shouldEnforceHostedLimits()) return;

    const user = await findUserById(db, userId);
    if (!user) return;

    const plan = getEffectivePlan(user);
    const limit = plan.limits.deliveredEmailsMonth;
    const used = deliveredCount;
    const threshold = Math.ceil(limit * APPROACHING_LIMIT_THRESHOLD);
    if (used < threshold || used >= limit) return;

    if (!(await claimQuotaNotification(db, userId, "approaching_monthly_limit", month))) return;

    const messages = getMessages(normalizeLocale(user.locale) ?? DEFAULT_LOCALE);
    await api.sendMessage(
      userId.toString(),
      messages.quotaNotice.approachingMonthlyLimit(plan.name, used, limit),
      { parse_mode: "HTML" },
    );
    getLogger().info(
      { userId: userId.toString(), reason: "approaching_monthly_limit", month, used, limit },
      "quota.notice.sent",
    );
  } catch (err: unknown) {
    getLogger().warn(
      { err, userId: userId.toString(), reason: "approaching_monthly_limit" },
      "quota.notice.failed",
    );
  }
}
