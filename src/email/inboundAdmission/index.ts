/**
 * Inbound admission: may this mail be accepted for this alias.
 *
 * Three stages decide it, each in its own check order: preflight (before the
 * Worker reads the message), the raw precheck (before the raw route stores
 * it) and the queue (live and recovery, under the owner and alias locks).
 * What each rejection reason means for HTTP, stored files and quota
 * accounting lives in the policy table.
 */
export {
  REJECTION_POLICY,
  UNKNOWN_REJECTION_POLICY,
  isQuotaRejection,
  rejectionPolicy,
  type QueueRejectionReason,
  type RejectionPolicy,
} from "./policy.js";
export { settlePlanLimitRejection } from "./checks.js";
export {
  admitPreflight,
  admitRawPrecheck,
  type PlanLimitRejection,
  type PreflightVerdict,
  type RawPrecheckVerdict,
} from "./stages.js";
export { queueInboundEmail } from "./queue.js";
