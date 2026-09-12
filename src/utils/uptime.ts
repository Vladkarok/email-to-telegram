import { randomUUID } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import { getLogger } from "./logger.js";
import { retryAsync } from "./retryAsync.js";
import { evaluateInboundStall } from "../observability/inboundHealth.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * How long the worker contract must be failing with no accepted inbound
 * before the uptime check reports inbound as down. Long enough to ride out a
 * brief blip, short enough to catch a real outage within the hour instead of
 * days.
 */
const INBOUND_STALL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Consecutive failing checks a dimension must accumulate before it alerts. At
 * the 5-minute cron interval this rides out a single transient blip (an
 * isolated Telegram 502 or ETIMEDOUT, both observed in production) while still
 * catching a real outage within roughly five minutes.
 */
const ALERT_THRESHOLD = 2;

/** How long a still-failing dimension stays quiet before reminding. */
const REALERT_INTERVAL_MS = 60 * 60 * 1000;

/** Attempts for the Telegram probe, including the first. */
const TELEGRAM_PROBE_ATTEMPTS = 2;
const TELEGRAM_PROBE_RETRY_DELAY_MS = 2000;

export interface UptimeConfig {
  healthchecksUrl: string | undefined;
  alertChatId: bigint | undefined;
  /** Directories that must be writable for the service to function. */
  probeDirs?: string[];
}

interface ProbeResult {
  db: boolean;
  disk: boolean;
  telegram: boolean;
  inbound: boolean;
}

type Dimension = keyof ProbeResult;

interface DimensionState {
  consecutiveFailures: number;
  /** Timestamp of the last alert sent for this dimension, or null if none is outstanding. */
  alertedAt: number | null;
  /**
   * Set when an alerted dimension recovers, cleared only once the all-clear is
   * actually delivered. Kept separate from `alertedAt` so a recovery notice
   * that fails to send is retried on the next check without also suppressing a
   * fresh alert if the dimension goes down again.
   */
  pendingRecoveryNotice: boolean;
}

function freshState(): Record<Dimension, DimensionState> {
  const initial = (): DimensionState => ({
    consecutiveFailures: 0,
    alertedAt: null,
    pendingRecoveryNotice: false,
  });
  return { db: initial(), disk: initial(), telegram: initial(), inbound: initial() };
}

/**
 * Per-dimension alert state, held in memory like the inbound counters in
 * `observability/inboundHealth.ts`. Deliberately not persisted: the health
 * check must keep working when the database is the failing dimension, so it
 * cannot depend on a write path. A restart mid-outage re-alerts, which is the
 * safe direction to fail.
 */
let alertState = freshState();

export function resetUptimeAlertStateForTests(): void {
  alertState = freshState();
}

async function probeDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch (err: unknown) {
    getLogger().error({ err }, "uptime check: DB connectivity failed");
    return false;
  }
}

async function probeDisk(dirs: string[]): Promise<boolean> {
  // A real write+delete probe detects full disks and out-of-inodes failures
  // that fs.access(W_OK) would miss (permissions look fine but writes fail).
  const results = await Promise.all(
    dirs.map(async (dir) => {
      // UUID makes the filename unique per invocation so overlapping uptime checks
      // (5-min cron firing while a previous check is still running) don't race on
      // the same path and produce false ENOENT errors.
      const probeFile = join(dir, `.uptime-probe-${process.pid}-${randomUUID()}`);
      try {
        await writeFile(probeFile, "");
        await unlink(probeFile);
        return true;
      } catch (err: unknown) {
        getLogger().error({ err, dir }, "uptime check: disk write probe failed");
        // Best-effort cleanup if write succeeded but unlink failed
        await unlink(probeFile).catch(() => undefined);
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

async function probeTelegram(api: Api): Promise<boolean> {
  // Retried because this is the only probe crossing the public internet, and
  // the Telegram API returns isolated 502s. db and disk are local calls; a
  // failure there is real and the consecutive-check threshold covers them.
  try {
    await retryAsync(() => api.getMe(), {
      attempts: TELEGRAM_PROBE_ATTEMPTS,
      delaysMs: [TELEGRAM_PROBE_RETRY_DELAY_MS],
    });
    return true;
  } catch (err: unknown) {
    getLogger().error({ err }, "uptime check: Telegram API probe failed");
    return false;
  }
}

/**
 * Folds this run's probe results into the debounce state and decides what the
 * operator should be told. Splitting the decision from the send keeps the
 * state transitions testable and makes the "only mark alerted once the send
 * succeeds" rule explicit at the call site.
 */
function decideNotifications(
  result: ProbeResult,
  now: number,
): { toAlert: Dimension[]; recovered: Dimension[] } {
  const toAlert: Dimension[] = [];
  const recovered: Dimension[] = [];

  for (const [dimension, ok] of Object.entries(result) as [Dimension, boolean][]) {
    const state = alertState[dimension];

    if (ok) {
      // Only announce recovery for dimensions the operator was actually paged
      // about; a blip that never alerted needs no all-clear.
      if (state.alertedAt !== null) {
        state.pendingRecoveryNotice = true;
        state.alertedAt = null;
      }
      if (state.pendingRecoveryNotice) recovered.push(dimension);
      state.consecutiveFailures = 0;
      continue;
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures < ALERT_THRESHOLD) continue;

    const due = state.alertedAt === null || now - state.alertedAt >= REALERT_INTERVAL_MS;
    if (due) toAlert.push(dimension);
  }

  return { toAlert, recovered };
}

/**
 * Runs on a cron schedule:
 * 1. Checks DB connectivity.
 * 2. Checks that configured directories are writable.
 * 3. Checks Telegram API reachability.
 * 4. On all-healthy — pings healthchecks.io URL if configured.
 * 5. On a dimension failing ALERT_THRESHOLD consecutive checks — sends a
 *    Telegram alert to ALERT_CHAT_ID if configured, then stays quiet about
 *    that dimension until it recovers or REALERT_INTERVAL_MS elapses.
 * 6. On an alerted dimension recovering — sends a recovery notice.
 */
export async function runUptimeCheck(db: Db, api: Api | null, config: UptimeConfig): Promise<void> {
  const log = getLogger();

  const [dbOk, diskOk, telegramOk] = await Promise.all([
    probeDb(db),
    config.probeDirs && config.probeDirs.length > 0 ? probeDisk(config.probeDirs) : true,
    api ? probeTelegram(api) : true,
  ]);

  // Synchronous: reads in-memory inbound counters fed by recordRawInbound.
  // Catches "app healthy but no mail can get in" (e.g. a worker↔app signature
  // contract mismatch), which the db/disk/telegram probes cannot see.
  const inboundOk = !evaluateInboundStall(INBOUND_STALL_WINDOW_MS).stalled;

  const result: ProbeResult = { db: dbOk, disk: diskOk, telegram: telegramOk, inbound: inboundOk };
  const allOk = dbOk && diskOk && telegramOk && inboundOk;
  const now = Date.now();
  const { toAlert, recovered } = decideNotifications(result, now);

  if (allOk) {
    if (config.healthchecksUrl) {
      fetch(config.healthchecksUrl).catch((err: unknown) => {
        log.warn({ err }, "uptime check: healthchecks ping failed");
      });
    }
  } else {
    log.error({ result }, "uptime check: one or more probes failed");
  }

  if (!api || !config.alertChatId) return;
  const chatId = Number(config.alertChatId);

  if (recovered.length > 0) {
    const sent = await sendOperatorMessage(
      api,
      chatId,
      `✅ <b>email-to-telegram</b>: recovered (${recovered.join(", ")}).`,
      "recovery notice",
    );
    // Same rule as alerts: an all-clear the operator never received has not
    // been delivered, so keep it queued for the next check.
    if (sent) {
      for (const dimension of recovered) alertState[dimension].pendingRecoveryNotice = false;
    }
  }

  if (toAlert.length > 0) {
    const sent = await sendOperatorMessage(
      api,
      chatId,
      `🚨 <b>email-to-telegram</b>: health probe failed (${toAlert.join(", ")}). Service may be degraded.`,
      "alert",
    );
    // Record the alert only once it is actually delivered. Marking on attempt
    // would let a failed send swallow a real outage until the re-alert
    // interval elapsed.
    if (sent) {
      for (const dimension of toAlert) alertState[dimension].alertedAt = now;
    }
  }
}

async function sendOperatorMessage(
  api: Api,
  chatId: number,
  text: string,
  kind: string,
): Promise<boolean> {
  try {
    await api.sendMessage(chatId, text, { parse_mode: "HTML" });
    return true;
  } catch (err: unknown) {
    getLogger().error({ err, kind }, "uptime check: failed to send Telegram operator message");
    return false;
  }
}
