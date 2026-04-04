import type { Context, NextFunction } from "grammy";
import { getDb } from "../../db/client.js";
import { upsertUser } from "../../db/repos/users.js";

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.from) return;

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
