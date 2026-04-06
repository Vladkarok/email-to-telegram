import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _pool: pg.Pool | null = null;

export function getDb() {
  if (!_db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return _db;
}

export function initDb(databaseUrl: string) {
  _pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Surface pool errors so they appear in logs rather than crashing the process
  // with an unhandled 'error' event on the EventEmitter.
  _pool.on("error", (err) => {
    // Imported lazily to avoid a circular dep at module load time
    void import("../utils/logger.js").then(({ getLogger }) => {
      getLogger().error({ err }, "pg pool error");
    });
  });

  _db = drizzle(_pool, { schema });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
