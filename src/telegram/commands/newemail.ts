import type { CommandContext, Context } from "grammy";
import { customAlphabet } from "nanoid";
import { getDb } from "../../db/client.js";
import { createAlias } from "../../db/repos/aliases.js";
import { loadConfig } from "../../config.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const generateSuffix = customAlphabet(ALPHABET, 6);
const generateRandom = customAlphabet(ALPHABET, 12);

/** Validates user-supplied name before lowercasing */
const NAME_RE = /^[a-z0-9._-]{1,32}$/;

export async function newemailHandler(ctx: CommandContext<Context>): Promise<void> {
  const rawName = ctx.match.trim();
  const config = loadConfig();

  let prefix: string;

  if (rawName.length > 0) {
    // Validate before accepting — don't silently lowercase
    if (rawName.length > 32) {
      await ctx.reply("❌ Name too long. Max 32 characters.\n\nUsage: /newemail <name>");
      return;
    }
    if (!NAME_RE.test(rawName)) {
      await ctx.reply(
        "❌ Invalid name. Only lowercase letters, digits, dots, hyphens and underscores are allowed.\n\nUsage: /newemail <name>",
      );
      return;
    }
    prefix = rawName;
  } else {
    // No name supplied — generate a fully random local part (no prefix-suffix split)
    prefix = generateRandom();
  }

  const localPart = rawName.length > 0 ? `${prefix}-${generateSuffix()}` : prefix;
  const fullAddress = `${localPart}@${config.mailDomain}`;

  const chatId = BigInt(ctx.chat.id);
  const messageThreadId =
    ctx.message?.message_thread_id != null ? BigInt(ctx.message.message_thread_id) : null;
  const createdBy = BigInt(ctx.from!.id);

  await createAlias(getDb(), {
    localPart,
    fullAddress,
    chatId,
    messageThreadId,
    createdBy,
    renderMode: "plaintext",
    status: "active",
  });

  await ctx.reply(
    `✅ Email alias created!\n\n📧 <code>${fullAddress}</code>\n\nUse /allow add ${localPart} &lt;email_or_domain&gt; to whitelist senders.\nAll mail is rejected until at least one allow rule is added.`,
    { parse_mode: "HTML" },
  );
}
