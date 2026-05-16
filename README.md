# email-to-telegram

Self-hosted email alias forwarding for Telegram.

The project lets you create email aliases from a Telegram bot, restrict who may
send to each alias, and forward accepted mail into a Telegram DM, group, or forum
topic. Attachments are stored on disk and exposed through expiring download links;
image attachments are also sent to Telegram directly when possible.

## Intended Use And Trust Model

This project is intended for operational alerts, monitoring mail, and convenience
forwarding where seeing the message in Telegram is faster than watching a busy inbox.

Do not use this project as a secure vault or a safe channel for secrets, recovery
codes, credentials, medical/legal/financial records, or other regulated or highly
confidential content.

Current trust model:

- The VPS operator and anyone with access to its backups may be able to access stored mail content
- Anyone with access to the destination Telegram chat can read forwarded messages
- Anyone with access to the bot token has meaningful visibility into bot-delivered content
- Telegram forwarding is a convenience channel, not a life-safety or sole paging system

## Current Scope

Implemented today:

- Cloudflare Email Routing as the inbound mail layer
- A Cloudflare Worker that preflights aliases and streams raw MIME to the VPS
- A VPS app that parses mail, stores raw `.eml` files and attachments, and sends
  deliveries to Telegram
- A checked-in Docker Compose file for the existing VPS deployment shape
- Standalone first-deploy examples under `docs/examples/`

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
| `/settings <name>`                       | Change render mode, body dedup, and privacy mode    |
| `/allow add <name> <email_or_domain>`    | Add an allow rule                                   |
| `/allow remove <name> <email_or_domain>` | Remove an allow rule                                |
| `/allow list <name>`                     | List allow rules                                    |
| `/language`                              | Choose bot language                                 |
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
- `BACKUP_ARCHIVE_ENCRYPTION=storage-key`
- `HEALTHCHECKS_URL=...`
- `ALERT_CHAT_ID=...`

### 6. Choose the deployment shape

The checked-in [`docker-compose.yml`](./docker-compose.yml) publishes the app
on `${HOST_BIND_IP}:3000`, expecting a separate reverse proxy (Caddy, nginx,
Cloudflare Tunnel, etc.) on another host or the same host to terminate TLS and
forward to that interface. `HOST_BIND_IP` is required — compose refuses to start
without it — and should be set to the private interface the reverse proxy reaches,
never `0.0.0.0`.

For a clean first install where you want everything in one compose file, use the
standalone examples instead:

- [`docs/examples/docker-compose.standalone.yml`](./docs/examples/docker-compose.standalone.yml)
- [`docs/examples/Caddyfile`](./docs/examples/Caddyfile)

Edit the example Caddyfile and replace `mail.example.com` with your real public
hostname.

### 7. Start the stack

For a clean first deployment from source, build with the standalone example:

```bash
docker compose -f docs/examples/docker-compose.standalone.yml up -d --build
```

Check the containers:

```bash
docker compose -f docs/examples/docker-compose.standalone.yml ps
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

### Alias settings

Each alias currently has three delivery-format settings:

- Render mode: `plaintext`, `html`, or `markdown`
- Privacy mode: `on` or `off`
- Body dedup: `on` or `off`

Privacy mode is off by default for new aliases. When enabled, Telegram receives
only a minimal alert and a browser view link instead of the email body. The
browser flow asks for one more confirmation before revealing the message, and
attachment download links are minted only inside that browser view.

Message-ID duplicates are still blocked when that header is present.

Body dedup is off by default for new aliases because alerting systems often send
repeated messages with the same body, and hiding those by default is riskier than
letting a duplicate through.

Upgraded installations keep body dedup enabled on existing aliases so behavior does
not change unexpectedly until you choose to change that setting.

### Operator admin UI

Hosted deployments can enable a small internal admin Web UI for support and
manual billing operations.

Enable it in `.env`:

```bash
ADMIN_ENABLED=true
ADMIN_SECRET=<random secret at least 32 characters>
ADMIN_SESSION_SECRET=<optional separate random secret at least 32 characters>
ADMIN_SESSION_TTL_MINUTES=60
```

Generate secrets with:

```bash
openssl rand -hex 32
```

Open:

```text
https://mail.example.com/admin
```

The app redirects to `/admin/login`. There is no username in the first admin
version: paste `ADMIN_SECRET` into the login form. After login, the admin UI can
search users, inspect organizations, and grant/renew/downgrade manual plans from
the organization detail page.

Operational notes:

- Admin routes are disabled unless `ADMIN_ENABLED=true`.
- In production, admin requires `PUBLIC_BASE_URL` to be HTTPS.
- Change `ADMIN_SECRET` and restart the app to rotate the login secret and end
  existing admin sessions.
- Disable the admin UI by setting `ADMIN_ENABLED=false` and restarting the app.
- Keep `/admin` behind your normal HTTPS reverse proxy; adding Cloudflare Access
  or Tailscale in front of it is recommended for hosted operations.

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

| Variable                      | Required | Description                                                |
| ----------------------------- | -------- | ---------------------------------------------------------- |
| `POSTGRES_PASSWORD`           | Yes      | PostgreSQL password                                        |
| `DATABASE_URL`                | Yes      | PostgreSQL connection string                               |
| `TELEGRAM_BOT_TOKEN`          | Yes      | Telegram bot token                                         |
| `MAIL_DOMAIN`                 | Yes      | Zone root mail domain, for example `example.com`           |
| `PUBLIC_BASE_URL`             | Yes      | Public HTTPS URL for downloads and Worker callbacks        |
| `HTTP_PORT`                   | Yes      | Internal app port, default `3000`                          |
| `HMAC_SECRET`                 | Yes      | Secret for attachment download tokens                      |
| `WORKER_SECRET`               | Yes      | Shared secret between Worker and VPS                       |
| `ATTACHMENT_DIR`              | Yes      | Attachment storage path                                    |
| `RAW_EMAIL_DIR`               | Yes      | Raw email storage path                                     |
| `ATTACHMENT_TTL_HOURS`        | No       | Attachment retention window                                |
| `RAW_EMAIL_TTL_HOURS`         | No       | Raw email retention window                                 |
| `DELIVERY_LOG_RETENTION_DAYS` | No       | Delivery log and retry-attempt retention window            |
| `STORAGE_ENCRYPTION_MODE`     | No       | `none` or `local-v1` for at-rest attachment/raw encryption |
| `MASTER_ENCRYPTION_KEY`       | No       | Required for `local-v1`; 32-byte base64 or hex key         |
| `MASTER_ENCRYPTION_KEY_ID`    | No       | Optional key label stored with wrapped DEKs                |
| `MASTER_ENCRYPTION_KEYRING`   | No       | Older read-only local keys for staged key rotation         |
| `MAX_SIZE_BYTES`              | No       | Max accepted inbound body size                             |
| `INITIAL_ALLOWED_USERS`       | No       | Initial Telegram operators; recommended on first deploy    |
| `BACKUP_DIR`                  | No       | Nightly backup directory                                   |
| `BACKUP_ARCHIVE_ENCRYPTION`   | No       | `off` or `storage-key`; `yes` is invalid                   |
| `HEALTHCHECKS_URL`            | No       | External heartbeat URL                                     |
| `ALERT_CHAT_ID`               | No       | Telegram chat for critical alerts                          |
| `ADMIN_ENABLED`               | No       | Enable internal `/admin` Web UI                            |
| `ADMIN_SECRET`                | No       | Login secret required when admin is enabled                |
| `ADMIN_SESSION_SECRET`        | No       | Optional separate admin session cookie signing secret      |
| `ADMIN_SESSION_TTL_MINUTES`   | No       | Admin session lifetime, default `60`                       |
| `METRICS_ENABLED`             | No       | Enable protected Prometheus `/metrics` endpoint            |
| `METRICS_TOKEN`               | No       | Bearer token required when metrics are enabled             |
| `LOG_LEVEL`                   | No       | Log verbosity                                              |
| `NODE_ENV`                    | No       | Environment name                                           |

`STORAGE_ENCRYPTION_MODE=local-v1` encrypts new attachment and raw email files
at rest with envelope encryption. Existing plaintext files remain readable, so
you can enable this on a running system without breaking old rows. The current
implementation does not support disabling encryption while encrypted files still
exist; the app will refuse to start in those states. Local key rotation is
staged by keeping older read-only keys configured until stored DEKs are
rewrapped.

For staged local-key rotation, keep the new write key in `MASTER_ENCRYPTION_KEY`
and list older read-only keys in `MASTER_ENCRYPTION_KEYRING` as
`key-id=base64_or_hex_key;key-id-2=...` until you finish rewrapping stored DEKs.

Nightly backups created via `BACKUP_DIR` contain only the PostgreSQL dump. Keep
the attachment/raw-mail directories alongside those backups, and if encryption
is enabled, keep the matching `MASTER_ENCRYPTION_KEY` available for restore.
`BACKUP_ARCHIVE_ENCRYPTION` is an enum, not a boolean: use `off` or
`storage-key`. If `BACKUP_ARCHIVE_ENCRYPTION=storage-key`, the dump itself is
encrypted with the same storage-key family configured by
`MASTER_ENCRYPTION_KEY`, `MASTER_ENCRYPTION_KEY_ID`, and
`MASTER_ENCRYPTION_KEYRING`, and stored as
`backup-YYYY-MM-DD.sql.gz.etg` and the sidecar `.meta` file records the wrapped
DEK and AAD needed for decryption. Restore those archives with:

```bash
MASTER_ENCRYPTION_KEY=... node dist/backupArchiveCli.js decrypt \
  /data/backups/backup-YYYY-MM-DD.sql.gz.etg \
  /tmp/restored.sql.gz \
  /data/backups/backup-YYYY-MM-DD.meta
```

If the backup archive was wrapped under an older key id, also set
`MASTER_ENCRYPTION_KEYRING` with the matching read-only legacy key before
running the decrypt command.

The database also stores the filesystem paths for attachment/raw-email blobs, so
restores should reuse the same `ATTACHMENT_DIR` / `RAW_EMAIL_DIR` paths that the
service used when those files were written. Raw-email files are also pruned on
their own TTL, so older `delivery_logs` rows remain for audit/retry history
without claiming that the original MIME is still restorable.

Enable Prometheus scraping with `METRICS_ENABLED=true` and a random
`METRICS_TOKEN` of at least 32 characters. Scrape `/metrics` with
`Authorization: Bearer <token>`. The endpoint exports process/runtime metrics,
HTTP route metrics, inbound pipeline counters, delivery/retry counters, manual
billing grant counters, quota rejection counters, and active organizations by
plan. Roll back by setting `METRICS_ENABLED=false` and restarting the app.

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

If you use the included GitHub Actions workflows:

1. CI runs on both `dev` and `main`, and on pull requests targeting either branch
2. The production VPS stays release-only; there is no built-in workflow that
   deploys `dev` automatically to `oracle-shiny`
3. Pushing a release tag like `v1.2.3` builds `:latest` plus `:v1.2.3`
4. The release deploy job checks out the exact tagged commit on the VPS,
   pulls the matching image tag, and restarts the stack
5. The same release workflow also has a manual `workflow_dispatch` path, so you
   can redeploy an existing release tag from the GitHub Actions UI without
   creating a new tag

The important operational detail is that the checked-out VPS repo and the
running app image are related but not identical concerns. `git pull` updates the
compose/config files on disk; the running bot version changes only after Docker
pulls the matching GHCR image and recreates the container with the desired
`IMAGE_TAG`.

That workflow is for this repository's existing VPS layout. A fresh install does
not need GHCR and can be done entirely with the standalone example compose file.

## Other Docs

- [`devdocs/encryption-todo.md`](./devdocs/encryption-todo.md) tracks future encryption work
- [`docs/examples/docker-compose.standalone.yml`](./docs/examples/docker-compose.standalone.yml) is a clean first-install compose example
- [`docs/examples/Caddyfile`](./docs/examples/Caddyfile) is the matching Caddy example

## License

MIT — see [LICENSE](./LICENSE)
