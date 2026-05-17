/**
 * Inbound email acceptance stage.
 *
 * Resolves the destination alias, enforces allow-rules, checks for
 * duplicates and rate limits, then atomically commits the delivery log
 * and charges monthly usage within a single advisory-locked transaction.
 */
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { parseEmail } from "../parser.js";
import { isDuplicate } from "../dedup.js";
import { checkAllowRule } from "../../db/repos/allowRules.js";
import { findAliasForInbound } from "../inboundRouting.js";
import { countRecentDeliveriesByAlias, createDeliveryLog } from "../../db/repos/deliveryLogs.js";
import { prepareDeliveryLogMetadataWrite } from "../../security/deliveryLogMetadata.js";
import { checkInboundLimit } from "../../billing/limits.js";
import { incrementUserUsageMonth, usageMonthForDate } from "../../db/repos/usage.js";
import { incrementUserStorageUsage } from "../../db/repos/storageUsage.js";
import type { Db, PipelineInput, QueueInboundResult } from "./types.js";
import { recordQuotaRejection } from "../../observability/metrics.js";

export async function queueInboundEmail(db: Db, input: PipelineInput): Promise<QueueInboundResult> {
  const {
    rawEmail,
    localPart,
    publicBaseUrl,
    attachmentDir,
    attachmentTtlHours,
    rawEmailTtlHours,
  } = input;

  // 1. Resolve alias
  const alias = await findAliasForInbound(db, {
    localPart,
    recipientDomain: input.recipientDomain,
  });
  if (!alias || alias.status !== "active") {
    return { queued: false, result: { ok: false, reason: "alias_not_found" } };
  }

  // 2. Parse email
  const parsed = await parseEmail(rawEmail, rawEmail.length);

  // 3. Allow-rule check — use the SMTP envelope sender from the HTTP header when available
  // (it comes from Cloudflare's message.from and cannot be spoofed via email headers),
  // falling back to the parsed From: address only when the worker doesn't supply it.
  const envelopeFrom = input.envelopeFrom ?? parsed.envelopeFrom;
  if (envelopeFrom) {
    const allowed = await checkAllowRule(db, alias.id, envelopeFrom);
    if (!allowed) {
      return { queued: false, result: { ok: false, reason: "sender_not_allowed" } };
    }
  }

  const receivedSince = new Date(Date.now() - 60 * 60 * 1000);
  const reservedAttachmentBytes = parsed.attachments.reduce(
    (sum, attachment) => sum + BigInt(attachment.sizeBytes ?? 0),
    0n,
  );
  const queueResult = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${alias.createdBy})`);

    // Serialize per-alias queue decisions so the hourly cap cannot be exceeded
    // by concurrent requests racing between COUNT(*) and INSERT.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${alias.id}))`);

    const inboundLimit = await checkInboundLimit(
      tx as Db,
      alias.createdBy,
      rawEmail.length,
      BigInt(rawEmail.length) + reservedAttachmentBytes,
    );
    if (!inboundLimit.ok) {
      return { kind: "inbound_limit" as const, limit: inboundLimit };
    }

    const dup = await isDuplicate(tx as Db, {
      messageId: parsed.messageId,
      bodySha256: parsed.bodySha256,
      aliasId: alias.id,
      bodyDedupEnabled: alias.bodyDedupEnabled ?? false,
    });
    if (dup) {
      return { kind: "duplicate" as const };
    }

    const recentDeliveries = await countRecentDeliveriesByAlias(tx as Db, alias.id, receivedSince);
    if (recentDeliveries >= alias.maxEmailsHour) {
      return { kind: "rate_limited" as const };
    }

    const deliveryLogId = randomUUID();
    const deliveryLogMetadata = await prepareDeliveryLogMetadataWrite(deliveryLogId, {
      envelopeFrom,
      headerFrom: parsed.headerFrom,
      subject: parsed.subject,
    });

    // 5. Create delivery log — null means a concurrent pipeline beat us (race dedup)
    const deliveryLog = await createDeliveryLog(tx as Db, {
      id: deliveryLogId,
      emailAddressId: alias.id,
      userId: alias.createdBy,
      messageIdHeader: parsed.messageId,
      bodySha256: parsed.bodySha256,
      bodyDedupApplied: alias.bodyDedupEnabled ?? false,
      envelopeFrom: deliveryLogMetadata.envelopeFrom,
      headerFrom: deliveryLogMetadata.headerFrom,
      subject: deliveryLogMetadata.subject,
      metadataCiphertext: deliveryLogMetadata.metadataCiphertext,
      metadataEncryptionMode: deliveryLogMetadata.metadataEncryptionMode,
      metadataWrappedDek: deliveryLogMetadata.metadataWrappedDek,
      metadataKekKeyId: deliveryLogMetadata.metadataKekKeyId,
      metadataEncryptedAt: deliveryLogMetadata.metadataEncryptedAt,
      rawSizeBytes: parsed.rawSizeBytes,
      rawEmailPath: input.rawEmailPath ?? null,
      rawEmailEncryptionMode: input.rawEmailEncryption?.encryptionMode ?? "none",
      rawEmailWrappedDek: input.rawEmailEncryption?.wrappedDek ?? null,
      rawEmailKekKeyId: input.rawEmailEncryption?.kekKeyId ?? null,
      rawEmailEncryptedAt: input.rawEmailEncryption?.encryptedAt ?? null,
      hasAttachments: parsed.attachments.length > 0,
      finalStatus: "received",
    });
    if (!deliveryLog) {
      return { kind: "duplicate" as const };
    }

    // Hosted monthly usage is charged once the email is accepted into durable processing.
    // This intentionally counts later Telegram send failures because infrastructure was used.
    await incrementUserUsageMonth(tx as Db, {
      userId: alias.createdBy,
      month: usageMonthForDate(),
      deliveredCount: 1,
    });
    await incrementUserStorageUsage(tx as Db, alias.createdBy, {
      rawEmailBytes: BigInt(rawEmail.length),
      attachmentBytes: reservedAttachmentBytes,
    });

    return { kind: "queued" as const, deliveryLog };
  });

  if (queueResult.kind === "duplicate") {
    return { queued: false, result: { ok: false, reason: "duplicate" } };
  }

  if (queueResult.kind === "rate_limited") {
    return { queued: false, result: { ok: false, reason: "rate_limited" } };
  }

  if (queueResult.kind === "inbound_limit") {
    recordQuotaRejection(queueResult.limit.code);
    return {
      queued: false,
      result: { ok: false, reason: queueResult.limit.code },
    };
  }

  return {
    queued: true,
    job: {
      alias,
      parsed,
      deliveryLog: queueResult.deliveryLog,
      envelopeFrom,
      publicBaseUrl,
      attachmentDir,
      attachmentTtlHours,
      rawEmailTtlHours,
      correlationId: input.correlationId,
    },
  };
}
