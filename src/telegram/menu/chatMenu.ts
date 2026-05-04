import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { getAccessibleChats } from "../authorization.js";
import { getPrimaryOrganizationForUser } from "../../tenant/currentOrganization.js";
import { getEffectivePlan } from "../../billing/limits.js";
import { countActiveAliasesByOrganization } from "../../db/repos/aliases.js";
import { escapeHtml } from "../../utils/html.js";
import { CB_CHAT_SELECTION, CB_CHAT_MENU, CB_NEW_EMAIL, CB_ALIAS_LIST } from "../callbacks.js";

type Db = NodePgDatabase<typeof schema>;

function chatIcon(type: string): string {
  return type === "private" ? "🏠" : "👥";
}

/**
 * Returns a one-line plan/alias footer for hosted mode,
 * e.g. "Plan: Free | 2/3 aliases used".
 * Returns null in self-hosted mode or when org info is unavailable.
 */
async function buildPlanFooter(db: Db, userId: number): Promise<string | null> {
  if (loadConfig().appMode !== "hosted") return null;

  try {
    const org = await getPrimaryOrganizationForUser(db, BigInt(userId));
    if (!org) return null;

    const plan = getEffectivePlan(org);
    const used = await countActiveAliasesByOrganization(db, org.id);
    return `Plan: ${escapeHtml(plan.name)} | ${used}/${plan.limits.aliases} aliases used`;
  } catch {
    return null;
  }
}

export async function sendChatSelectionMenu(
  ctx: Context,
  db: Db,
  { welcome = false }: { welcome?: boolean } = {},
): Promise<void> {
  if (!ctx.from) return;
  const chats = await getAccessibleChats(db, ctx.api, ctx.from.id);
  const prefix = welcome ? "👋 Welcome! All email aliases are managed here.\n\n" : "";

  if (chats.length === 0) {
    await ctx.reply(
      `${prefix}No chats registered yet.\n\nAdd me to a group to manage email aliases for it, or use me here in DM.`,
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard.text(`${chatIcon(chat.type)} ${chat.title}`, CB_CHAT_MENU.build(chat.id)).row();
  }

  const footer = await buildPlanFooter(db, ctx.from.id);
  const body = footer
    ? `${prefix}Select a chat to manage:\n\n<i>${footer}</i>`
    : `${prefix}Select a chat to manage:`;

  await ctx.reply(body, { parse_mode: "HTML", reply_markup: keyboard });
}

export async function editChatSelectionMenu(ctx: Context, db: Db): Promise<void> {
  if (!ctx.from) return;
  const chats = await getAccessibleChats(db, ctx.api, ctx.from.id);

  if (chats.length === 0) {
    await ctx.editMessageText(
      "No chats registered yet.\n\nAdd me to a group to manage email aliases for it.",
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard.text(`${chatIcon(chat.type)} ${chat.title}`, CB_CHAT_MENU.build(chat.id)).row();
  }

  const footer = await buildPlanFooter(db, ctx.from.id);
  const body = footer ? `Select a chat to manage:\n\n<i>${footer}</i>` : "Select a chat to manage:";

  await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: keyboard });
}

export async function editChatManagementMenu(
  ctx: Context,
  chatId: string,
  chatTitle: string,
): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("📧 New Email", CB_NEW_EMAIL.build(chatId))
    .text("📋 List Emails", CB_ALIAS_LIST.build(chatId))
    .row()
    .text("⬅️ Back", CB_CHAT_SELECTION);

  await ctx.editMessageText(`Managing: <b>${escapeHtml(chatTitle)}</b>`, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}
