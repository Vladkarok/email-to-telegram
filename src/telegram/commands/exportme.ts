import { InputFile, type Context } from "grammy";
import { getDb } from "../../db/client.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";
import { exportHostedUserData } from "../../dataLifecycle/exportUser.js";
import { getLogger } from "../../utils/logger.js";

/**
 * /export_me — GDPR right-of-access entry point.
 *
 * Builds a JSON snapshot of everything the bot stores about the user
 * (account row, aliases, usage counters, billing records, delivery
 * metadata summary) and sends it back as a Telegram document.
 *
 * Email bodies and attachments are intentionally excluded: they are
 * already deliverable via the chat history and re-uploading them as a
 * single archive would frequently exceed Telegram's 50 MB bot file
 * upload limit. Users wanting raw bytes can request them from the
 * operator via the privacy contact.
 */
export async function exportMeHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  if (ctx.chat?.type !== "private") return;

  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const userId = BigInt(ctx.from.id);
  const logger = getLogger();

  try {
    const data = await exportHostedUserData(db, userId);
    if (!data) {
      await ctx.reply(messages.exportMe.noData);
      return;
    }

    const json = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(json, "utf8");
    const filename = `email-to-telegram-export-${userId.toString()}-${data.exportedAt.slice(0, 10)}.json`;

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: messages.exportMe.caption,
    });
    logger.info(
      { userId: userId.toString(), bytes: buffer.byteLength },
      "user.self_export_succeeded",
    );
  } catch (err: unknown) {
    logger.error({ err, userId: userId.toString() }, "user.self_export_failed");
    await ctx.reply(messages.exportMe.failed);
  }
}
