import type { Organization } from "../db/schema.js";
import type { PlanDefinition } from "./plans.js";
import { escapeHtml } from "../utils/html.js";

export interface UsageCounters {
  acceptedBillable: number;
  rejected: number;
  telegramDelivered: number;
  telegramFailed: number;
  telegramPending: number;
}

export interface PlanSummaryInput {
  plan: PlanDefinition;
  organization: Pick<Organization, "planCode" | "subscriptionStatus" | "currentPeriodEnd">;
}

export interface UsageSummaryInput {
  plan: PlanDefinition;
  month: string;
  counters: UsageCounters;
  egressBytes: bigint;
  storageBytes: bigint;
  aliasesUsed: number;
  allowRulesUsed: number;
}

export interface BillingStatusInput {
  plan: PlanDefinition;
  organization: Pick<Organization, "name" | "planCode" | "subscriptionStatus" | "currentPeriodEnd">;
  month: string;
  acceptedBillable: number;
  egressBytes: bigint;
  storageBytes: bigint;
  aliasesUsed: number;
}

const KIB = 1024n;
const MIB = KIB * 1024n;
const GIB = MIB * 1024n;

export function formatBytes(bytes: bigint): string {
  if (bytes < 0n) return "0 B";
  if (bytes < KIB) return `${bytes.toString()} B`;
  if (bytes < MIB) return `${formatScaled(bytes, KIB)} KB`;
  if (bytes < GIB) return `${formatScaled(bytes, MIB)} MB`;
  return `${formatScaled(bytes, GIB)} GB`;
}

export function formatBytesQuota(used: bigint, limit: bigint): string {
  return `${formatBytes(used)} / ${formatBytes(limit)} (${formatBytesPercent(used, limit)})`;
}

export function formatCountQuota(used: number, limit: number): string {
  if (limit <= 0) return `${used} / ${limit} (—)`;
  if (used > limit) return `${used} / ${limit} (100%+)`;
  const percent = Math.round((used / limit) * 100);
  return `${used} / ${limit} (${percent}%)`;
}

export function buildPlanSummaryText(input: PlanSummaryInput): string {
  const { plan, organization } = input;
  const status = organization.subscriptionStatus;
  const lines: string[] = [];

  lines.push(`<b>📦 Plan</b>`);
  lines.push(`Name: <b>${escapeHtml(plan.name)}</b>`);
  lines.push(`Status: <code>${escapeHtml(status)}</code>`);

  if (organization.currentPeriodEnd) {
    lines.push(`Renews/ends: <code>${organization.currentPeriodEnd.toISOString()}</code>`);
  }

  lines.push("");
  lines.push("<b>Limits</b>");
  lines.push(`• Aliases: <code>${plan.limits.aliases}</code>`);
  lines.push(`• Chats: <code>${plan.limits.chats}</code>`);
  lines.push(`• Allow rules: <code>${plan.limits.allowRules}</code>`);
  lines.push(`• Accepted emails / month: <code>${plan.limits.deliveredEmailsMonth}</code>`);
  lines.push(`• Egress / month: <code>${formatBytes(BigInt(plan.limits.egressBytesMonth))}</code>`);
  lines.push(`• Storage: <code>${formatBytes(BigInt(plan.limits.storageBytes))}</code>`);
  lines.push(
    `• Max message size: <code>${formatBytes(BigInt(plan.limits.maxMessageBytes))}</code>`,
  );
  lines.push(`• Retention: <code>${plan.limits.retentionDays} days</code>`);
  lines.push(`• Custom domains: <code>${plan.limits.customDomains}</code>`);

  return lines.join("\n");
}

export function buildUsageSummaryText(input: UsageSummaryInput): string {
  const { plan, month, counters, egressBytes, storageBytes, aliasesUsed, allowRulesUsed } = input;
  const lines: string[] = [];

  lines.push(`<b>📊 Usage — ${escapeHtml(month)}</b>`);
  lines.push(`Plan: <b>${escapeHtml(plan.name)}</b>`);
  lines.push("");
  lines.push("<b>Inbound mail this month</b>");
  lines.push(`• Accepted (billable): <code>${counters.acceptedBillable}</code>`);
  lines.push(`• Rejected: <code>${counters.rejected}</code>`);
  lines.push(`• Delivered to Telegram: <code>${counters.telegramDelivered}</code>`);
  lines.push(`• Telegram delivery failures: <code>${counters.telegramFailed}</code>`);
  lines.push(`• Pending / retrying: <code>${counters.telegramPending}</code>`);
  lines.push("");
  lines.push(
    "<i>Note: Telegram delivery failures and pending messages are still counted toward your " +
      "monthly billable total because the email was accepted into processing.</i>",
  );
  lines.push("");
  lines.push("<b>Bandwidth and storage</b>");
  lines.push(`• Egress: ${formatBytesQuota(egressBytes, BigInt(plan.limits.egressBytesMonth))}`);
  lines.push(`• Storage: ${formatBytesQuota(storageBytes, BigInt(plan.limits.storageBytes))}`);
  lines.push("");
  lines.push("<b>Workspace</b>");
  lines.push(`• Aliases: ${formatCountQuota(aliasesUsed, plan.limits.aliases)}`);
  lines.push(`• Allow rules: ${formatCountQuota(allowRulesUsed, plan.limits.allowRules)}`);

  return lines.join("\n");
}

export function buildBillingStatusText(input: BillingStatusInput): string {
  const { plan, organization, month, acceptedBillable, egressBytes, storageBytes, aliasesUsed } =
    input;
  const lines: string[] = [];

  lines.push(`<b>💳 Billing</b>`);
  lines.push(`Workspace: <b>${escapeHtml(organization.name)}</b>`);
  lines.push(`Plan: <b>${escapeHtml(plan.name)}</b>`);
  lines.push(`Status: <code>${escapeHtml(organization.subscriptionStatus)}</code>`);
  if (organization.currentPeriodEnd) {
    lines.push(`Renews/ends: <code>${organization.currentPeriodEnd.toISOString()}</code>`);
  }

  lines.push("");
  lines.push(`<b>This month — ${escapeHtml(month)}</b>`);
  lines.push(`• Accepted (billable): <code>${acceptedBillable}</code>`);
  lines.push(`• Egress: ${formatBytesQuota(egressBytes, BigInt(plan.limits.egressBytesMonth))}`);
  lines.push("");
  lines.push("<b>Workspace</b>");
  lines.push(`• Aliases: ${formatCountQuota(aliasesUsed, plan.limits.aliases)}`);
  lines.push(`• Storage: ${formatBytesQuota(storageBytes, BigInt(plan.limits.storageBytes))}`);

  return lines.join("\n");
}

function formatScaled(bytes: bigint, unit: bigint): string {
  // Convert to a Number with one-decimal precision, avoiding bigint→number lossy cast on huge values.
  const tenths = (bytes * 10n) / unit;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return `${whole.toString()}.${frac.toString()}`;
}

function formatBytesPercent(used: bigint, limit: bigint): string {
  if (limit <= 0n) return "—";
  const clamped = used < 0n ? 0n : used;
  if (clamped > limit) return "100%+";
  // (used * 100) / limit — bigint arithmetic stays safe for any plan size.
  const percent = (clamped * 100n) / limit;
  return `${percent.toString()}%`;
}

