import { schedule } from "node-cron";
import { loadConfig } from "./config.js";
import { createLogger, setLogger } from "./utils/logger.js";
import { initDb, closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createHttpServer, startHttpServer } from "./http/server.js";
import { createBot } from "./telegram/bot.js";
import { setApi, getApi } from "./telegram/api.js";
import { upsertAllowedUser } from "./db/repos/users.js";
import { runRetryWorker } from "./email/retry.js";
import { runCleanup } from "./storage/cleanup.js";
import { runUptimeCheck } from "./utils/uptime.js";

async function main() {
  // 1. Load and validate config (fail fast)
  const config = loadConfig();

  // 2. Initialize logger
  const logger = createLogger(config.logLevel);
  setLogger(logger);
  logger.info({ ingestMode: config.ingestMode }, "Starting email-to-telegram");

  // 3. Connect to DB and run migrations
  initDb(config.databaseUrl);
  await runMigrations();

  // 3a. Seed initial allowed users
  if (config.initialAllowedUsers.length > 0) {
    const db = getDb();
    await Promise.all(config.initialAllowedUsers.map((id) => upsertAllowedUser(db, id)));
    logger.info({ count: config.initialAllowedUsers.length }, "Seeded initial allowed users");
  }

  // 4. Start Telegram bot
  const bot = createBot(config.telegramBotToken);
  setApi(bot.api);
  const startPolling = () => {
    bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      logger.error({ err }, "Bot polling error — restarting in 5s");
      setTimeout(startPolling, 5000);
    });
  };
  startPolling();

  // 5. Start HTTP server
  const app = await createHttpServer(config);
  await startHttpServer(app, config.httpPort);

  // 6. Background cron jobs
  const cleanupConfig = {
    attachmentDir: config.attachmentDir,
    rawEmailDir: config.rawEmailDir,
    attachmentTtlHours: config.attachmentTtlHours,
    rawEmailTtlHours: config.rawEmailTtlHours,
  };

  // Retry failed deliveries every 5 minutes
  schedule("*/5 * * * *", () => {
    runRetryWorker(getDb(), getApi()).catch((err: unknown) => {
      logger.error({ err }, "retry worker error");
    });
  });

  // Clean up expired files and old DB rows every 15 minutes
  schedule("*/15 * * * *", () => {
    runCleanup(getDb(), cleanupConfig).catch((err: unknown) => {
      logger.error({ err }, "cleanup worker error");
    });
  });

  // Uptime check every 5 minutes
  schedule("*/5 * * * *", () => {
    runUptimeCheck(getDb(), getApi(), {
      healthchecksUrl: config.healthchecksUrl,
      alertChatId: config.alertChatId,
    }).catch((err: unknown) => {
      logger.error({ err }, "uptime check error");
    });
  });

  // 7. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    try {
      await bot.stop();
      await app.close();
      await closeDb();
      logger.info("Shutdown complete.");
      process.exit(0);
    } catch (err: unknown) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info({ httpPort: config.httpPort, mailDomain: config.mailDomain }, "Service ready");
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
