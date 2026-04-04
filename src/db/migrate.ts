import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "./client.js";
import { getLogger } from "../utils/logger.js";

export async function runMigrations(): Promise<void> {
  const logger = getLogger();
  logger.info("Running database migrations...");
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  logger.info("Migrations complete.");
}

// Support --migrate-only flag: run migrations and exit
if (process.argv.includes("--migrate-only")) {
  const { loadConfig } = await import("../config.js");
  const { initDb } = await import("./client.js");
  const config = loadConfig();
  initDb(config.databaseUrl);
  await runMigrations();
  process.exit(0);
}
