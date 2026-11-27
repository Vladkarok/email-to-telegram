/**
 * What an inbound rejection reason means, in one table.
 *
 * Every reason the queue stage can reject with has exactly one row; the raw
 * route, raw recovery and the quota accounting all read their outcome from
 * here instead of keeping their own lists.
 */
import type { InboundLimitCode } from "../../billing/limits.js";
import type { QuotaNotificationReason } from "../../db/repos/quotaNotifications.js";
import type { AllowEvaluationReason } from "../allowRuleEvaluator.js";

/**
 * Every reason the queue stage (live and recovery) rejects a mail with. The
 * route stages refuse with a subset of these, plus the hosted blocklist,
 * which only runs before the mail is stored and so has no row here (see the
 * verdict types in stages.ts).
 */
export type QueueRejectionReason =
  | "alias_not_found"
  | InboundLimitCode
  | AllowEvaluationReason
  | "duplicate"
  | "rate_limited";

export interface RejectionPolicy {
  /**
   * The raw route's answer after the queue rejected the mail. 202 answers
   * with the accepted body, so the Worker neither bounces nor retries.
   */
  rawStatus: 202 | 403 | 413 | 503;
  /** The live raw route deletes the stored .eml and its pending metadata. */
  deleteLive: boolean;
  /** Raw recovery deletes the stored .eml and its pending metadata. */
  deleteInRecovery: boolean;
  /**
   * Counts in the owner's rejectedCount and earns a live exhaustion notice.
   * Persistent, user-actionable rejections only: per-message conditions
   * (size, rate, duplicates) would be spam.
   */
  quota: boolean;
}

// The mapped type forces a decision for every reason, and keeps `quota` false
// for any reason notifyQuotaExhausted has no copy for.
type RejectionPolicyTable = {
  readonly [R in QueueRejectionReason]: Readonly<
    RejectionPolicy & { quota: R extends QuotaNotificationReason ? boolean : false }
  >;
};

export const REJECTION_POLICY: RejectionPolicyTable = {
  subscription_inactive: { rawStatus: 403, deleteLive: true, deleteInRecovery: true, quota: true },
  monthly_email_limit: { rawStatus: 403, deleteLive: true, deleteInRecovery: true, quota: true },
  storage_limit: { rawStatus: 403, deleteLive: true, deleteInRecovery: true, quota: true },
  message_size_limit: { rawStatus: 413, deleteLive: true, deleteInRecovery: true, quota: false },
  // Both sender rejections answer alike: a 202 here silently dropped the
  // mail, and a 202/403 split told a prober which From domains are allowed.
  sender_not_allowed: { rawStatus: 403, deleteLive: true, deleteInRecovery: true, quota: false },
  sender_auth_failed: { rawStatus: 403, deleteLive: true, deleteInRecovery: true, quota: false },
  // Live: 503 hands the retry to the sending server, so the local copy goes.
  // Recovery keeps its copy for a later cycle: the sender was already
  // answered 202 (or the request died), so no one else may retry it; a copy
  // that does arrive again is dropped by its Message-ID.
  sender_auth_temperror: {
    rawStatus: 503,
    deleteLive: true,
    deleteInRecovery: false,
    quota: false,
  },
  // The alias vanished between the route's lookup and the queue's: acknowledged
  // like a delivery so the sender does not learn it, and nothing is kept.
  alias_not_found: { rawStatus: 202, deleteLive: true, deleteInRecovery: true, quota: false },
  duplicate: { rawStatus: 202, deleteLive: true, deleteInRecovery: true, quota: false },
  // Over the hourly cap at queue time the mail is acknowledged and kept, so
  // raw recovery queues it once the sliding hour frees a slot.
  rate_limited: { rawStatus: 202, deleteLive: false, deleteInRecovery: false, quota: false },
};

/** A reason the table does not know (or none) keeps the mail for recovery. */
export const UNKNOWN_REJECTION_POLICY: Readonly<RejectionPolicy> = {
  rawStatus: 202,
  deleteLive: false,
  deleteInRecovery: false,
  quota: false,
};

function isQueueRejectionReason(reason: string): reason is QueueRejectionReason {
  return Object.hasOwn(REJECTION_POLICY, reason);
}

export function rejectionPolicy(reason: string | undefined): Readonly<RejectionPolicy> {
  if (reason === undefined || !isQueueRejectionReason(reason)) return UNKNOWN_REJECTION_POLICY;
  return REJECTION_POLICY[reason];
}

export function isQuotaRejection(reason: string | undefined): reason is QuotaNotificationReason {
  return rejectionPolicy(reason).quota;
}
