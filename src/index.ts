import { execFile } from "child_process";
import { access, mkdir, constants } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { schedule } from "node-cron";
import { parseStartupOptions } from "./cli.js";
import { loadConfig } from "./config.js";
import { buildRetryWorkerOptions, nextPollingStartOptions } from "./startup/runtime.js";
import { createLogger, setLogger, stderrLoggerDestination } from "./utils/logger.js";
import { initDb, closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createHttpServer, startHttpServer } from "./http/server.js";
import { createBot } from "./telegram/bot.js";
import { setApi, getApi } from "./telegram/api.js";
import { markBotHealthy, markBotUnhealthy } from "./telegram/health.js";
import { upsertAllowedUser } from "./db/repos/users.js";
import { runRetryWorker } from "./email/retry.js";
import { runCleanup } from "./storage/cleanup.js";
import { runUptimeCheck } from "./utils/uptime.js";
import { pipelineTracker } from "./utils/inFlight.js";
import { startSessionSweep, destroySessionStore } from "./telegram/session.js";
import { configureStorageEncryption } from "./security/encryption.js";
import { assertStorageEncryptionReadiness } from "./startup/storageReadiness.js";
import {
  assertHostedDataLifecycleAllowed,
  hasHostedDataLifecycleOperation,
} from "./startup/hostedDataLifecycle.js";
import {
  assertHostedManualBillingAllowed,
  hasHostedManualBillingOperation,
} from "./startup/hostedManualBilling.js";
import { dispatchOperatorCommand } from "./cli/dispatcher.js";

async function main() {
  const startup = parseStartupOptions(process.argv.slice(2));

  // 1. Load and validate config (fail fast)
  const config = loadConfig();
  const hostedDataLifecycleOperation = hasHostedDataLifecycleOperation(startup);
  const hostedManualBillingOperation = hasHostedManualBillingOperation(startup);
  if (hostedDataLifecycleOperation) {
    assertHostedDataLifecycleAllowed(config);
  }
  if (hostedManualBillingOperation) {
    assertHostedManualBillingAllowed(config);
  }

  const isOperatorCommand = hostedDataLifecycleOperation || hostedManualBillingOperation;

  // 2. Initialize logger
  const logger = createLogger(
    config.logLevel,
    isOperatorCommand ? stderrLoggerDestination() : undefined,
  );
  setLogger(logger);
  logger.info("Starting email-to-telegram");
  configureStorageEncryption({
    mode: config.storageEncryptionMode,
    masterKey: config.masterEncryptionKey,
    masterKeyId: config.masterEncryptionKeyId,
    additionalMasterKeys: config.masterEncryptionKeyring,
  });

  // 3. Connect to DB and run migrations
  initDb(config.databaseUrl);
  await runMigrations();

  if (await dispatchOperatorCommand({ startup, config, logger })) {
    return;
  }

  // 3a. Ensure required directories exist and are writable (fail fast)
  const requiredDirs = [config.attachmentDir, config.rawEmailDir];
  if (config.backupDir) requiredDirs.push(config.backupDir);
  await Promise.all(
    requiredDirs.map(async (dir) => {
      await mkdir(dir, { recursive: true });
      // W_OK alone passes on mode-0200 dirs that lack the execute bit
      // (required to create entries).  W_OK | X_OK catches both cases.
      await access(dir, constants.W_OK | constants.X_OK).catch(() => {
        throw new Error(`Directory is not writable or not traversable: ${dir}`);
      });
    }),
  );
  await assertStorageEncryptionReadiness(getDb(), config);

  // 3b. Seed initial allowed users
  if (config.initialAllowedUsers.length > 0) {
    const db = getDb();
    await Promise.all(config.initialAllowedUsers.map((id) => upsertAllowedUser(db, id)));
    logger.info({ count: config.initialAllowedUsers.length }, "Seeded initial allowed users");
  }

  // 4. Start Telegram bot
  startSessionSweep();
  const bot = createBot(config.telegramBotToken);
  setApi(bot.api);
  markBotUnhealthy();
  let shuttingDown = false;
  let pollingRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let isInitialPollingStart = true;
  const startPolling = async () => {
    if (shuttingDown) return; // guard against already-queued setTimeout callbacks
    const pollingStart = nextPollingStartOptions(isInitialPollingStart);
    isInitialPollingStart = pollingStart.nextIsInitialPollingStart;

    try {
      await bot.api.getMe();
      markBotHealthy();
      await bot.start({ drop_pending_updates: pollingStart.dropPendingUpdates });
    } catch (err: unknown) {
      markBotUnhealthy();
      if (shuttingDown) return;
      logger.error({ err }, "Bot polling error — restarting in 5s");
      pollingRestartTimer = setTimeout(() => {
        void startPolling();
      }, 5000);
    }
  };
  void startPolling();

  // 5. Start HTTP server
  const app = await createHttpServer(config);
  await startHttpServer(app, config.httpPort);

  // 6. Background cron jobs — keep references so shutdown can stop them
  const cleanupConfig = {
    attachmentDir: config.attachmentDir,
    rawEmailDir: config.rawEmailDir,
    attachmentTtlHours: config.attachmentTtlHours,
    rawEmailTtlHours: config.rawEmailTtlHours,
    deliveryLogRetentionDays: config.deliveryLogRetentionDays,
  };

  const cronTasks = [
    // Retry failed deliveries every 5 minutes
    schedule("*/5 * * * *", () => {
      runRetryWorker(getDb(), getApi(), buildRetryWorkerOptions(config)).catch((err: unknown) => {
        logger.error({ err }, "retry worker error");
      });
    }),

    // Clean up expired files and old DB rows every 15 minutes
    schedule("*/15 * * * *", () => {
      runCleanup(getDb(), cleanupConfig).catch((err: unknown) => {
        logger.error({ err }, "cleanup worker error");
      });
    }),

    // Uptime check every 5 minutes
    schedule("*/5 * * * *", () => {
      runUptimeCheck(getDb(), getApi(), {
        healthchecksUrl: config.healthchecksUrl,
        alertChatId: config.alertChatId,
        probeDirs: [config.attachmentDir, config.rawEmailDir],
      }).catch((err: unknown) => {
        logger.error({ err }, "uptime check error");
      });
    }),
  ];

  // Nightly DB backup at 02:00 UTC
  if (config.backupDir) {
    if (config.storageEncryptionMode === "local-v1" && config.backupArchiveEncryption === "off") {
      logger.warn(
        "Nightly backups are enabled without backup archive encryption. Set BACKUP_ARCHIVE_ENCRYPTION=storage-key to protect database dumps at rest.",
      );
    }
    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "backup.sh");
    cronTasks.push(
      schedule(
        "0 2 * * *",
        () => {
          execFile(
            scriptPath,
            [config.backupDir!],
            { env: { ...process.env, DATABASE_URL: config.databaseUrl } },
            (err, stdout, stderr) => {
              if (err) {
                logger.error({ err, stderr }, "backup failed");
              } else {
                logger.info({ stdout: stdout.trim() }, "backup complete");
              }
            },
          );
        },
        { timezone: "UTC" },
      ),
    );
    logger.info(
      {
        backupDir: config.backupDir,
        archiveEncryption: config.backupArchiveEncryption,
      },
      "Nightly backup scheduled at 02:00 UTC",
    );
  }

  // 7. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    shuttingDown = true;
    markBotUnhealthy();
    if (pollingRestartTimer) {
      clearTimeout(pollingRestartTimer);
      pollingRestartTimer = null;
    }
    try {
      // 7a. Stop cron schedulers so no new background work starts.
      for (const task of cronTasks) void task.stop();

      // 7b. Close HTTP and stop bot in parallel — both stop accepting new work.
      // HTTP is closed first priority so that /inbound/raw stops triggering
      // new pipelines immediately; bot.stop() runs concurrently.
      await Promise.all([app.close(), bot.stop()]);

      // 7d. Wait for any in-flight email pipelines to finish before closing the DB.
      if (pipelineTracker.inFlight > 0) {
        logger.info({ inFlight: pipelineTracker.inFlight }, "Draining in-flight pipelines...");
        await pipelineTracker.drain(15_000).catch((err: unknown) => {
          logger.warn({ err }, "Pipeline drain timed out; proceeding with shutdown");
        });
      }
      destroySessionStore();
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
