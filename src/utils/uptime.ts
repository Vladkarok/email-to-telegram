import { randomUUID } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import { getLogger } from "./logger.js";
import { evaluateInboundStall } from "../observability/inboundHealth.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * How long the worker contract must be failing with no accepted inbound
 * before the uptime check reports inbound as down. Long enough to ride out a
 * brief blip, short enough to catch a real outage within the hour instead of
 * days.
 */
const INBOUND_STALL_WINDOW_MS = 60 * 60 * 1000;

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
  try {
    await api.getMe();
    return true;
  } catch (err: unknown) {
    getLogger().error({ err }, "uptime check: Telegram API probe failed");
    return false;
  }
}

/**
 * Runs on a cron schedule:
 * 1. Checks DB connectivity.
 * 2. Checks that configured directories are writable.
 * 3. Checks Telegram API reachability.
 * 4. On all-healthy — pings healthchecks.io URL if configured.
 * 5. On any failure — sends a Telegram alert to ALERT_CHAT_ID if configured.
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

  if (allOk) {
    if (config.healthchecksUrl) {
      fetch(config.healthchecksUrl).catch((err: unknown) => {
        log.warn({ err }, "uptime check: healthchecks ping failed");
      });
    }
    return;
  }

  log.error({ result }, "uptime check: one or more probes failed");

  if (api && config.alertChatId) {
    const failures = Object.entries(result)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)
      .join(", ");
    try {
      await api.sendMessage(
        Number(config.alertChatId),
        `🚨 <b>email-to-telegram</b>: health probe failed (${failures}). Service may be degraded.`,
        { parse_mode: "HTML" },
      );
    } catch (err: unknown) {
      log.error({ err }, "uptime check: failed to send Telegram alert");
    }
  }
}
