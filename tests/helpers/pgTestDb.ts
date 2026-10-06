/**
 * Real-Postgres test databases.
 *
 * Set TEST_DATABASE_URL to a server the tests may create databases on (CI
 * points it at its postgres service). Each call creates a fresh database,
 * runs the drizzle migrations into it, and drops it again in `drop()`.
 * Without TEST_DATABASE_URL the suites that use this skip.
 *
 *   docker run -d --rm --name etg-test-pg -e POSTGRES_USER=app \
 *     -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://app:test@127.0.0.1:55432/postgres npm test
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "../../src/db/schema.js";

export const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "";
export const hasTestDatabase = TEST_DATABASE_URL !== "";

export type TestDb = NodePgDatabase<typeof schema>;

export interface PgTestDatabase {
  url: string;
  pool: pg.Pool;
  db: TestDb;
  /** Runs migrations up to and including `lastTag` (all when omitted). */
  migrate(lastTag?: string): Promise<void>;
  /** A separate client, for holding locks or transactions across awaits. */
  client(): Promise<pg.Client>;
  drop(): Promise<void>;
}

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

interface Journal {
  entries: Array<{ tag: string }>;
}

/** A copy of the migrations folder whose journal stops at `lastTag`. */
async function migrationsUpTo(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "etg-migrations-"));
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  const index = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (index === -1) throw new Error(`unknown migration ${lastTag}`);
  journal.entries = journal.entries.slice(0, index + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

export async function createPgTestDatabase(): Promise<PgTestDatabase> {
  const server = new URL(TEST_DATABASE_URL);
  const name = `etg_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: server.toString() });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(server);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
  const db = drizzle(pool, { schema });

  return {
    url: url.toString(),
    pool,
    db,
    async migrate(lastTag?: string) {
      if (!lastTag) {
        await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
        return;
      }
      const folder = await migrationsUpTo(lastTag);
      try {
        await migrate(db, { migrationsFolder: folder });
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    async client() {
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      return client;
    },
    async drop() {
      await pool.end().catch(() => {});
      const cleanup = new pg.Client({ connectionString: server.toString() });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists ${name} with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
