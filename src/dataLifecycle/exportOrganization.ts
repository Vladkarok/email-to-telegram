import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { asc, eq, or } from "drizzle-orm";
import {
  deliveryLogs,
  emailAddresses,
  organizationStorageUsage,
  organizationUsageMonths,
  organizations,
} from "../db/schema.js";
import type * as schema from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface OrganizationExport {
  exportedAt: string;
  organization: {
    id: string;
    name: string;
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
}

export async function exportHostedOrganizationData(
  db: Db,
  organizationId: string,
  now = new Date(),
): Promise<OrganizationExport | null> {
  const [organization] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      planCode: organizations.planCode,
      subscriptionStatus: organizations.subscriptionStatus,
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!organization) return null;

  const [aliases, usageMonths, storageRows, deliveryRows] = await Promise.all([
    listAliases(db, organizationId),
    listUsageMonths(db, organizationId),
    listStorageUsage(db, organizationId),
    listDeliverySummaryRows(db, organizationId),
  ]);

  return {
    exportedAt: now.toISOString(),
    organization: {
      id: organization.id,
      name: organization.name,
      planCode: organization.planCode,
      subscriptionStatus: organization.subscriptionStatus,
      createdAt: organization.createdAt.toISOString(),
      updatedAt: organization.updatedAt.toISOString(),
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
  };
}

async function listAliases(db: Db, organizationId: string) {
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
    .where(eq(emailAddresses.organizationId, organizationId))
    .orderBy(asc(emailAddresses.createdAt));
}

async function listUsageMonths(db: Db, organizationId: string) {
  return db
    .select({
      month: organizationUsageMonths.month,
      deliveredCount: organizationUsageMonths.deliveredCount,
      rejectedCount: organizationUsageMonths.rejectedCount,
      egressBytes: organizationUsageMonths.egressBytes,
    })
    .from(organizationUsageMonths)
    .where(eq(organizationUsageMonths.organizationId, organizationId))
    .orderBy(asc(organizationUsageMonths.month));
}

async function listStorageUsage(db: Db, organizationId: string) {
  return db
    .select({
      rawEmailBytes: organizationStorageUsage.rawEmailBytes,
      attachmentBytes: organizationStorageUsage.attachmentBytes,
    })
    .from(organizationStorageUsage)
    .where(eq(organizationStorageUsage.organizationId, organizationId))
    .limit(1);
}

async function listDeliverySummaryRows(db: Db, organizationId: string) {
  return db
    .select({
      finalStatus: deliveryLogs.finalStatus,
      billable: deliveryLogs.billable,
      hasAttachments: deliveryLogs.hasAttachments,
      rawSizeBytes: deliveryLogs.rawSizeBytes,
      receivedAt: deliveryLogs.receivedAt,
    })
    .from(deliveryLogs)
    .leftJoin(emailAddresses, eq(emailAddresses.id, deliveryLogs.emailAddressId))
    .where(
      or(
        eq(deliveryLogs.organizationId, organizationId),
        eq(emailAddresses.organizationId, organizationId),
      ),
    );
}

function buildDeliverySummary(
  rows: Awaited<ReturnType<typeof listDeliverySummaryRows>>,
): OrganizationExport["deliverySummary"] {
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
