import { createHash } from "crypto";
import type { ManualGrantSummary } from "./manual.js";

/**
 * Identifies who performed a manual billing operation.
 *
 * - `"cli"` — Docker-run CLI command (current startup operations)
 * - `"admin:<fingerprint>"` — admin web UI; fingerprint is a stable truncated
 *   SHA-256 of the configured ADMIN_SECRET so it is consistent across restarts
 *   without storing the raw secret anywhere.
 */
export type OperatorSource = "cli" | `admin:${string}`;

/**
 * Derives a stable, non-reversible operator fingerprint from the admin secret.
 * Returns the first 16 hex chars of SHA-256(secret) — enough to distinguish
 * operators in logs without revealing the secret.
 */
export function adminOperatorSource(adminSecret: string): OperatorSource {
  const hash = createHash("sha256").update(adminSecret).digest("hex").slice(0, 16);
  return `admin:${hash}`;
}

export interface RedactedBillingLog {
  organizationId: string;
  telegramUserId: string | null;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: string | null;
  paymentReferencePresent: boolean;
  notePresent: boolean;
  keptStripeLink: boolean;
  manualBillingEventId: string;
  operatorSource: string;
}

/**
 * Strips payment_reference and note CONTENT before logging because log
 * aggregation pipelines may retain data subject to erasure requests.
 * Replaces sensitive fields with boolean presence flags so operators can
 * still verify whether values were supplied.
 */
export function redactManualBillingForLog(
  summary: ManualGrantSummary & { operatorSource?: string },
): RedactedBillingLog {
  return {
    organizationId: summary.organizationId,
    telegramUserId: summary.telegramUserId,
    planCode: summary.planCode,
    subscriptionStatus: summary.subscriptionStatus,
    paidThroughAt: summary.paidThroughAt,
    paymentReferencePresent: summary.paymentReference != null && summary.paymentReference !== "",
    notePresent: summary.note != null && summary.note !== "",
    keptStripeLink: summary.keptStripeLink,
    manualBillingEventId: summary.manualBillingEventId,
    operatorSource: summary.operatorSource ?? "cli",
  };
}
