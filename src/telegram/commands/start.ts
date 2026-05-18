import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { upsertChat } from "../../db/repos/chats.js";
import { upsertUser } from "../../db/repos/users.js";
import {
  HOSTED_ONBOARDING_RATE_LIMIT_MESSAGE,
  HostedOnboardingRateLimitError,
  ensureUserWithOnboardingLimit,
} from "../../abuse/hostedOnboarding.js";
import { sendChatSelectionMenu } from "../menu/chatMenu.js";
import { getMessages, localeFromTelegram } from "../../i18n/index.js";

export async function startHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const locale = localeFromTelegram(ctx.from.language_code) ?? "en";
  const messages = getMessages(locale);

  if (ctx.chat?.type !== "private") {
    const botUsername = ctx.me.username;
    const keyboard = new InlineKeyboard().url(
      messages.start.openDmButton,
      `https://t.me/${botUsername}?start=hi`,
    );
    await ctx.reply(messages.start.privateChatRedirect, {
      reply_markup: keyboard,
    });
    return;
  }

  // Register DM chat so it appears in selection menus
  const db = getDb();
  if (loadConfig().appMode === "hosted") {
    try {
      await ensureUserWithOnboardingLimit(db, {
        id: BigInt(ctx.from.id),
        username: ctx.from.username ?? null,
        locale,
      });
    } catch (err: unknown) {
      if (err instanceof HostedOnboardingRateLimitError) {
        await ctx.reply(HOSTED_ONBOARDING_RATE_LIMIT_MESSAGE);
        return;
      }
      throw err;
    }
  } else {
    await upsertUser(db, {
      id: BigInt(ctx.from.id),
      username: ctx.from.username ?? null,
      locale,
    });
  }

  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  await upsertChat(db, {
    id: BigInt(ctx.chat.id),
    title: messages.start.dmTitle(name),
    type: "private",
  });

  await sendChatSelectionMenu(ctx, db, { welcome: true });
}
