# Runbook — email-to-telegram

## Architecture

```
[Sender] → [Cloudflare Email Routing] → [Email Worker] → [VPS HTTPS API] → [Telegram Bot]
```

- **VPS**: Oracle Cloud Always Free (ARM), `oracle-shiny`
- **Reverse proxy**: Caddy (auto TLS via Cloudflare DNS-01), on the `proxy` Docker network
- **Image registry**: GHCR (`ghcr.io/vladkarok/email-to-telegram:latest`)
- **CI/CD**: GitHub Actions — push to `main` triggers build + deploy

---

## Deployment

### Automatic (normal flow)

Push to `main`. GitHub Actions will:

1. Run lint + typecheck + tests (CI job)
2. Build Docker image and push to GHCR
3. SSH into VPS, pull new image, `docker compose up -d --remove-orphans`
4. Run DB migrations inside the new container

Monitor at: `github.com/Vladkarok/email-to-telegram/actions`

### Manual deploy (emergency)

```bash
ssh oracle-shiny
cd ~/email-to-telegram
git pull origin main
echo "$GHCR_TOKEN" | docker login ghcr.io -u vladkarok --password-stdin
docker compose pull
docker compose up -d --remove-orphans
docker compose exec -T app node dist/index.js --migrate-only || true
```

### First-time setup on a new VPS

```bash
# 1. Clone repo
git clone https://github.com/Vladkarok/email-to-telegram.git ~/email-to-telegram
cd ~/email-to-telegram

# 2. Create .env from example
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD, TELEGRAM_BOT_TOKEN, MAIL_DOMAIN,
# PUBLIC_BASE_URL, HMAC_SECRET, WORKER_SECRET, INITIAL_ALLOWED_USERS

# 3. Create shared proxy network (if not already exists)
docker network create proxy

# 4. Start services
docker compose up -d

# 5. Verify health
docker compose ps
curl http://127.0.0.1:3000/healthz
```

---

## Health checks

### Endpoint

```
GET /healthz
→ {"status":"ok"}
```

### Container status

```bash
ssh oracle-shiny "cd ~/email-to-telegram && docker compose ps"
```

Expected: both `app` and `postgres` show `Up (healthy)`.

### Resource usage

```bash
ssh oracle-shiny "docker stats email-to-telegram-app-1 email-to-telegram-postgres-1 --no-stream"
```

Idle baseline: ~40 MB (app) + ~26 MB (postgres), ~0% CPU.

---

## Common issues

### Bot not responding

1. Check polling status — look for 409 conflict in logs:
   ```bash
   ssh oracle-shiny "docker logs email-to-telegram-app-1 --tail=50 2>&1 | grep -E 'error|Error|409'"
   ```
2. If 409 found: a manual `getUpdates` call (external tool/script) conflicted with the bot.
   The app auto-restarts polling after 5s — wait and retry.
3. If no logs at all after sending a command: restart the container:
   ```bash
   ssh oracle-shiny "cd ~/email-to-telegram && docker compose up -d app"
   ```
   Note: use `up -d`, not `restart` — `restart` does not re-read `.env`.

### Container unhealthy

```bash
ssh oracle-shiny "docker logs email-to-telegram-app-1 --tail=100 2>&1"
```

Common causes:

- Missing required env var — look for `Invalid configuration` in logs
- DB not ready — postgres healthcheck should gate startup; check postgres logs
- Port conflict on 3000 — check `ss -tlnp | grep 3000`

### Email not arriving in Telegram

Check each stage:

1. **Cloudflare Email Routing** — confirm catch-all route is Active and points to the `email-to-telegram` Worker (Dashboard → Email → Email Routing → Routing rules)
2. **Worker reached VPS** — check app logs for `/inbound/preflight` or `/inbound/raw` requests
3. **Alias exists and active** — query DB:
   ```bash
   ssh oracle-shiny "docker exec email-to-telegram-postgres-1 psql -U emailtelegram -c 'SELECT local_part, status FROM email_addresses;'"
   ```
4. **Allow rule exists**:
   ```bash
   ssh oracle-shiny "docker exec email-to-telegram-postgres-1 psql -U emailtelegram -c 'SELECT match_type, match_value FROM allow_rules;'"
   ```
5. **Telegram send error** — check logs for `level:50` (error) entries

### Cloudflare 522 error

Origin unreachable from Cloudflare proxy.

- Verify SSL/TLS mode is **Full** (not Flexible): Dashboard → SSL/TLS → Overview
- Check Caddy is running: `ssh oracle-shiny "docker ps | grep caddy"`
- Test origin directly: `curl -sk --resolve tgmail.vladkarok.pp.ua:443:127.0.0.1 https://tgmail.vladkarok.pp.ua/healthz`

### `.env` change not taking effect after restart

`docker compose restart` does **not** re-read `.env`. Always use:

```bash
docker compose up -d app
```

---

## Rollback

### Roll back to previous image

GHCR only stores `latest`. To roll back, redeploy from the previous commit:

```bash
# On VPS:
cd ~/email-to-telegram
git log --oneline -5          # find the commit to roll back to
git checkout <commit-hash>
docker compose build          # build locally from that commit
docker compose up -d --remove-orphans
```

Or revert the commit on `main` and let CI/CD redeploy automatically.

### Roll back a migration

Drizzle does not support automatic down-migrations. To revert:

1. Identify the schema change
2. Write a manual SQL rollback
3. Apply via: `docker exec email-to-telegram-postgres-1 psql -U emailtelegram -c '<SQL>'`

---

## Secrets rotation

| Secret               | Where to update                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | BotFather → revoke → update `.env` on VPS → `docker compose up -d app`                        |
| `HMAC_SECRET`        | Update `.env` → redeploy — existing attachment links will break                               |
| `WORKER_SECRET`      | Update `.env` AND `wrangler secret put WORKER_SECRET` in `cloudflare-worker/` → redeploy both |
| `POSTGRES_PASSWORD`  | Update `.env` + recreate postgres container (data volume persists)                            |
| `GHCR_TOKEN`         | GitHub → Settings → Tokens → update in repo Secrets                                           |
| `SSH_KEY`            | GitHub repo Secrets → `SSH_KEY`                                                               |

---

## Logs

```bash
# Follow live
ssh oracle-shiny "cd ~/email-to-telegram && docker compose logs app -f"

# Last 100 lines
ssh oracle-shiny "docker logs email-to-telegram-app-1 --tail=100 2>&1"

# Errors only
ssh oracle-shiny "docker logs email-to-telegram-app-1 2>&1 | grep '\"level\":50'"
```

Log levels (pino): `10`=trace, `20`=debug, `30`=info, `40`=warn, `50`=error, `60`=fatal.

Set `LOG_LEVEL=debug` in `.env` + `docker compose up -d app` for verbose output.
