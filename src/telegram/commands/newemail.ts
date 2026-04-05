import { InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import { customAlphabet } from "nanoid";
import { getDb } from "../../db/client.js";
import { createAlias } from "../../db/repos/aliases.js";
import { findChatById } from "../../db/repos/chats.js";
import { loadConfig } from "../../config.js";
import { getPending, clearPending } from "../session.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const generateSuffix = customAlphabet(ALPHABET, 6);
const generateRandom = customAlphabet(ALPHABET, 12);

/** Validates user-supplied name before lowercasing */
const NAME_RE = /^[a-z0-9._-]{1,32}$/;

export async function newemailHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;

  const rawName = ctx.match.trim();
  const db = getDb();

  // Determine target chat: session context (DM flow) > current chat
  const pending = getPending(ctx.from.id);
  let targetChatId: bigint;
  let targetThreadId: bigint | null = null;
  let targetChatTitle: string | undefined;

  if (pending) {
    targetChatId = pending.chatId;
    targetChatTitle = pending.chatTitle;
    clearPending(ctx.from.id);
  } else {
    targetChatId = BigInt(ctx.chat.id);
    targetThreadId =
      ctx.message?.message_thread_id != null ? BigInt(ctx.message.message_thread_id) : null;
    const chat = await findChatById(db, targetChatId);
    targetChatTitle = chat?.title;
  }

  await createEmailAlias(ctx, rawName, targetChatId, targetThreadId, targetChatTitle);
}

export async function createEmailAlias(
  ctx: Context,
  rawName: string,
  chatId: bigint,
  threadId: bigint | null,
  chatTitle: string | undefined,
): Promise<void> {
  if (!ctx.from) return;
  const config = loadConfig();

  let prefix: string;

  if (rawName.length > 0) {
    if (rawName.length > 32) {
      await ctx.reply("❌ Name too long. Max 32 characters.");
      return;
    }
    if (!NAME_RE.test(rawName)) {
      await ctx.reply(
        "❌ Invalid name. Only lowercase letters, digits, dots, hyphens and underscores are allowed.",
      );
      return;
    }
    prefix = rawName;
  } else {
    prefix = generateRandom();
  }

  const localPart = rawName.length > 0 ? `${prefix}-${generateSuffix()}` : prefix;
  const fullAddress = `${localPart}@${config.mailDomain}`;

  try {
    await createAlias(getDb(), {
      localPart,
      fullAddress,
      chatId,
      messageThreadId: threadId,
      createdBy: BigInt(ctx.from.id),
      renderMode: "plaintext",
      status: "active",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("duplicate") ||
      msg.includes("unique") ||
      msg.includes("idx_alias_local_part")
    ) {
      await ctx.reply("❌ That alias name is already taken. Try a different one.");
      return;
    }
    throw err;
  }

  const chatNote = chatTitle ? `\nDelivering to: <b>${escapeHtml(chatTitle)}</b>` : "";

  const keyboard = new InlineKeyboard().text(
    "🔐 Add Allow Rule",
    `am:${localPart}`, // will be resolved via alias lookup — placeholder, handled in bot.ts
  );

  await ctx.reply(
    `✅ Email alias created!\n\n📧 <code>${fullAddress}</code>${chatNote}\n\n⚠️ Add at least one allow rule — until then all mail is rejected.\n\n<code>/allow add ${localPart} domain.com</code>`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
