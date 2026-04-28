import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getEffectivePlan } from "../../billing/limits.js";
import { buildPlanSummaryText } from "../../billing/usageSummary.js";
import { getPrimaryOrganizationForUser } from "../../tenant/currentOrganization.js";

const SELF_HOSTED_MESSAGE =
  "ℹ️ Billing is not enabled in self-hosted mode. /plan is only available on the hosted service.";

const NO_ORGANIZATION_MESSAGE =
  "❌ No hosted workspace found for your account. Use /start to set one up.";

export async function planHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  if (loadConfig().appMode !== "hosted") {
    await ctx.reply(SELF_HOSTED_MESSAGE);
    return;
  }

  const db = getDb();
  const organization = await getPrimaryOrganizationForUser(db, BigInt(ctx.from.id));
  if (!organization) {
    await ctx.reply(NO_ORGANIZATION_MESSAGE);
    return;
  }

  const plan = getEffectivePlan(organization);
  const text = buildPlanSummaryText({ plan, organization });
  await ctx.reply(text, { parse_mode: "HTML" });
}
