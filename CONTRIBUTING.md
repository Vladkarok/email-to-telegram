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

- Node.js 20 or newer (`node --version` should print `v20.x.x` or
  higher).
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
