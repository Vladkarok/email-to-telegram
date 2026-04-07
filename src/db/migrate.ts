import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "./client.js";
import { getLogger } from "../utils/logger.js";

export async function runMigrations(): Promise<void> {
  const logger = getLogger();
  logger.info("Running database migrations...");
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  logger.info("Migrations complete.");
}
