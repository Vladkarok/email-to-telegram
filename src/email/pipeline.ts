import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { parseEmail } from "./parser.js";
import { cleanEmailBody } from "./cleaner.js";
import { renderEmail } from "./renderer.js";
import { isDuplicate } from "./dedup.js";
import { findAliasByLocalPart } from "../db/repos/aliases.js";
import { checkAllowRule } from "../db/repos/allowRules.js";
import { createDeliveryLog, updateDeliveryLogStatus } from "../db/repos/deliveryLogs.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

export interface PipelineInput {
  rawEmail: Buffer;
  localPart: string;
}

export interface PipelineResult {
  ok: boolean;
  reason?: string;
}

export async function processInboundEmail(
  db: Db,
  api: { sendMessage: (...args: unknown[]) => Promise<unknown> } | null,
  input: PipelineInput,
): Promise<PipelineResult> {
  const log = getLogger();
  const { rawEmail, localPart } = input;

  // 1. Resolve alias
  const alias = await findAliasByLocalPart(db, localPart);
  if (!alias || alias.status !== "active") {
    return { ok: false, reason: "alias_not_found" };
  }

  // 2. Parse email
  const parsed = await parseEmail(rawEmail, rawEmail.length);

  // 3. Allow-rule check
  if (parsed.envelopeFrom) {
    const allowed = await checkAllowRule(db, alias.id, parsed.envelopeFrom);
    if (!allowed) {
      return { ok: false, reason: "sender_not_allowed" };
    }
  }

  // 4. Dedup
  const dup = await isDuplicate(db, {
    messageId: parsed.messageId,
    bodySha256: parsed.bodySha256,
    aliasId: alias.id,
  });
  if (dup) {
    return { ok: false, reason: "duplicate" };
  }

  // 5. Create delivery log
  const deliveryLog = await createDeliveryLog(db, {
    emailAddressId: alias.id,
    messageIdHeader: parsed.messageId,
    bodySha256: parsed.bodySha256,
    envelopeFrom: parsed.envelopeFrom,
    headerFrom: parsed.headerFrom,
    subject: parsed.subject,
    rawSizeBytes: parsed.rawSizeBytes,
    hasAttachments: parsed.attachments.length > 0,
    finalStatus: "received",
  });

  // 6. Clean body
  if (parsed.textBody) {
    parsed.textBody = cleanEmailBody(parsed.textBody);
  }

  // 7. Render
  const renderMode = (alias.renderMode ?? "plaintext") as "plaintext" | "html" | "markdown";
  const text = renderEmail(parsed, renderMode, alias.fullAddress, []);

  // 8. Send
  if (api) {
    const { sendTelegramMessage } = await import("../telegram/sender.js");
    const result = await sendTelegramMessage(api as Parameters<typeof sendTelegramMessage>[0], {
      chatId: alias.chatId,
      threadId: alias.messageThreadId ?? null,
      text,
      parseMode: renderMode === "html" ? "HTML" : renderMode === "markdown" ? "MarkdownV2" : "HTML",
    });

    const finalStatus = result.ok ? "delivered" : "failed";
    await updateDeliveryLogStatus(db, deliveryLog.id, finalStatus);

    if (!result.ok) {
      log.error({ deliveryLogId: deliveryLog.id, error: result.error }, "delivery failed");
      return { ok: false, reason: "send_failed" };
    }
  }

  return { ok: true };
}
