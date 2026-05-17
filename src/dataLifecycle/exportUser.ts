import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { asc, desc, eq } from "drizzle-orm";
import {
  deliveryLogs,
  emailAddresses,
  manualBillingEvents,
  userStorageUsage,
  userUsageMonths,
  users,
} from "../db/schema.js";
import type * as schema from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface UserExport {
  exportedAt: string;
  user: {
    id: string;
    username: string | null;
    planCode: string;
    subscriptionStatus: string;
    createdAt: string;
    updatedAt: string;
  };
  aliases: Array<{
    id: string;
    localPart: string;
    fullAddress: string;
    status: string;
    chatId: string;
    messageThreadId: string | null;
    renderMode: string;
    privacyModeEnabled: boolean;
    bodyDedupEnabled: boolean;
    createdAt: string;
  }>;
  usageMonths: Array<{
    month: string;
    deliveredCount: number;
    rejectedCount: number;
    egressBytes: string;
  }>;
  storageUsage: {
    rawEmailBytes: string;
    attachmentBytes: string;
  };
  deliverySummary: {
    total: number;
    billable: number;
    withAttachments: number;
    rawEmailBytes: number;
    byFinalStatus: Record<string, number>;
    byMonth: Record<string, number>;
  };
  manualBillingEvents: Array<{
    id: string;
    telegramUserId: string;
    planCode: string;
    subscriptionStatus: string;
    paidThroughAt: string | null;
    paymentReference: string | null;
    note: string | null;
    keptStripeLink: boolean;
    createdAt: string;
  }>;
}

export async function exportHostedUserData(
  db: Db,
  userId: bigint,
  now = new Date(),
): Promise<UserExport | null> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      planCode: users.planCode,
      subscriptionStatus: users.subscriptionStatus,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return null;

  const [aliases, usageMonths, storageRows, deliveryRows, manualEventRows] = await Promise.all([
    listAliases(db, userId),
    listUsageMonths(db, userId),
    listStorageUsage(db, userId),
    listDeliverySummaryRows(db, userId),
    listManualBillingEvents(db, userId),
  ]);

  return {
    exportedAt: now.toISOString(),
    user: {
      id: user.id.toString(),
      username: user.username,
      planCode: user.planCode,
      subscriptionStatus: user.subscriptionStatus,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    aliases: aliases.map((alias) => ({
      id: alias.id,
      localPart: alias.localPart,
      fullAddress: alias.fullAddress,
      status: alias.status,
      chatId: alias.chatId.toString(),
      messageThreadId: alias.messageThreadId?.toString() ?? null,
      renderMode: alias.renderMode,
      privacyModeEnabled: alias.privacyModeEnabled,
      bodyDedupEnabled: alias.bodyDedupEnabled,
      createdAt: alias.createdAt.toISOString(),
    })),
    usageMonths: usageMonths.map((usage) => ({
      month: usage.month,
      deliveredCount: usage.deliveredCount,
      rejectedCount: usage.rejectedCount,
      egressBytes: usage.egressBytes.toString(),
    })),
    storageUsage: {
      rawEmailBytes: (storageRows[0]?.rawEmailBytes ?? 0n).toString(),
      attachmentBytes: (storageRows[0]?.attachmentBytes ?? 0n).toString(),
    },
    deliverySummary: buildDeliverySummary(deliveryRows),
    manualBillingEvents: manualEventRows.map((row) => ({
      id: row.id,
      telegramUserId: row.telegramUserId.toString(),
      planCode: row.planCode,
      subscriptionStatus: row.subscriptionStatus,
      paidThroughAt: row.paidThroughAt ? row.paidThroughAt.toISOString() : null,
      paymentReference: row.paymentReference,
      note: row.note,
      keptStripeLink: row.keptStripeLink,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

async function listManualBillingEvents(db: Db, userId: bigint) {
  return db
    .select({
      id: manualBillingEvents.id,
      telegramUserId: manualBillingEvents.telegramUserId,
      planCode: manualBillingEvents.planCode,
      subscriptionStatus: manualBillingEvents.subscriptionStatus,
      paidThroughAt: manualBillingEvents.paidThroughAt,
      paymentReference: manualBillingEvents.paymentReference,
      note: manualBillingEvents.note,
      keptStripeLink: manualBillingEvents.keptStripeLink,
      createdAt: manualBillingEvents.createdAt,
    })
    .from(manualBillingEvents)
    .where(eq(manualBillingEvents.telegramUserId, userId))
    .orderBy(desc(manualBillingEvents.createdAt));
}

async function listAliases(db: Db, userId: bigint) {
  return db
    .select({
      id: emailAddresses.id,
      localPart: emailAddresses.localPart,
      fullAddress: emailAddresses.fullAddress,
      status: emailAddresses.status,
      chatId: emailAddresses.chatId,
      messageThreadId: emailAddresses.messageThreadId,
      renderMode: emailAddresses.renderMode,
      privacyModeEnabled: emailAddresses.privacyModeEnabled,
      bodyDedupEnabled: emailAddresses.bodyDedupEnabled,
      createdAt: emailAddresses.createdAt,
    })
    .from(emailAddresses)
    .where(eq(emailAddresses.createdBy, userId))
    .orderBy(asc(emailAddresses.createdAt));
}

async function listUsageMonths(db: Db, userId: bigint) {
  return db
    .select({
      month: userUsageMonths.month,
      deliveredCount: userUsageMonths.deliveredCount,
      rejectedCount: userUsageMonths.rejectedCount,
      egressBytes: userUsageMonths.egressBytes,
    })
    .from(userUsageMonths)
    .where(eq(userUsageMonths.userId, userId))
    .orderBy(asc(userUsageMonths.month));
}

async function listStorageUsage(db: Db, userId: bigint) {
  return db
    .select({
      rawEmailBytes: userStorageUsage.rawEmailBytes,
      attachmentBytes: userStorageUsage.attachmentBytes,
    })
    .from(userStorageUsage)
    .where(eq(userStorageUsage.userId, userId))
    .limit(1);
}

async function listDeliverySummaryRows(db: Db, userId: bigint) {
  return db
    .select({
      finalStatus: deliveryLogs.finalStatus,
      billable: deliveryLogs.billable,
      hasAttachments: deliveryLogs.hasAttachments,
      rawSizeBytes: deliveryLogs.rawSizeBytes,
      receivedAt: deliveryLogs.receivedAt,
    })
    .from(deliveryLogs)
    .where(eq(deliveryLogs.userId, userId));
}

function buildDeliverySummary(
  rows: Awaited<ReturnType<typeof listDeliverySummaryRows>>,
): UserExport["deliverySummary"] {
  const byFinalStatus: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  let billable = 0;
  let withAttachments = 0;
  let rawEmailBytes = 0;

  for (const row of rows) {
    byFinalStatus[row.finalStatus] = (byFinalStatus[row.finalStatus] ?? 0) + 1;
    const month = row.receivedAt.toISOString().slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
    if (row.billable) billable += 1;
    if (row.hasAttachments) withAttachments += 1;
    rawEmailBytes += row.rawSizeBytes ?? 0;
  }

  return {
    total: rows.length,
    billable,
    withAttachments,
    rawEmailBytes,
    byFinalStatus,
    byMonth,
  };
}
