# Staging migration: Oracle → vprojects VM

## Goal

Move the staging deployment of `email-to-telegram` from Oracle onto the shared
`vprojects` VM (10.0.88.3), reusing the existing self-hosted GitHub runner that
already deploys prod. Add Caddy edge config for the staging hostname and deploy
the staging Cloudflare Worker.

## Target topology

```
Internet
  └─ MikroTik → Caddy VM (kc-infra)
        ├─ tgemails.vladkarok.pp.ua → prod VM:3000        (unchanged)
        └─ tgmail.vladkarok.pp.ua   → 10.0.88.3:3000      (new, staging)

kc-github-runner
  └─ user gh-emailtg (existing runner)
        labels: [self-hosted, linux, x64, email-tg-prod, email-tg-staging]
        ssh aliases: prod, staging

Cloudflare Email Routing
  └─ zone staging.vladkarok.pp.ua per-alias rules → worker
        email-to-telegram-staging
              ├─ secret WORKER_SECRET
              └─ secret VPS_URL=https://tgmail.vladkarok.pp.ua
```

## Decisions captured

| Topic                 | Decision                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App home              | `~vladkarok/email-to-telegram` on vprojects                                                                                                                                                                                                                                                                                                                                       |
| User                  | Runs under `vladkarok` (in docker group)                                                                                                                                                                                                                                                                                                                                          |
| Network               | **Revised**: drop `proxy` network from base compose entirely (caddy is off-host on both envs). Base compose binds `${HOST_BIND_IP:-0.0.0.0}:3000:3000`. Staging `.env` sets `HOST_BIND_IP=10.0.88.3` (private interface only); prod `.env` leaves it unset (0.0.0.0). No overrides, no stub networks. After deploy, `rm ~/email-to-telegram/docker-compose.override.yml` on prod. |
| MAIL_DOMAIN           | `staging.vladkarok.pp.ua` (per-alias rules in CF dashboard)                                                                                                                                                                                                                                                                                                                       |
| HOSTED_MAIL_DOMAIN    | same                                                                                                                                                                                                                                                                                                                                                                              |
| APP_MODE              | `hosted`, `BILLING_PROVIDER=none`, `ADMIN_ENABLED=true`                                                                                                                                                                                                                                                                                                                           |
| PUBLIC_BASE_URL       | `https://tgmail.vladkarok.pp.ua`                                                                                                                                                                                                                                                                                                                                                  |
| Runner                | Reuse existing `gh-emailtg`; add `email-tg-staging` label via **GitHub repo Settings → Actions → Runners UI** (no sudo, no service restart).                                                                                                                                                                                                                                      |
| Wrangler              | Run from dev machine (already authenticated).                                                                                                                                                                                                                                                                                                                                     |
| Secrets               | Generated via `openssl` and routed to `.env` / `wrangler secret put` with minimal echo, but values do pass through this agent's tool output. If full secrecy required, run those exact commands yourself.                                                                                                                                                                         |
| INITIAL_ALLOWED_USERS | `419515180`                                                                                                                                                                                                                                                                                                                                                                       |
| TELEGRAM_BOT_TOKEN    | Placeholder `__SET_BEFORE_LAUNCH__`; you fill on VM before final restart.                                                                                                                                                                                                                                                                                                         |
| Backups               | **On** (`BACKUP_DIR=/data/backups`, `BACKUP_ARCHIVE_ENCRYPTION=storage-key`) — mirror prod.                                                                                                                                                                                                                                                                                       |
| Metrics               | **On** (`METRICS_ENABLED=true`, `METRICS_TOKEN` generated) — mirror prod.                                                                                                                                                                                                                                                                                                         |
| Storage encryption    | **On** (`STORAGE_ENCRYPTION_MODE=local-v1`, `MASTER_ENCRYPTION_KEY` generated, `MASTER_ENCRYPTION_KEY_ID=staging-v1`) — mirror prod.                                                                                                                                                                                                                                              |
| GHCR auth             | Inline via `secrets.GHCR_TOKEN` in the workflow (same as prod's `deploy.yml`). No manual `docker login` needed during setup.                                                                                                                                                                                                                                                      |

## Execution steps

### 0. Pre-reqs you do once

1. DNS record `tgmail.vladkarok.pp.ua` → Caddy VM public IP — **done**.
2. From GitHub repo `Vladkarok/email-to-telegram` → Settings → Actions → Runners → click `gh-runner-email-tg-01` → add label `email-tg-staging`. Confirm via:
   `gh api repos/Vladkarok/email-to-telegram/actions/runners --jq '.runners[] | {name, labels:[.labels[].name]}'` shows both labels.
3. GHCR auth: not needed as a pre-req. The workflow (mirroring prod `deploy.yml`) does `echo "${GHCR_TOKEN}" | docker login ghcr.io -u vladkarok --password-stdin` inside the ssh heredoc, using the existing repo secret `GHCR_TOKEN`. No manual login during setup.

### 1. Generate shared secrets (local, one shot)

On dev machine, in a scratch dir, run a script that writes each generated value to a file with `chmod 600` and assembles:

- `staging.env` (full env file for vprojects)
- `worker.secrets` (just WORKER_SECRET, for wrangler step)

I'll keep stdout silent; values are written file-only. Note: command lines still appear in tool transcript — privacy claim limited to "values aren't `echo`ed".

Generated: `POSTGRES_PASSWORD`, `HMAC_SECRET`, `WORKER_SECRET`, `ADMIN_SECRET`, `ADMIN_SESSION_SECRET`, `METRICS_TOKEN`, `MASTER_ENCRYPTION_KEY` (base64 32).

### 2. Repo changes (branch `chore/staging-on-vprojects`)

1. **Add `docker-compose.staging.yml` override** at repo root:
   - `ports: ["10.0.88.3:3000:3000"]` on app (explicit private bind).
   - No network changes — the `proxy` external network is satisfied by a stub created on vprojects in step 3.
2. **Rewrite `.github/workflows/deploy-staging.yml`**:
   - `runs-on: [self-hosted, linux, x64, email-tg-staging]`.
   - Steps mirror prod: `scp docker-compose.yml docker-compose.staging.yml staging:~/email-to-telegram/` then `ssh staging bash <<EOF` for `docker login ghcr` → `IMAGE_TAG=main docker compose -f docker-compose.yml -f docker-compose.staging.yml --env-file .env pull/up` → 30×5s health-poll.
   - Drop `SSH_HOST_STAGING / SSH_USER_STAGING / SSH_PORT_STAGING / SSH_KEY_STAGING` secret references.
3. Open PR — **do not merge yet**.

### 3. Runner host (kc-github-runner) — needs sudo

You grant passwordless sudo, then I:

1. Generate ed25519 key for `gh-emailtg` if missing.
2. Append pubkey to `~vladkarok/.ssh/authorized_keys` on vprojects.
3. Write SSH config entry for `gh-emailtg`:
   ```
   Host staging
     HostName 10.0.88.3
     User vladkarok
     IdentityFile ~/.ssh/id_ed25519
     StrictHostKeyChecking accept-new
   ```
4. Sanity: `sudo -u gh-emailtg ssh staging 'hostname && docker ps'`.

### 4. vprojects VM preparation

1. `mkdir -p ~/email-to-telegram` (named volumes handle storage).
2. `docker network create proxy` (stub bridge so base compose's `external: true` reference resolves — nothing else uses it on this host).
3. `scp staging.env vprojects:~/email-to-telegram/.env && ssh vprojects 'chmod 600 ~/email-to-telegram/.env'`. Static keys baked in: `MAIL_DOMAIN`, `HOSTED_MAIL_DOMAIN`, `PUBLIC_BASE_URL`, `HTTP_PORT=3000`, `APP_MODE=hosted`, `BILLING_PROVIDER=none`, `ADMIN_ENABLED=true`, `STORAGE_ENCRYPTION_MODE=local-v1`, `MASTER_ENCRYPTION_KEY_ID=staging-v1`, `METRICS_ENABLED=true`, `BACKUP_DIR=/data/backups`, `BACKUP_ARCHIVE_ENCRYPTION=storage-key`, `INITIAL_ALLOWED_USERS=419515180`, `ALERT_CHAT_ID=419515180`, `LOG_LEVEL=info`, `NODE_ENV=production`. Plus placeholder `TELEGRAM_BOT_TOKEN=__SET_BEFORE_LAUNCH__`.
4. No manual `docker login` — workflow handles it on every deploy.
5. **Firewall check**: confirm vprojects has either no host firewall (current state — only docker bridges) or rules that only allow port 3000 from the Caddy VM private IP. If nothing is enforced, add nftables rule limiting `10.0.88.3:3000` ingress to the Caddy VM's private IP. (`ss -tlnp` showed only 22 + docker-published ports, so default-allow within the private LAN is the current posture — call out and confirm with user before adding restrictions.)

### 5. Cloudflare Worker (staging)

From `~/Work/email-to-telegram/cloudflare-worker`:

1. `wrangler deploy --env staging`.
2. `wrangler secret put WORKER_SECRET --env staging < worker.secrets`.
3. `printf 'https://tgmail.vladkarok.pp.ua' | wrangler secret put VPS_URL --env staging`.
4. Verify with `curl -i https://email-to-telegram-staging.<account>.workers.dev` (expect 405/401 — worker rejects non-CF requests).
5. **You (manual)**: set per-alias Email Routing rules on zone `staging.vladkarok.pp.ua` → worker `email-to-telegram-staging`.

### 6. Caddy edge config (kc-infra PR)

1. Create `sites-available/tgmail.vladkarok.pp.ua.caddy`:
   ```caddyfile
   tgmail.vladkarok.pp.ua {
       tls {
           dns cloudflare {env.CF_TOKEN_VL}
           resolvers 1.1.1.1
       }
       import common_proxy
       reverse_proxy 10.0.88.3:3000
   }
   ```
2. Append `tgmail.vladkarok.pp.ua.caddy` to `enabled-sites.txt`.
3. Open PR, merge → existing infra-kc deploy rolls it out.
4. Verify: `curl -I https://tgmail.vladkarok.pp.ua` returns a valid cert (502 expected until step 7 — app not started).

### 7. Sequencing gate, then first deploy

Before merging the email-to-telegram PR:

- [ ] Runner shows both labels (step 0.2 `gh api` check).
- [ ] `sudo -u gh-emailtg ssh staging hostname` works (step 3.4).
- [ ] `.env` on vprojects exists with 600 perms.
- [ ] `proxy` docker network exists on vprojects.

Then merge → `deploy-staging.yml` triggers → runner picks job → builds `:main` → scp + `docker compose up`. Postgres + app HTTP healthcheck pass; bot will log auth errors due to placeholder token.

### 8. Final cutover (you)

1. `ssh vprojects 'vi ~/email-to-telegram/.env'` — set real `TELEGRAM_BOT_TOKEN`.
2. `ssh vprojects 'cd ~/email-to-telegram && docker compose -f docker-compose.yml -f docker-compose.staging.yml --env-file .env up -d --no-deps app'` (only restart app; leave postgres alone).
3. `curl https://tgmail.vladkarok.pp.ua/healthz` → 200.
4. Send a test email to a staging alias → verify DM.

## Rollback

One-liner: revert both PRs, `wrangler delete --env staging`, `ssh vprojects 'cd ~/email-to-telegram && docker compose down -v && cd .. && rm -rf email-to-telegram'`, remove `email-tg-staging` label in GH UI.

## Open items called out by review

- DNS A record for `tgmail` must exist before Caddy issues cert (step 0.1).
- Runner label change is via GH UI/API, **not** `config.sh --labels` (that only works at registration).
- `proxy` external network handled by stub-create on vprojects; alternative is restructuring compose files (deferred).
- Port bound to `10.0.88.3` specifically, not `0.0.0.0`.
- Secret values pass through agent tool output; if you need stronger guarantees, run step 1 and step 5.2/5.3 yourself.
- Firewall on vprojects: current posture is no host firewall (only Docker iptables rules). Plan keeps that posture; call out for explicit acceptance.
