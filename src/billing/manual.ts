import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createOrganization,
  findOrganizationById,
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
  createManualBillingEvent,
  findManualBillingEventByPaymentReference,
  type ManualBillingEventInput,
} from "../db/repos/manualBillingEvents.js";
import type { PlanCode } from "./plans.js";
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
  paymentReference: string | null;
  note: string | null;
  keptStripeLink: boolean;
}

export interface GrantManualOrganizationPlanInput extends ManualPlanGrantInput {
  organizationId: string;
  telegramUserId?: bigint | null;
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
  | "user_not_in_organization";

export interface ManualGrantSummary {
  organizationId: string;
  telegramUserId: string | null;
  planCode: PlanCode;
  subscriptionStatus: ManualSubscriptionStatus;
  paidThroughAt: string | null;
  paymentReference: string | null;
  keptStripeLink: boolean;
  manualBillingEventId: string;
}

export type GrantManualOrganizationPlanResult =
  | ({ ok: true; idempotent: false; updated: true } & ManualGrantSummary)
  | ({ ok: true; idempotent: true; updated: true } & ManualGrantSummary)
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
      updated: true;
      createdOrganization: boolean;
    } & ManualGrantSummary)
  | { ok: false; code: ManualGrantErrorCode; organizationIds?: string[] };

export type AddManualOrganizationMemberResult =
  | { ok: true; organizationId: string; telegramUserId: string; role: OrganizationRole }
  | { ok: false; code: ManualGrantErrorCode };

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
): ManualBillingEventInput {
  return {
    organizationId,
    telegramUserId,
    planCode: input.planCode,
    subscriptionStatus: input.subscriptionStatus,
    paidThroughAt: input.paidThroughAt,
    paymentReference: input.paymentReference,
    note: input.note,
    keptStripeLink: input.keptStripeLink,
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
    keptStripeLink: input.keptStripeLink,
    manualBillingEventId,
  };
}

export async function grantManualOrganizationPlan(
  db: Db,
  input: GrantManualOrganizationPlanInput,
): Promise<GrantManualOrganizationPlanResult> {
  const validation = validatePlanInput(input);
  if (!validation.ok) return validation;

  return db.transaction(async (tx) => {
    const organization = await findOrganizationById(tx, input.organizationId);
    if (!organization) return { ok: false, code: "organization_not_found" };

    const telegramUserId = input.telegramUserId ?? null;

    let manualBillingEventId: string;
    let idempotent = false;
    if (input.paymentReference) {
      const existing = await findManualBillingEventByPaymentReference(
        tx,
        input.organizationId,
        input.paymentReference,
      );
      if (existing) {
        manualBillingEventId = existing.id;
        idempotent = true;
      } else {
        const created = await createManualBillingEvent(
          tx,
          buildEventInput(input, input.organizationId, telegramUserId),
        );
        manualBillingEventId = created.id;
      }
    } else {
      const created = await createManualBillingEvent(
        tx,
        buildEventInput(input, input.organizationId, telegramUserId),
      );
      manualBillingEventId = created.id;
    }

    await updateOrganizationBillingState(tx, input.organizationId, buildBillingPatch(input));

    const summary = summarize(input, input.organizationId, telegramUserId, manualBillingEventId);
    return idempotent
      ? { ok: true, idempotent: true, updated: true, ...summary }
      : { ok: true, idempotent: false, updated: true, ...summary };
  });
}

export async function grantManualUserPlan(
  db: Db,
  input: GrantManualUserPlanInput,
): Promise<GrantManualUserPlanResult> {
  const validation = validatePlanInput(input);
  if (!validation.ok) return validation;

  return db.transaction(async (tx) => {
    await findOrCreateUserById(tx, input.telegramUserId);

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

    const organization = await findOrganizationById(tx, resolvedOrganizationId);
    if (!organization) return { ok: false, code: "organization_not_found" };

    let manualBillingEventId: string;
    let idempotent = false;
    if (input.paymentReference) {
      const existing = await findManualBillingEventByPaymentReference(
        tx,
        resolvedOrganizationId,
        input.paymentReference,
      );
      if (existing) {
        manualBillingEventId = existing.id;
        idempotent = true;
      } else {
        const created = await createManualBillingEvent(
          tx,
          buildEventInput(input, resolvedOrganizationId, input.telegramUserId),
        );
        manualBillingEventId = created.id;
      }
    } else {
      const created = await createManualBillingEvent(
        tx,
        buildEventInput(input, resolvedOrganizationId, input.telegramUserId),
      );
      manualBillingEventId = created.id;
    }

    await updateOrganizationBillingState(tx, resolvedOrganizationId, buildBillingPatch(input));

    const summary = summarize(
      input,
      resolvedOrganizationId,
      input.telegramUserId,
      manualBillingEventId,
    );
    return idempotent
      ? { ok: true, idempotent: true, updated: true, createdOrganization, ...summary }
      : { ok: true, idempotent: false, updated: true, createdOrganization, ...summary };
  });
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
