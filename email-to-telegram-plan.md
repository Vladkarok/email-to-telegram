# Email-to-Telegram Bot Service

## Context

Self-hosted replacement for the defunct **etlgr.io** service. Core feature: create email addresses via a Telegram bot, map them to chats/groups, and forward incoming emails to those chats. Hosted on Oracle Cloud VPS with Docker.

---

## Technology Stack

| Concern       | Choice                                                                                                                        | Why                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Language      | **Node.js / TypeScript**                                                                                                      | Best ecosystem: `smtp-server`, `mailparser`, `grammy` are mature and well-typed |
| Telegram Bot  | **grammY**                                                                                                                    | First-class TypeScript, active, clean middleware model                          |
| SMTP          | **smtp-server** (Nodemailer ecosystem)                                                                                        | Battle-tested inbound SMTP, full TS types — used in direct SMTP mode            |
| Email Parsing | **mailparser**                                                                                                                | Same ecosystem, handles MIME/attachments/encodings                              |
| Database      | **PostgreSQL 16** + **Drizzle ORM**                                                                                           | Pure TS schema, no codegen, lightweight migrations                              |
| HTTP          | **Fastify**                                                                                                                   | Native pino logging, schema validation, plugins                                 |
| TLS/HTTPS     | **Caddy** sidecar                                                                                                             | Automatic Let's Encrypt, zero config                                            |
| Other         | `zod` (config validation), `pino` (logging), `nanoid` (tokens), `node-cron` (cleanup), `sanitize-html` (Telegram HTML subset) |

---

## Architecture Decision: Email Ingestion

Two viable approaches. **Choose before Phase 1.**

### Option A — Direct SMTP (self-hosted)

```
[Sending MTA] --TCP:25--> [smtp-server inside app]
                               |
                   onRcptTo:  validate domain + local_part + allow_rules
                               check per-alias and per-sender rate limits
                   onData:    buffer raw stream, save .eml
                               |
                               v
                          [Email Pipeline]
```

**Pros**: no external dependencies, fully self-contained  
**Cons**: Oracle Cloud port 25 requires explicit security-list rule + support request; self-signed STARTTLS cert; must manage MX/PTR/SPF/DMARC DNS records yourself

### Option B — Cloudflare Email Worker (recommended if domain is on Cloudflare)

```
[Sending MTA] --> [Cloudflare Email Routing on tgmail.domain.com]
                       |
              [catch-all Email Worker] (thin, TypeScript)
                       |
          preflight: POST /inbound/preflight  (HMAC-signed)
          on accept:  POST /inbound/raw       (stream raw MIME)
                       |
                  [VPS app — Fastify]
```

**Pros**: no port 25 needed; no STARTTLS cert issues; no MX/PTR DNS management on VPS; Cloudflare handles spam/size (25 MiB limit) at the edge; free up to 100k req/day; Worker rejects unknown aliases before MIME is even streamed  
**Cons**: Cloudflare dependency; Worker is a second deployment artifact; requires domain on Cloudflare  
**When to use**: domain already on Cloudflare — this is the clearly better path

Both options share the same VPS app, DB schema, bot, and HTTP layer. Only the ingestion entry point differs. The plan covers both; Phase 3 notes where they diverge.

---

## Architecture (shared core)

```
                    [Email Ingestion]
                    (SMTP server OR Cloudflare Worker → /inbound/*)
                              |
                   validate alias + allow_rules
                   check per-alias + per-sender rate limits
                   save raw .eml to disk (14-day retention)
                              |
                              v
                       [Email Parser] (mailparser)
                        /          \
              [Attachments]    [Renderer] (plaintext / html / markdown)
              save to disk     strip quotes + signatures
              sha256 hash      format body for Telegram
              uuid filename    truncate to 4096 chars
              gen download URL
                        \          /
                         v        v
                    [Telegram Sender] --> bot.api.sendMessage(
                                           chat_id, text,
                                           message_thread_id  ← forum topic support
                                         )
                              |
                    [Delivery Log + Attempts] --> DB

[Caddy :443] --reverse_proxy--> [Fastify :3000]
                                    |
                              /dl/:token      (attachment download)
                              /healthz        (liveness)
                              /readyz         (readiness: DB + bot token)
                              /inbound/preflight  (Option B only)
                              /inbound/raw        (Option B only)
```

**Deduplication**: `Message-ID` header + `sha256(body)` checked against `delivery_logs` before processing. Guards against both MTA retries and Cloudflare Worker duplicate delivery.

**Graceful shutdown order**: (1) stop SMTP / stop accepting inbound HTTP, (2) drain in-flight processing, (3) stop bot, (4) close HTTP server, (5) close DB pool.

**Telegram failure handling**: Retry with exponential backoff (3 attempts: 1s / 2s / 4s). On all retries exhausted: in SMTP mode return 451 so sending MTA retries; in Cloudflare mode mark delivery as `failed` and rely on a DB-backed retry worker (Phase 6).

---

## Database Schema (7 tables)

### users

| Column     | Type                  | Notes                     |
| ---------- | --------------------- | ------------------------- |
| id         | BIGINT PK             | Telegram user ID          |
| username   | VARCHAR(255)          |                           |
| is_allowed | BOOLEAN DEFAULT false | Global operator whitelist |
| created_at | TIMESTAMPTZ           |                           |
| updated_at | TIMESTAMPTZ           |                           |

### email_addresses

| Column            | Type                            | Notes                                                                           |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| id                | UUID PK                         | gen_random_uuid()                                                               |
| local_part        | VARCHAR(64) UNIQUE              | validated `^[a-z0-9._-]{1,64}$`; suffix added by default (e.g. `alerts-k3x9m2`) |
| full_address      | VARCHAR(320)                    | convenience: `local_part + "@" + MAIL_DOMAIN`, stored for display               |
| chat_id           | BIGINT NOT NULL                 | Telegram chat/group ID (negative for groups)                                    |
| message_thread_id | BIGINT                          | Telegram forum topic ID; NULL = main chat, non-null = specific topic            |
| created_by        | BIGINT FK → users(id)           | `ctx.from.id` — always the issuing user, even in groups                         |
| render_mode       | VARCHAR(20) DEFAULT 'plaintext' | 'plaintext' / 'html' / 'markdown'                                               |
| status            | VARCHAR(20) DEFAULT 'active'    | 'active' / 'paused' / 'deleted'                                                 |
| max_emails_hour   | INT DEFAULT 60                  | Per-alias rate limit                                                            |
| created_at        | TIMESTAMPTZ                     |                                                                                 |
| updated_at        | TIMESTAMPTZ                     |                                                                                 |

Indexes:

- `idx_alias_active ON email_addresses(local_part) WHERE status = 'active'`
- `idx_alias_chat ON email_addresses(chat_id)`

### allow_rules

Per-alias sender allowlist. Every alias starts with no rules — all mail is rejected unless at least one rule matches the envelope sender.

| Column           | Type                                  | Notes                                    |
| ---------------- | ------------------------------------- | ---------------------------------------- |
| id               | UUID PK                               |                                          |
| email_address_id | UUID FK → email_addresses(id) CASCADE |                                          |
| match_type       | VARCHAR(20)                           | 'exact_email' or 'domain'                |
| match_value      | VARCHAR(320)                          | e.g. `alerts@github.com` or `github.com` |
| created_at       | TIMESTAMPTZ                           |                                          |

Index: `idx_allow_alias ON allow_rules(email_address_id)`

**Allowlist enforcement**: checked against `envelope_from` (not `header_from`). If an alias has zero allow_rules, reject the email with a logged reason (misconfigured alias, not a silent drop).

### delivery_logs

| Column            | Type                                  | Notes                                                 |
| ----------------- | ------------------------------------- | ----------------------------------------------------- |
| id                | UUID PK                               |                                                       |
| email_address_id  | UUID FK → email_addresses(id) CASCADE |                                                       |
| message_id_header | VARCHAR(998)                          | RFC 5322 Message-ID; dedup key 1                      |
| body_sha256       | VARCHAR(64)                           | sha256 of plain-text body; dedup key 2                |
| envelope_from     | VARCHAR(320)                          | SMTP MAIL FROM / envelope sender                      |
| header_from       | VARCHAR(320)                          | RFC 5322 From header (may differ from envelope)       |
| subject           | TEXT                                  |                                                       |
| received_at       | TIMESTAMPTZ                           |                                                       |
| raw_size_bytes    | INT                                   |                                                       |
| raw_email_path    | VARCHAR(512)                          | path to stored .eml file; NULL after retention expiry |
| has_attachments   | BOOLEAN DEFAULT false                 |                                                       |
| final_status      | VARCHAR(20)                           | 'delivered' / 'failed' / 'duplicate' / 'rejected'     |
| created_at        | TIMESTAMPTZ                           |                                                       |

Indexes:

- `idx_log_alias_time ON delivery_logs(email_address_id, received_at DESC)`
- `idx_log_message_id ON delivery_logs(message_id_header)`
- `idx_log_body_hash ON delivery_logs(body_sha256)`

### delivery_attempts

Tracks individual Telegram send attempts (retries). Separate from delivery_logs to keep the main log clean.

| Column              | Type                                | Notes                  |
| ------------------- | ----------------------------------- | ---------------------- |
| id                  | UUID PK                             |                        |
| delivery_log_id     | UUID FK → delivery_logs(id) CASCADE |                        |
| attempt_no          | SMALLINT                            | 1, 2, 3 …              |
| target_chat_id      | BIGINT                              |                        |
| target_thread_id    | BIGINT                              | nullable               |
| telegram_message_id | BIGINT                              | set on success         |
| status              | VARCHAR(20)                         | 'delivered' / 'failed' |
| error_text          | TEXT                                |                        |
| created_at          | TIMESTAMPTZ                         |                        |

Index: `idx_attempt_log ON delivery_attempts(delivery_log_id)`

### attachments

| Column            | Type                                | Notes                                                                  |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| id                | UUID PK                             |                                                                        |
| delivery_log_id   | UUID FK → delivery_logs(id) CASCADE |                                                                        |
| original_filename | VARCHAR(255)                        | From MIME — display only, never used for disk path                     |
| content_type      | VARCHAR(127)                        |                                                                        |
| size_bytes        | INT                                 |                                                                        |
| sha256            | VARCHAR(64)                         | Content hash; used to deduplicate identical attachments                |
| storage_path      | VARCHAR(512)                        | `<ATTACHMENT_DIR>/<YYYY-MM-DD>/<uuid>` — no user-controlled components |
| created_at        | TIMESTAMPTZ                         |                                                                        |

### attachment_links

One row per generated download link. Decoupled from attachment metadata. Tracks usage.

| Column        | Type                              | Notes                             |
| ------------- | --------------------------------- | --------------------------------- |
| id            | UUID PK                           |                                   |
| attachment_id | UUID FK → attachments(id) CASCADE |                                   |
| token         | VARCHAR(64) UNIQUE                | nanoid; HMAC-verified on download |
| expires_at    | TIMESTAMPTZ                       | default now() + 24h               |
| downloaded_at | TIMESTAMPTZ                       | set on first successful download  |
| created_at    | TIMESTAMPTZ                       |                                   |

Indexes:

- `idx_link_token ON attachment_links(token)`
- `idx_link_expires ON attachment_links(expires_at)`

**HMAC scheme**: `HMAC-SHA256(attachment_id + ":" + expires_at_unix, HMAC_SECRET)`. Covers both identity and expiry. Token stored separately from the HMAC — verify on every request.

---

## Data Retention Policy

| Data                                        | Retention                       | Cleanup mechanism                                                |
| ------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| Raw `.eml` files                            | 14 days                         | node-cron every 15 min; set `raw_email_path = NULL` after delete |
| Attachment files                            | 14 days (default, configurable) | same cron; cascade removes `attachment_links`                    |
| `delivery_logs` rows                        | 90 days                         | nightly cron                                                     |
| `delivery_attempts` rows                    | 180 days                        | nightly cron                                                     |
| `users` / `email_addresses` / `allow_rules` | indefinite                      | manual only                                                      |
| DB backups                                  | 7 daily                         | `backup.sh` prunes old files                                     |

---

## Bot Commands

### Private chat (DM) commands

| Command            | Description                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`           | Register user, show welcome                                                                                                                                                |
| `/newemail [name]` | Create alias mapped to a chat. If run in DM, prompts for chat selection. `name` validated `^[a-z0-9._-]{1,32}$`; a random 6-char suffix is appended (e.g. `alerts-k3x9m2`) |
| `/listemail`       | List all aliases across all chats owned by this user                                                                                                                       |
| `/help`            | List commands                                                                                                                                                              |

### Group / topic commands

| Command                                  | Description                                                          |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `/newemail [name]`                       | Create alias mapped to current group or forum topic                  |
| `/listemail`                             | List aliases for this chat (or topic if `message_thread_id` present) |
| `/deleteemail <name>`                    | Soft-delete (status = 'deleted') with inline keyboard confirmation   |
| `/pauseemail <name>`                     | Set status = 'paused'; mail rejected with logged reason              |
| `/resumeemail <name>`                    | Set status = 'active'                                                |
| `/settings <name>`                       | Change render mode via inline keyboard (plaintext / html / markdown) |
| `/allow add <name> <email_or_domain>`    | Add allow rule; e.g. `/allow add alerts-k3x9m2 github.com`           |
| `/allow remove <name> <email_or_domain>` | Remove allow rule                                                    |
| `/allow list <name>`                     | Show current allow rules for alias                                   |
| `/help`                                  | List commands                                                        |

**Auth middleware**: `users.is_allowed` check on every command. User upserted on every interaction.

**Forum topic awareness**: When a command is issued inside a forum topic, `ctx.message.message_thread_id` is captured and stored. Delivered emails are sent to that specific topic via `message_thread_id` parameter.

**Bot must be admin** in any group it serves — required for `getChatMember` lookups and reliable message delivery in restricted groups.

---

## Project Structure

```
email-to-telegram/
├── docker-compose.yml
├── Dockerfile
├── Caddyfile
├── .env.example
├── .env                              # gitignored
├── drizzle.config.ts
├── tsconfig.json
├── package.json
├── vitest.config.ts
│
├── cloudflare-worker/                # Option B only
│   ├── src/worker.ts                 # Thin Email Worker: preflight + raw MIME stream
│   ├── wrangler.toml
│   └── package.json
│
├── drizzle/
│   └── 0000_initial.sql
│
├── scripts/
│   └── backup.sh                     # pg_dump to /backups volume
│
├── src/
│   ├── index.ts                      # Entry point; graceful shutdown
│   ├── config.ts                     # Zod-validated env config
│   │
│   ├── db/
│   │   ├── schema.ts                 # All 7 tables + indexes
│   │   ├── client.ts                 # Drizzle + pg pool
│   │   └── migrate.ts                # Startup migrations; --migrate-only flag
│   │
│   ├── smtp/                         # Option A only
│   │   ├── server.ts                 # smtp-server: onRcptTo, onData
│   │   └── validator.ts              # Domain, alias, allow_rules, rate-limit checks
│   │
│   ├── inbound/                      # Option B only (Cloudflare Worker endpoints)
│   │   ├── preflight.ts              # POST /inbound/preflight handler
│   │   └── raw.ts                    # POST /inbound/raw handler + HMAC auth
│   │
│   ├── email/
│   │   ├── pipeline.ts               # Orchestrates parse → render → send → log
│   │   ├── parser.ts                 # mailparser wrapper → ParsedEmail
│   │   ├── dedup.ts                  # Message-ID + body_sha256 deduplication
│   │   ├── renderer.ts               # plaintext / html / markdown strategies
│   │   ├── cleaner.ts                # Strip quoted replies + obvious signatures
│   │   ├── attachments.ts            # Save to disk (uuid path), sha256, generate links
│   │   └── types.ts                  # ParsedEmail, Attachment, RenderMode, etc.
│   │
│   ├── telegram/
│   │   ├── bot.ts                    # grammY bot, middleware chain, error handler
│   │   ├── commands/
│   │   │   ├── start.ts
│   │   │   ├── newemail.ts           # Validate name, append suffix, create alias
│   │   │   ├── listemail.ts
│   │   │   ├── deleteemail.ts
│   │   │   ├── pauseemail.ts
│   │   │   ├── resumeemail.ts
│   │   │   ├── settings.ts
│   │   │   ├── allow.ts              # /allow add|remove|list
│   │   │   └── help.ts
│   │   ├── sender.ts                 # Format + send; respects message_thread_id; retry backoff
│   │   └── middleware/
│   │       └── auth.ts               # is_allowed check + user upsert
│   │
│   ├── http/
│   │   ├── server.ts                 # Fastify setup + rate-limit plugin
│   │   └── routes/
│   │       ├── healthz.ts            # GET /healthz — liveness
│   │       ├── readyz.ts             # GET /readyz — DB ping + bot token check
│   │       ├── attachments.ts        # GET /dl/:token — HMAC verify, expiry, stream
│   │       ├── preflight.ts          # POST /inbound/preflight (Option B)
│   │       └── raw.ts                # POST /inbound/raw (Option B)
│   │
│   ├── storage/
│   │   ├── fileStore.ts              # Save/read/delete; uuid paths only
│   │   └── cleanup.ts                # node-cron: attachments (15min), raw emails (15min), old log rows (nightly), backup (nightly)
│   │
│   └── utils/
│       ├── logger.ts                 # Pino instance
│       ├── tokens.ts                 # nanoid + HMAC-SHA256(attachment_id:expires_at, secret)
│       ├── rateLimit.ts              # In-memory sliding window; per-alias + per-sender
│       └── telegramHtml.ts           # sanitize-html with Telegram allowlist; truncation; quote/sig strip
│
└── tests/
    ├── unit/
    │   ├── config/config.test.ts
    │   ├── email/parser.test.ts
    │   ├── email/dedup.test.ts
    │   ├── email/renderer.test.ts
    │   ├── email/cleaner.test.ts
    │   ├── smtp/validator.test.ts
    │   ├── telegram/sender.test.ts
    │   └── utils/tokens.test.ts
    ├── integration/
    │   ├── smtp-flow.test.ts          # Option A
    │   ├── inbound-flow.test.ts       # Option B
    │   └── http-attachments.test.ts
    └── fixtures/
        ├── simple.eml
        ├── html-rich.eml
        ├── with-attachments.eml
        ├── unicode.eml
        ├── quoted-reply.eml
        ├── with-signature.eml
        ├── no-content-type.eml
        ├── nested-mime.eml
        └── calendar-invite.eml
```

---

## Cloudflare Worker (Option B)

**`cloudflare-worker/src/worker.ts`** — keep it intentionally thin. No business logic here.

```typescript
export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // 1. Quick size check
    if (message.rawSize > env.MAX_SIZE_BYTES) {
      message.setReject("Message too large");
      return;
    }

    // 2. Preflight: does this alias exist and accept this sender?
    const sig = hmacSign({ to: message.to, from: message.from, ts: Date.now() }, env.WORKER_SECRET);
    const pre = await fetch(`${env.VPS_URL}/inbound/preflight`, {
      method: "POST",
      headers: { "X-Worker-Sig": sig, "Content-Type": "application/json" },
      body: JSON.stringify({ to: message.to, from: message.from, rawSize: message.rawSize }),
    });
    const { accept, reason } = await pre.json();
    if (!accept) {
      message.setReject(reason);
      return;
    }

    // 3. Stream raw MIME to VPS
    await fetch(`${env.VPS_URL}/inbound/raw`, {
      method: "POST",
      headers: {
        "X-Worker-Sig": sig,
        "X-Envelope-To": message.to,
        "X-Envelope-From": message.from,
      },
      body: message.raw,
    });
  },
};
```

**Worker-to-VPS authentication**: `HMAC-SHA256(to + from + timestamp, WORKER_SECRET)` sent as `X-Worker-Sig`. VPS verifies on every request; rejects if timestamp is >60s old (replay protection).

**`wrangler.toml`**: route `tgmail.domain.com` → `*`, bind `WORKER_SECRET` and `VPS_URL` as secrets.

---

## Docker Compose

### app

- Node.js 20 Alpine, multi-stage build
- Non-root user (`USER app`)
- Ports: `:2525` mapped to host `:25` (Option A only), `:3000` always
- Volumes: `attachments:/data/attachments`, `rawemails:/data/rawemails`, `backups:/backups`
- Memory limit: `512m`

### postgres

- PostgreSQL 16 Alpine, internal only
- Volume: `pgdata:/var/lib/postgresql/data`
- Healthcheck: `pg_isready`
- Memory limit: `256m`

### caddy

- Caddy 2 Alpine, ports 80 + 443
- Reverse proxy to `app:3000`
- Memory limit: `128m`

### Dockerfile (multi-stage)

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/drizzle ./drizzle
RUN mkdir -p /data/attachments /data/rawemails /backups && chown -R app:app /data /backups
USER app
EXPOSE 2525 3000
CMD ["node", "dist/index.js"]
```

### Caddyfile

```
tgmail.domain.com {
    reverse_proxy app:3000
}
```

---

## Environment Variables (.env.example)

```dotenv
# PostgreSQL
DATABASE_URL=postgres://app:password@postgres:5432/emailbot

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Email receiving domain — aliases will be name@MAIL_DOMAIN
MAIL_DOMAIN=tgmail.domain.com

# Ingestion mode: "smtp" or "cloudflare"
INGEST_MODE=cloudflare

# SMTP mode — listen port inside container (mapped to host :25)
SMTP_PORT=2525

# HTTP server listen port
HTTP_PORT=3000

# HMAC secret for signing attachment download tokens (openssl rand -hex 32)
HMAC_SECRET=changeme

# Option B — shared secret between Cloudflare Worker and VPS
WORKER_SECRET=changeme

# Storage directories inside container
ATTACHMENT_DIR=/data/attachments
RAW_EMAIL_DIR=/data/rawemails

# Retention in hours (default 336 = 14 days)
ATTACHMENT_TTL_HOURS=336
RAW_EMAIL_TTL_HOURS=336

# Maximum accepted message size in bytes (app-side; Cloudflare enforces 25 MiB at edge)
MAX_SIZE_BYTES=10485760

# Comma-separated Telegram user IDs to whitelist on first run (optional)
# INITIAL_ALLOWED_USERS=123456789,987654321

LOG_LEVEL=info
NODE_ENV=production
```

---

## DNS Setup

### Option A — Direct SMTP

All records required before deploy. Caddy cannot issue TLS until A record resolves.

| Record                     | Type      | Value                   | Notes                            |
| -------------------------- | --------- | ----------------------- | -------------------------------- |
| `tgmail.domain.com`        | A         | `<VPS_IP>`              | Caddy TLS + SMTP delivery        |
| `tgmail.domain.com`        | MX        | `10 tgmail.domain.com.` | **Without this no MTA delivers** |
| `tgmail.domain.com`        | TXT (SPF) | `"v=spf1 a -all"`       | This domain never sends          |
| `_dmarc.tgmail.domain.com` | TXT       | `"v=DMARC1; p=reject;"` |                                  |
| PTR                        | PTR       | `tgmail.domain.com`     | Set in Oracle Cloud console      |

Open inbound: TCP 25, 80, 443. Port 25 requires explicit Oracle Cloud security-list rule.

### Option B — Cloudflare Email Routing

| Record              | Type | Value                                           | Notes                               |
| ------------------- | ---- | ----------------------------------------------- | ----------------------------------- |
| `tgmail.domain.com` | A    | `<VPS_IP>`                                      | Caddy TLS only                      |
| MX + routing        | —    | Managed by Cloudflare Email Routing             | Enable on subdomain in CF dashboard |
| SPF                 | TXT  | Added automatically by Cloudflare Email Routing | Verify in CF dashboard              |

Open inbound: TCP 80, 443 only. **Port 25 not needed on VPS.**

### Deployment Order (Option B)

1. Enable Cloudflare Email Routing on `tgmail.domain.com`
2. Create catch-all rule → Email Worker
3. Point A record to VPS IP
4. Deploy Worker (`wrangler deploy`) with `WORKER_SECRET` + `VPS_URL` secrets
5. Deploy VPS stack (`docker compose up -d`)
6. Verify: send test email → check `/readyz` → check Telegram

---

## Security

### Ingestion

- **Unknown alias**: rejected before MIME is accepted/streamed
- **Allow rules**: `envelope_from` checked against `allow_rules` for the alias; zero rules = reject
- **Message size**: enforced at app level (`MAX_SIZE_BYTES`); Cloudflare enforces 25 MiB outer limit
- **Rate limiting**: per-alias sliding window + per-sender sliding window (in-memory, resets on restart)
- **Option B Worker auth**: `HMAC-SHA256(to + from + ts, WORKER_SECRET)` + 60s replay window
- **Option A**: domain validated in `onRcptTo` before DB lookup; `maxClients: 50`; STARTTLS self-signed

### Attachments

- Disk path uses UUID only — no user-controlled path components
- `original_filename` in DB for `Content-Disposition` header only
- HMAC-SHA256 token covers `attachment_id + ":" + expires_at_unix`
- Expiry checked on every download request (404 before cron cleanup)
- `downloaded_at` recorded on first successful download
- Blocked extensions: `.exe`, `.bat`, `.cmd`, `.scr`, `.ps1`, `.vbs`, `.msi`, `.com`
- Per-file size cap: configurable, default 20 MB

### Telegram Bot

- Token in env only, never logged
- `users.is_allowed` whitelist on every command
- Bot must be admin in groups
- Inline mode disabled

### Docker

- Non-root container user
- PostgreSQL: dedicated user, no SUPERUSER
- `.env` in `.dockerignore` + `.gitignore`
- Memory limits on all containers

### Database Backup

- Nightly `pg_dump` via `scripts/backup.sh` → `/backups` volume
- Retain 7 daily backups; prune older files in same script

---

## Message Rendering

### Pre-processing (all modes)

Before rendering, run `cleaner.ts`:

1. **Strip quoted replies**: remove lines starting with `>` and common reply headers (`On … wrote:`, `From:` blocks at end of body)
2. **Strip signatures**: remove content after `-- \n` (RFC 3676 sig delimiter) or heuristic patterns (`Best regards,`, `--\n<name>`)

### Render Mode: `plaintext`

Strip all HTML; render as plain text. Default.

```
From: alerts@github.com
To: myalerts-k3x9m2@tgmail.domain.com
Subject: [repo/name] CI failed on main
Date: 2026-04-04 14:30 UTC
---
Build #1234 failed. 3 tests failed in src/auth.test.ts.
---
Attachments (1):
  build-log.txt (12 KB) — https://tgmail.domain.com/dl/abc123
Links expire in 14 days.
```

### Render Mode: `html`

Use Telegram's `parse_mode: "HTML"`. Pass body through `sanitize-html` with Telegram's supported tag allowlist (`<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`). No intermediate Markdown conversion — avoids double-escaping bugs.

### Render Mode: `markdown`

For plain-text email bodies, send as-is with `parse_mode` off (no parsing). For HTML-only emails with no plain-text part, fall back to `html` mode.

### Truncation

- Reserve ~600 chars for metadata header + attachment block
- Truncate body at 3496 chars; append `[… N chars omitted]`
- If body significantly exceeds budget, also send raw body as a Telegram document (`.txt` file)

---

## Implementation Phases

### Phase 1: Foundation

- `package.json`, `tsconfig.json` (ESM, strict), install core deps
- `src/config.ts`: zod schema for all env vars including `INGEST_MODE`; fail-fast
- `src/utils/logger.ts`: pino
- `src/db/schema.ts`: all 7 tables + indexes
- `src/db/client.ts` + `src/db/migrate.ts` (`--migrate-only` flag)
- `src/index.ts`: graceful shutdown handler (SIGTERM/SIGINT); shutdown order documented
- docker-compose with postgres only
- **Tests**: config zod schema (valid, missing vars, invalid values, both ingest modes)
- **Verify**: migration runs, all 7 tables exist, graceful shutdown works

### Phase 2: Telegram Bot

- `src/telegram/bot.ts`: grammY, long polling, error boundary
- `src/telegram/middleware/auth.ts`: is_allowed check + upsert
- Commands: `/start`, `/newemail` (name validation + random suffix), `/listemail`, `/deleteemail`, `/pauseemail`, `/resumeemail`, `/settings`, `/allow`, `/help`
- Forum topic: capture `message_thread_id` on all group commands; store in `email_addresses`
- Wire into `src/index.ts`
- **Tests**: each command handler (mock grammY context, including `message_thread_id`); auth middleware; name validation regex; allow_rules CRUD; pause/resume state transitions
- **Verify**: create/list/pause/resume/delete aliases; allow rules work; forum topic aliases created correctly

### Phase 3: Email Ingestion + Processing

**Option A (SMTP)**:

- `src/smtp/server.ts`: smtp-server, onRcptTo (domain + alias + allow_rules + rate-limit), onData (save .eml, feed pipeline)
- `src/smtp/validator.ts`: domain check, alias lookup, allow_rule match, per-alias + per-sender rate limits

**Option B (Cloudflare)**:

- `cloudflare-worker/src/worker.ts`: thin Worker (preflight call → setReject or raw stream)
- `src/inbound/preflight.ts` + `src/inbound/raw.ts`: HMAC-auth Fastify handlers; raw saves `.eml`
- `src/utils/rateLimit.ts`: shared per-alias + per-sender sliding window used by both options

**Shared**:

- `src/email/pipeline.ts`: orchestrates parse → dedup → allow check → clean → render → send → log
- `src/email/parser.ts`: mailparser → `ParsedEmail`; extract `message_id_header`, compute `body_sha256`
- `src/email/dedup.ts`: check `message_id_header` + `body_sha256` against DB
- `src/email/cleaner.ts`: strip quoted replies + signatures
- `src/email/renderer.ts`: plaintext / html / markdown
- `src/utils/telegramHtml.ts`: sanitize-html with Telegram allowlist; truncation
- `src/telegram/sender.ts`: send with `message_thread_id`; retry 3× with backoff; log attempt
- **Tests**: parser (all fixtures including `quoted-reply.eml`, `with-signature.eml`); cleaner; dedup logic; renderer per mode; rate limiter (per-alias + per-sender); allow_rules matching; validator (Option A: domain mismatch → 550, blocked sender → 550, rate limit → 452; Option B: HMAC auth, replay rejection)
- **Integration**: full ingest flow → DB entry + delivery_attempts + bot mock called; duplicate email → skipped
- **Verify**: `swaks` (Option A) or `curl /inbound/*` (Option B) → message in Telegram; forum topic message lands in correct topic

### Phase 4: Attachments + HTTP

- `src/storage/fileStore.ts`: `<ATTACHMENT_DIR>/<YYYY-MM-DD>/<uuid>` — uuid path only
- `src/email/attachments.ts`: compute sha256, save file, insert attachments + attachment_links rows
- `src/utils/tokens.ts`: nanoid + HMAC-SHA256 generation/verification
- `src/http/routes/attachments.ts`: verify HMAC, check expiry, record `downloaded_at`, stream file; rate-limit 100 req/min per IP
- `src/http/routes/healthz.ts` + `readyz.ts`
- `src/storage/cleanup.ts`: node-cron — attachments + raw emails (every 15min), log rows (nightly per retention policy), DB backup (nightly)
- **Tests**: token HMAC round-trip; expired/tampered token rejection; sha256 dedup (same attachment → same sha256, only one file written); `downloaded_at` set on first download
- **Integration**: attachment email → uuid file on disk → download → `downloaded_at` set → cleanup removes after TTL; expired token → 404; tampered → 403; `/readyz` returns 200 with DB up, 503 with DB down
- **Verify**: attachment links in Telegram work; `/readyz` vs `/healthz` behave correctly

### Phase 5: Deploy

- Full docker-compose + Dockerfile + Caddyfile + memory limits
- `scripts/backup.sh` wired into nightly cron
- Complete `.env.example`
- **Option A DNS**: A + MX + SPF + DMARC + PTR; open port 25 on Oracle Cloud
- **Option B**: enable Cloudflare Email Routing on subdomain; `wrangler deploy` with secrets
- **Verify**: real email from Gmail → Telegram message; attachment link works; `/readyz` healthy

### Phase 6: Hardening

- DB-backed retry worker (Option B): poll `delivery_logs` where `final_status = 'failed'` and retry pending `delivery_attempts`; mark permanently failed after N attempts
- Full integration test matrix: plain text, HTML-heavy, quoted reply, signature, multiple attachments, unicode, oversized, rapid-fire (rate limit both axes), unknown alias, blocked sender, duplicate Message-ID, duplicate body hash, forum topic delivery
- Observability: uptime check (healthchecks.io or Telegram self-ping on `/readyz` failure)
- Log driver in docker-compose: `json-file` with `max-size: 50m`, `max-file: 3`

---

## Entry Point Boot Sequence (`src/index.ts`)

1. Load + validate config (zod, fail fast)
2. Initialize pino logger
3. Register SIGTERM/SIGINT graceful shutdown handler
4. Connect to PostgreSQL, run pending migrations
5. Start grammY bot (long polling)
6. If `INGEST_MODE=smtp`: start smtp-server
7. Start Fastify (always — serves HTTP endpoints + inbound routes for Option B)
8. Start node-cron jobs (attachments cleanup, raw email cleanup, log retention, nightly backup)

---

## Testing

### Unit Tests (vitest)

- Config: zod schema, both ingest modes, all required vars
- Parser: all .eml fixtures → fields, Message-ID, sha256, attachment metadata
- Dedup: Message-ID match, body hash match, no false positives
- Cleaner: quoted reply stripped, signature stripped, clean email unchanged
- Renderer: each mode; truncation; `[… N chars omitted]` present; HTML sanitization
- Validator (Option A): domain mismatch, unknown alias, blocked sender, per-alias rate limit, per-sender rate limit
- Allow rules: exact email match, domain match, no rules → reject
- Tokens: HMAC round-trip, expired → reject, tampered → reject
- `fileStore.ts`: path never contains original filename

### Integration Tests

- Full ingest → DB entry → delivery_attempts → bot mock (both Option A and B paths)
- Unknown alias → rejected (550 / preflight deny)
- Blocked sender (not in allow_rules) → rejected
- Duplicate Message-ID → skipped
- Duplicate body hash → skipped
- Per-alias rate limit exceeded → 452 / preflight deny
- Per-sender rate limit exceeded → 452 / preflight deny
- Option B: missing HMAC → 401; stale timestamp → 401
- Attachment: file at uuid path → download → `downloaded_at` set → cron removes after TTL
- Expired token → 404; tampered token → 403
- `/healthz` → 200 always; `/readyz` → 200 when DB up, 503 when DB down
- Forum topic: `message_thread_id` stored + used on send

### Manual E2E

```bash
# Option A
swaks --to alerts-k3x9m2@tgmail.domain.com --from allowed@sender.com \
      --server localhost:25 --header "Subject: Test" \
      --body "Hello" --attach /path/to/file.png

# Option B
curl -X POST https://tgmail.domain.com/inbound/preflight \
  -H "X-Worker-Sig: <hmac>" \
  -d '{"to":"alerts-k3x9m2@tgmail.domain.com","from":"allowed@sender.com","rawSize":1234}'
```

---

## Known Limitations (MVP)

- **In-memory rate limiter**: resets on restart; replace with Redis for persistence
- **Single domain**: `local_part` globally unique; multi-domain requires `UNIQUE(local_part, domain)`
- **No DKIM verification**: envelope sender can be spoofed; allow_rules mitigate this partially
- **No bounce/NDR**: if Telegram chat is deleted, retries eventually exhaust; auto-deactivate on N failures is a future enhancement
- **Option A STARTTLS**: self-signed cert; some strict MTAs may downgrade to plaintext

---

## Future Enhancements (Post-MVP)

- **Redis**: persistent rate limiting + job queue (BullMQ) for higher throughput
- **Webhook mode**: switch grammY from long-polling to webhook
- **Screenshot rendering**: Playwright sidecar → HTML → PNG → Telegram photo
- **Multi-domain support**: `UNIQUE(local_part, domain)` schema migration
- **Web dashboard**: manage aliases + view delivery logs
- **Bounce notifications**: DSN to senders on permanent Telegram failure
- **Let's Encrypt STARTTLS** (Option A): reuse Caddy certs for SMTP
- **Content-type sniffing**: libmagic verification of attachment content vs declared type
- **Download all as ZIP**: generate zip of all attachments per email on demand
