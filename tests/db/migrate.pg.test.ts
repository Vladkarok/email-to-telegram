/**
 * The migration connection against a real Postgres (TEST_DATABASE_URL, see
 * tests/helpers/pgTestDb.ts): a migration that queues behind a table lock an
 * app transaction holds gives up at the 5-s lock_timeout and changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgTestDatabase, hasTestDatabase, type PgTestDatabase } from "../helpers/pgTestDb.js";
import { createLogger, setLogger } from "../../src/utils/logger.js";
import { runMigrations } from "../../src/db/migrate.js";

setLogger(createLogger("silent"));

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");
const PROBE_TAG = "9999_lock-probe";

interface Journal {
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
}

/** A copy of the migrations folder with one more migration on email_addresses. */
async function migrationsWithProbe(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "etg-migrations-"));
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  const last = journal.entries.at(-1)!;
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 1_000,
    tag: PROBE_TAG,
    breakpoints: true,
  });
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(
    join(folder, `${PROBE_TAG}.sql`),
    'ALTER TABLE "email_addresses" ADD COLUMN "lock_probe" integer;',
  );
  return folder;
}

function errorCode(err: unknown): string | undefined {
  // Drizzle wraps driver errors; the SQLSTATE is on the error or its cause.
  const withCode = err as { code?: string; cause?: { code?: string } };
  return withCode.code ?? withCode.cause?.code;
}

describe.skipIf(!hasTestDatabase)("runMigrations on real Postgres", () => {
  let testDb: PgTestDatabase;
  let folder: string;

  beforeAll(async () => {
    testDb = await createPgTestDatabase();
    await testDb.migrate();
    folder = await migrationsWithProbe();
  });

  afterAll(async () => {
    await testDb?.drop();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  async function appliedMigrations(): Promise<number> {
    const { rows } = await testDb.pool.query<{ n: string }>(
      "select count(*) as n from drizzle.__drizzle_migrations",
    );
    return Number(rows[0].n);
  }

  async function hasProbeColumn(): Promise<boolean> {
    const { rows } = await testDb.pool.query(
      `select 1 from information_schema.columns
       where table_name = 'email_addresses' and column_name = 'lock_probe'`,
    );
    return rows.length > 0;
  }

  it("fails after about 5 s behind a held table lock and leaves schema and history unchanged", async () => {
    const before = await appliedMigrations();
    const app = await testDb.client();
    try {
      // An app transaction that read the table holds ACCESS SHARE until it
      // ends; ALTER TABLE needs ACCESS EXCLUSIVE.
      await app.query("begin");
      await app.query("select 1 from email_addresses limit 1");

      const startedAt = Date.now();
      const err = await runMigrations(testDb.url, folder).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(errorCode(err)).toBe("55P03"); // lock_not_available
      expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      await app.query("rollback").catch(() => {});
      await app.end();
    }

    expect(await appliedMigrations()).toBe(before);
    expect(await hasProbeColumn()).toBe(false);
  }, 30_000);

  it("applies the same migration once the lock is gone", async () => {
    const before = await appliedMigrations();

    await runMigrations(testDb.url, folder);

    expect(await appliedMigrations()).toBe(before + 1);
    expect(await hasProbeColumn()).toBe(true);
  });
});
