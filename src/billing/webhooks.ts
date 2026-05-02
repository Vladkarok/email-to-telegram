import type Stripe from "stripe";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { loadConfig } from "../config.js";
import { recordBillingWebhookEvent } from "../db/repos/billingWebhookEvents.js";
import {
  findOrganizationById,
  findOrganizationByStripeCustomerId,
  findOrganizationByStripeSubscriptionId,
  updateOrganizationBillingState,
  updateOrganizationPaidThroughAtIfLater,
} from "../db/repos/organizations.js";
import { findLatestManualBillingEventForOrganization } from "../db/repos/manualBillingEvents.js";
import { resolvePlanFromStripePriceId } from "./stripe.js";

type Db = NodePgDatabase<typeof schema>;

export async function processStripeWebhookEvent(
  db: Db,
  event: Stripe.Event,
): Promise<"processed" | "duplicate" | "ignored"> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const inserted = await recordBillingWebhookEvent(txDb, event.id, event.type);
    if (!inserted) return "duplicate";

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const organization = await findOrganizationForStripeSubject(txDb, {
          organizationId:
            session.metadata?.["organizationId"] ?? session.client_reference_id ?? null,
          stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
        });
        if (!organization) return "ignored";
        if (
          await shouldIgnoreStripeUpdate(
            txDb,
            organization,
            null,
            typeof session.customer === "string" ? session.customer : null,
          )
        ) {
          return "ignored";
        }
        await updateOrganizationBillingState(txDb, organization.id, {
          stripeCustomerId:
            typeof session.customer === "string" ? session.customer : organization.stripeCustomerId,
        });
        return "processed";
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        return applyStripeSubscription(txDb, event.type, event.data.object);
      }
      case "invoice.payment_succeeded": {
        return applyStripeInvoicePaymentSucceeded(txDb, event.data.object);
      }
      case "invoice.payment_failed": {
        return validateStripeInvoiceSubject(txDb, event.data.object);
      }
      default:
        return "ignored";
    }
  });
}

async function applyStripeSubscription(
  db: Db,
  eventType:
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  subscription: Stripe.Subscription,
): Promise<"processed" | "ignored"> {
  const organization = await findOrganizationForStripeSubject(db, {
    organizationId: subscription.metadata?.["organizationId"] ?? null,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : null,
    stripeSubscriptionId: subscription.id,
  });
  if (!organization) return "ignored";
  if (
    await shouldIgnoreStripeUpdate(
      db,
      organization,
      subscription.id,
      typeof subscription.customer === "string" ? subscription.customer : null,
    )
  ) {
    return "ignored";
  }
  if (
    organization.stripeSubscriptionId &&
    organization.stripeSubscriptionId !== subscription.id &&
    (eventType !== "customer.subscription.created" ||
      !canReplaceStripeSubscription(organization.subscriptionStatus))
  ) {
    return "ignored";
  }

  const config = loadConfig();
  const primaryPriceId = subscription.items.data[0]?.price.id ?? null;
  const resolvedPlan = resolvePlanFromStripePriceId(config, primaryPriceId);
  if (!resolvedPlan) return "ignored";

  await updateOrganizationBillingState(db, organization.id, {
    planCode: resolvedPlan.planCode,
    subscriptionStatus: mapStripeSubscriptionStatus(subscription.status),
    stripeCustomerId:
      typeof subscription.customer === "string"
        ? subscription.customer
        : organization.stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    trialEndsAt: subscription.trial_end != null ? new Date(subscription.trial_end * 1000) : null,
    currentPeriodStart:
      subscription.items.data[0]?.current_period_start != null
        ? new Date(subscription.items.data[0].current_period_start * 1000)
        : null,
    currentPeriodEnd:
      subscription.items.data[0]?.current_period_end != null
        ? new Date(subscription.items.data[0].current_period_end * 1000)
        : null,
  });
  return "processed";
}

async function validateStripeInvoiceSubject(db: Db, invoice: Stripe.Invoice): Promise<"ignored"> {
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
  const organization = await findOrganizationForStripeSubject(db, {
    organizationId: invoice.parent?.subscription_details?.metadata?.["organizationId"] ?? null,
    stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : null,
    stripeSubscriptionId,
  });
  if (!organization) return "ignored";
  if (
    await shouldIgnoreStripeUpdate(
      db,
      organization,
      stripeSubscriptionId,
      typeof invoice.customer === "string" ? invoice.customer : null,
    )
  ) {
    return "ignored";
  }
  if (!stripeSubscriptionId || organization.stripeSubscriptionId !== stripeSubscriptionId) {
    return "ignored";
  }

  // Subscription events remain the authoritative source of billing state. Invoice
  // payment events can arrive out of order, so we avoid mutating plan/status here.
  return "ignored";
}

async function applyStripeInvoicePaymentSucceeded(
  db: Db,
  invoice: Stripe.Invoice,
): Promise<"processed" | "ignored"> {
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
  const organization = await findOrganizationForStripeSubject(db, {
    organizationId: invoice.parent?.subscription_details?.metadata?.["organizationId"] ?? null,
    stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : null,
    stripeSubscriptionId,
  });
  if (!organization) return "ignored";
  if (
    await shouldIgnoreStripeUpdate(
      db,
      organization,
      stripeSubscriptionId,
      typeof invoice.customer === "string" ? invoice.customer : null,
    )
  ) {
    return "ignored";
  }
  if (!stripeSubscriptionId || organization.stripeSubscriptionId !== stripeSubscriptionId) {
    return "ignored";
  }

  const paidThroughAt = getInvoicePaidThroughAt(invoice, stripeSubscriptionId);
  if (!paidThroughAt) return "ignored";
  await updateOrganizationPaidThroughAtIfLater(db, organization.id, paidThroughAt);
  return "processed";
}

async function findOrganizationForStripeSubject(
  db: Db,
  input: {
    organizationId: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  },
) {
  if (input.stripeSubscriptionId) {
    const organization = await findOrganizationByStripeSubscriptionId(
      db,
      input.stripeSubscriptionId,
    );
    if (organization) return organization;
  }
  if (input.stripeCustomerId) {
    const organization = await findOrganizationByStripeCustomerId(db, input.stripeCustomerId);
    if (organization) return organization;
  }
  if (input.organizationId) {
    return findOrganizationById(db, input.organizationId);
  }
  return null;
}

async function shouldIgnoreStripeUpdate(
  db: Db,
  organization: {
    id: string;
    planCode: string;
    stripeSubscriptionId: string | null;
    stripeCustomerId: string | null;
  },
  stripeSubscriptionId: string | null,
  stripeCustomerId: string | null,
): Promise<boolean> {
  if (!organization.stripeSubscriptionId && !organization.stripeCustomerId) {
    // Manual paid grants clear Stripe links. A delayed Stripe event may still
    // carry organizationId metadata, but without a current Stripe link it must
    // not be allowed to clobber the manual entitlement.
    if (organization.planCode !== "free") return true;

    // Fresh free organizations also have no Stripe links and must still be able
    // to start checkout. Protect only free orgs whose latest manual event is the
    // operator's manual downgrade/cancellation to free.
    const latestManualEvent = await findLatestManualBillingEventForOrganization(
      db,
      organization.id,
    );
    if (latestManualEvent?.planCode === "free") return true;
  }
  if (organization.planCode !== "business") return false;
  return !(
    (stripeSubscriptionId && organization.stripeSubscriptionId === stripeSubscriptionId) ||
    (stripeCustomerId && organization.stripeCustomerId === stripeCustomerId)
  );
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const value = invoice.parent?.subscription_details?.subscription;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return null;
}

function getInvoicePaidThroughAt(
  invoice: Stripe.Invoice,
  stripeSubscriptionId: string | null,
): Date | null {
  if (!stripeSubscriptionId) return null;

  const periodEnds = (invoice.lines?.data ?? [])
    .filter((line) => isSubscriptionInvoiceLine(line, stripeSubscriptionId))
    .map((line) => line.period?.end)
    .filter((periodEnd): periodEnd is number => typeof periodEnd === "number");

  if (periodEnds.length === 0) return null;
  return new Date(Math.max(...periodEnds) * 1000);
}

function isSubscriptionInvoiceLine(
  line: Stripe.InvoiceLineItem,
  stripeSubscriptionId: string,
): boolean {
  const parent = line.parent as
    | {
        subscription_item_details?: { subscription?: string | null } | null;
      }
    | null
    | undefined;

  return parent?.subscription_item_details?.subscription === stripeSubscriptionId;
}

function mapStripeSubscriptionStatus(status: Stripe.Subscription.Status) {
  switch (status) {
    case "trialing":
      return "trialing" as const;
    case "active":
      return "active" as const;
    case "paused":
      return "paused" as const;
    case "past_due":
      return "past_due" as const;
    case "canceled":
      return "canceled" as const;
    case "unpaid":
      return "unpaid" as const;
    case "incomplete":
      return "incomplete" as const;
    case "incomplete_expired":
      return "incomplete_expired" as const;
    default:
      return "free" as const;
  }
}

function canReplaceStripeSubscription(status: string): boolean {
  return status === "free" || status === "canceled" || status === "incomplete_expired";
}
