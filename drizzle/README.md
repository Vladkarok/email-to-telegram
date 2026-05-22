# Database migrations

Migrations in this folder are **hand-written SQL**. They are applied at startup
by `runMigrations()` (`src/db/migrate.ts`), which uses drizzle-orm's
`migrate()` — it reads `meta/_journal.json` and runs each `NNNN_*.sql` file not
yet recorded in the database's `__drizzle_migrations` table.

## Adding a migration

1. Update the schema source of truth in `src/db/schema/*.ts`.
2. Create the next file: `drizzle/NNNN_short_description.sql` (zero-padded,
   one greater than the current highest). Write plain SQL; use
   `IF NOT EXISTS` / `IF EXISTS` where practical so re-runs are safe. See
   `0007_delivery_view_link_unique_per_log.sql` for the dedupe-then-constrain
   pattern and `0021_attempt_log_no_unique.sql` for a recent example.
3. Add a matching entry to `meta/_journal.json` (`idx` = file number,
   `version: "7"`, a `when` timestamp greater than the previous entry, and the
   `tag` = file name without `.sql`).
4. Apply against a database with `npm run db:migrate`.

## Why not `drizzle-kit generate`

`drizzle-kit generate` (schema-diff migration authoring) is **not used** here.
Its snapshot history in `meta/` is frozen at `0014`; migrations `0015+` were
hand-authored. Running `generate` now diffs the current schema against the
stale `0014` snapshot and drops into interactive "table renamed or dropped?"
prompts — it cannot be run non-interactively, and re-baselining the snapshots
would break already-deployed databases (whose `__drizzle_migrations` table is
keyed to the existing files).

Hand-written migrations are the intended workflow. `drizzle-kit migrate` (the
apply path) is unaffected and is the only drizzle-kit command this project
relies on.
