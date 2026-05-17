import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { countOrganizationsByPlan } from "../db/repos/organizations.js";
import { countUsers } from "../db/repos/users.js";
import { countChats } from "../db/repos/chats.js";
import { countAliasesByStatus } from "../db/repos/aliases.js";
import { countAttachmentStorage } from "../db/repos/attachments.js";

type Db = NodePgDatabase<typeof schema>;

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ service: "email_to_telegram" });

collectDefaultMetrics({
  register: metricsRegistry,
  eventLoopMonitoringPrecision: 20,
});

const httpRequestsTotal = new Counter({
  name: "email_to_telegram_http_requests_total",
  help: "HTTP requests by route, method, and status class.",
  labelNames: ["route", "method", "status_class"] as const,
  registers: [metricsRegistry],
});

const httpRequestDurationSeconds = new Histogram({
  name: "email_to_telegram_http_request_duration_seconds",
  help: "HTTP request duration by route, method, and status class.",
  labelNames: ["route", "method", "status_class"] as const,
  buckets,
  registers: [metricsRegistry],
});

const inboundPreflightTotal = new Counter({
  name: "email_to_telegram_inbound_preflight_total",
  help: "Inbound preflight decisions by result and reason.",
  labelNames: ["result", "reason"] as const,
  registers: [metricsRegistry],
});

const rawInboundTotal = new Counter({
  name: "email_to_telegram_raw_inbound_total",
  help: "Raw inbound decisions by result and reason.",
  labelNames: ["result", "reason"] as const,
  registers: [metricsRegistry],
});

const deliveryAttemptsTotal = new Counter({
  name: "email_to_telegram_delivery_attempts_total",
  help: "Initial delivery attempts by result.",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

const retryAttemptsTotal = new Counter({
  name: "email_to_telegram_retry_attempts_total",
  help: "Retry delivery attempts by result.",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

const telegramSendFailuresTotal = new Counter({
  name: "email_to_telegram_telegram_send_failures_total",
  help: "Telegram send failures by coarse error class.",
  labelNames: ["error_class"] as const,
  registers: [metricsRegistry],
});

const manualPlanGrantsTotal = new Counter({
  name: "email_to_telegram_manual_plan_grants_total",
  help: "Manual plan grant events by plan.",
  labelNames: ["plan"] as const,
  registers: [metricsRegistry],
});

const quotaRejectionsTotal = new Counter({
  name: "email_to_telegram_quota_rejections_total",
  help: "Quota rejections by reason.",
  labelNames: ["reason"] as const,
  registers: [metricsRegistry],
});

const activeOrganizationsByPlan = new Gauge({
  name: "email_to_telegram_active_organizations",
  help: "Current organizations by plan code.",
  labelNames: ["plan"] as const,
  registers: [metricsRegistry],
});

const usersGauge = new Gauge({
  name: "email_to_telegram_users",
  help: "Telegram users known to the bot, partitioned by allow status.",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
});

const chatsGauge = new Gauge({
  name: "email_to_telegram_chats",
  help: "Telegram chats known to the bot, partitioned by activity.",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
});

const aliasesGauge = new Gauge({
  name: "email_to_telegram_aliases",
  help: "Email aliases by status.",
  labelNames: ["status"] as const,
  registers: [metricsRegistry],
});

const organizationsTotalGauge = new Gauge({
  name: "email_to_telegram_organizations_total",
  help: "Total organizations across all plans.",
  registers: [metricsRegistry],
});

const attachmentsStoredGauge = new Gauge({
  name: "email_to_telegram_attachments_stored",
  help: "Attachment rows currently stored in the database.",
  registers: [metricsRegistry],
});

const attachmentsStoredBytesGauge = new Gauge({
  name: "email_to_telegram_attachments_stored_bytes",
  help: "Sum of stored attachment sizes in bytes.",
  registers: [metricsRegistry],
});

export function recordHttpRequest(input: {
  route: string;
  method: string;
  statusCode: number;
  durationSeconds: number;
}): void {
  const labels = {
    route: normalizeRouteLabel(input.route),
    method: input.method,
    status_class: statusClass(input.statusCode),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, input.durationSeconds);
}

export function recordInboundPreflight(result: "accepted" | "rejected", reason: string): void {
  inboundPreflightTotal.inc({ result, reason });
}

export function recordRawInbound(result: "accepted" | "rejected", reason: string): void {
  rawInboundTotal.inc({ result, reason });
}

export function recordDeliveryAttempt(result: "succeeded" | "failed"): void {
  deliveryAttemptsTotal.inc({ result });
}

export function recordRetryAttempt(result: "succeeded" | "failed" | "permanently_failed"): void {
  retryAttemptsTotal.inc({ result });
}

export function recordTelegramSendFailure(error: string | null | undefined): void {
  telegramSendFailuresTotal.inc({ error_class: classifyTelegramError(error) });
}

export function recordManualPlanGrant(plan: string): void {
  manualPlanGrantsTotal.inc({ plan });
}

export function recordQuotaRejection(reason: string): void {
  quotaRejectionsTotal.inc({ reason });
}

export async function refreshActiveOrganizationsByPlan(db: Db): Promise<void> {
  activeOrganizationsByPlan.reset();
  const rows = await countOrganizationsByPlan(db);
  let total = 0;
  for (const row of rows) {
    activeOrganizationsByPlan.set({ plan: row.planCode }, row.count);
    total += row.count;
  }
  organizationsTotalGauge.set(total);
}

export async function refreshBusinessGauges(db: Db): Promise<void> {
  await Promise.all([
    refreshActiveOrganizationsByPlan(db),
    refreshUsersGauge(db),
    refreshChatsGauge(db),
    refreshAliasesGauge(db),
    refreshAttachmentsGauge(db),
  ]);
}

async function refreshUsersGauge(db: Db): Promise<void> {
  const { total, allowed } = await countUsers(db);
  usersGauge.set({ state: "total" }, total);
  usersGauge.set({ state: "allowed" }, allowed);
}

async function refreshChatsGauge(db: Db): Promise<void> {
  const { total, active } = await countChats(db);
  chatsGauge.set({ state: "total" }, total);
  chatsGauge.set({ state: "active" }, active);
}

async function refreshAliasesGauge(db: Db): Promise<void> {
  aliasesGauge.reset();
  const rows = await countAliasesByStatus(db);
  for (const row of rows) {
    aliasesGauge.set({ status: row.status }, row.count);
  }
}

async function refreshAttachmentsGauge(db: Db): Promise<void> {
  const { count: rowCount, bytes } = await countAttachmentStorage(db);
  attachmentsStoredGauge.set(rowCount);
  attachmentsStoredBytesGauge.set(bytes);
}

export function resetMetricsForTests(): void {
  metricsRegistry.resetMetrics();
}

function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

function normalizeRouteLabel(route: string): string {
  if (!route || route === "unknown") return "unknown";
  return route.replace(/:[^/]+/g, ":param");
}

function classifyTelegramError(error: string | null | undefined): string {
  const normalized = (error ?? "").toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("flood")) return "flood_wait";
  if (normalized.includes("forbidden") || normalized.includes("blocked")) return "forbidden";
  if (normalized.includes("bad request")) return "bad_request";
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "timeout";
  if (
    normalized.includes("network") ||
    normalized.includes("econn") ||
    normalized.includes("fetch")
  )
    return "network";
  return "other";
}
