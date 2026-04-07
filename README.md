# email-to-telegram

Self-hosted email alias forwarding for Telegram.

The project lets you create email aliases from a Telegram bot, restrict who may
send to each alias, and forward accepted mail into a Telegram DM, group, or forum
topic. Attachments are stored on disk and exposed through expiring download links;
image attachments are also sent to Telegram directly when possible.

## Current Scope

Implemented today:

- Cloudflare Email Routing as the inbound mail layer
- A Cloudflare Worker that preflights aliases and streams raw MIME to the VPS
- A VPS app that parses mail, stores raw `.eml` files and attachments, and sends
  deliveries to Telegram
- Docker Compose services for the app, PostgreSQL, and Caddy

Not implemented today:

- Direct SMTP ingestion

If you need SMTP in the future, treat it as new work rather than something this
repository already supports.

## Architecture

```text
[Sender]
   -> [Cloudflare Email Routing]
   -> [Cloudflare Worker]
   -> [HTTPS endpoint on the VPS]
   -> [Telegram Bot API]
```

Important domain split:

- `MAIL_DOMAIN` is the zone root that receives mail, for example `example.com`
- `PUBLIC_BASE_URL` is the HTTPS host users download attachments from, for example
  `https://mail.example.com`

That means aliases look like `alerts-ab12cd@example.com`, while attachment links
can be served from `https://mail.example.com`.

## Bot Commands

| Command                                  | Description                                         |
| ---------------------------------------- | --------------------------------------------------- |
| `/start`                                 | Open the management menu in DM                      |
| `/newemail [name]`                       | Create an alias mapped to the current chat or topic |
| `/listemail`                             | List aliases you can manage                         |
| `/deleteemail <name>`                    | Delete an alias                                     |
| `/pauseemail <name>`                     | Pause an alias                                      |
| `/resumeemail <name>`                    | Resume an alias                                     |
| `/settings <name>`                       | Change render mode                                  |
| `/allow add <name> <email_or_domain>`    | Add an allow rule                                   |
| `/allow remove <name> <email_or_domain>` | Remove an allow rule                                |
| `/allow list <name>`                     | List allow rules                                    |
| `/help`                                  | Show help                                           |

## First Deployment Guide

This guide assumes:

- Your mail domain is `example.com`
- Your public HTTPS hostname is `mail.example.com`
- Your VPS public IP is `203.0.113.10`

Use your own values in place of those placeholders.

### 1. Prepare the prerequisites

You need:

- A domain managed in Cloudflare
- A Telegram bot token from `@BotFather`
- One Telegram user ID to bootstrap as the first operator
- A Linux VPS with Docker Engine and the Docker Compose plugin installed

The first operator matters: set `INITIAL_ALLOWED_USERS` in `.env` on the first
deploy, otherwise the bot starts but nobody is authorized to manage aliases.

### 2. Create the public DNS record

In Cloudflare DNS, create:

- `A` or `AAAA` for `mail.example.com` pointing to your VPS

`mail.example.com` is the HTTPS frontend for the app and attachment downloads.

### 3. Enable Cloudflare Email Routing on the zone root

In Cloudflare:

1. Open the zone for `example.com`
2. Enable Email Routing for the zone
3. Leave the routing target for later; you will point the catch-all rule to the
   Worker after it is deployed

Do not set `MAIL_DOMAIN` to `mail.example.com`. Mail aliases belong on the zone
root, for example `alerts@example.com`.

### 4. Clone the repo on the VPS

```bash
git clone <your-fork-or-repo-url> email-to-telegram
cd email-to-telegram
```

### 5. Configure the application environment

Start from the template:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `MAIL_DOMAIN=example.com`
- `PUBLIC_BASE_URL=https://mail.example.com`
- `HMAC_SECRET`
- `WORKER_SECRET`
- `INITIAL_ALLOWED_USERS=<your_telegram_user_id>`

Optional but useful on a real deployment:

- `BACKUP_DIR=/data/backups`
- `HEALTHCHECKS_URL=...`
- `ALERT_CHAT_ID=...`

### 6. Configure the bundled HTTPS proxy

Edit [`Caddyfile`](./Caddyfile) and replace `mail.example.com` with your real
public hostname.

The default compose stack includes Caddy, so a first deployment does not need an
external reverse proxy.

If you already run your own reverse proxy, you can remove or override the `caddy`
service and point your proxy at `app:3000` on the compose network.

### 7. Start the stack

For a first deployment from source, build locally:

```bash
docker compose up -d --build
```

Check the containers:

```bash
docker compose ps
```

### 8. Verify the VPS services

From the VPS or another machine:

```bash
curl -fsS https://mail.example.com/readyz
curl -fsS https://mail.example.com/healthz
```

Expected behavior:

- `/readyz` returns `200` when PostgreSQL is reachable
- `/healthz` returns `200` when the app is up and the Telegram bot is healthy

If `/healthz` stays `503`, check the bot token and outbound connectivity to the
Telegram Bot API.

### 9. Deploy the Cloudflare Worker

On any machine with Node.js and Wrangler installed:

```bash
cd cloudflare-worker
npm ci
npx wrangler login
npx wrangler secret put WORKER_SECRET
npx wrangler secret put VPS_URL
npm run deploy
```

Use these secret values:

- `WORKER_SECRET`: exactly the same value as in the VPS `.env`
- `VPS_URL`: your public app URL, for example `https://mail.example.com`

### 10. Connect Email Routing to the Worker

Back in Cloudflare:

1. Open `example.com`
2. Go to `Email -> Email Routing -> Routing rules`
3. Add or edit the catch-all rule
4. Set the action to `Send to Worker`
5. Choose the Worker you just deployed

At that point, mail for `*@example.com` will hit the Worker, be preflighted, and
then be forwarded to the VPS over HTTPS.

### 11. Bootstrap the Telegram side

1. Start a DM with your bot
2. Run `/start`
3. Add the bot to the target group or forum if you want deliveries there
4. In the bot DM, run `/start` again and select the chat
5. Create an alias with `/newemail alerts`
6. Add at least one allow rule, for example:

```text
/allow add alerts-ab12cd github.com
```

Without an allow rule, all mail to that alias is rejected.

### 12. Send a real test message

Send a message from an allowed sender to the generated alias, for example:

```text
alerts-ab12cd@example.com
```

Verify:

- the Telegram message appears
- attachment links work
- `/healthz` still returns `200`

## Configuration Reference

See [`.env.example`](./.env.example) for the authoritative template.

| Variable                | Required | Description                                             |
| ----------------------- | -------- | ------------------------------------------------------- |
| `POSTGRES_PASSWORD`     | Yes      | PostgreSQL password                                     |
| `DATABASE_URL`          | Yes      | PostgreSQL connection string                            |
| `TELEGRAM_BOT_TOKEN`    | Yes      | Telegram bot token                                      |
| `MAIL_DOMAIN`           | Yes      | Zone root mail domain, for example `example.com`        |
| `PUBLIC_BASE_URL`       | Yes      | Public HTTPS URL for downloads and Worker callbacks     |
| `HTTP_PORT`             | Yes      | Internal app port, default `3000`                       |
| `HMAC_SECRET`           | Yes      | Secret for attachment download tokens                   |
| `WORKER_SECRET`         | Yes      | Shared secret between Worker and VPS                    |
| `ATTACHMENT_DIR`        | Yes      | Attachment storage path                                 |
| `RAW_EMAIL_DIR`         | Yes      | Raw email storage path                                  |
| `ATTACHMENT_TTL_HOURS`  | No       | Attachment retention window                             |
| `RAW_EMAIL_TTL_HOURS`   | No       | Raw email retention window                              |
| `MAX_SIZE_BYTES`        | No       | Max accepted inbound body size                          |
| `INITIAL_ALLOWED_USERS` | No       | Initial Telegram operators; recommended on first deploy |
| `BACKUP_DIR`            | No       | Nightly backup directory                                |
| `HEALTHCHECKS_URL`      | No       | External heartbeat URL                                  |
| `ALERT_CHAT_ID`         | No       | Telegram chat for critical alerts                       |
| `LOG_LEVEL`             | No       | Log verbosity                                           |
| `NODE_ENV`              | No       | Environment name                                        |

Compose-only overrides:

- `APP_IMAGE` lets you pull a prebuilt image instead of building locally
- `IMAGE_TAG` selects which tag to run

For a first deployment from source, you can leave both unset.

## Development

```bash
npm ci
npm --prefix cloudflare-worker ci
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run lint
npm test
npm --prefix cloudflare-worker run typecheck
```

## Release Workflow

Tag-based releases are optional.

If you use the included GitHub Actions deploy workflow:

1. CI runs on `main`
2. Pushing a tag like `v1.2.3` builds `ghcr.io/<owner>/email-to-telegram`
3. The VPS deploy job checks out the exact tagged commit
4. Compose pulls the matching image tag and restarts the stack

That flow is for automated releases. A first deployment does not need GHCR and can
be done entirely with `docker compose up -d --build`.

## Other Docs

- [`email-to-telegram-plan.md`](./email-to-telegram-plan.md) is now just an archive note
- [`devdocs/encryption-todo.md`](./devdocs/encryption-todo.md) tracks future encryption work

## License

MIT — see [LICENSE](./LICENSE)
