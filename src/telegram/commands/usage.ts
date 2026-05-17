import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getEffectivePlan } from "../../billing/limits.js";
import { buildUsageSummaryText } from "../../billing/usageSummary.js";
import { findUserById } from "../../db/repos/users.js";
import { countActiveAliasesByUser } from "../../db/repos/aliases.js";
import { countAllowRulesByUser } from "../../db/repos/allowRules.js";
import { countDeliveryLogsByUserInMonth } from "../../db/repos/deliveryLogs.js";
import { getUserStorageUsage } from "../../db/repos/storageUsage.js";
import { getUserUsageMonth, usageMonthForDate } from "../../db/repos/usage.js";
import { getLogger } from "../../utils/logger.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function usageHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);

  if (loadConfig().appMode !== "hosted") {
    await ctx.reply(messages.billingCommands.usageSelfHosted);
    return;
  }

  try {
    const userId = BigInt(ctx.from.id);
    const user = await findUserById(db, userId);
    if (!user) {
      await ctx.reply(messages.common.noHostedWorkspace);
      return;
    }

    const plan = getEffectivePlan(user);
    const month = usageMonthForDate();

    const [
      usage,
      storage,
      aliasesUsed,
      allowRulesUsed,
      telegramDelivered,
      telegramFailed,
      telegramPending,
    ] = await Promise.all([
      getUserUsageMonth(db, userId, month),
      getUserStorageUsage(db, userId),
      countActiveAliasesByUser(db, userId),
      countAllowRulesByUser(db, userId),
      countDeliveryLogsByUserInMonth(db, userId, month, ["delivered"]),
      countDeliveryLogsByUserInMonth(db, userId, month, ["failed"]),
      countDeliveryLogsByUserInMonth(db, userId, month, ["received", "processing", "retrying"]),
    ]);

    const storageBytes = (storage?.rawEmailBytes ?? 0n) + (storage?.attachmentBytes ?? 0n);

    const text = buildUsageSummaryText(
      {
        plan,
        month,
        counters: {
          acceptedBillable: usage?.deliveredCount ?? 0,
          rejected: usage?.rejectedCount ?? 0,
          telegramDelivered,
          telegramFailed,
          telegramPending,
        },
        egressBytes: usage?.egressBytes ?? 0n,
        storageBytes,
        aliasesUsed,
        allowRulesUsed,
      },
      locale,
    );

    await ctx.reply(text, { parse_mode: "HTML" });
  } catch (err: unknown) {
    getLogger().error({ err }, "usageHandler: failed to fetch usage data");
    await ctx.reply(messages.billingCommands.usageUnavailable);
  }
}
