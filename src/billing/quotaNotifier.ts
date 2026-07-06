import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { findUserById } from "../db/repos/users.js";
import {
  claimQuotaNotification,
  type QuotaNotificationReason,
} from "../db/repos/quotaNotifications.js";
import { getEffectivePlan } from "./limits.js";
import { DEFAULT_LOCALE, getMessages, normalizeLocale } from "../i18n/index.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

const NOTIFIABLE_REASONS: ReadonlySet<string> = new Set([
  "monthly_email_limit",
  "storage_limit",
  "subscription_inactive",
] satisfies QuotaNotificationReason[]);

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
 * Never throws: inbound handling must not depend on Telegram availability.
 * If the send fails after the claim was won, the notice is lost for the rest
 * of the month — deliberate: releasing the claim on failure would hammer the
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
