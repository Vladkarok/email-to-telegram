import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { countUsers, countUsersByPlan } from "../db/repos/users.js";
import { countChats } from "../db/repos/chats.js";
import { countAliasesByStatus } from "../db/repos/aliases.js";
import { countAttachmentStorage } from "../db/repos/attachments.js";
import { classifyTelegramError } from "../telegram/errorClassifier.js";

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

const deliveriesDeferredTotal = new Counter({
  name: "email_to_telegram_deliveries_deferred_total",
  help: "Inbound deliveries deferred to the retry worker because the in-flight cap was reached.",
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

const activeUsersByPlan = new Gauge({
  name: "email_to_telegram_active_users_by_plan",
  help: "Current users by plan code (the user IS the tenant).",
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

const usersTotalGauge = new Gauge({
  name: "email_to_telegram_users_total",
  help: "Total users across all plans.",
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

export function recordDeliveryDeferred(): void {
  deliveriesDeferredTotal.inc();
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

// All five business reads happen first; gauge mutations only execute once
// every read has succeeded. This makes `/metrics` either fully refresh to
// a consistent snapshot or fully retain its previous values on failure,
// matching the route's "serving last known values" promise.
export async function refreshBusinessGauges(db: Db): Promise<void> {
  const [planRows, userCounts, chatCounts, aliasRows, attachmentStats] = await Promise.all([
    countUsersByPlan(db),
    countUsers(db),
    countChats(db),
    countAliasesByStatus(db),
    countAttachmentStorage(db),
  ]);

  applyUsersByPlanGauges(planRows);
  applyUsersGauge(userCounts);
  applyChatsGauge(chatCounts);
  applyAliasesGauge(aliasRows);
  applyAttachmentsGauge(attachmentStats);
}

function applyUsersByPlanGauges(rows: Array<{ planCode: string; count: number }>): void {
  activeUsersByPlan.reset();
  let total = 0;
  for (const row of rows) {
    activeUsersByPlan.set({ plan: row.planCode }, row.count);
    total += row.count;
  }
  usersTotalGauge.set(total);
}

function applyUsersGauge(counts: { total: number; allowed: number }): void {
  usersGauge.set({ state: "total" }, counts.total);
  usersGauge.set({ state: "allowed" }, counts.allowed);
}

function applyChatsGauge(counts: { total: number; active: number }): void {
  chatsGauge.set({ state: "total" }, counts.total);
  chatsGauge.set({ state: "active" }, counts.active);
}

function applyAliasesGauge(rows: Array<{ status: string; count: number }>): void {
  aliasesGauge.reset();
  for (const row of rows) {
    aliasesGauge.set({ status: row.status }, row.count);
  }
}

function applyAttachmentsGauge(stats: { count: number; bytes: number }): void {
  attachmentsStoredGauge.set(stats.count);
  attachmentsStoredBytesGauge.set(stats.bytes);
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
