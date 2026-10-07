# Contributing to email-to-telegram

Thank you for your interest in contributing. This document covers the
basics: how to set up a dev environment, run the tests, and propose
changes.

## Code of conduct

Be kind. Critique code, not people. Disagreements are fine; personal
attacks, harassment, and discriminatory language are not. Maintainers
may close or hide comments that don't follow this.

## Getting started

### Prerequisites

- Node.js 22.19 or newer (`node --version` should print `v22.19.0` or
  higher; `mailauth` and `wrangler` both require it). The Docker image and
  CI run Node 24, so that is the version to develop against.
- PostgreSQL 16+ for local development (the repo ships a
  `docker-compose.yml` that includes Postgres).
- Docker Engine + Docker Compose v2 if you want to run the full stack
  locally.

### Local setup

```sh
git clone https://github.com/Vladkarok/email-to-telegram.git
cd email-to-telegram
npm ci
cp .env.example .env  # fill in the required values
npm run db:generate
npm run db:migrate
npm test
```

For an end-to-end run against a real Telegram bot, you also need a
Cloudflare account with Email Routing configured and a Cloudflare
Worker. See `README.md` for the first-deployment guide; for unit and
integration tests, the database is enough.

## Running tests

```sh
npm test                  # run all tests once
npm run test:watch        # watch mode while developing
npm run test:coverage     # report coverage
```

Tests must pass on `main`. New features and bug fixes should include
tests that fail before your change and pass after it.

The suites under `tests/db/` run against a real Postgres and are skipped
unless `TEST_DATABASE_URL` points at a server where they may create and drop
throwaway databases (CI sets it). Locally:

```sh
docker run -d --rm --name etg-test-pg -e POSTGRES_USER=app \
  -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://app:test@127.0.0.1:55432/postgres npm test
docker stop etg-test-pg
```

### Rendering changes

`tests/fixtures/golden/*.eml` are real (redacted) emails rendered exactly as
the delivery pipeline renders them; the recorded output lives next to each
file as `<name>.classic.txt` and `<name>.rich.html`. A rendering change
shows up as a diff of what Telegram would receive. After an intentional
change, refresh the recordings and review the diff:

```sh
UPDATE_GOLDEN=1 npx vitest run goldenRender
```

To see how any `.eml` renders without sending it anywhere:

```sh
npm run render:preview -- path/to/message.eml
```

Fixtures are public: replace addresses with `example.com` ones and strip
hostnames, `Received:` and signature headers before adding one.

## Database migrations

Migrations live in `drizzle/` and are generated with `npm run db:generate`.
A deploy applies them while the previous release is still serving, and an
automatic rollback runs the previous image on the new schema. So every
migration must work with the code of the release that is running when it is
applied, normally the one before yours:

- Expand first, contract one release later. To replace a column, add the new
  one and stop using the old one in one release, then drop the old column in a
  later release, once the release that still used it is no longer deployed.
- A new `NOT NULL` column needs a `DEFAULT`. Constraints, unique indexes and
  data changes (`UPDATE`, `DELETE`) must not break the running release's
  writes or reads.
- A migration that locks a large table for long is planned downtime; say so in
  the PR.

The reviewer of a contract migration checks which release production runs. A
deploy that skips the release a contract migration depends on, or a rollback
further back than the previous image, is outside the rule.

CI runs a compatibility lint (`.github/scripts/migration-compat-lint.ts`) on
the migrations a pull request adds. It flags `DROP TABLE`, `DROP COLUMN`,
`RENAME`, `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `ADD COLUMN ... NOT NULL`
without `DEFAULT`, `ADD CONSTRAINT`, `CREATE UNIQUE INDEX`, `UPDATE` and
`DELETE`. Each flagged statement needs a marker on the line directly before
it:

```sql
-- compat: v1.11.0 no longer uses email_addresses.max_emails_hour
ALTER TABLE "email_addresses" DROP COLUMN "max_emails_hour";
```

Use `-- compat: <release> no longer uses <object>` for a contract change,
naming the first release that no longer uses the object, and
`-- compat: safe, <reason>` for everything else (for example a constraint on a
table this migration creates). Drizzle may put `--> statement-breakpoint` at
the end of the previous line; the marker goes on its own line after it.

The lint only catches common shapes. It does not prove a migration is
compatible, and a marker is a claim for the reviewer to check. To run it
locally:

```sh
npx tsx .github/scripts/migration-compat-lint.ts drizzle/0013_example.sql
```

## Code style

- TypeScript with strict mode; prefer types over `any`.
- `npm run lint` (ESLint) and `npm run format:check` (Prettier) must
  pass.
- Run `npm run lint:fix` and `npm run format` to auto-fix where
  possible.
- Keep modules small and cohesive; prefer pure functions where the
  domain allows.

## Commit messages

This project follows [Conventional Commits][cc]:

[cc]: https://www.conventionalcommits.org/

```
<type>: <description>

<optional body>
```

Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
`perf`, `ci`.

Examples:

- `feat: add per-alias delivery cap`
- `fix(worker): handle empty raw body without throwing`
- `docs: clarify Cloudflare Email Routing setup`

Keep the subject line under ~72 characters. Use the body for the _why_,
not just the _what_.

## Branch naming

Short, descriptive, kebab-case. Examples:

- `fix/worker-empty-body`
- `feat/per-alias-cap`
- `docs/contributing-guide`

There is no enforced prefix scheme; clarity beats consistency.

## Pull requests

1. Fork the repo (or create a branch if you have write access).
2. Make your change in a focused branch.
3. Run `npm run lint`, `npm run typecheck`, and `npm test` locally.
4. Open a PR against `main` using the PR template.
5. CI must be green. A maintainer will review; expect comments,
   suggested changes, or a request for additional tests.

Smaller PRs are easier to review and land faster than large ones. If
your change is large, consider splitting it into a stack of related
PRs.

## Reporting bugs

Use the bug-report issue template. Redact tokens, IDs, and real email
addresses before posting logs.

## Reporting security vulnerabilities

Please do **not** file public issues for security vulnerabilities. See
[`SECURITY.md`](./SECURITY.md) for the private disclosure process.

## License

By contributing, you agree that your contributions will be licensed
under the [MIT License](./LICENSE) of this repository.
