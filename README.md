# email-to-telegram

Self-hosted replacement for the defunct **etlgr.io** service. Create email aliases via a Telegram bot and forward incoming emails to Telegram chats or forum topics.

## How it works

1. Add the bot to a Telegram group (or use it in DM)
2. Run `/newemail [name]` — the bot creates an alias like `alerts-k3x9m2@tgmail.example.com`
3. Add allowed senders with `/allow add alerts-k3x9m2 github.com`
4. Any email from an allowed sender to that alias appears in the chat

Attachments are stored on the VPS and served as expiring download links (not uploaded to Telegram).

## Architecture

```
[Sender] → [Cloudflare Email Routing] → [Email Worker] → [VPS HTTPS API] → [Telegram Bot]
```

The Cloudflare Email Worker handles ingestion: it does a preflight check (is this alias valid? is this sender allowed?), rejects unknown mail at the edge, and streams accepted raw MIME to the VPS.

## Tech stack

- **Runtime**: Node.js 20 + TypeScript (ESM, strict)
- **Bot**: grammY
- **HTTP**: Fastify
- **Database**: PostgreSQL 16 + Drizzle ORM
- **Email parsing**: mailparser
- **Deployment**: Docker Compose + Caddy (auto TLS)

## Bot commands

| Command                                  | Description                                      |
| ---------------------------------------- | ------------------------------------------------ |
| `/newemail [name]`                       | Create an alias mapped to this chat/topic        |
| `/listemail`                             | List aliases for this chat                       |
| `/deleteemail <name>`                    | Delete an alias                                  |
| `/pauseemail <name>`                     | Pause delivery (alias stays, mail rejected)      |
| `/resumeemail <name>`                    | Resume delivery                                  |
| `/settings <name>`                       | Change render mode (plaintext / html / markdown) |
| `/allow add <name> <email_or_domain>`    | Add allowed sender                               |
| `/allow remove <name> <email_or_domain>` | Remove allowed sender                            |
| `/allow list <name>`                     | Show allowed senders                             |
| `/help`                                  | Show all commands                                |

## Setup

See [email-to-telegram-plan.md](./email-to-telegram-plan.md) for the full architecture, database schema, and deployment guide.

### Quick start

```bash
cp .env.example .env
# edit .env with your values
docker compose up -d
```

### Environment variables

<!-- AUTO-GENERATED: from .env.example -->

| Variable                | Required | Description                                                          |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`     | Yes      | PostgreSQL password (must match `DATABASE_URL`)                      |
| `DATABASE_URL`          | Yes      | PostgreSQL connection string                                         |
| `TELEGRAM_BOT_TOKEN`    | Yes      | Bot token from @BotFather                                            |
| `MAIL_DOMAIN`           | Yes      | Domain for email aliases (e.g. `example.com`)                        |
| `PUBLIC_BASE_URL`       | Yes      | HTTPS URL of this server (for attachment links)                      |
| `INGEST_MODE`           | Yes      | `cloudflare` or `smtp`                                               |
| `SMTP_PORT`             | If smtp  | SMTP listen port inside container                                    |
| `HTTP_PORT`             | Yes      | HTTP server port (default `3000`)                                    |
| `HMAC_SECRET`           | Yes      | Secret for signing attachment tokens (min 16 chars)                  |
| `WORKER_SECRET`         | Yes      | Shared secret with Cloudflare Worker (min 16 chars)                  |
| `ATTACHMENT_DIR`        | Yes      | Path for storing attachments                                         |
| `RAW_EMAIL_DIR`         | Yes      | Path for storing raw emails                                          |
| `ATTACHMENT_TTL_HOURS`  | No       | Attachment retention in hours (default `336` = 14 days)              |
| `RAW_EMAIL_TTL_HOURS`   | No       | Raw email retention in hours (default `336`)                         |
| `MAX_SIZE_BYTES`        | No       | Max accepted message size in bytes (default `10485760` = 10 MiB)     |
| `INITIAL_ALLOWED_USERS` | No       | Comma-separated Telegram user IDs to pre-authorize                   |
| `LOG_LEVEL`             | No       | `trace`, `debug`, `info`, `warn`, `error`, `silent` (default `info`) |
| `NODE_ENV`              | No       | `development`, `production`, `test` (default `production`)           |

<!-- /AUTO-GENERATED -->

## Development

<!-- AUTO-GENERATED: scripts from package.json -->

| Command                 | Description                            |
| ----------------------- | -------------------------------------- |
| `npm run dev`           | Start with hot reload (tsx watch)      |
| `npm run build`         | Compile TypeScript to `dist/`          |
| `npm start`             | Run compiled output                    |
| `npm test`              | Run tests once                         |
| `npm run test:watch`    | Run tests in watch mode                |
| `npm run test:coverage` | Run tests with coverage report         |
| `npm run lint`          | ESLint                                 |
| `npm run lint:fix`      | ESLint with auto-fix                   |
| `npm run format`        | Prettier write                         |
| `npm run format:check`  | Prettier check (used in CI)            |
| `npm run typecheck`     | TypeScript type check (no emit)        |
| `npm run db:generate`   | Generate Drizzle migration from schema |
| `npm run db:migrate`    | Apply migrations via drizzle-kit       |

<!-- /AUTO-GENERATED -->

## Deployment

CI/CD via GitHub Actions. On push to `main`:

1. Lint + typecheck + test
2. SSH into VPS, pull latest image, `docker compose up -d`

## License

MIT — see [LICENSE](./LICENSE)
