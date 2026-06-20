/**
 * In-memory inbound-health tracking for the worker → app delivery path.
 *
 * Motivation: a v1.2.0 security change made `/inbound/raw` reject every
 * non-v2 worker signature, but the deployed Cloudflare Worker was still on
 * v1. Inbound email was 100% down for ~9 days with no alert, because the app
 * process itself stayed perfectly healthy. This module gives the uptime check
 * a signal for "the app is up but no mail can get in".
 */

/**
 * Rejection reasons a correctly configured Worker never produces. Sustained
 * occurrences mean the worker↔app signature contract is broken (wrong version,
 * wrong secret, or replay) — inbound is effectively down.
 *
 * Deliberately excludes:
 *  - per-message rejections a healthy worker legitimately forwards
 *    (`alias_not_found`, `sender_not_allowed`, `rate_limited`, quota codes,
 *    `hosted_blocklist`), and
 *  - `missing_signature` / `empty_body`, which unauthenticated internet
 *    scanners hitting the public endpoint trigger without our worker.
 */
const WORKER_CONTRACT_FAILURE_REASONS = new Set<string>([
  "unsupported_signature_version",
  "invalid_signature",
  "replayed_signature",
]);

let lastAcceptedAtMs: number | null = null;
let lastContractFailureAtMs: number | null = null;

/** Feed every raw-inbound decision in so stall detection can reason over it. */
export function noteRawInboundOutcome(
  result: "accepted" | "rejected",
  reason: string,
  nowMs: number = Date.now(),
): void {
  if (result === "accepted") {
    lastAcceptedAtMs = nowMs;
  } else if (WORKER_CONTRACT_FAILURE_REASONS.has(reason)) {
    lastContractFailureAtMs = nowMs;
  }
}

export interface InboundStallStatus {
  stalled: boolean;
  lastAcceptedAtMs: number | null;
  lastContractFailureAtMs: number | null;
}

/**
 * Inbound is "stalled" when the worker contract has failed within `windowMs`
 * and no inbound email has been accepted within the same window.
 *
 * Because contract failures are zero in normal operation, this stays quiet on
 * genuinely idle or low-volume mailboxes (no failures → no stall) and does not
 * fire while mail is flowing (a recent accept clears it).
 */
export function evaluateInboundStall(
  windowMs: number,
  nowMs: number = Date.now(),
): InboundStallStatus {
  const failureRecent =
    lastContractFailureAtMs !== null && nowMs - lastContractFailureAtMs <= windowMs;
  const acceptRecent = lastAcceptedAtMs !== null && nowMs - lastAcceptedAtMs <= windowMs;
  return {
    stalled: failureRecent && !acceptRecent,
    lastAcceptedAtMs,
    lastContractFailureAtMs,
  };
}

export function resetInboundHealthForTests(): void {
  lastAcceptedAtMs = null;
  lastContractFailureAtMs = null;
}
