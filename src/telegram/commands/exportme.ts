import { InputFile, type Context } from "grammy";
import { getDb } from "../../db/client.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";
import { exportHostedUserData } from "../../dataLifecycle/exportUser.js";
import { getLogger } from "../../utils/logger.js";

/**
 * /export_me — GDPR right-of-access entry point.
 *
 * Builds a JSON snapshot of everything the bot stores about the user
 * (account, chats, aliases, allow rules, custom domains, per-row
 * delivery metadata, attempts, attachment manifest, usage counters,
 * storage usage, manual billing events).
 *
 * Raw email bodies and attachment bytes are intentionally excluded:
 * they would frequently exceed Telegram's 50 MB bot upload limit and
 * the metadata included here gives the user a verifiable audit trail.
 * Users wanting raw bytes can request them from the operator.
 */

// Per-user cooldown between successful (or attempted) exports. The export is
// repeatable and read-heavy; this keeps a misbehaving client from grinding
// the DB. In-memory only — adequate for a single-process bot. On a multi-
// process deployment a Redis-backed cooldown would be more accurate.
export const EXPORT_COOLDOWN_MS = 60_000;

// Telegram bot file upload hard limit is 50 MiB. Use a small safety margin so
// JSON.stringify rounding + grammy headers can't tip a file at the limit over.
const MAX_EXPORT_BYTES = 49 * 1024 * 1024;

const lastExportAt = new Map<bigint, number>();

export function _resetExportCooldownForTests(): void {
  lastExportAt.clear();
}

export async function exportMeHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  if (ctx.chat?.type !== "private") return;

  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const userId = BigInt(ctx.from.id);
  const logger = getLogger();

  const previous = lastExportAt.get(userId);
  const now = Date.now();
  if (previous !== undefined && now - previous < EXPORT_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((EXPORT_COOLDOWN_MS - (now - previous)) / 1000);
    await ctx.reply(messages.exportMe.rateLimited(retryAfterSeconds));
    return;
  }
  // Reserve the cooldown slot up front so a concurrent invocation from the
  // same user is rate-limited. Released below when the call didn't actually
  // produce or consume a successful export (no-data or thrown error), so
  // honest retries don't get punished for transient failures.
  lastExportAt.set(userId, now);

  await ctx.reply(messages.exportMe.preparing);

  try {
    const data = await exportHostedUserData(db, userId);
    if (!data) {
      await ctx.reply(messages.exportMe.noData);
      return;
    }

    const json = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(json, "utf8");

    if (buffer.byteLength > MAX_EXPORT_BYTES) {
      // Keep the cooldown slot: the heavy DB work already ran, so this is
      // exactly the case we want to throttle against retries of.
      logger.warn(
        { userId: userId.toString(), bytes: buffer.byteLength, limit: MAX_EXPORT_BYTES },
        "user.self_export_too_large",
      );
      await ctx.reply(messages.exportMe.tooLarge);
      return;
    }

    const filename = `email-to-telegram-export-${userId.toString()}-${data.exportedAt.slice(0, 10)}.json`;

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: messages.exportMe.caption,
    });
    logger.info(
      { userId: userId.toString(), bytes: buffer.byteLength },
      "user.self_export_succeeded",
    );
  } catch (err: unknown) {
    lastExportAt.delete(userId);
    logger.error({ err, userId: userId.toString() }, "user.self_export_failed");
    await ctx.reply(messages.exportMe.failed);
  }
}
