import { access, constants } from "fs/promises";
import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import { getLogger } from "./logger.js";

type Db = NodePgDatabase<typeof schema>;

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
  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        await access(dir, constants.W_OK);
        return true;
      } catch (err: unknown) {
        getLogger().error({ err, dir }, "uptime check: disk write probe failed");
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

  const result: ProbeResult = { db: dbOk, disk: diskOk, telegram: telegramOk };
  const allOk = dbOk && diskOk && telegramOk;

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
