import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import { getLogger } from "./logger.js";

type Db = NodePgDatabase<typeof schema>;

export interface UptimeConfig {
  healthchecksUrl: string | undefined;
  alertChatId: bigint | undefined;
}

/**
 * Runs on a cron schedule:
 * 1. Checks DB connectivity.
 * 2. On success — pings healthchecks.io URL if configured.
 * 3. On failure — sends a Telegram alert to ALERT_CHAT_ID if configured.
 */
export async function runUptimeCheck(db: Db, api: Api | null, config: UptimeConfig): Promise<void> {
  const log = getLogger();

  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch (err: unknown) {
    log.error({ err }, "uptime check: DB connectivity failed");
  }

  if (dbOk) {
    // Ping healthchecks.io (fire-and-forget, failures don't matter)
    if (config.healthchecksUrl) {
      fetch(config.healthchecksUrl).catch((err: unknown) => {
        log.warn({ err }, "uptime check: healthchecks ping failed");
      });
    }
    return;
  }

  // DB is down — send Telegram alert if possible
  if (api && config.alertChatId) {
    try {
      await api.sendMessage(
        Number(config.alertChatId),
        "🚨 <b>email-to-telegram</b>: database connectivity check failed. Service may be degraded.",
        { parse_mode: "HTML" },
      );
    } catch (err: unknown) {
      log.error({ err }, "uptime check: failed to send Telegram alert");
    }
  }
}
