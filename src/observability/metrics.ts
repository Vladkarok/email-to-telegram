import { readFileSync } from "node:fs";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { countUsers, countUsersByPlan } from "../db/repos/users.js";
import { countChats } from "../db/repos/chats.js";
import { countAliasesByStatus, countUsersWithAlias } from "../db/repos/aliases.js";
import { countAttachmentStorage } from "../db/repos/attachments.js";
import {
  NON_FINAL_DELIVERY_STATUSES,
  summarizeDeliveryBacklog,
  type DeliveryBacklogSummary,
} from "../db/repos/deliveryLogs.js";
import {
  countUsersEverDelivered,
  countUsersWithAcceptedMailInMonth,
  usageMonthForDate,
} from "../db/repos/usage.js";
import { classifyTelegramError, type TelegramErrorClass } from "../telegram/errorClassifier.js";
import { PLAN_CODES } from "../billing/plans.js";
import { noteRawInboundOutcome } from "./inboundHealth.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * accepted = the Worker may upload the mail; rejected = the Worker bounces it
 * (permanent 550); deferred = a 429, so the sending server retries later.
 */
export type InboundPreflightResult = "accepted" | "rejected" | "deferred";
export type DeliveryPath = "initial" | "retry";
/**
 * Where a delivery log was closed as permanently_failed: the first attempt
 * (blocked or deleted chat), the retry worker, or raw-email expiry cleanup.
 */
export type DeliveryLostStage = "initial" | "retry" | "cleanup";
/** Where the bounce that triggered a first-bounce notice was decided. */
export type ActivationNoticeStage = "raw" | "preflight";
/**
 * sent = Telegram acknowledged the notice; gated = the alias is working, not
 * active, or old with an owner who had mail accepted; not_claimed = the 24 h
 * window, the lifetime budget or a concurrent bounce took it; dropped = not
 * admitted (saturated, shutting down) or stopped by a deadline or shutdown;
 * stale = the alias or its claim changed before the send; failed = a DB or
 * Telegram error (a gate that cannot be read included: no notice).
 */
export type ActivationNoticeResult =
  | "sent"
  | "gated"
  | "not_claimed"
  | "dropped"
  | "stale"
  | "failed";
/** added = the rule exists now; expired = spent, replaced or stale button; failed = not added. */
export type ActivationAllowResult = "added" | "expired" | "failed";
/** stale = a text message older than STALE_TEXT_UPDATE_MAX_AGE_S when the bot got it. */
export type BotUpdateSkipReason = "stale";

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// Received → Telegram accepted. Most deliveries take a second or two; the
// tail covers the retry worker (minutes) up to the raw-email TTL (a day).
const deliveryLatencyBuckets = [0.5, 1, 2, 5, 10, 30, 60, 300, 900, 3600, 21600, 86400];

/**
 * The running version, from the package.json one level above `src/` and
 * `dist/` (the image copies it to /app). "unknown" when it cannot be read, so
 * a packaging mistake never stops the app from starting.
 */
export function readAppVersion(
  packageJsonUrl: URL = new URL("../../package.json", import.meta.url),
): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const APP_VERSION = readAppVersion();

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
  help: "Inbound preflight decisions by result and reason. accepted = the Worker may upload the mail; rejected = the Worker bounces it (permanent 550); deferred = answered 429 so the sending server retries later (reason rate_limited: the alias hourly cap).",
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

const deliveriesLostTotal = new Counter({
  name: "email_to_telegram_deliveries_lost_total",
  help: "Delivery logs closed as permanently_failed (the user never got the mail), by stage: initial = first attempt, retry = retry worker, cleanup = raw email expired before a delivery succeeded.",
  labelNames: ["stage"] as const,
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

const richMessagesTotal = new Counter({
  name: "email_to_telegram_rich_messages_total",
  help: "Telegram rich-message outcomes (success, classic fallback, or disabled).",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

const richIneligibleTotal = new Counter({
  name: "email_to_telegram_rich_ineligible_total",
  help: "Classic sends whose body had no rich payload because of a limit, by first limit hit.",
  labelNames: ["reason"] as const,
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

const activationNoticesTotal = new Counter({
  name: "email_to_telegram_activation_notices_total",
  help: "First-bounce notices to the owner of a not-yet-working alias, by the stage that bounced the mail (raw, preflight) and result: sent, gated, not_claimed (window or lifetime budget), dropped (admission or deadline), stale (alias or claim changed before the send), failed.",
  labelNames: ["stage", "result"] as const,
  registers: [metricsRegistry],
});

const activationAllowsTotal = new Counter({
  name: "email_to_telegram_activation_allows_total",
  help: "Taps on the one-tap allow button of a first-bounce notice, by result: added, expired (spent, replaced or stale button), failed (rule limit or DB error; the button is spent).",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

const botUpdatesSkippedTotal = new Counter({
  name: "email_to_telegram_bot_updates_skipped_total",
  help: "Telegram updates the bot received but did not handle, by reason: stale = a text message older than STALE_TEXT_UPDATE_MAX_AGE_S (a backlog after an outage); the user has to send it again.",
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
  help: "Telegram users known to the bot, partitioned by state (total, allowed, with_alias = has an undeleted alias, accepted_mail_this_month = mail accepted into processing this month, ever_delivered = mail accepted into processing in any month; Telegram send failures still count, permanent failures are refunded).",
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

const buildInfoGauge = new Gauge({
  name: "email_to_telegram_build_info",
  help: "Always 1; the version label is the running app version from package.json.",
  labelNames: ["version"] as const,
  registers: [metricsRegistry],
});

const deliveryLatencySeconds = new Histogram({
  name: "email_to_telegram_delivery_latency_seconds",
  help: "Seconds from a delivery log's received_at to Telegram accepting the first message of a successful delivery, by path (initial = the delivery right after acceptance, retry = the retry worker).",
  labelNames: ["path"] as const,
  buckets: deliveryLatencyBuckets,
  registers: [metricsRegistry],
});

const deliveryBacklogGauge = new Gauge({
  name: "email_to_telegram_delivery_backlog",
  help: "Delivery logs not in a final state yet, by final_status (received, processing, retrying, failed = waiting for the retry worker).",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
});

const deliveryBacklogOldestAgeGauge = new Gauge({
  name: "email_to_telegram_delivery_backlog_oldest_age_seconds",
  help: "Age in seconds (from received_at) of the oldest delivery log not in a final state; 0 when the backlog is empty.",
  registers: [metricsRegistry],
});

// Label values the counters can take, enumerated from their call sites. Each
// combination starts at 0 so its series exists before the first event:
// otherwise increase() cannot count that first event and stat panels show
// "No data" instead of 0. A reason missing here still works; its series just
// appears on its first event.
const INBOUND_LIMIT_REASONS = [
  "subscription_inactive",
  "message_size_limit",
  "storage_limit",
  "monthly_email_limit",
] as const;

/** Why a non-empty body had no rich payload: the renderer's first limit hit, or the delivery frame. */
export const RICH_INELIGIBLE_REASONS = [
  "input_limit",
  "text_limit",
  "block_limit",
  "column_limit",
  "depth_limit",
  "delivery_budget",
] as const;
export type RichIneligibleReason = (typeof RICH_INELIGIBLE_REASONS)[number];

const PREFLIGHT_REASONS: Record<InboundPreflightResult, readonly string[]> = {
  accepted: ["accepted"],
  rejected: [
    "missing_signature",
    "invalid_signature",
    "missing_local_part",
    "alias_not_found",
    "hosted_blocklist",
    "subscription_inactive",
    "monthly_email_limit",
    "sender_not_allowed",
  ],
  deferred: ["rate_limited"],
};

const RAW_REASONS: Record<"accepted" | "rejected", readonly string[]> = {
  accepted: ["accepted"],
  rejected: [
    "missing_signature",
    "unsupported_signature_version",
    "empty_body",
    "invalid_signature",
    "replayed_signature",
    "missing_local_part",
    "alias_not_found",
    "hosted_blocklist",
    ...INBOUND_LIMIT_REASONS,
    "duplicate",
    "rate_limited",
    "sender_not_allowed",
    "sender_auth_failed",
    "sender_auth_temperror",
  ],
};

// `satisfies` makes the compiler flag an error class added later but missing here.
const TELEGRAM_ERROR_CLASSES = Object.keys({
  flood_wait: true,
  forbidden: true,
  chat_not_found: true,
  migrated: true,
  bad_request: true,
  timeout: true,
  network: true,
  server: true,
  other: true,
  unknown: true,
} satisfies Record<TelegramErrorClass, true>);

const DELIVERY_PATHS: readonly DeliveryPath[] = ["initial", "retry"];
const ACTIVATION_NOTICE_STAGES: readonly ActivationNoticeStage[] = ["raw", "preflight"];
const ACTIVATION_NOTICE_RESULTS = Object.keys({
  sent: true,
  gated: true,
  not_claimed: true,
  dropped: true,
  stale: true,
  failed: true,
} satisfies Record<ActivationNoticeResult, true>);
const ACTIVATION_ALLOW_RESULTS = Object.keys({
  added: true,
  expired: true,
  failed: true,
} satisfies Record<ActivationAllowResult, true>);
const DELIVERY_LOST_STAGES: readonly DeliveryLostStage[] = ["initial", "retry", "cleanup"];
const BOT_UPDATE_SKIP_REASONS: readonly BotUpdateSkipReason[] = ["stale"];

function initializeSeries(): void {
  buildInfoGauge.set({ version: APP_VERSION }, 1);
  for (const [result, reasons] of Object.entries(PREFLIGHT_REASONS)) {
    for (const reason of reasons) inboundPreflightTotal.inc({ result, reason }, 0);
  }
  for (const [result, reasons] of Object.entries(RAW_REASONS)) {
    for (const reason of reasons) rawInboundTotal.inc({ result, reason }, 0);
  }
  for (const result of ["succeeded", "failed"]) deliveryAttemptsTotal.inc({ result }, 0);
  for (const result of ["succeeded", "failed", "permanently_failed"]) {
    retryAttemptsTotal.inc({ result }, 0);
  }
  for (const errorClass of TELEGRAM_ERROR_CLASSES) {
    telegramSendFailuresTotal.inc({ error_class: errorClass }, 0);
  }
  for (const result of ["success", "fallback", "disabled"]) richMessagesTotal.inc({ result }, 0);
  for (const reason of RICH_INELIGIBLE_REASONS) richIneligibleTotal.inc({ reason }, 0);
  for (const reason of INBOUND_LIMIT_REASONS) quotaRejectionsTotal.inc({ reason }, 0);
  for (const path of DELIVERY_PATHS) deliveryLatencySeconds.zero({ path });
  for (const stage of DELIVERY_LOST_STAGES) deliveriesLostTotal.inc({ stage }, 0);
  for (const plan of PLAN_CODES) manualPlanGrantsTotal.inc({ plan }, 0);
  for (const stage of ACTIVATION_NOTICE_STAGES) {
    for (const result of ACTIVATION_NOTICE_RESULTS)
      activationNoticesTotal.inc({ stage, result }, 0);
  }
  for (const result of ACTIVATION_ALLOW_RESULTS) activationAllowsTotal.inc({ result }, 0);
  for (const reason of BOT_UPDATE_SKIP_REASONS) botUpdatesSkippedTotal.inc({ reason }, 0);
}

initializeSeries();

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

export function recordInboundPreflight(result: InboundPreflightResult, reason: string): void {
  inboundPreflightTotal.inc({ result, reason });
}

export function recordRawInbound(result: "accepted" | "rejected", reason: string): void {
  rawInboundTotal.inc({ result, reason });
  noteRawInboundOutcome(result, reason);
}

export function recordDeliveryAttempt(result: "succeeded" | "failed"): void {
  deliveryAttemptsTotal.inc({ result });
}

export function recordDeliveryDeferred(): void {
  deliveriesDeferredTotal.inc();
}

/** Call only after the permanently_failed status write has succeeded. */
export function recordDeliveryLost(stage: DeliveryLostStage): void {
  deliveriesLostTotal.inc({ stage });
}

/**
 * Observes received → Telegram-accepted latency for a successful delivery.
 * Never throws: an invalid timestamp is dropped and clock skew is clamped to 0.
 */
export function recordDeliveryLatency(
  path: DeliveryPath,
  receivedAt: Date,
  deliveredAt: Date = new Date(),
): void {
  try {
    const seconds = (deliveredAt.getTime() - receivedAt.getTime()) / 1000;
    if (!Number.isFinite(seconds)) return;
    deliveryLatencySeconds.observe({ path }, Math.max(0, seconds));
  } catch {
    // Observability must never break the delivery path.
  }
}

export function recordRetryAttempt(result: "succeeded" | "failed" | "permanently_failed"): void {
  retryAttemptsTotal.inc({ result });
}

export function recordTelegramSendFailure(error: string | null | undefined): void {
  telegramSendFailuresTotal.inc({ error_class: classifyTelegramError(error) });
}

export function recordRichMessage(result: "success" | "fallback" | "disabled"): void {
  richMessagesTotal.inc({ result });
}

export function recordRichIneligible(reason: RichIneligibleReason): void {
  richIneligibleTotal.inc({ reason });
}

export function recordManualPlanGrant(plan: string): void {
  manualPlanGrantsTotal.inc({ plan });
}

export function recordQuotaRejection(reason: string): void {
  quotaRejectionsTotal.inc({ reason });
}

export function recordActivationNotice(
  stage: ActivationNoticeStage,
  result: ActivationNoticeResult,
): void {
  activationNoticesTotal.inc({ stage, result });
}

export function recordActivationAllow(result: ActivationAllowResult): void {
  activationAllowsTotal.inc({ result });
}

export function recordBotUpdateSkipped(reason: BotUpdateSkipReason): void {
  botUpdatesSkippedTotal.inc({ reason });
}

// All business reads happen first; gauge mutations only execute once
// every read has succeeded. This makes `/metrics` either fully refresh to
// a consistent snapshot or fully retain its previous values on failure,
// matching the route's "serving last known values" promise.
export async function refreshBusinessGauges(db: Db): Promise<void> {
  const [
    planRows,
    userCounts,
    chatCounts,
    aliasRows,
    attachmentStats,
    usersWithAlias,
    usersAcceptedMailThisMonth,
    usersEverDelivered,
    deliveryBacklog,
  ] = await Promise.all([
    countUsersByPlan(db),
    countUsers(db),
    countChats(db),
    countAliasesByStatus(db),
    countAttachmentStorage(db),
    countUsersWithAlias(db),
    countUsersWithAcceptedMailInMonth(db, usageMonthForDate()),
    countUsersEverDelivered(db),
    summarizeDeliveryBacklog(db),
  ]);

  applyUsersByPlanGauges(planRows);
  applyUsersGauge(userCounts, { usersWithAlias, usersAcceptedMailThisMonth, usersEverDelivered });
  applyChatsGauge(chatCounts);
  applyAliasesGauge(aliasRows);
  applyAttachmentsGauge(attachmentStats);
  applyDeliveryBacklogGauges(deliveryBacklog);
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

function applyUsersGauge(
  counts: { total: number; allowed: number },
  engagement: {
    usersWithAlias: number;
    usersAcceptedMailThisMonth: number;
    usersEverDelivered: number;
  },
): void {
  usersGauge.set({ state: "total" }, counts.total);
  usersGauge.set({ state: "allowed" }, counts.allowed);
  usersGauge.set({ state: "with_alias" }, engagement.usersWithAlias);
  usersGauge.set({ state: "accepted_mail_this_month" }, engagement.usersAcceptedMailThisMonth);
  usersGauge.set({ state: "ever_delivered" }, engagement.usersEverDelivered);
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

function applyDeliveryBacklogGauges(backlog: DeliveryBacklogSummary): void {
  // Every non-final state gets a series, so a drained state reads 0 instead
  // of keeping its last count.
  for (const state of NON_FINAL_DELIVERY_STATUSES) {
    deliveryBacklogGauge.set({ state }, backlog.counts[state] ?? 0);
  }
  const oldestAgeSeconds = backlog.oldestReceivedAt
    ? (Date.now() - backlog.oldestReceivedAt.getTime()) / 1000
    : 0;
  deliveryBacklogOldestAgeGauge.set(
    Number.isFinite(oldestAgeSeconds) ? Math.max(0, oldestAgeSeconds) : 0,
  );
}

/** Clears every metric, then restores the build info and zero-initialised series. */
export function resetMetricsForTests(): void {
  metricsRegistry.resetMetrics();
  initializeSeries();
}

function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

function normalizeRouteLabel(route: string): string {
  if (!route || route === "unknown") return "unknown";
  return route.replace(/:[^/]+/g, ":param");
}
