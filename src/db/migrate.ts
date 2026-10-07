import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { getLogger } from "../utils/logger.js";

/**
 * Session limits for the migration connection. A migration that queues
 * behind an app transaction's lock gives up after 5 s instead of blocking
 * every query behind it; one statement may run for 2 min.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 5_000;
const MIGRATION_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * Applies pending migrations on a connection of its own, not the app pool:
 * the history read and the migration transaction share one connection with
 * the limits above (a `SET` on the pool would reach one pooled connection
 * only). An error rolls the whole transaction back.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder = "./drizzle",
): Promise<void> {
  const logger = getLogger();
  logger.info("Running database migrations...");
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    lock_timeout: MIGRATION_LOCK_TIMEOUT_MS,
    statement_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
  });
  // A dropped connection fails the running query; without a listener it
  // would also crash the process with an unhandled 'error' event.
  client.on("error", (err) => {
    logger.warn({ err }, "migration connection error");
  });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end().catch((err: unknown) => {
      logger.warn({ err }, "Failed to close the migration connection");
    });
  }
  logger.info("Migrations complete.");
}
