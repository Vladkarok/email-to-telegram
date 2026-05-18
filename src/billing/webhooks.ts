import type Stripe from "stripe";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { loadConfig } from "../config.js";
import { recordBillingWebhookEvent } from "../db/repos/billingWebhookEvents.js";
import {
  findUserById,
  findUserByIdForUpdate,
  findUserByStripeCustomerId,
  findUserByStripeSubscriptionId,
  updateUserBillingState,
  updateUserPaidThroughAtIfLater,
} from "../db/repos/users.js";
import { findLatestManualBillingEventForUser } from "../db/repos/manualBillingEvents.js";
import { resolvePlanFromStripePriceId } from "./stripe.js";

type Db = NodePgDatabase<typeof schema>;

function parseTelegramUserIdMetadata(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

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
        const found = await findUserForStripeSubject(txDb, {
          telegramUserId: parseTelegramUserIdMetadata(
            session.metadata?.["telegramUserId"] ?? session.client_reference_id ?? null,
          ),
          stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
        });
        if (!found) return "ignored";
        const user = await findUserByIdForUpdate(txDb, found.id);
        if (!user) return "ignored";
        if (
          await shouldIgnoreStripeUpdate(
            txDb,
            user,
            null,
            typeof session.customer === "string" ? session.customer : null,
          )
        ) {
          return "ignored";
        }
        await updateUserBillingState(txDb, user.id, {
          stripeCustomerId:
            typeof session.customer === "string" ? session.customer : user.stripeCustomerId,
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
  const found = await findUserForStripeSubject(db, {
    telegramUserId: parseTelegramUserIdMetadata(subscription.metadata?.["telegramUserId"] ?? null),
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : null,
    stripeSubscriptionId: subscription.id,
  });
  if (!found) return "ignored";
  const user = await findUserByIdForUpdate(db, found.id);
  if (!user) return "ignored";
  if (
    await shouldIgnoreStripeUpdate(
      db,
      user,
      subscription.id,
      typeof subscription.customer === "string" ? subscription.customer : null,
    )
  ) {
    return "ignored";
  }
  if (
    user.stripeSubscriptionId &&
    user.stripeSubscriptionId !== subscription.id &&
    (eventType !== "customer.subscription.created" ||
      !canReplaceStripeSubscription(user.subscriptionStatus))
  ) {
    return "ignored";
  }

  const config = loadConfig();
  const primaryPriceId = subscription.items.data[0]?.price.id ?? null;
  const resolvedPlan = resolvePlanFromStripePriceId(config, primaryPriceId);
  if (!resolvedPlan) return "ignored";

  await updateUserBillingState(db, user.id, {
    planCode: resolvedPlan.planCode,
    subscriptionStatus: mapStripeSubscriptionStatus(subscription.status),
    stripeCustomerId:
      typeof subscription.customer === "string" ? subscription.customer : user.stripeCustomerId,
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
  const user = await findUserForStripeSubject(db, {
    telegramUserId: parseTelegramUserIdMetadata(
      invoice.parent?.subscription_details?.metadata?.["telegramUserId"] ?? null,
    ),
    stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : null,
    stripeSubscriptionId,
  });
  if (!user) return "ignored";
  if (
    await shouldIgnoreStripeUpdate(
      db,
      user,
      stripeSubscriptionId,
      typeof invoice.customer === "string" ? invoice.customer : null,
    )
  ) {
    return "ignored";
  }
  if (!stripeSubscriptionId || user.stripeSubscriptionId !== stripeSubscriptionId) {
    return "ignored";
  }
  return "ignored";
}

async function applyStripeInvoicePaymentSucceeded(
  db: Db,
  invoice: Stripe.Invoice,
): Promise<"processed" | "ignored"> {
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
  const found = await findUserForStripeSubject(db, {
    telegramUserId: parseTelegramUserIdMetadata(
      invoice.parent?.subscription_details?.metadata?.["telegramUserId"] ?? null,
    ),
    stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : null,
    stripeSubscriptionId,
  });
  if (!found) return "ignored";
  const user = await findUserByIdForUpdate(db, found.id);
  if (!user) return "ignored";
  if (
    await shouldIgnoreStripeUpdate(
      db,
      user,
      stripeSubscriptionId,
      typeof invoice.customer === "string" ? invoice.customer : null,
    )
  ) {
    return "ignored";
  }
  if (!stripeSubscriptionId || user.stripeSubscriptionId !== stripeSubscriptionId) {
    return "ignored";
  }

  const paidThroughAt = getInvoicePaidThroughAt(invoice, stripeSubscriptionId);
  if (!paidThroughAt) return "ignored";
  await updateUserPaidThroughAtIfLater(db, user.id, paidThroughAt);
  return "processed";
}

async function findUserForStripeSubject(
  db: Db,
  input: {
    telegramUserId: bigint | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  },
) {
  if (input.stripeSubscriptionId) {
    const user = await findUserByStripeSubscriptionId(db, input.stripeSubscriptionId);
    if (user) return user;
  }
  if (input.stripeCustomerId) {
    const user = await findUserByStripeCustomerId(db, input.stripeCustomerId);
    if (user) return user;
  }
  if (input.telegramUserId != null) {
    return findUserById(db, input.telegramUserId);
  }
  return null;
}

async function shouldIgnoreStripeUpdate(
  db: Db,
  user: {
    id: bigint;
    planCode: string;
    stripeSubscriptionId: string | null;
    stripeCustomerId: string | null;
  },
  stripeSubscriptionId: string | null,
  stripeCustomerId: string | null,
): Promise<boolean> {
  if (!user.stripeSubscriptionId && !user.stripeCustomerId) {
    if (user.planCode !== "free") return true;

    const latestManualEvent = await findLatestManualBillingEventForUser(db, user.id);
    if (latestManualEvent?.planCode === "free") return true;
  }
  if (user.stripeSubscriptionId || user.stripeCustomerId) {
    const hasMatchingStripeId =
      (stripeSubscriptionId != null && user.stripeSubscriptionId === stripeSubscriptionId) ||
      (stripeCustomerId != null && user.stripeCustomerId === stripeCustomerId);
    if ((stripeSubscriptionId != null || stripeCustomerId != null) && !hasMatchingStripeId) {
      return true;
    }
  }
  if (user.planCode !== "business") return false;
  const hasMatchingStripeId =
    (stripeSubscriptionId && user.stripeSubscriptionId === stripeSubscriptionId) ||
    (stripeCustomerId && user.stripeCustomerId === stripeCustomerId);
  if (!hasMatchingStripeId) return true;
  const latestManualEvent = await findLatestManualBillingEventForUser(db, user.id);
  return latestManualEvent?.keptStripeLink === true;
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
