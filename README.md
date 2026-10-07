# email-to-telegram

Email aliases that deliver to Telegram. Create an address from a Telegram bot,
choose who may send to it, and read what arrives in a DM, a group, or a forum
topic.

Read this in: [Українська](README.uk.md) · [中文](README.zh-CN.md) ·
[Français](README.fr.md) · [Italiano](README.it.md)

![Demo: create alias, send email, receive in Telegram](docs/assets/demo.gif)

## Two ways to use it

**Use the hosted bot.** Open [@tgemails_Bot](https://t.me/tgemails_Bot), send
`/start`, then `/newemail`. The address works a few seconds later. You need no
domain, no server and no Cloudflare account. There is a free tier; `/plan` in
the bot shows its current limits. If your workflow needs more, message
[@yolovlad](https://t.me/yolovlad). Before you rely on it, read the
[acceptable use](https://vladkarok.github.io/email-to-telegram/hosted/acceptable-use/)
and [privacy](https://vladkarok.github.io/email-to-telegram/hosted/privacy-and-data-requests/)
pages.

**Run your own.** The code is MIT-licensed. Cloudflare Email Routing receives
mail for your domain, a small Worker checks the alias, and a Node app on your
server delivers the message to Telegram. Start with the
[first deployment guide](#first-deployment-guide).

## What it's for

- alerts from apps, servers and uptime monitors
- CI, deploy and GitHub notifications
- SaaS notifications that get lost in a busy inbox
- automations that can send an email, such as a Power Automate flow
- a team's alerts in one Telegram group or forum topic

It is one-way on purpose. The bot never sends email. Stored copies of mail and
attachments expire (after 7 days on the hosted free tier), and Telegram keeps
the delivered messages.

## Trust model

Do not use this project as a secure vault or a safe channel for secrets, recovery
codes, credentials, medical/legal/financial records, or other regulated or highly
confidential content.

Who can see your mail:

- The VPS operator and anyone with access to its backups may be able to access stored mail content
- Anyone with access to the destination Telegram chat can read forwarded messages
- Anyone with access to the bot token has meaningful visibility into bot-delivered content
- Telegram forwarding is a convenience channel, not a life-safety or sole paging system

## Architecture

Mail enters only through Cloudflare Email Routing. There is no SMTP server.
Example deployment files live under `docs/examples/`.

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

## Bot commands

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
| `/usage`                                 | This month's usage and limits (hosted)              |
| `/plan`                                  | Current plan and limits (hosted)                    |
| `/language`                              | Choose bot language                                 |
| `/help`                                  | Show help                                           |

## First deployment guide

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

- `TRUST_PROXY=true` when the app is reachable EXCLUSIVELY through a trusted reverse proxy. Required for per-client rate limits to work behind the bundled `docker-compose.yml` (Caddy/nginx in front of `HOST_BIND_IP`). Leave unset/`false` if clients can reach the app directly — otherwise `X-Forwarded-For` can be spoofed to bypass rate limits.
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

To update later, follow the steps at the top of the standalone compose file:
build, run the migrations while the old app keeps serving, then `up -d`.

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

On any machine with Node.js 22 or newer and Wrangler installed:

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

- Render mode: `html` (default) or `plaintext`
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
search users and grant/renew/downgrade manual plans from the user detail page.

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

## Configuration reference

See [`.env.example`](./.env.example) for the authoritative template.

| Variable                         | Required | Description                                                                                                         |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`              | Yes      | PostgreSQL password                                                                                                 |
| `DATABASE_URL`                   | Yes      | PostgreSQL connection string                                                                                        |
| `TELEGRAM_BOT_TOKEN`             | Yes      | Telegram bot token                                                                                                  |
| `MAIL_DOMAIN`                    | Yes      | Zone root mail domain, for example `example.com`                                                                    |
| `PUBLIC_BASE_URL`                | Yes      | Public HTTPS URL for downloads and Worker callbacks                                                                 |
| `HTTP_PORT`                      | Yes      | Internal app port, default `3000`                                                                                   |
| `HMAC_SECRET`                    | Yes      | Secret for attachment download tokens                                                                               |
| `WORKER_SECRET`                  | Yes      | Shared secret between Worker and VPS                                                                                |
| `ATTACHMENT_DIR`                 | Yes      | Attachment storage path                                                                                             |
| `RAW_EMAIL_DIR`                  | Yes      | Raw email storage path                                                                                              |
| `ATTACHMENT_TTL_HOURS`           | No       | Attachment retention window                                                                                         |
| `RAW_EMAIL_TTL_HOURS`            | No       | Raw email retention window                                                                                          |
| `DELIVERY_LOG_RETENTION_DAYS`    | No       | Delivery log and retry-attempt retention window                                                                     |
| `STORAGE_ENCRYPTION_MODE`        | No       | `none` or `local-v1` for at-rest attachment/raw encryption                                                          |
| `MASTER_ENCRYPTION_KEY`          | No       | Required for `local-v1`; 32-byte base64 or hex key                                                                  |
| `MASTER_ENCRYPTION_KEY_ID`       | No       | Optional key label stored with wrapped DEKs                                                                         |
| `MASTER_ENCRYPTION_KEYRING`      | No       | Older read-only local keys for staged key rotation                                                                  |
| `MAX_SIZE_BYTES`                 | No       | Max accepted inbound body size                                                                                      |
| `STALE_TEXT_UPDATE_MAX_AGE_S`    | No       | Telegram text messages older than this many seconds on arrival are skipped, not answered. Default `600`             |
| `TRUST_PROXY`                    | No       | Trust `X-Forwarded-*` for client IP (rate limits). Default `false`. Set `true` only behind a trusted reverse proxy. |
| `TELEGRAM_RICH_MESSAGES_ENABLED` | No       | Prefer native Rich Messages for structured mail. Default `true`; set `false` for classic-only delivery.             |
| `INITIAL_ALLOWED_USERS`          | No       | Initial Telegram operators; recommended on first deploy                                                             |
| `BACKUP_DIR`                     | No       | Nightly backup directory                                                                                            |
| `BACKUP_ARCHIVE_ENCRYPTION`      | No       | `off` or `storage-key`; `yes` is invalid                                                                            |
| `HEALTHCHECKS_URL`               | No       | External heartbeat URL; sustained probe failures POST `<url>/fail`                                                  |
| `ALERT_CHAT_ID`                  | No       | Telegram chat for critical alerts                                                                                   |
| `ADMIN_ENABLED`                  | No       | Enable internal `/admin` Web UI                                                                                     |
| `ADMIN_SECRET`                   | No       | Login secret required when admin is enabled                                                                         |
| `ADMIN_SESSION_SECRET`           | No       | Optional separate admin session cookie signing secret                                                               |
| `ADMIN_SESSION_TTL_MINUTES`      | No       | Admin session lifetime, default `60`                                                                                |
| `METRICS_ENABLED`                | No       | Enable protected Prometheus `/metrics` endpoint                                                                     |
| `METRICS_TOKEN`                  | No       | Bearer token required when metrics are enabled                                                                      |
| `LOG_LEVEL`                      | No       | Log verbosity                                                                                                       |
| `NODE_ENV`                       | No       | Environment name                                                                                                    |

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
billing grant counters, quota rejection counters, and active users by plan. Roll
back by setting `METRICS_ENABLED=false` and restarting the app.

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

## Release workflow

Tag-based releases are optional.

If you use the included GitHub Actions workflows:

1. CI runs on both `dev` and `main`, and on pull requests targeting either branch
2. The production VPS stays release-only; there is no built-in workflow that
   deploys `dev` automatically to `oracle-shiny`
3. Before tagging, bump `version` in `package.json` to the release version
   through a normal PR; the release workflow refuses a tag that does not match
   it
4. Pushing a release tag like `v1.2.3` builds `:latest` plus `:v1.2.3`
5. The release deploy job copies the tagged commit's `docker-compose.yml` and
   `.github/scripts/deploy-app.sh` to the VPS and runs the script there (see
   below)
6. The same release workflow also has a manual `workflow_dispatch` path, so you
   can redeploy an existing release tag from the GitHub Actions UI without
   creating a new tag. That path copies the release's compose file but takes
   `deploy-app.sh` from the workflow's own commit on `main`, so it also works
   for releases older than the script. This is also how you roll back by hand:
   dispatch `main`'s workflow with the older tag.

The important operational detail is that the checked-out VPS repo and the
running app image are related but not identical concerns. `git pull` updates the
compose/config files on disk; the running bot version changes only after Docker
pulls the matching GHCR image and recreates the container with the desired
`IMAGE_TAG`. `IMAGE_TAG` is passed on the command line; a pin in `.env` is not
updated by a deploy.

That workflow is for this repository's existing VPS layout. A fresh install does
not need GHCR and can be done entirely with the standalone example compose file.

### What a deploy does

Every app deploy (tag push, dispatch, and the staging deploy on each push to
`main`) first uploads `docker-compose.yml` and `deploy-app.sh` to a fresh
directory on the host, without the lock. It then takes the host deploy lock
once and, under it, creates the `monitoring_scrape` network if it is missing,
logs in to GHCR, installs the new compose file as `docker-compose.next.yml`
(the candidate) and the script, and runs `deploy-app.sh`.

`docker-compose.yml` on the host always describes the release that runs. The
script pulls, migrates and replaces with the candidate, and renames it to
`docker-compose.yml` only once the new release is healthy and ready. Any other
outcome deletes the candidate and leaves `docker-compose.yml` as it was, and
the rollback uses that file. Without a candidate (a run by hand) the script
deploys with `docker-compose.yml`. A `docker-compose.previous.yml` left by an
older deploy is no longer read; delete it.

Every Compose call gets the same files a plain `docker compose` in that
directory would read: the compose file plus the first override file that
exists, in Compose's order (`compose.override.yml`, `compose.override.yaml`,
`docker-compose.override.yml`, `docker-compose.override.yaml`). The script
refuses to run when `COMPOSE_FILE` is set in the environment or `.env`, or when
a `compose.yaml`, `compose.yml` or `docker-compose.yaml` sits next to
`docker-compose.yml`, because a plain call would then read other files.

The script needs Compose 2.32 or later (`docker compose run --pull never`)
and GNU coreutils 8.31 or later (`env --ignore-signal`, which keeps the host
log's `tee` alive through a Ctrl-C); without the latter it stops before
anything else. Each stage has its own time limit, and every other Docker call
(`ps`, `inspect`, `tag`, `logs`, `rm`) gets 20 s:

1. Checks that Compose can read the candidate and `docker-compose.yml` with
   `.env`, with all output hidden, so a line of `.env` never reaches the job
   log.
2. Prints the tooling commit, the target tag, and the running app container's
   image, image ID, state and restart count.
3. Pulls the target image (600 s) and reads its image ID.
4. Tags the running container's image ID locally as
   `ghcr.io/vladkarok/email-to-telegram:deploy-previous`. This is the rollback
   target.
5. Starts an availability probe: `curl` to `http://$HOST_BIND_IP:3000/readyz`
   every 2 s with a 1-s timeout, until the end of the run. The script reads
   `HOST_BIND_IP` from `.env` without sourcing the file and exports it for
   every Compose call, so Compose binds the address the probe requests. It
   stops if the environment already has a different `HOST_BIND_IP`.
6. Checks that the target tag still names the pulled image ID, starts
   Postgres if it is not running and waits for it to be healthy
   (`docker compose up -d --wait --no-recreate postgres`), then runs the
   migrations in a one-off container while the old app keeps serving:
   `docker compose run --rm --no-deps --pull never -T --name etg-migrate app node dist/index.js --migrate-only`.
   The database wait and the migration share the 300-s limit. The job log
   gets only the exit status and the duration; on a failure, also the level,
   `msg` and error code of the migration's error lines. If the migration
   fails, the run stops here with nothing replaced.
7. Replaces the app container with
   `docker compose up -d --remove-orphans --no-build --pull never` (120 s).
8. Waits up to 90 s for the container to run the pulled image ID, for Docker
   to report `healthy` and for the probe to get a 200.
9. Renames the candidate to `docker-compose.yml`, prints the availability
   report and exits 0.

The Compose calls after the pull never pull, so a moving tag such as `:main`
cannot give the migration one image and the app another; a container that
runs another image ID than the one pulled fails the deploy.

All stages together take at most 22 minutes, the other Docker calls about 6
minutes more at worst, the job's own calls (upload, network check, login,
cleanup) about 8, and the job may also wait up to 15 minutes for the host lock.
The deploy jobs time out after 55 minutes.

Everything the script prints also goes to `~/email-to-telegram/deploy-logs/`
on the host (the newest 30 files are kept), so the report survives a lost SSH
session. The directory is private to the deploy user (mode 700, files 600).
The full output of a failed migration and of a failed app container is kept
there too; the job log, which is public, gets only their error lines.

### The gap

The old container stops before the new one starts, so the app does not answer
for a few seconds on every deploy. The report at the end of each deploy log
lists every interval in which `/readyz` did not answer 200, with start, end
and length, then the total, the migration time, and the time from the start
of the replacement until the script saw Docker's `healthy`. A run that ends while the app is down prints
`not recovered`. A 429 from `/readyz` means another client shares the probe's
rate limit, and the report says it is unreliable. The probe runs on the host,
at 2-s resolution: it does not see the Worker and the reverse proxy, and
`SELECT 1` does not notice a table locked by a migration.

Mail sent during the gap is not lost. The Worker turns the failed request into
a temporary SMTP failure and the sending server retries later (Gmail after
about 5 minutes), so the mail arrives late. Mail the app accepted before the
stop is already in the delivery log; if the old process could not finish it
within the 25-s shutdown deadline, the retry worker delivers it later,
possibly as a second Telegram message. A delivery becomes eligible for a retry
2 minutes after it was received, or 10 minutes after its send started if it
was cut off mid-send. The retry worker runs every 5 minutes and works through
eligible deliveries one at a time, so a backlog or Telegram being unavailable
delays it further.

Telegram updates sent during the gap wait at Telegram and the new process
handles them after it starts. Telegram keeps an update for at most 24 hours. A
queued backlog meets the same rate limits as live traffic, and text messages
older than 10 minutes are skipped (`STALE_TEXT_UPDATE_MAX_AGE_S`). A pending
multi-step prompt, such as `/newemail` waiting for a name, is forgotten; the
user starts it again.

### Health timing

The compose healthcheck runs every 30 s with a 60-s start period. When Docker
probes for the first time depends on the engine: some probe every 5 s during
the start period, others wait the full 30 s. The report's "time to healthy" is
measured by the script, from the start of `compose up` until an inspect at
2-s intervals sees `healthy`; it includes the container start and the
engine's probe schedule and does not separate them. A release that needs more
than about 60 s to become ready can miss the 90-s wait on a 30-s engine and is
rolled back.

### Automatic rollback

From the replacement on, any failure rolls back: a compose error or timeout, no
app container ID, a `docker compose ps` or `docker inspect` error or timeout,
the container running another image ID than the one pulled, `unhealthy`,
`exited`, `dead` or `restarting`, a restart count above zero, no `healthy`
plus a 200 within 90 s, or an unexpected exit of the script. The script prints
the error lines of the failed container's last 200 log lines (the full lines
stay in `deploy-logs/`), starts the `deploy-previous` image with
`IMAGE_TAG=deploy-previous docker compose up -d --no-build --pull never`,
waits for it the same way (it must run the previous image ID), prints the
report and exits 1 with `Rolled back to <image id>.` on the last line. The run
is red either way.

The rollback runs the previous image with `docker-compose.yml`, which the
failed deploy never touched, so the previous release gets back the compose
file it ran with. It does not restore `.env`, the database schema or data, or
the deploy script. To deploy a changed compose file by hand, put it at
`docker-compose.next.yml` before running the script.

There is no rollback on a first deploy (no previous image) or when the
previous image is the target image. If the rollback fails too, the run exits 1
with `rollback failed` and leaves the host as it is; recover by dispatching the
previous release.

The rollback does not cover a release that fails after it was healthy and
ready, a database outage, a run cancelled by hand, or a lost runner. A run
stopped by a signal does not roll back; it deletes the candidate like any
other failed run, so after a signal during the replacement the new release may
run while `docker-compose.yml` still describes the previous one. Recovery in
those cases is a dispatch of the previous tag, which brings its own compose
file.

### Migrations

A migration that fails with an SQL error before it commits rolls back as a
whole: the old app keeps serving and nothing is replaced. When the migration
process is killed or loses its database connection, the outcome is unknown:
the commit may have happened before. A migration that hits the 300-s limit
ends the run with `migration outcome unknown: it may have committed`, and a
run interrupted during the migration says the same. In both cases the script
removes the migrate container (`docker rm -f etg-migrate`, bounded at 20 s),
which stops a migration still running, and replaces nothing. If that removal
fails, the last line says so; the next deploy then stops before migrating
until you remove the container yourself with `docker rm -f etg-migrate`. The
old app works with either schema under the compatibility rule below, and the
next deploy applies whatever is still pending. To find out, read
`drizzle.__drizzle_migrations` in the database.

The migration connection uses `lock_timeout=5s` and `statement_timeout=120s`.
While a migration runs, the old app's queries on a table it locks wait for it, so a migration
that locks a large table for long needs planned downtime; say so in its PR.

Every migration must work with the release that is running when it is
applied, and the automatic rollback runs the previous image on the new schema.
So expand first and contract one release later: add a column in one release,
stop using the old one, and drop it in a later release. See
[CONTRIBUTING.md](./CONTRIBUTING.md#database-migrations). Deploying across a
skipped release that a contract migration depends on, or rolling back further
than the previous image, is outside that rule.

### Before deploying over a crash-looping app

Every app start also runs pending migrations, outside the deploy lock. If an
app container started outside the script (a manual `docker compose up` with a
newer tag, or a crash loop left by an older deploy) is restarting with pending
migrations, stop it first, then deploy:

```bash
docker compose --env-file .env stop app
```

The first line of every deploy log shows the container's state and restart
count, and the script warns when it is restarting.

To run the script by hand, take the host lock first. It deploys with
`docker-compose.yml`, or with `docker-compose.next.yml` when you put a changed
compose file there:

```bash
flock -w 900 ~/.etg-deploy.lock env IMAGE_TAG=v1.2.3 \
  bash ~/email-to-telegram/deploy-app.sh </dev/null
```

## Other docs

- [`devdocs/encryption-todo.md`](./devdocs/encryption-todo.md) tracks future encryption work
- [`docs/examples/docker-compose.standalone.yml`](./docs/examples/docker-compose.standalone.yml) is a clean first-install compose example
- [`docs/examples/Caddyfile`](./docs/examples/Caddyfile) is the matching Caddy example

## License

MIT — see [LICENSE](./LICENSE)
