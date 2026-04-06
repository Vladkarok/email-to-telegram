import type { Context, NextFunction } from "grammy";
import { getDb } from "../../db/client.js";
import { upsertUser } from "../../db/repos/users.js";
import { RateLimiter } from "../../utils/rateLimit.js";

// 30 commands per minute per user
const limiter = new RateLimiter(30, 60_000);

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

  if (!user.isAllowed) {
    await ctx.reply("⛔ Access denied. You are not authorized to use this bot.");
    return;
  }

  await next();
}
