import type { Context, NextFunction } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { upsertChat } from "../../db/repos/chats.js";
import { upsertUser } from "../../db/repos/users.js";
import { ensurePersonalOrganizationForUser } from "../../tenant/currentOrganization.js";
import { RateLimiter } from "../../utils/rateLimit.js";

// 30 commands per minute per user; sweep idle keys every 60 s to prevent memory growth
const limiter = new RateLimiter(30, 60_000);
limiter.startSweep();

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.from) return;

  if (!limiter.check(String(ctx.from.id))) {
    await ctx.reply("⚠️ Too many requests. Please slow down.");
    return;
  }

  const db = getDb();
  const user = await upsertUser(db, {
    id: BigInt(ctx.from.id),
    username: ctx.from.username ?? null,
  });

  if (loadConfig().appMode === "hosted") {
    const organization = await ensurePersonalOrganizationForUser(db, user);
    if (ctx.chat?.type === "private") {
      await upsertChat(db, {
        id: BigInt(ctx.chat.id),
        organizationId: organization.id,
        title: privateChatTitle(ctx),
        type: "private",
      });
    }
    await next();
    return;
  }

  if (!user.isAllowed) {
    await ctx.reply("⛔ Access denied. You are not authorized to use this bot.");
    return;
  }

  await next();
}

function privateChatTitle(ctx: Context): string {
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ");
  return `🏠 ${name || ctx.from?.username || ctx.from?.id} (DM)`;
}
