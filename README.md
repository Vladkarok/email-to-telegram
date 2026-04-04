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

See [`.env.example`](.env.example) for all required variables.

## Development

```bash
npm install
npm run dev          # start with hot reload
npm test             # run tests
npm run test:watch   # watch mode
npm run lint         # ESLint
npm run typecheck    # TypeScript check
```

## Deployment

CI/CD via GitHub Actions. On push to `main`:

1. Lint + typecheck + test
2. SSH into VPS, pull latest image, `docker compose up -d`

## License

MIT — see [LICENSE](./LICENSE)
