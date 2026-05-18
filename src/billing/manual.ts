import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  findOrCreateUserById,
  findUserByIdForUpdate,
  updateUserBillingState,
} from "../db/repos/users.js";
import {
  findManualBillingEventByUserAndPaymentReference,
  findOrCreateManualBillingEvent,
  type ManualBillingEventInput,
} from "../db/repos/manualBillingEvents.js";
import type { PlanCode } from "./plans.js";
import type { OperatorSource } from "./audit.js";
import type * as schema from "../db/schema.js";
import { recordManualPlanGrant } from "../observability/metrics.js";

type Db = NodePgDatabase<typeof schema>;

export type ManualSubscriptionStatus = "free" | "active" | "canceled";

const MANUAL_PLAN_CODES: readonly PlanCode[] = ["free", "personal", "pro", "team", "business"];
const MANUAL_STATUSES: readonly ManualSubscriptionStatus[] = ["free", "active", "canceled"];

export interface ManualPlanGrantInput {
  planCode: PlanCode;
  subscriptionStatus: ManualSubscriptionStatus;
  paidThroughAt: Date | null;
  paymentReference: string;
  note: string | null;
  keptStripeLink: boolean;
  operatorSource: OperatorSource;
}

export interface GrantManualUserPlanInput extends ManualPlanGrantInput {
  telegramUserId: bigint;
  expectedUpdatedAt?: string | null;
}

export type ManualGrantErrorCode =
  | "user_not_found"
  | "invalid_plan"
  | "invalid_status"
  | "free_status_required"
  | "paid_through_required"
  | "keep_stripe_link_not_allowed"
  | "free_status_not_allowed_for_paid_plan"
  | "concurrent_update"
  | "payment_reference_required"
  | "payment_reference_conflict"
  | "payment_reference_too_long"
  | "note_too_long"
  | "paid_through_not_allowed"
  | "canceled_not_allowed_for_business";

export interface ManualGrantSummary {
  telegramUserId: string;
  planCode: PlanCode;
  subscriptionStatus: ManualSubscriptionStatus;
  paidThroughAt: string | null;
  paymentReference: string | null;
  note: string | null;
  keptStripeLink: boolean;
  manualBillingEventId: string;
  operatorSource: string;
}

export type GrantManualUserPlanResult =
  | ({ ok: true; idempotent: false; updated: true } & ManualGrantSummary)
  | ({ ok: true; idempotent: true; updated: false; reconciled: boolean } & ManualGrantSummary)
  | { ok: false; code: ManualGrantErrorCode };

function normalizePlanInput<T extends ManualPlanGrantInput>(input: T): T {
  return {
    ...input,
    paymentReference: input.paymentReference.trim(),
    note: input.note != null ? input.note.trim() || null : null,
  };
}

function validatePlanInput(
  input: ManualPlanGrantInput,
): { ok: true } | { ok: false; code: ManualGrantErrorCode } {
  if (!MANUAL_PLAN_CODES.includes(input.planCode)) {
    return { ok: false, code: "invalid_plan" };
  }
  if (!MANUAL_STATUSES.includes(input.subscriptionStatus)) {
    return { ok: false, code: "invalid_status" };
  }
  if (input.planCode === "free" && input.subscriptionStatus !== "free") {
    return { ok: false, code: "free_status_required" };
  }
  if (input.planCode !== "free" && input.subscriptionStatus === "free") {
    return { ok: false, code: "free_status_not_allowed_for_paid_plan" };
  }
  if (input.keptStripeLink && input.planCode !== "business") {
    return { ok: false, code: "keep_stripe_link_not_allowed" };
  }
  const isPaidPlan =
    input.planCode === "personal" || input.planCode === "pro" || input.planCode === "team";
  if (isPaidPlan && input.subscriptionStatus === "active" && input.paidThroughAt == null) {
    return { ok: false, code: "paid_through_required" };
  }
  if (input.subscriptionStatus === "canceled" && input.paidThroughAt != null) {
    return { ok: false, code: "paid_through_not_allowed" };
  }
  if (input.planCode === "business" && input.subscriptionStatus === "canceled") {
    return { ok: false, code: "canceled_not_allowed_for_business" };
  }
  if (!input.paymentReference) {
    return { ok: false, code: "payment_reference_required" };
  }
  if (input.paymentReference.length > 255) {
    return { ok: false, code: "payment_reference_too_long" };
  }
  if (input.note !== null && input.note.length > 1000) {
    return { ok: false, code: "note_too_long" };
  }
  return { ok: true };
}

function buildBillingPatch(input: ManualPlanGrantInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    planCode: input.planCode,
    subscriptionStatus: input.subscriptionStatus,
    paidThroughAt: input.paidThroughAt,
  };
  if (!input.keptStripeLink) {
    patch.stripeCustomerId = null;
    patch.stripeSubscriptionId = null;
    patch.trialEndsAt = null;
    patch.currentPeriodStart = null;
    patch.currentPeriodEnd = null;
  }
  return patch;
}

function buildEventInput(
  input: ManualPlanGrantInput,
  telegramUserId: bigint,
): ManualBillingEventInput & { paymentReference: string } {
  return {
    telegramUserId,
    planCode: input.planCode,
    subscriptionStatus: input.subscriptionStatus,
    paidThroughAt: input.paidThroughAt,
    paymentReference: input.paymentReference,
    note: input.note,
    keptStripeLink: input.keptStripeLink,
    operatorSource: input.operatorSource,
  };
}

function summarize(
  input: ManualPlanGrantInput,
  telegramUserId: bigint,
  manualBillingEventId: string,
): ManualGrantSummary {
  return {
    telegramUserId: telegramUserId.toString(),
    planCode: input.planCode,
    subscriptionStatus: input.subscriptionStatus,
    paidThroughAt: input.paidThroughAt ? input.paidThroughAt.toISOString() : null,
    paymentReference: input.paymentReference,
    note: input.note,
    keptStripeLink: input.keptStripeLink,
    manualBillingEventId,
    operatorSource: input.operatorSource,
  };
}

function summarizeEvent(event: {
  id: string;
  telegramUserId: bigint;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: Date | null;
  paymentReference: string | null;
  note: string | null;
  keptStripeLink: boolean;
  operatorSource?: string | null;
}): ManualGrantSummary {
  return {
    telegramUserId: event.telegramUserId.toString(),
    planCode: event.planCode as PlanCode,
    subscriptionStatus: event.subscriptionStatus as ManualSubscriptionStatus,
    paidThroughAt: event.paidThroughAt ? event.paidThroughAt.toISOString() : null,
    paymentReference: event.paymentReference,
    note: event.note,
    keptStripeLink: event.keptStripeLink,
    manualBillingEventId: event.id,
    operatorSource: event.operatorSource ?? "cli",
  };
}

function payloadMatchesEvent(
  event: {
    planCode: string;
    subscriptionStatus: string;
    paidThroughAt: Date | null;
    keptStripeLink: boolean;
    note: string | null;
  },
  input: ManualPlanGrantInput,
): boolean {
  return (
    event.planCode === input.planCode &&
    event.subscriptionStatus === input.subscriptionStatus &&
    (event.paidThroughAt?.getTime() ?? null) === (input.paidThroughAt?.getTime() ?? null) &&
    event.keptStripeLink === input.keptStripeLink &&
    event.note === input.note
  );
}

function userMatchesStoredEvent(
  user: {
    planCode: string;
    subscriptionStatus: string;
    paidThroughAt: Date | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    trialEndsAt: Date | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
  },
  event: {
    planCode: string;
    subscriptionStatus: string;
    paidThroughAt: Date | null;
    keptStripeLink: boolean;
  },
): boolean {
  if (user.planCode !== event.planCode) return false;
  if (user.subscriptionStatus !== event.subscriptionStatus) return false;
  if ((user.paidThroughAt?.getTime() ?? null) !== (event.paidThroughAt?.getTime() ?? null))
    return false;
  if (!event.keptStripeLink) {
    if (user.stripeCustomerId !== null || user.stripeSubscriptionId !== null) return false;
    if (
      user.trialEndsAt !== null ||
      user.currentPeriodStart !== null ||
      user.currentPeriodEnd !== null
    )
      return false;
  }
  return true;
}

class ConcurrentUpdateSignal extends Error {}

export async function grantManualUserPlan(
  db: Db,
  rawInput: GrantManualUserPlanInput,
): Promise<GrantManualUserPlanResult> {
  const input = normalizePlanInput(rawInput);
  const validation = validatePlanInput(input);
  if (!validation.ok) return validation;

  try {
    return await db.transaction(async (tx) => {
      await findOrCreateUserById(tx, input.telegramUserId);
      // Serialize concurrent grants for the same user via bigint advisory lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.telegramUserId})`);

      const user = await findUserByIdForUpdate(tx, input.telegramUserId);
      if (!user) return { ok: false, code: "user_not_found" };

      // Idempotency check before any write so a retry never duplicates.
      const existingEvent = await findManualBillingEventByUserAndPaymentReference(
        tx,
        input.telegramUserId,
        input.paymentReference,
      );
      if (existingEvent) {
        if (!payloadMatchesEvent(existingEvent, input)) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        let reconciled = false;
        if (!userMatchesStoredEvent(user, existingEvent)) {
          await updateUserBillingState(tx, input.telegramUserId, buildBillingPatch(input));
          reconciled = true;
        }
        return {
          ok: true,
          idempotent: true,
          updated: false,
          reconciled,
          ...summarizeEvent(existingEvent),
        };
      }

      // Atomic insert-or-find: race-safe via unique partial index.
      const { event, created } = await findOrCreateManualBillingEvent(
        tx,
        buildEventInput(input, input.telegramUserId),
      );
      if (!created) {
        // Conflict path: returned event belongs to a different user (global
        // payment_reference uniqueness).
        if (event.telegramUserId !== input.telegramUserId) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        if (!payloadMatchesEvent(event, input)) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        let reconciled = false;
        if (!userMatchesStoredEvent(user, event)) {
          await updateUserBillingState(tx, input.telegramUserId, buildBillingPatch(input));
          reconciled = true;
        }
        return {
          ok: true,
          idempotent: true,
          updated: false,
          reconciled,
          ...summarizeEvent(event),
        };
      }

      // New event just inserted — version check now. Throw to roll back the
      // insert if the page is stale (no orphaned event left behind).
      if (
        input.expectedUpdatedAt != null &&
        user.updatedAt.toISOString() !== input.expectedUpdatedAt
      ) {
        throw new ConcurrentUpdateSignal();
      }
      await updateUserBillingState(tx, input.telegramUserId, buildBillingPatch(input));
      const summary = summarize(input, input.telegramUserId, event.id);
      recordManualPlanGrant(input.planCode);
      return { ok: true, idempotent: false, updated: true, ...summary };
    });
  } catch (err) {
    if (err instanceof ConcurrentUpdateSignal) {
      return { ok: false, code: "concurrent_update" };
    }
    throw err;
  }
}
