import type { User } from "../db/schema.js";
import type { PlanDefinition } from "./plans.js";
import { escapeHtml } from "../utils/html.js";
import { DEFAULT_LOCALE, getMessages, type Locale } from "../i18n/index.js";

export interface UsageCounters {
  acceptedBillable: number;
  rejected: number;
  telegramDelivered: number;
  telegramFailed: number;
  telegramPending: number;
}

export interface PlanSummaryInput {
  plan: PlanDefinition;
  user: Pick<User, "planCode" | "subscriptionStatus" | "currentPeriodEnd">;
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
  user: Pick<User, "planCode" | "subscriptionStatus" | "currentPeriodEnd"> & {
    /** Display name for the user (e.g. "@username" or "Telegram <id>"). */
    displayName: string;
  };
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

export function buildPlanSummaryText(
  input: PlanSummaryInput,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const { plan, user } = input;
  const messages = getMessages(locale).usageSummary;
  const status = user.subscriptionStatus;
  const lines: string[] = [];

  lines.push(messages.planTitle);
  lines.push(`${messages.name}: <b>${escapeHtml(plan.name)}</b>`);
  lines.push(`${messages.status}: <code>${escapeHtml(status)}</code>`);

  if (user.currentPeriodEnd) {
    lines.push(`${messages.renewsEnds}: <code>${user.currentPeriodEnd.toISOString()}</code>`);
  }

  lines.push("");
  lines.push(messages.limits);
  lines.push(`• ${messages.aliases}: <code>${plan.limits.aliases}</code>`);
  lines.push(`• ${messages.chats}: <code>${plan.limits.chats}</code>`);
  lines.push(`• ${messages.allowRules}: <code>${plan.limits.allowRules}</code>`);
  lines.push(`• ${messages.acceptedEmailsMonth}: <code>${plan.limits.deliveredEmailsMonth}</code>`);
  lines.push(
    `• ${messages.egressMonth}: <code>${formatBytes(BigInt(plan.limits.egressBytesMonth))}</code>`,
  );
  lines.push(
    `• ${messages.storage}: <code>${formatBytes(BigInt(plan.limits.storageBytes))}</code>`,
  );
  lines.push(
    `• ${messages.maxMessageSize}: <code>${formatBytes(BigInt(plan.limits.maxMessageBytes))}</code>`,
  );
  lines.push(`• ${messages.retention}: <code>${plan.limits.retentionDays} ${messages.days}</code>`);
  lines.push(`• ${messages.customDomains}: <code>${plan.limits.customDomains}</code>`);

  return lines.join("\n");
}

export function buildUsageSummaryText(
  input: UsageSummaryInput,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const { plan, month, counters, egressBytes, storageBytes, aliasesUsed, allowRulesUsed } = input;
  const messages = getMessages(locale).usageSummary;
  const lines: string[] = [];

  lines.push(messages.usageTitle(escapeHtml(month)));
  lines.push(`${messages.plan}: <b>${escapeHtml(plan.name)}</b>`);
  lines.push("");
  lines.push(messages.inboundThisMonth);
  lines.push(`• ${messages.acceptedBillable}: <code>${counters.acceptedBillable}</code>`);
  lines.push(`• ${messages.rejected}: <code>${counters.rejected}</code>`);
  lines.push(`• ${messages.deliveredTelegram}: <code>${counters.telegramDelivered}</code>`);
  lines.push(`• ${messages.telegramFailures}: <code>${counters.telegramFailed}</code>`);
  lines.push(`• ${messages.pendingRetrying}: <code>${counters.telegramPending}</code>`);
  lines.push("");
  lines.push(messages.billableNote);
  lines.push("");
  lines.push(messages.bandwidthStorage);
  lines.push(
    `• ${messages.egress}: ${formatBytesQuota(egressBytes, BigInt(plan.limits.egressBytesMonth))}`,
  );
  lines.push(
    `• ${messages.storage}: ${formatBytesQuota(storageBytes, BigInt(plan.limits.storageBytes))}`,
  );
  lines.push("");
  lines.push(messages.account);
  lines.push(`• ${messages.aliases}: ${formatCountQuota(aliasesUsed, plan.limits.aliases)}`);
  lines.push(
    `• ${messages.allowRules}: ${formatCountQuota(allowRulesUsed, plan.limits.allowRules)}`,
  );

  return lines.join("\n");
}

export function buildBillingStatusText(
  input: BillingStatusInput,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const { plan, user, month, acceptedBillable, egressBytes, storageBytes, aliasesUsed } = input;
  const messages = getMessages(locale).usageSummary;
  const lines: string[] = [];

  lines.push(messages.billingTitle);
  lines.push(`${messages.accountName}: <b>${escapeHtml(user.displayName)}</b>`);
  lines.push(`${messages.plan}: <b>${escapeHtml(plan.name)}</b>`);
  lines.push(`${messages.status}: <code>${escapeHtml(user.subscriptionStatus)}</code>`);
  if (user.currentPeriodEnd) {
    lines.push(`${messages.renewsEnds}: <code>${user.currentPeriodEnd.toISOString()}</code>`);
  }

  lines.push("");
  lines.push(messages.thisMonth(escapeHtml(month)));
  lines.push(`• ${messages.acceptedBillable}: <code>${acceptedBillable}</code>`);
  lines.push(
    `• ${messages.egress}: ${formatBytesQuota(egressBytes, BigInt(plan.limits.egressBytesMonth))}`,
  );
  lines.push("");
  lines.push(messages.account);
  lines.push(`• ${messages.aliases}: ${formatCountQuota(aliasesUsed, plan.limits.aliases)}`);
  lines.push(
    `• ${messages.storage}: ${formatBytesQuota(storageBytes, BigInt(plan.limits.storageBytes))}`,
  );

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
