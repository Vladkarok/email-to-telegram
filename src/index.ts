import { execFile } from "child_process";
import { access, mkdir, constants } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { schedule } from "node-cron";
import { parseStartupOptions } from "./cli.js";
import { buildRetryWorkerOptions, loadStartupConfig } from "./startup/runtime.js";
import { createLogger, setLogger, stderrLoggerDestination } from "./utils/logger.js";
import { initDb, closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createHttpServer, startHttpServer } from "./http/server.js";
import { createBot, syncBotCommands } from "./telegram/bot.js";
import { setApi, getApi } from "./telegram/api.js";
import { markBotUnhealthy } from "./telegram/health.js";
import { createPollingController } from "./telegram/polling.js";
import { upsertAllowedUser } from "./db/repos/users.js";
import { createRetryRunner, runRetryWorker } from "./email/retry.js";
import { reconcileActivationMarkers, runCleanup } from "./storage/cleanup.js";
import { shutdownActivationNotices } from "./activation/notice.js";
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
import { createShutdown } from "./startup/shutdown.js";

async function main() {
  const startup = parseStartupOptions(process.argv.slice(2));

  // 1. Load and validate config (fail fast)
  const config = loadStartupConfig();
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

  if (config.storageEncryptionMode === "none" && config.nodeEnv === "production") {
    logger.warn(
      "STORAGE_ENCRYPTION_MODE=none: attachment and raw email files are not encrypted at rest",
    );
  }
  logger.info("Starting email-to-telegram");
  if (Object.keys(config.planLimitOverrides).length > 0) {
    logger.info({ planLimitOverrides: config.planLimitOverrides }, "plan limit overrides active");
  }
  configureStorageEncryption({
    mode: config.storageEncryptionMode,
    masterKey: config.masterEncryptionKey,
    masterKeyId: config.masterEncryptionKeyId,
    additionalMasterKeys: config.masterEncryptionKeyring,
  });

  // 3. Connect to DB and run migrations
  initDb(config.databaseUrl);
  await runMigrations(config.databaseUrl);

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

  // Deliveries made while this build was not running (a rollback window) set
  // no first-delivered marker; restore them before any notice can go out.
  await reconcileActivationMarkers(getDb(), logger);

  // 3b. Seed initial allowed users
  if (config.initialAllowedUsers.length > 0) {
    const db = getDb();
    await Promise.all(config.initialAllowedUsers.map((id) => upsertAllowedUser(db, id)));
    logger.info({ count: config.initialAllowedUsers.length }, "Seeded initial allowed users");
  }

  // 4. Start Telegram bot
  startSessionSweep();
  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;
  const bot = createBot(config.telegramBotToken, {
    isShuttingDown,
    staleTextMaxAgeS: config.staleTextUpdateMaxAgeS,
  });
  setApi(bot.api);
  markBotUnhealthy();
  const polling = createPollingController({
    bot,
    logger,
    isShuttingDown,
    syncCommands: syncBotCommands,
  });
  void polling.start();

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

  const retryRunner = createRetryRunner((shouldStop) =>
    runRetryWorker(getDb(), getApi(), { ...buildRetryWorkerOptions(config), shouldStop }),
  );

  const cronTasks = [
    // Retry failed deliveries every 5 minutes, one run at a time
    schedule("*/5 * * * *", () => {
      retryRunner.tick();
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

  // 7. Graceful shutdown, bounded by one 25-s deadline (Docker kills at 30 s)
  const shutdown = createShutdown(
    {
      begin: () => {
        shuttingDown = true; // the admission gate skips every update from here
        markBotUnhealthy();
        polling.cancelRestart();
        for (const task of cronTasks) void task.stop();
        retryRunner.stop();
      },
      stopNotices: shutdownActivationNotices,
      closeHttp: () => app.close(),
      stopBot: () => bot.stop(),
      pollingRun: () => polling.currentRun(),
      retryRun: () => retryRunner.activeRun(),
      pipelines: pipelineTracker,
      destroySessionStore,
      closeDb,
    },
    { logger, exit: (code) => process.exit(code) },
  );

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info({ httpPort: config.httpPort, mailDomain: config.mailDomain }, "Service ready");
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
