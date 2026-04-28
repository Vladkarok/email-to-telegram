import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { upsertChat } from "../../db/repos/chats.js";
import { upsertUser } from "../../db/repos/users.js";
import {
  HOSTED_ONBOARDING_RATE_LIMIT_MESSAGE,
  HostedOnboardingRateLimitError,
  ensurePersonalOrganizationForUserWithOnboardingLimit,
} from "../../abuse/hostedOnboarding.js";
import { sendChatSelectionMenu } from "../menu/chatMenu.js";

export async function startHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  if (ctx.chat?.type !== "private") {
    // In a group — redirect to DM
    const botUsername = ctx.me.username;
    const keyboard = new InlineKeyboard().url("💬 Open DM", `https://t.me/${botUsername}?start=hi`);
    await ctx.reply("Manage email aliases in our private chat 👇", {
      reply_markup: keyboard,
    });
    return;
  }

  // Register DM chat so it appears in selection menus
  const db = getDb();
  let organizationId: string | null = null;
  if (loadConfig().appMode === "hosted") {
    const user = await upsertUser(db, {
      id: BigInt(ctx.from.id),
      username: ctx.from.username ?? null,
    });
    let organization;
    try {
      organization = await ensurePersonalOrganizationForUserWithOnboardingLimit(db, user);
    } catch (err: unknown) {
      if (err instanceof HostedOnboardingRateLimitError) {
        await ctx.reply(HOSTED_ONBOARDING_RATE_LIMIT_MESSAGE);
        return;
      }
      throw err;
    }
    organizationId = organization.id;
  }

  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  await upsertChat(db, {
    id: BigInt(ctx.chat.id),
    organizationId,
    title: `🏠 ${name} (DM)`,
    type: "private",
  });

  await sendChatSelectionMenu(ctx, db, { welcome: true });
}
