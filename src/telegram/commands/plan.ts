import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getEffectivePlan } from "../../billing/limits.js";
import { buildPlanSummaryText } from "../../billing/usageSummary.js";
import { getPrimaryOrganizationForUser } from "../../tenant/currentOrganization.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function planHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);

  if (loadConfig().appMode !== "hosted") {
    await ctx.reply(messages.billingCommands.planSelfHosted);
    return;
  }

  const organization = await getPrimaryOrganizationForUser(db, BigInt(ctx.from.id));
  if (!organization) {
    await ctx.reply(messages.common.noHostedWorkspace);
    return;
  }

  const plan = getEffectivePlan(organization);
  const text = buildPlanSummaryText({ plan, organization }, locale);
  await ctx.reply(text, { parse_mode: "HTML" });
}
