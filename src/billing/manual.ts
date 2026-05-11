import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  createOrganization,
  findOrganizationById,
  findOrganizationByIdForUpdate,
  updateOrganizationBillingState,
} from "../db/repos/organizations.js";
import { findOrCreateUserById } from "../db/repos/users.js";
import {
  addOrganizationMember,
  listOrganizationMembershipsForUser,
  userHasOrganizationRole,
  type OrganizationRole,
} from "../db/repos/organizationMembers.js";
import {
  findManualBillingEventByUserAndPaymentReference,
  findOrCreateManualBillingEvent,
  type ManualBillingEventInput,
} from "../db/repos/manualBillingEvents.js";
import type { PlanCode } from "./plans.js";
import type { OperatorSource } from "./audit.js";
import type * as schema from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

export type ManualSubscriptionStatus = "free" | "active" | "canceled";

const MANUAL_PLAN_CODES: readonly PlanCode[] = ["free", "personal", "pro", "team", "business"];
const MANUAL_STATUSES: readonly ManualSubscriptionStatus[] = ["free", "active", "canceled"];
const MANUAL_ROLES: readonly OrganizationRole[] = ["owner", "admin", "member"];
const PRIVILEGED_ROLES: readonly OrganizationRole[] = ["owner", "admin"];
const PRIVILEGED_ROLE_SET: ReadonlySet<string> = new Set(PRIVILEGED_ROLES);

export interface ManualPlanGrantInput {
  planCode: PlanCode;
  subscriptionStatus: ManualSubscriptionStatus;
  paidThroughAt: Date | null;
  paymentReference: string;
  note: string | null;
  keptStripeLink: boolean;
  operatorSource: OperatorSource;
}

export interface GrantManualOrganizationPlanInput extends ManualPlanGrantInput {
  organizationId: string;
  telegramUserId?: bigint | null;
  expectedUpdatedAt?: string | null;
}

export interface GrantManualUserPlanInput extends ManualPlanGrantInput {
  telegramUserId: bigint;
  organizationId: string | null;
  createNewOrganization: boolean;
}

export interface AddManualOrganizationMemberInput {
  organizationId: string;
  telegramUserId: bigint;
  role: OrganizationRole;
}

export type ManualGrantErrorCode =
  | "organization_not_found"
  | "invalid_plan"
  | "invalid_status"
  | "invalid_role"
  | "free_status_required"
  | "paid_through_required"
  | "keep_stripe_link_not_allowed"
  | "ambiguous_organization"
  | "member_only_memberships"
  | "user_not_in_organization"
  | "free_status_not_allowed_for_paid_plan"
  | "concurrent_update"
  | "payment_reference_required"
  | "payment_reference_conflict"
  | "payment_reference_too_long"
  | "note_too_long"
  | "paid_through_not_allowed"
  | "canceled_not_allowed_for_business";

export interface ManualGrantSummary {
  organizationId: string;
  telegramUserId: string | null;
  planCode: PlanCode;
  subscriptionStatus: ManualSubscriptionStatus;
  paidThroughAt: string | null;
  paymentReference: string | null;
  note: string | null;
  keptStripeLink: boolean;
  manualBillingEventId: string;
  operatorSource: string;
}

export type GrantManualOrganizationPlanResult =
  | ({ ok: true; idempotent: false; updated: true } & ManualGrantSummary)
  | ({ ok: true; idempotent: true; updated: false } & ManualGrantSummary)
  | { ok: false; code: ManualGrantErrorCode };

export type GrantManualUserPlanResult =
  | ({
      ok: true;
      idempotent: false;
      updated: true;
      createdOrganization: boolean;
    } & ManualGrantSummary)
  | ({
      ok: true;
      idempotent: true;
      updated: false;
      createdOrganization: boolean;
    } & ManualGrantSummary)
  | { ok: false; code: ManualGrantErrorCode; organizationIds?: string[] };

export type AddManualOrganizationMemberResult =
  | { ok: true; organizationId: string; telegramUserId: string; role: OrganizationRole }
  | { ok: false; code: ManualGrantErrorCode };

// Trim paymentReference and note so all callers share the same idempotency key semantics.
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
    // --keep-stripe-link is allowed only with --plan business; webhook
    // overwrite protection only exists for business plans.
    return { ok: false, code: "keep_stripe_link_not_allowed" };
  }
  const isPaidPlan =
    input.planCode === "personal" || input.planCode === "pro" || input.planCode === "team";
  if (isPaidPlan && input.subscriptionStatus === "active" && input.paidThroughAt == null) {
    return { ok: false, code: "paid_through_required" };
  }
  if (input.subscriptionStatus === "canceled" && input.paidThroughAt != null) {
    // Runtime enforcement treats canceled as free immediately regardless of paidThroughAt.
    // Storing a future paidThroughAt with canceled status would create a split-brain billing
    // state: the event records one date while plan enforcement ignores it.
    return { ok: false, code: "paid_through_not_allowed" };
  }
  if (input.planCode === "business" && input.subscriptionStatus === "canceled") {
    // The entitlement path does not check subscriptionStatus for business plans, so
    // storing business+canceled would leave business limits active despite the status.
    // Operators must downgrade to a lower plan code instead of canceling in-place.
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
  // Always clear Stripe IDs unless explicitly kept (validated to business-only above).
  if (!input.keptStripeLink) {
    patch.stripeCustomerId = null;
    patch.stripeSubscriptionId = null;
  }
  return patch;
}

function buildEventInput(
  input: ManualPlanGrantInput,
  organizationId: string,
  telegramUserId: bigint | null,
): ManualBillingEventInput & { paymentReference: string } {
  return {
    organizationId,
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
  organizationId: string,
  telegramUserId: bigint | null,
  manualBillingEventId: string,
): ManualGrantSummary {
  return {
    organizationId,
    telegramUserId: telegramUserId == null ? null : telegramUserId.toString(),
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
  organizationId: string;
  telegramUserId: bigint | null;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: Date | null;
  paymentReference: string | null;
  note: string | null;
  keptStripeLink: boolean;
  operatorSource?: string | null;
}): ManualGrantSummary {
  return {
    organizationId: event.organizationId,
    telegramUserId: event.telegramUserId == null ? null : event.telegramUserId.toString(),
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

// Thrown inside a transaction to force rollback; caught outside to return ok:false.
class ConcurrentUpdateSignal extends Error {}
// Thrown when a newly created org must be rolled back because a concurrent
// request won the billing-event insert race on (telegram_user_id, payment_reference).
class OrgCreationRaceSignal extends Error {}

export async function grantManualOrganizationPlan(
  db: Db,
  rawInput: GrantManualOrganizationPlanInput,
): Promise<GrantManualOrganizationPlanResult> {
  const input = normalizePlanInput(rawInput);
  const validation = validatePlanInput(input);
  if (!validation.ok) return validation;

  try {
    return await db.transaction(async (tx) => {
      // FOR UPDATE locks the row so no concurrent transaction can write to this
      // org between the version check and the billing write.
      const organization = await findOrganizationByIdForUpdate(tx, input.organizationId);
      if (!organization) return { ok: false, code: "organization_not_found" };

      const telegramUserId = input.telegramUserId ?? null;

      // Atomic insert-or-find: race-safe via unique partial index.
      // Idempotency result comes BEFORE the version check so a retry of an
      // already-applied write succeeds even when the caller's page is stale.
      const { event, created } = await findOrCreateManualBillingEvent(
        tx,
        buildEventInput(input, input.organizationId, telegramUserId),
      );
      if (!created) {
        // The secondary user+payref fallback in findOrCreateManualBillingEvent may
        // return an event from a different org. Guard against cross-org replays.
        if (event.organizationId !== input.organizationId) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        // If both the stored event and the new request carry a telegramUserId, they
        // must match — a different user re-using the same payref is a conflict.
        const inputUserId = telegramUserId;
        if (
          event.telegramUserId != null &&
          inputUserId != null &&
          event.telegramUserId !== inputUserId
        ) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        // A second submission with the same payment reference but different billing
        // fields is a correction attempt — reject rather than silently drop it.
        if (!payloadMatchesEvent(event, input)) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        return {
          ok: true,
          idempotent: true,
          updated: false,
          ...summarizeEvent(event),
        };
      }
      // New event just inserted — version check now. Throw to roll back the
      // insert if the page is stale (no orphaned event left behind).
      if (
        input.expectedUpdatedAt != null &&
        organization.updatedAt.toISOString() !== input.expectedUpdatedAt
      ) {
        throw new ConcurrentUpdateSignal();
      }
      await updateOrganizationBillingState(tx, input.organizationId, buildBillingPatch(input));
      const summary = summarize(input, input.organizationId, telegramUserId, event.id);
      return { ok: true, idempotent: false, updated: true, ...summary };
    });
  } catch (err) {
    if (err instanceof ConcurrentUpdateSignal) {
      return { ok: false, code: "concurrent_update" };
    }
    throw err;
  }
}

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
      // Serialize all grantManualUserPlan calls and normal personal-org auto-creation
      // for the same Telegram user. Uses the same hashtext key as ensurePersonalOrganizationForUser
      // so that concurrent normal onboarding and manual billing flows cannot both
      // observe memberships.length === 0 and each create a separate organization.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${input.telegramUserId.toString()}))`,
      );

      // Pre-check idempotency before org resolution so that a retry with the
      // same paymentReference never creates a second organization or billing event.
      // If the caller explicitly provides an organizationId that differs from the
      // existing event's org, it is a conflict — refuse rather than silently grant twice.
      const existingEvent = await findManualBillingEventByUserAndPaymentReference(
        tx,
        input.telegramUserId,
        input.paymentReference,
      );
      if (existingEvent) {
        if (input.organizationId && existingEvent.organizationId !== input.organizationId) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        if (!payloadMatchesEvent(existingEvent, input)) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        return {
          ok: true,
          idempotent: true,
          updated: false,
          createdOrganization: false,
          ...summarizeEvent(existingEvent),
        };
      }

      let resolvedOrganizationId: string | null;
      let createdOrganization = false;

      if (input.createNewOrganization) {
        const newOrg = await createOrganization(tx, {
          name: `Telegram ${input.telegramUserId.toString()}`,
        });
        await addOrganizationMember(tx, {
          organizationId: newOrg.id,
          userId: input.telegramUserId,
          role: "owner",
        });
        resolvedOrganizationId = newOrg.id;
        createdOrganization = true;
      } else if (input.organizationId) {
        const isPrivileged = await userHasOrganizationRole(
          tx,
          input.organizationId,
          input.telegramUserId,
          PRIVILEGED_ROLES,
        );
        if (!isPrivileged) return { ok: false, code: "user_not_in_organization" };
        resolvedOrganizationId = input.organizationId;
      } else {
        const memberships = await listOrganizationMembershipsForUser(tx, input.telegramUserId);
        if (memberships.length === 0) {
          const newOrg = await createOrganization(tx, {
            name: `Telegram ${input.telegramUserId.toString()}`,
          });
          await addOrganizationMember(tx, {
            organizationId: newOrg.id,
            userId: input.telegramUserId,
            role: "owner",
          });
          resolvedOrganizationId = newOrg.id;
          createdOrganization = true;
        } else {
          const privileged = memberships.filter((m) => PRIVILEGED_ROLE_SET.has(m.role));
          if (privileged.length === 0) {
            return { ok: false, code: "member_only_memberships" };
          }
          if (privileged.length > 1) {
            return {
              ok: false,
              code: "ambiguous_organization",
              organizationIds: privileged.map((m) => m.organizationId),
            };
          }
          resolvedOrganizationId = privileged[0].organizationId;
        }
      }

      const organization = await findOrganizationByIdForUpdate(tx, resolvedOrganizationId);
      if (!organization) return { ok: false, code: "organization_not_found" };

      const { event, created } = await findOrCreateManualBillingEvent(
        tx,
        buildEventInput(input, resolvedOrganizationId, input.telegramUserId),
      );
      if (!created) {
        if (createdOrganization) {
          // A concurrent request won the event race; throw to roll back this
          // transaction so the freshly created org is not left behind as an orphan.
          throw new OrgCreationRaceSignal();
        }
        // The secondary fallback in findOrCreateManualBillingEvent may return an event
        // from a different org (concurrent request on a different org won the user-scoped
        // unique index race). Mirror the pre-check conflict guard here.
        if (input.organizationId && event.organizationId !== input.organizationId) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        // A different user in the same org could have committed the same payref — their
        // event would be returned by the org-scoped fallback in findOrCreateManualBillingEvent.
        if (event.telegramUserId !== null && event.telegramUserId !== input.telegramUserId) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        if (!payloadMatchesEvent(event, input)) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        return {
          ok: true,
          idempotent: true,
          updated: false,
          createdOrganization,
          ...summarizeEvent(event),
        };
      }
      await updateOrganizationBillingState(tx, resolvedOrganizationId, buildBillingPatch(input));
      const summary = summarize(input, resolvedOrganizationId, input.telegramUserId, event.id);
      return { ok: true, idempotent: false, updated: true, createdOrganization, ...summary };
    });
  } catch (err) {
    if (err instanceof OrgCreationRaceSignal) {
      // Transaction rolled back — read the winning event from the committed tx.
      const canonical = await findManualBillingEventByUserAndPaymentReference(
        db,
        input.telegramUserId,
        input.paymentReference,
      );
      if (canonical) {
        // Apply the same conflict guards used in the normal !created path.
        if (input.organizationId && canonical.organizationId !== input.organizationId) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        if (
          canonical.telegramUserId !== null &&
          canonical.telegramUserId !== input.telegramUserId
        ) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        if (!payloadMatchesEvent(canonical, input)) {
          return { ok: false, code: "payment_reference_conflict" };
        }
        return {
          ok: true,
          idempotent: true,
          updated: false,
          createdOrganization: false,
          ...summarizeEvent(canonical),
        };
      }
      throw new Error("grantManualUserPlan: event race signal but no canonical event found", {
        cause: err,
      });
    }
    throw err;
  }
}

export async function addManualOrganizationMember(
  db: Db,
  input: AddManualOrganizationMemberInput,
): Promise<AddManualOrganizationMemberResult> {
  if (!MANUAL_ROLES.includes(input.role)) {
    return { ok: false, code: "invalid_role" };
  }

  return db.transaction(async (tx) => {
    const organization = await findOrganizationById(tx, input.organizationId);
    if (!organization) return { ok: false, code: "organization_not_found" };

    await findOrCreateUserById(tx, input.telegramUserId);
    await addOrganizationMember(tx, {
      organizationId: input.organizationId,
      userId: input.telegramUserId,
      role: input.role,
    });

    return {
      ok: true,
      organizationId: input.organizationId,
      telegramUserId: input.telegramUserId.toString(),
      role: input.role,
    };
  });
}
