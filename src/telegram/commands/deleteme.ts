import { InlineKeyboard, type Context } from "grammy";
import { getDb } from "../../db/client.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";
import {
  findUserById,
  getUserDeletionSummary,
  hasLivePaidSubscription,
} from "../../db/repos/users.js";
import { deleteHostedUser } from "../../dataLifecycle/deleteUser.js";
import { getLogger } from "../../utils/logger.js";
import { CB_DELETE_ME_CONFIRM, CB_DELETE_ME_CANCEL } from "../callbacks.js";

/**
 * /delete_me — GDPR right-to-erasure entry point.
 *
 * Shows a preview of what will be wiped and asks for inline confirmation.
 * Refuses if the user has a live paid Stripe subscription — they must
 * cancel it first to avoid orphaned billing state.
 */
export async function deleteMeHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  if (ctx.chat?.type !== "private") return;

  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const userId = BigInt(ctx.from.id);

  const user = await findUserById(db, userId);
  if (!user) {
    // Nothing to delete — treat as success so the user gets a clean reply.
    await ctx.reply(messages.deleteMe.success);
    return;
  }

  if (hasLivePaidSubscription(user)) {
    await ctx.reply(messages.deleteMe.activeSubscription);
    return;
  }

  const summary = await getUserDeletionSummary(db, userId);

  const keyboard = new InlineKeyboard()
    .text(messages.deleteMe.confirmButton, CB_DELETE_ME_CONFIRM)
    .row()
    .text(messages.deleteMe.cancelButton, CB_DELETE_ME_CANCEL);

  await ctx.reply(
    messages.deleteMe.prompt(
      summary.aliasCount,
      summary.deliveryLogCount,
      summary.billingEventCount,
    ),
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

export async function deleteMeConfirmCallback(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const userId = BigInt(ctx.from.id);
  const logger = getLogger();

  // Re-check live subscription at confirm time in case the user upgraded
  // between sending /delete_me and tapping confirm.
  const user = await findUserById(db, userId);
  if (user && hasLivePaidSubscription(user)) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(messages.deleteMe.activeSubscription);
    return;
  }

  try {
    const result = await deleteHostedUser(db, userId);
    const partialFileFailure = result.failedFileDeletes.length > 0;
    logger.info(
      {
        userId: userId.toString(),
        deleted: result.deleted,
        rawEmailFiles: result.rawEmailFiles,
        attachmentFiles: result.attachmentFiles,
        failedFileDeletes: result.failedFileDeletes.length,
        partialFileFailure,
        source: "user_self_delete",
      },
      partialFileFailure ? "user.self_delete_partial" : "user.self_deleted",
    );
    await ctx.answerCallbackQuery();
    // Fail closed: only claim full erasure when DB rows were removed AND every
    // referenced file was unlinked. Partial state must be surfaced so the user
    // knows residual data remains and contacts the operator.
    if (partialFileFailure) {
      await ctx.editMessageText(messages.deleteMe.partial);
    } else {
      await ctx.editMessageText(messages.deleteMe.success);
    }
  } catch (err: unknown) {
    logger.error({ err, userId: userId.toString() }, "user.self_delete_failed");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(messages.deleteMe.failed);
  }
}

export async function deleteMeCancelCallback(ctx: Context): Promise<void> {
  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.deleteMe.cancelled);
}
