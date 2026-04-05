import { loadConfig } from "./config.js";
import { createLogger, setLogger } from "./utils/logger.js";
import { initDb, closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createHttpServer, startHttpServer } from "./http/server.js";
import { createBot } from "./telegram/bot.js";
import { setApi } from "./telegram/api.js";
import { upsertAllowedUser } from "./db/repos/users.js";

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

  // 6. Graceful shutdown
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
