import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { findUserById } from "../db/repos/users.js";
import {
  claimQuotaNotification,
  type QuotaNotificationReason,
} from "../db/repos/quotaNotifications.js";
import { getEffectivePlan, shouldEnforceHostedLimits } from "./limits.js";
import { DEFAULT_LOCALE, getMessages, normalizeLocale } from "../i18n/index.js";
import { getLogger } from "../utils/logger.js";
import { loadConfig } from "../config.js";
import { escapeHtml } from "../utils/html.js";
import type { Messages } from "../i18n/index.js";
import { resolveSupportContact } from "./selfServe.js";

type Db = NodePgDatabase<typeof schema>;

const NOTIFIABLE_REASONS: ReadonlySet<string> = new Set([
  "monthly_email_limit",
  "storage_limit",
  "subscription_inactive",
] satisfies QuotaNotificationReason[]);

/** Fraction of the monthly email limit at which the early warning fires. */
export const APPROACHING_LIMIT_THRESHOLD = 0.8;

/**
 * The "how to get more" line of every quota notice. In donation mode plans are
 * not sold (donations are gifts, the legal basis of the model), so the notice
 * names the operator contact directly instead of pointing at /upgrade.
 */
function higherLimitsLine(messages: Messages): string {
  const config = loadConfig();
  return config.billingProvider === "donation"
    ? messages.quotaNotice.higherLimitsContact(escapeHtml(resolveSupportContact(config)))
    : messages.quotaNotice.higherLimitsUpgrade;
}

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
 * double-send. There is deliberately no follow-up reminder while a cap stays
 * exhausted: weekly "still capped" nags were judged too noisy (2026-09-22).
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

    if (!(await claimQuotaNotification(db, userId, reason, month))) return;

    const user = await findUserById(db, userId);
    if (!user) return;

    const plan = getEffectivePlan(user);
    const messages = getMessages(normalizeLocale(user.locale) ?? DEFAULT_LOCALE);
    const text =
      reason === "monthly_email_limit"
        ? messages.quotaNotice.monthlyEmailLimit(
            plan.name,
            plan.limits.deliveredEmailsMonth,
            higherLimitsLine(messages),
          )
        : reason === "storage_limit"
          ? messages.quotaNotice.storageLimit(plan.name, higherLimitsLine(messages))
          : messages.quotaNotice.subscriptionInactive();

    await api.sendMessage(userId.toString(), text, { parse_mode: "HTML" });
    getLogger().info({ userId: userId.toString(), reason, month }, "quota.notice.sent");
  } catch (err: unknown) {
    getLogger().warn({ err, userId: userId.toString(), reason }, "quota.notice.failed");
  }
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
      messages.quotaNotice.approachingMonthlyLimit(
        plan.name,
        used,
        limit,
        higherLimitsLine(messages),
      ),
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
