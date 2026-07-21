import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import {
  aliasMoveEvents,
  allowRules,
  attachments,
  chats,
  deliveryAttempts,
  deliveryLogs,
  emailAddresses,
  inboundDomains,
  manualBillingEvents,
  userStorageUsage,
  userUsageMonths,
  users,
} from "../db/schema.js";
import type * as schema from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

export const EXPORT_SCHEMA_VERSION = 4;

export interface UserExport {
  schemaVersion: number;
  exportedAt: string;
  user: {
    id: string;
    username: string | null;
    planCode: string;
    subscriptionStatus: string;
    createdAt: string;
    updatedAt: string;
  };
  chats: Array<{
    id: string;
    title: string;
    type: string;
    isActive: boolean;
    createdAt: string;
  }>;
  aliases: Array<{
    id: string;
    localPart: string;
    fullAddress: string;
    status: string;
    chatId: string;
    messageThreadId: string | null;
    label: string | null;
    renderMode: string;
    privacyModeEnabled: boolean;
    bodyDedupEnabled: boolean;
    createdAt: string;
  }>;
  allowRules: Array<{
    id: string;
    emailAddressId: string;
    matchType: string;
    matchValue: string;
    createdAt: string;
  }>;
  inboundDomains: Array<{
    id: string;
    domain: string;
    kind: string;
    status: string;
    verifiedAt: string | null;
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
  deliveryLogs: Array<{
    id: string;
    emailAddressId: string;
    messageIdHeader: string | null;
    envelopeFrom: string | null;
    headerFrom: string | null;
    subject: string | null;
    receivedAt: string;
    rawSizeBytes: number | null;
    hasAttachments: boolean;
    bodyDedupApplied: boolean;
    finalStatus: string;
    billable: boolean;
  }>;
  deliveryAttempts: Array<{
    id: string;
    deliveryLogId: string;
    attemptNo: number;
    targetChatId: string;
    targetThreadId: string | null;
    telegramMessageId: string | null;
    status: string;
    errorText: string | null;
    createdAt: string;
  }>;
  attachments: Array<{
    id: string;
    deliveryLogId: string;
    originalFilename: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    sha256: string | null;
    createdAt: string;
  }>;
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
  aliasMoveEvents: Array<{
    id: string;
    /** "owner" when the requester owns the alias, "actor" when they moved someone else's. */
    role: "owner" | "actor";
    /** Null on actor-role rows: the alias belongs to another user. */
    aliasId: string | null;
    authzPath: string;
    /** Routing ids are the owner's data; null on actor-role rows. */
    oldChatId: string | null;
    newChatId: string | null;
    oldThreadId: string | null;
    newThreadId: string | null;
    outcome: string;
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

  // Aliases run first because the chats lookup depends on the set of chat
  // ids they reference. Everything else fans out in parallel.
  const aliases = await listAliases(db, userId);
  const aliasChatIds = uniqueBigInts(aliases.map((alias) => alias.chatId));

  const [
    allowRuleRows,
    inboundDomainRows,
    chatRows,
    usageMonths,
    storageRows,
    deliveryRows,
    deliveryAttemptRows,
    attachmentRows,
    manualEventRows,
    aliasMoveEventRows,
  ] = await Promise.all([
    listAllowRulesForUser(db, userId),
    listInboundDomainsForUser(db, userId),
    listChatsForUser(db, userId, aliasChatIds),
    listUsageMonths(db, userId),
    listStorageUsage(db, userId),
    listDeliveryLogsForUser(db, userId),
    listDeliveryAttemptsForUser(db, userId),
    listAttachmentsForUser(db, userId),
    listManualBillingEvents(db, userId),
    listAliasMoveEvents(db, userId),
  ]);

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    user: {
      id: user.id.toString(),
      username: user.username,
      planCode: user.planCode,
      subscriptionStatus: user.subscriptionStatus,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    chats: chatRows.map((chat) => ({
      id: chat.id.toString(),
      title: chat.title,
      type: chat.type,
      isActive: chat.isActive,
      createdAt: chat.createdAt.toISOString(),
    })),
    aliases: aliases.map((alias) => ({
      id: alias.id,
      localPart: alias.localPart,
      fullAddress: alias.fullAddress,
      status: alias.status,
      chatId: alias.chatId.toString(),
      messageThreadId: alias.messageThreadId?.toString() ?? null,
      label: alias.label,
      renderMode: alias.renderMode,
      privacyModeEnabled: alias.privacyModeEnabled,
      bodyDedupEnabled: alias.bodyDedupEnabled,
      createdAt: alias.createdAt.toISOString(),
    })),
    allowRules: allowRuleRows.map((rule) => ({
      id: rule.id,
      emailAddressId: rule.emailAddressId,
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      createdAt: rule.createdAt.toISOString(),
    })),
    inboundDomains: inboundDomainRows.map((row) => ({
      id: row.id,
      domain: row.domain,
      kind: row.kind,
      status: row.status,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
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
    deliveryLogs: deliveryRows.map((row) => ({
      id: row.id,
      emailAddressId: row.emailAddressId,
      messageIdHeader: row.messageIdHeader,
      envelopeFrom: row.envelopeFrom,
      headerFrom: row.headerFrom,
      subject: row.subject,
      receivedAt: row.receivedAt.toISOString(),
      rawSizeBytes: row.rawSizeBytes,
      hasAttachments: row.hasAttachments,
      bodyDedupApplied: row.bodyDedupApplied,
      finalStatus: row.finalStatus,
      billable: row.billable,
    })),
    deliveryAttempts: deliveryAttemptRows.map((row) => ({
      id: row.id,
      deliveryLogId: row.deliveryLogId,
      attemptNo: row.attemptNo,
      targetChatId: row.targetChatId.toString(),
      targetThreadId: row.targetThreadId?.toString() ?? null,
      telegramMessageId: row.telegramMessageId?.toString() ?? null,
      status: row.status,
      errorText: row.errorText,
      createdAt: row.createdAt.toISOString(),
    })),
    attachments: attachmentRows.map((row) => ({
      id: row.id,
      deliveryLogId: row.deliveryLogId,
      originalFilename: row.originalFilename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      createdAt: row.createdAt.toISOString(),
    })),
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
    aliasMoveEvents: aliasMoveEventRows.map((row) => {
      const isOwner = row.aliasOwnerId === userId;
      // On a row where the requester was only the ACTOR, the alias and both
      // chat ids describe someone else's mailbox. The requester is entitled
      // to know they performed the action, not to a copy of the other user's
      // routing — so those fields are withheld, not just the user ids.
      return {
        id: row.id,
        role: isOwner ? ("owner" as const) : ("actor" as const),
        aliasId: isOwner ? row.aliasId : null,
        authzPath: row.authzPath,
        oldChatId: isOwner ? row.oldChatId.toString() : null,
        newChatId: isOwner ? row.newChatId.toString() : null,
        oldThreadId: isOwner ? (row.oldThreadId?.toString() ?? null) : null,
        newThreadId: isOwner ? (row.newThreadId?.toString() ?? null) : null,
        outcome: row.outcome,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * Move events the requester appears in, as alias owner or as actor.
 *
 * Third-party identifiers are redacted by omission: neither `aliasOwnerId`
 * nor `actorId` is exported. On a row where the requester is only the actor,
 * the owner is someone else; on a row they own, the actor may be someone
 * else. `role` conveys which side they were on without naming the other.
 */
async function listAliasMoveEvents(db: Db, userId: bigint) {
  return db
    .select({
      id: aliasMoveEvents.id,
      aliasId: aliasMoveEvents.aliasId,
      aliasOwnerId: aliasMoveEvents.aliasOwnerId,
      authzPath: aliasMoveEvents.authzPath,
      oldChatId: aliasMoveEvents.oldChatId,
      newChatId: aliasMoveEvents.newChatId,
      oldThreadId: aliasMoveEvents.oldThreadId,
      newThreadId: aliasMoveEvents.newThreadId,
      outcome: aliasMoveEvents.outcome,
      createdAt: aliasMoveEvents.createdAt,
    })
    .from(aliasMoveEvents)
    .where(or(eq(aliasMoveEvents.aliasOwnerId, userId), eq(aliasMoveEvents.actorId, userId)))
    .orderBy(desc(aliasMoveEvents.createdAt));
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
      label: emailAddresses.label,
      renderMode: emailAddresses.renderMode,
      privacyModeEnabled: emailAddresses.privacyModeEnabled,
      bodyDedupEnabled: emailAddresses.bodyDedupEnabled,
      createdAt: emailAddresses.createdAt,
    })
    .from(emailAddresses)
    .where(eq(emailAddresses.createdBy, userId))
    .orderBy(asc(emailAddresses.createdAt));
}

async function listAllowRulesForUser(db: Db, userId: bigint) {
  return db
    .select({
      id: allowRules.id,
      emailAddressId: allowRules.emailAddressId,
      matchType: allowRules.matchType,
      matchValue: allowRules.matchValue,
      createdAt: allowRules.createdAt,
    })
    .from(allowRules)
    .innerJoin(emailAddresses, eq(emailAddresses.id, allowRules.emailAddressId))
    .where(eq(emailAddresses.createdBy, userId))
    .orderBy(asc(allowRules.createdAt));
}

async function listInboundDomainsForUser(db: Db, userId: bigint) {
  return db
    .select({
      id: inboundDomains.id,
      domain: inboundDomains.domain,
      kind: inboundDomains.kind,
      status: inboundDomains.status,
      verifiedAt: inboundDomains.verifiedAt,
      createdAt: inboundDomains.createdAt,
    })
    .from(inboundDomains)
    .where(eq(inboundDomains.userId, userId))
    .orderBy(asc(inboundDomains.createdAt));
}

async function listChatsForUser(db: Db, userId: bigint, aliasChatIds: bigint[]) {
  // The DM chat row shares the user's id; include it whenever it exists, even
  // if the user has no aliases pointed there. Group/supergroup chats are only
  // included when the user has at least one alias targeting them.
  const idsToFetch = uniqueBigInts([...aliasChatIds, userId]);
  if (idsToFetch.length === 0) return [];

  return db
    .select({
      id: chats.id,
      title: chats.title,
      type: chats.type,
      isActive: chats.isActive,
      createdAt: chats.createdAt,
    })
    .from(chats)
    .where(
      or(
        inArray(
          chats.id,
          idsToFetch.filter((id) => id !== userId),
        ),
        and(eq(chats.id, userId), eq(chats.type, "private")),
      ),
    )
    .orderBy(asc(chats.createdAt));
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

async function listDeliveryLogsForUser(db: Db, userId: bigint) {
  return db
    .select({
      id: deliveryLogs.id,
      emailAddressId: deliveryLogs.emailAddressId,
      messageIdHeader: deliveryLogs.messageIdHeader,
      envelopeFrom: deliveryLogs.envelopeFrom,
      headerFrom: deliveryLogs.headerFrom,
      subject: deliveryLogs.subject,
      receivedAt: deliveryLogs.receivedAt,
      rawSizeBytes: deliveryLogs.rawSizeBytes,
      hasAttachments: deliveryLogs.hasAttachments,
      bodyDedupApplied: deliveryLogs.bodyDedupApplied,
      finalStatus: deliveryLogs.finalStatus,
      billable: deliveryLogs.billable,
    })
    .from(deliveryLogs)
    .where(eq(deliveryLogs.userId, userId))
    .orderBy(asc(deliveryLogs.receivedAt));
}

async function listDeliveryAttemptsForUser(db: Db, userId: bigint) {
  return db
    .select({
      id: deliveryAttempts.id,
      deliveryLogId: deliveryAttempts.deliveryLogId,
      attemptNo: deliveryAttempts.attemptNo,
      targetChatId: deliveryAttempts.targetChatId,
      targetThreadId: deliveryAttempts.targetThreadId,
      telegramMessageId: deliveryAttempts.telegramMessageId,
      status: deliveryAttempts.status,
      errorText: deliveryAttempts.errorText,
      createdAt: deliveryAttempts.createdAt,
    })
    .from(deliveryAttempts)
    .innerJoin(deliveryLogs, eq(deliveryLogs.id, deliveryAttempts.deliveryLogId))
    .where(eq(deliveryLogs.userId, userId))
    .orderBy(asc(deliveryAttempts.createdAt));
}

async function listAttachmentsForUser(db: Db, userId: bigint) {
  return db
    .select({
      id: attachments.id,
      deliveryLogId: attachments.deliveryLogId,
      originalFilename: attachments.originalFilename,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
      sha256: attachments.sha256,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .innerJoin(deliveryLogs, eq(deliveryLogs.id, attachments.deliveryLogId))
    .where(eq(deliveryLogs.userId, userId))
    .orderBy(asc(attachments.createdAt));
}

function buildDeliverySummary(
  rows: Awaited<ReturnType<typeof listDeliveryLogsForUser>>,
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

function uniqueBigInts(values: bigint[]): bigint[] {
  return [...new Set(values)];
}
