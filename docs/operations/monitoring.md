# Monitoring Stack

## Overview

A self-hosted Prometheus + Grafana + Loki stack runs on the staging VM alongside the application containers. Co-locating it with staging keeps cost and operational surface low while letting the same instance optionally scrape production. Grafana is fronted by a Caddy reverse proxy (vhost `grafana.example.com`, configured outside this repo) and reachable only from the LAN / WireGuard VPN — Caddy returns 404 to any request from the public internet. Grafana's raw port is still published on the private VPN interface (see below) but the canonical access path is the Caddy HTTPS URL.

Each VM also runs a small host agent (`monitoring/agent/`, compose project `etg-agent`): node_exporter and postgres_exporter on both, and on prod a Promtail that ships the app container's log lines to the staging Loki. Nothing leaves the two VMs.

## Architecture

```
 prod VM 10.0.88.2                          staging VM 10.0.88.3
 +-------------------------------+          +--------------------------------------+
 | app compose: app, postgres    |          | app compose: app, postgres           |
 |   app :3000 /metrics  <---------- bearer --- prometheus      (monitoring      |
 |                               |          |      |  scrape      compose)         |
 | etg-agent compose             |          |      |  TLS + basic auth             |
 |   node_exporter     :9100 <-----------------+---+--> node_exporter     :9100     |
 |   postgres_exporter :9187 <-----------------+------> postgres_exporter :9187     |
 |                               |          |         (etg-agent compose)          |
 |   promtail (json-file logs,   |  push    |                                      |
 |   app container only)  --------- TLS ----> loki-gateway :3101 --> loki :3100    |
 |                               |  + basic |                          ^           |
 +-------------------------------+   auth   |  promtail (Docker SD,    |           |
                                            |  app container only) ----+           |
                                            |  grafana :3001 (VPN, via Caddy)      |
                                            +--------------------------------------+
```

Listeners on the private subnet (`10.0.88.0/24`, which other hosts share). Each binds to its VM's `10.0.88.x` address only, serves TLS with a certificate from the private CA, and requires basic auth:

| Listener                      | Where   | Bind             | Consumer           |
| ----------------------------- | ------- | ---------------- | ------------------ |
| node_exporter `:9100`         | both    | `10.0.88.x:9100` | staging Prometheus |
| postgres_exporter `:9187`     | both    | `10.0.88.x:9187` | staging Prometheus |
| Loki push gateway `:3101`     | staging | `10.0.88.3:3101` | prod Promtail      |
| app `/metrics` `:3000` (HTTP) | both    | `HOST_BIND_IP`   | staging Prometheus |

The app's `/metrics` scrape is unchanged: bearer token over HTTP. Docker networks on the staging VM: `monitoring_scrape` (external, app + Prometheus) and `monitoring_internal` (Prometheus, Loki, Grafana, Promtail, gateway).

## First-time setup on the VM

Run once on the staging VM as the deploy user:

```sh
docker network create monitoring_scrape
mkdir -p ~/monitoring/prometheus/secrets
```

Create `~/monitoring/.env` from the template (`monitoring/.env.example` in the repo):

```sh
cp monitoring/.env.example ~/monitoring/.env
openssl rand -hex 16   # use as GRAFANA_ADMIN_PASSWORD
```

Required variables in `~/monitoring/.env` (read by docker compose at boot):

- `MONITORING_BIND_IP` — private interface IP for Grafana publish (e.g. the VPN IP). Compose refuses to start if unset.
- `LOKI_PUSH_BIND_IP` — the staging VM's subnet address, `10.0.88.3`. The Loki push gateway binds there on port 3101. Compose refuses to start if unset, and the deploy fails unless it is exactly `10.0.88.3` and the VM has that address.
- `GRAFANA_ADMIN_PASSWORD` — initial Grafana admin password. Required.
- `GRAFANA_ROOT_URL` — full URL operators use to reach Grafana, including trailing slash. **Must be the public Caddy URL** (e.g. `https://grafana.example.com/`), not the internal `http://<vm-private-ip>:3001/`. Grafana uses this for redirects, shared links, **and the Grafana Live WebSocket origin check**: if it points at the internal IP while the browser reaches Grafana via Caddy, the browser Origin no longer matches and every `/api/live/ws` upgrade is rejected `401`, producing a reconnect loop (see Troubleshooting).
- `GRAFANA_ADMIN_USER` — optional, defaults to `admin`.

**Bearer tokens are not in `~/monitoring/.env`.** Scrape auth comes from the GitHub repository secrets `METRICS_BEARER_TOKEN_STAGING` / `METRICS_BEARER_TOKEN_PROD`. The deploy workflow writes them into `~/monitoring/prometheus/secrets/{staging_token,prod_token}` on the host. Each secret must exactly match `METRICS_TOKEN` in the corresponding app deployment's `.env`; if they drift, Prometheus targets go red with `401 Unauthorized`. Rotate via the GitHub secret UI and re-run the workflow.

The exporter credentials and the push gateway's certificate and htpasswd come from the GitHub environment `staging` (see [GitHub environments and secrets](#github-environments-and-secrets)). The deploy writes them into `~/monitoring/secrets/`, which, like `prometheus/secrets/`, is excluded from the rsync `--delete`.

Trigger the `Deploy Monitoring` GitHub Action from the Actions tab to bring the stack up.

What `Deploy Monitoring` does on the VM (`monitoring/deploy/stack-deploy.sh`, under the [host lock](#the-host-lock)): checks `.env` and `LOKI_PUSH_BIND_IP`, syncs `monitoring/` into `~/monitoring/`, writes the token and secret files, runs `compose up`, reloads Prometheus, recreates Loki, Promtail, the gateway or Grafana when their start-time config changed, waits for health, and checks the push gateway (401 without credentials, 403 for `GET`, 204 for an authenticated empty push, plain HTTP refused). Config is mounted as directories, so a file the sync replaces is visible inside the running container.

Pushes that change only `monitoring/agent/**` deploy the host agent instead; neither monitoring workflow redeploys the staging app.

## GitHub environments and secrets

Two GitHub environments, created by the owner under Settings → Environments:

- `staging`: deployment branches limited to `main`. The `Deploy Monitoring` deploy job and the staging job of `Deploy Monitoring Agent` run in it.
- `production`: deployment branches limited to `main`, the owner as required reviewer. Only the production job of `Deploy Monitoring Agent` runs in it, on manual dispatch.

The app workflows (`Deploy`, `Deploy Staging`) are not bound to an environment and keep using repository secrets.

Environment secrets (`gh secret set NAME --env staging`, value on stdin):

| Secret                                   | `staging`                   | `production`         | Read by                                     |
| ---------------------------------------- | --------------------------- | -------------------- | ------------------------------------------- |
| `HOST_TLS_CERT`, `HOST_TLS_KEY`          | certificate for `10.0.88.3` | for `10.0.88.2`      | exporters; on staging also the push gateway |
| `PG_MONITOR_PASSWORD`                    | its own value               | its own value        | `etg_monitor` role, postgres_exporter       |
| `EXPORTER_BASIC_AUTH_PASSWORD`           | same value in both          | same value in both   | exporters accept it, Prometheus sends it    |
| `EXPORTER_BASIC_AUTH_PASSWORD_SECONDARY` | only during a rotation      | only during rotation | exporters accept it for the other user      |
| `LOKI_PUSH_PASSWORD`                     | same value in both          | same value in both   | the gateway accepts it, prod Promtail sends |
| `LOKI_PUSH_PASSWORD_SECONDARY`           | only during a rotation      | not used             | the gateway accepts it for the other user   |

Environment variables (`gh variable set NAME --env staging --body prometheus-a`):

| Variable                   | Values                         | Default        |
| -------------------------- | ------------------------------ | -------------- |
| `EXPORTER_BASIC_AUTH_USER` | `prometheus-a`, `prometheus-b` | `prometheus-a` |
| `LOKI_PUSH_USER`           | `promtail-a`, `promtail-b`     | `promtail-a`   |

Keep both variables equal in the two environments. Generate every password with `openssl rand -hex 32`. Prometheus scrapes both VMs and prod Promtail pushes to staging, which is why the exporter and push passwords are the same in both environments. The workflow refuses passwords shorter than 24 characters or with characters outside `[A-Za-z0-9._~+/=-]`.

The workflows render secrets on the runner with shell tracing off and never print them. bcrypt hashes (cost 10) come from the pinned `httpd:2.4.69-alpine` image on the target VM, password on stdin. The `etg_monitor` SCRAM verifier is computed on the runner (`python3`), so its plaintext never reaches Postgres. Runner prerequisites: `ssh`, `tar`, `rsync`, `openssl`, `python3`, `sha256sum`; VM prerequisites: `docker`, `flock`, `curl`, `ip`, `timeout`, and `rsync` on staging. A missing one fails the run.

## Certificates

A private CA signs one server certificate per VM; consumers verify against the CA, which is public and lives in the repo as `monitoring/tls/ca.crt`. The CA key stays offline: never on a VM, never in GitHub.

Create the CA once, in a private directory on the operator's machine:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
  -subj /CN=etg-monitoring-ca \
  -addext basicConstraints=critical,CA:TRUE,pathlen:0 \
  -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout ca.key -out ca.crt
cp ca.crt <code clone>/monitoring/tls/ca.crt   # commit it; never ca.key
```

Issue a server certificate per VM, valid 2 years, with its subnet address as the only SAN:

```sh
host=staging ip=10.0.88.3        # prod: host=prod ip=10.0.88.2
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$ip" \
  -keyout "$host.key" -out "$host.csr"
printf 'subjectAltName=IP:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' \
  "$ip" > "$host.ext"
openssl x509 -req -in "$host.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days 730 \
  -extfile "$host.ext" -out "$host.crt"
openssl verify -CAfile ca.crt "$host.crt"
gh secret set HOST_TLS_CERT --env "$( [ "$host" = prod ] && echo production || echo staging )" < "$host.crt"
gh secret set HOST_TLS_KEY --env "$( [ "$host" = prod ] && echo production || echo staging )" < "$host.key"
```

The deploy checks that the certificate chains to `monitoring/tls/ca.crt`, carries the VM's IP, matches the key and has not expired. It warns 30 days before expiry. Check the date any time with `openssl x509 -in "$host.crt" -noout -enddate`.

Renewal: issue a new certificate from the same CA with the commands above, replace the two secrets, then deploy. For staging, dispatch `Deploy Monitoring Agent` (staging) and `Deploy Monitoring` (gateway); for prod, dispatch `Deploy Monitoring Agent` (production). Consumers trust the CA, not the certificate, so the switch has no gap. The old certificate is retired by deleting its files; nothing else references it. The CA itself is valid for 10 years; replacing it means committing the new `ca.crt`, issuing both server certificates again, and deploying both agents and the stack in one sitting.

## Host agent

`monitoring/agent/docker-compose.agent.yml`, compose project `etg-agent` (pinned in the file), installed at `~/monitoring-agent/` with its own `.env` and `secrets/`. It is a separate project: no app service, no `depends_on`, the app network `email-to-telegram_internal` is joined as external and never created or removed, and the app workflows' `--remove-orphans` cannot see it. Every container has a memory, CPU and PID limit, json-file logging at 10 MB × 3, `no-new-privileges`, no capabilities and a read-only root filesystem.

| Service             | Image                                           | Limits           | Notes                                                                                                                                    |
| ------------------- | ----------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `node-exporter`     | `prom/node-exporter:v1.12.1`                    | 48 MiB, 0.25 CPU | host network and PID namespace, `/` mounted read-only at `/host`, textfile collector at `/var/lib/node_exporter/textfile`                |
| `postgres-exporter` | `prometheuscommunity/postgres-exporter:v0.20.1` | 48 MiB, 0.25 CPU | logs in as `etg_monitor` (password from a file), default collectors, `stat_statements` and custom queries off; never sees the app `.env` |
| `promtail`          | `grafana/promtail:2.9.10`                       | 96 MiB, 0.25 CPU | profile `prod` only; see [Prod logs](#prod-logs)                                                                                         |

Deploys: a push to `main` that touches `monitoring/agent/**` or the workflow deploys staging. Prod deploys only by dispatching `Deploy Monitoring Agent` with `environment: production` from `main`, after the owner approves.

What the deploy does on the VM (`monitoring/agent/deploy/agent-deploy.sh`), under the [host lock](#the-host-lock):

1. Checks that the VM has the expected address (`10.0.88.2` or `10.0.88.3`) and waits up to 120 s for the network `email-to-telegram_internal` and a healthy app Postgres, creating neither.
2. Pulls the pinned images.
3. Takes a snapshot of the previous deployment into `~/.etg-agent-snapshot/`: the `~/monitoring-agent/` tree, the image IDs in use and the role's current SCRAM verifier from `pg_authid`.
4. Writes the marker `~/.etg-agent-restore-pending` and arms the restore: from here on any exit before the deploy completes (a failure, SIGHUP or SIGPIPE from a dropped SSH session, a cancel) restores the snapshot: files, image tags, the old verifier, and each service's recorded state (running, stopped or absent; a Promtail stopped on purpose stays stopped). Everything the restore needs is in memory or in the snapshot, not in the uploaded payload.
5. Installs the files and `.env`, writes the secrets as temp file + rename with the consuming container's UID as owner (`65534` for the exporters, `0` for Promtail, mode `0400`) and checks each is readable as that UID with no capabilities, the way the containers read them.
6. Reconciles the `etg_monitor` role, runs `compose up`, and recreates a service whose start-time input (database password, Promtail config) changed.
7. Verifies: authenticated scrapes answer and `pg_up` is 1, requests without or with a wrong password get 401, plain HTTP fails; on prod, Promtail is ready, tails files and has no push refused during the ten-second verification window (an earlier, recovered refusal does not count), and an authenticated empty push to the gateway gets 204; the containers do not restart; the app and Postgres container IDs did not change.
8. Removes secret files the new manifest no longer lists (such as the previous Promtail user's password), then the marker and the snapshot.

Image pulls run under `timeout`, the `etg_monitor` session under `lock_timeout` and `statement_timeout`, and each deploy job has `timeout-minutes: 30`. The workflow's cleanup step removes the uploaded payload under the host lock, so after a cancel it waits for the remote script to finish restoring.

On a first deployment there is nothing to restore to: a failure takes the agent down, removes `~/monitoring-agent/` and leaves the role without `LOGIN`. If a run is killed before it could restore (runner lost, SIGKILL), the marker stays and the next run restores the snapshot before doing anything else. If that restore fails too (any step, including listing the services to restore), the run stops and keeps the marker and the snapshot; read `~/.etg-agent-restore.log`, repair by hand, then remove the marker.

Inspect, on either VM:

```sh
docker compose -p etg-agent -f ~/monitoring-agent/docker-compose.agent.yml \
  --env-file ~/monitoring-agent/.env ps          # prod: the .env sets COMPOSE_PROFILES=prod
docker compose -p etg-agent -f ~/monitoring-agent/docker-compose.agent.yml \
  --env-file ~/monitoring-agent/.env logs --tail 50 postgres-exporter
```

Rollback (volumes kept; the role can stay):

```sh
flock -w 900 ~/.etg-deploy.lock docker compose -p etg-agent \
  -f ~/monitoring-agent/docker-compose.agent.yml --env-file ~/monitoring-agent/.env --profile prod down
```

To go back to an earlier agent version, revert the change on `main`; staging redeploys on its own, prod by dispatch.

Firewall: node_exporter uses the host network, so a host firewall that filters input (ufw's default) must allow `tcp/9100` from the scraper: on prod from `10.0.88.3`, on staging from the Docker bridge subnets, because Prometheus connects from a container. Ports `9187` and `3101` are Docker-published and do not need a rule.

Accepted residual risk, postgres_exporter's `/probe` endpoint: v0.20.1 always serves `/probe?target=<DSN>` (multi-target mode, no flag turns it off), so a client holding the exporter credential can make the prod exporter open Postgres connections to a target of its choosing, with credentials it supplies. There is no small fix: exporter-toolkit cannot restrict paths, and a filtering proxy in front would not fit the agent's 192 MiB budget. The exposure is limited to holders of the exporter credential, which only staging Prometheus has (environment secrets, `0400` on the VMs), behind TLS and basic auth on `10.0.88.2:9187`. Revisit if an exporter release adds a switch or the budget allows a proxy.

## The etg_monitor role

postgres_exporter logs in as `etg_monitor`. Every agent deploy creates or reconciles it under the host lock, with `psql -X -q -v ON_ERROR_STOP=1` and `monitoring/agent/deploy/sql/reconcile-role.sql` on stdin, in one transaction:

- Created if absent. Missing `LOGIN`, `INHERIT` or membership in `pg_monitor` is repaired.
- Any other privilege fails the run and nothing is revoked automatically: `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, `BYPASSRLS`, any other role membership or admin option, owned objects, explicit table, column, schema, database, function or default grants, and every effective table, column and sequence privilege in the app database, whatever its source (the role's own grants, `PUBLIC`, inherited roles), extension relations included. The app's only extension, `pgcrypto`, has no relations; installing one that grants `PUBLIC` read access to a view (such as `pg_stat_statements`) makes the run fail until someone decides. The same checks run again after the repairs, before `COMMIT`, because a repaired membership can switch on inherited privileges.
- The password is set as a SCRAM-SHA-256 verifier computed on the runner. The verifier is still secret, so the session first switches off statement, error-statement, duration and sampling logs and sets `lock_timeout` and `statement_timeout` (the preamble lives in `monitoring/agent/deploy/lib.sh`, so a restore never runs without it); psql runs with `VERBOSITY terse` and its stderr drops any line containing `SCRAM-`. The CI test runs the deploys' `ALTER ROLE`s and a failing one through the same psql path against a Postgres with all of those logs switched on, and checks the server log, the deploy output and psql's unfiltered stderr for the verifier.

`pg_monitor` can read statistics, settings and other sessions' current query text in `pg_stat_activity`. App queries are parameterised; ad-hoc operator SQL may contain literals. The exporter's default collectors export counts, not query text.

## Prod logs

Prod app logs go to the staging Loki with `env="prod"`. The prod Promtail has no Docker API access. It tails `/var/lib/docker/containers/*/*-json.log` read-only. The app service's logging options in `docker-compose.yml` add `labels: com.docker.compose.project,com.docker.compose.service`, which puts an `attrs` object on every json-file line. The pipeline keeps a line only when `attrs` names project `email-to-telegram` and service `app`; Postgres lines, the agent's own lines and anything else are dropped on the VM. Stream labels: `env`, `compose_project`, `service`, `stream`. The timestamp is the json-file envelope's. Positions live in the volume `etg-agent_promtail-positions`.

Staging's Promtail applies the same allowlist through Docker service discovery: only the `email-to-telegram` project's `app` container is read, other projects on the staging VM are not.

Delivery is best effort. Known loss and duplicate windows:

- lines written after Promtail last read the file, when Docker deletes the file on a container recreate (Promtail reads within seconds; deploys stop the old container first);
- batches still pending when Promtail stops;
- batches dropped after Promtail's retries (10, backoff up to 5 minutes) run out during a long Loki or gateway outage;
- lines sent twice after a crash, from the last positions checkpoint.

Compatibility boundary: the allowlist needs the `attrs` that the app's logging `labels` option adds, so only releases from the first one with that option ship logs. Rolling prod back to an older release stops prod log shipping until a newer release is deployed again. The Logs row's **Prod app lines (15 min)** stat shows 0 in that state.

## Rotating basic-auth passwords

Each direction has two users so that a consumer never holds a credential the server rejects: the servers accept both while the consumer switches. Rotate one direction at a time and do not run deploys while editing secrets.

A consumer's username and password always change together. Each password file is named after its user (`~/monitoring/secrets/prometheus/<user>`, `~/monitoring-agent/secrets/promtail/<user>`) and the previous user's file stays until the deploy has finished. Prometheus takes the new username and file name from its config on the reload, and Promtail from its environment when it is recreated, so neither sends one user's name with the other's password.

Exporters (servers: both agents; consumer: Prometheus), from `prometheus-a` to `prometheus-b`:

1. Set `EXPORTER_BASIC_AUTH_PASSWORD_SECONDARY` to the new password in `staging` and `production`. Deploy the agent to staging and to production. The exporters now accept `prometheus-a` with the old password and `prometheus-b` with the new one.
2. In both environments set `EXPORTER_BASIC_AUTH_USER=prometheus-b`, `EXPORTER_BASIC_AUTH_PASSWORD` to the new password and `EXPORTER_BASIC_AUTH_PASSWORD_SECONDARY` to the old one. The set the exporters accept does not change. Dispatch `Deploy Monitoring`: Prometheus switches. Check that the `node` and `postgres` targets are up.
3. Delete `EXPORTER_BASIC_AUTH_PASSWORD_SECONDARY` in both environments and deploy both agents again.

Push (server: the staging gateway; consumer: prod Promtail), from `promtail-a` to `promtail-b`:

1. Set `LOKI_PUSH_PASSWORD_SECONDARY` to the new password in `staging` and dispatch `Deploy Monitoring`.
2. In `production` set `LOKI_PUSH_USER=promtail-b` and `LOKI_PUSH_PASSWORD` to the new password. In `staging` set the same two, plus `LOKI_PUSH_PASSWORD_SECONDARY` to the old password. Dispatch the production agent deploy; it verifies with an authenticated push.
3. Delete `LOKI_PUSH_PASSWORD_SECONDARY` in `staging` and dispatch `Deploy Monitoring`.

`PG_MONITOR_PASSWORD`: set the new value and deploy the agent for that environment. The role and the exporter's password file change in the same locked run; one scrape may report `pg_up 0`.

## The host lock

Every job that changes a VM (`Deploy`, `Deploy Staging`, `Deploy Monitoring`, `Deploy Monitoring Agent`) shares a job-level concurrency group per VM, `host-prod` or `host-staging`, with `cancel-in-progress: false` and `queue: max`: a second run waits in the queue instead of replacing a pending one. Each workflow also has a workflow-level group of its own (`deploy-release`, `deploy-staging`, `deploy-monitoring`, `deploy-monitoring-agent-<environment>`), also queued, so its runs start in trigger order. On the VM, each remote script also takes `flock -w 900 ~/.etg-deploy.lock` and fails if the lock is still held after 15 minutes. Deploy jobs time out after 30 minutes.

`Deploy Staging` deploys the image its own build pushed, tagged `main-<commit>`, together with that commit's compose file; `:main` is still pushed but no longer deployed.

Only the workflow definitions on `main` are supported entry points. An app rollback dispatches `main`'s `Deploy` with an older `release_tag`, never the workflow file of an old tag; older definitions do not take the lock.

Run manual changes on a VM under the same lock:

```sh
flock -w 900 ~/.etg-deploy.lock <command>
```

## Backup freshness

`etg-r2-backup` writes `etg_offsite_backup_last_success_timestamp_seconds` to `/var/lib/node_exporter/textfile/etg_offsite_backup.prom` after a successful upload (temp file, mode 0644, rename). node_exporter's textfile collector exposes it and the Host & database row shows the age. A failure to write the metric is logged and never fails the backup. `install.sh` creates the directory and the service unit allows the write, so re-run it once on each VM after updating the repo copy:

```sh
sudo bash infra/offsite-backup/install.sh <environment> <restic-repository>
```

## Accessing Grafana

Connect to the LAN or WireGuard VPN, then open:

```
https://grafana.example.com
```

Caddy terminates TLS and reverse-proxies to Grafana at `<vm-private-ip>:3001`, restricting access to the LAN and VPN source ranges (any other source IP gets a 404). Log in as `admin` with the password from `~/monitoring/.env`.

Grafana's raw port `3001` is still published on the VM's private VPN interface. Direct `http://<VPN-IP>:3001` access works for HTTP but Grafana Live (dashboard auto-refresh) will 401 there, because `GRAFANA_ROOT_URL` is set to the Caddy URL — use the Caddy HTTPS host. Verify the raw port is not exposed publicly:

```sh
ssh <staging-host> 'ss -tlnp | grep 3001'
```

The output must bind to the VPN interface only (not `0.0.0.0`).

## Dashboards

Provisioned from `monitoring/grafana/provisioning/dashboards/json/` (read-only in
the UI; edit the JSON and redeploy). All three have the `Env` variable
(single-select, default `prod`). Every panel's info icon says what it shows and
what "bad" looks like.

**Email to Telegram – Operations** (`e2t-app`, default range 24 h): is mail
getting from the sender to Telegram, how fast, and where is it lost.

- Top row, always visible: Scrape up · Version · Uptime · Stale bot updates
  (24h, text messages skipped as older than `STALE_TEXT_UPDATE_MAX_AGE_S`;
  orange above 0; see below) · Offered (24h,
  preflight decisions without signature failures) · Delivered (24h, first
  attempts plus retries) · Lost (7d, `deliveries_lost_total`; red above 0) ·
  Backlog now (pending logs and the oldest one's age) · Latency (24h, delivery
  p95).
- Stale bot updates is a lower bound. Skips happen right after a start,
  often before the first 30-s scrape, so `increase()` can miss them: the
  process's first sample is already non-zero and no counter reset shows. The
  panel therefore also shows the highest total one process reported in 24 h
  (`max_over_time` of the summed counter), which catches skips a later scrape
  still sees; a process that stops before its first scrape is missed by both.
  The exact count is the number of `telegram.update.stale_skipped` log lines
  in Loki:
  `sum(count_over_time({compose_project="email-to-telegram", service="app", env="prod"} |= "telegram.update.stale_skipped" [24h]))`.
- **Inbound**: preflight decisions per hour (accepted / deferred / bounced),
  preflight bounces by reason, raw uploads per hour (accepted / rejected), raw
  rejections by reason, bounce notices per hour by stage and result, one-tap
  allows per hour by result.
- **Delivery**: deliveries per hour by path and result, lost mail per hour by
  stage, delivery latency p50 / p95, first-attempt success rate per hour,
  delivery backlog, Telegram send failures by class, rich vs classic fallback,
  local rich downgrades by reason, backpressure (24h stat and per hour).
- **HTTP**: requests per hour by status class and by route, p95 latency by route
  (1 h window). `/healthz` and `/metrics` are excluded: probe and scrape traffic
  would otherwise drown real requests.
- **Logs** (collapsed): app error logs from Loki for the selected env
  (`{compose_project="email-to-telegram", service="app", env="$env"}`), and
  **Prod app lines (15 min)**: how many prod app lines reached Loki in the
  last 15 minutes, whatever Env is set to. 0 while prod handles mail means
  prod logs are not arriving (see [Prod logs](#prod-logs)); a quiet app can
  also log nothing for 15 minutes.
- **Host & database** (collapsed): root filesystem free, memory available,
  load, swap, `pg_up`, connections and size of the `emailtelegram` database,
  off-site backup age (red above 30 h). These read node_exporter (job `node`)
  and postgres_exporter (job `postgres`) of the [host agent](#host-agent),
  both labelled `env`, and `etg_offsite_backup_last_success_timestamp_seconds`
  from node_exporter's textfile collector. An environment whose agent is not
  deployed shows "No data"; backup age shows "No data" until the first
  nightly upload after [install.sh is re-run](#backup-freshness).

**Email to Telegram – Product** (`e2t-product`, default range 30 d, refresh 5
min, UTC time axis so daily bars are UTC days): activation funnel (signed up →
created an alias → ever received mail → received mail this month), users and
aliases over time, delivered per day, quota rejections per day by reason, users
by plan, aliases by status, chats, attachments storage.

**Email to Telegram – Runtime** (`e2t-runtime`): process CPU, RSS, heap, event
loop lag, GC time.

How to read them:

- **"Per hour" and "per day" panels are real buckets.** Each bar is
  `increase(metric[$__interval])` with the panel's minimum interval set to `1h`
  or `1d`, so a bar covers exactly the hour (or UTC day) ending at its right
  edge and the legend's Total is the true sum over the range. The bucket still
  in progress is not drawn. On ranges wide enough that Grafana picks a larger
  interval, a bar covers that interval instead.
- **Deferral is not backpressure.** A _deferral_ happens at preflight: over the
  per-alias hourly cap the app answers 429, the Worker fails the SMTP
  transaction temporarily and the sending server retries later
  (`inbound_preflight_total{result="deferred",reason="rate_limited"}`). The mail
  never reached the app and is not lost. _Backpressure_ happens after
  acceptance: the mail is stored, but the in-flight delivery cap
  (`MAX_INFLIGHT_DELIVERIES`) is full, so it waits for the retry worker
  (`deliveries_deferred_total`, shown as "Backpressure: sent to retry worker").
  It is delivered minutes later. Before the `deferred` result existed, hourly-cap
  deferrals were recorded as `result="rejected",reason="rate_limited"` and show
  up among the older preflight bounces.
- **Process starts are annotated.** The `App start` annotation (toggle at the
  top of Operations and Runtime) draws a marker at each app process start,
  using `process_start_time_seconds` as the timestamp and the version from
  `email_to_telegram_build_info` as text. Deploys and crashes both show up; a
  marker with no deploy behind it is a crash.
- **Lost means the user never got the mail.** `deliveries_lost_total{stage}`
  counts each delivery log closed as `permanently_failed`, once the status
  write succeeds: `initial` (first attempt to a blocked or deleted chat),
  `retry` (the retry worker gave up), `cleanup` (the raw email expired before
  any delivery succeeded, e.g. Telegram unreachable for the whole TTL).
  `retry_attempts_total{result="permanently_failed"}` covers only the retry
  stage, so it undercounts loss.
- **No data vs 0.** Counters start every known label set at 0 when the process
  starts, and stats use `or vector(0)`, so "0" means nothing happened. "No
  data" means the series does not exist: the target is not scraped, the
  exporter is not deployed, or the app predates the metric.

## Business metrics catalog

All gauges/counters are prefixed `email_to_telegram_`. Exposed at `GET /metrics` (bearer-protected).

| Metric                                                             | Type      | Description                                                                                                                                           | Example PromQL                                                                                                   |
| ------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `email_to_telegram_build_info{version}`                            | gauge     | Always 1; `version` is the running app version from `package.json`                                                                                    | `max by (version)(email_to_telegram_build_info)`                                                                 |
| `email_to_telegram_users{state}`                                   | gauge     | Users by state (`total`, `allowed`, `with_alias`, `accepted_mail_this_month`, `ever_delivered`; see below)                                            | `email_to_telegram_users{state="ever_delivered"}`                                                                |
| `email_to_telegram_users_total`                                    | gauge     | Total users across all plans                                                                                                                          | `email_to_telegram_users_total`                                                                                  |
| `email_to_telegram_active_users_by_plan{plan}`                     | gauge     | Active users by plan                                                                                                                                  | `email_to_telegram_active_users_by_plan{plan="pro"}`                                                             |
| `email_to_telegram_chats{state}`                                   | gauge     | Chats by state (`total`, `active`)                                                                                                                    | `email_to_telegram_chats{state="active"}`                                                                        |
| `email_to_telegram_aliases{status}`                                | gauge     | Aliases grouped by status (`active`, `paused`, `deleted`)                                                                                             | `sum by (status)(email_to_telegram_aliases)`                                                                     |
| `email_to_telegram_attachments_stored`                             | gauge     | Stored attachment count                                                                                                                               | `email_to_telegram_attachments_stored`                                                                           |
| `email_to_telegram_attachments_stored_bytes`                       | gauge     | Total stored attachment bytes                                                                                                                         | `email_to_telegram_attachments_stored_bytes / 1024 / 1024 / 1024`                                                |
| `email_to_telegram_inbound_preflight_total{result,reason}`         | counter   | Preflight decisions: `accepted`, `rejected` (the Worker bounces with a permanent 550), `deferred` (429 over the alias hourly cap; the sender retries) | `sum by (result)(increase(email_to_telegram_inbound_preflight_total[1h]))`                                       |
| `email_to_telegram_raw_inbound_total{result,reason}`               | counter   | Raw upload decisions (`accepted`, `rejected`) by reason                                                                                               | `sum by (reason)(increase(email_to_telegram_raw_inbound_total{result="rejected"}[1h]))`                          |
| `email_to_telegram_delivery_attempts_total{result}`                | counter   | Delivery attempts by result                                                                                                                           | `sum by (result)(rate(email_to_telegram_delivery_attempts_total[5m]))`                                           |
| `email_to_telegram_retry_attempts_total{result}`                   | counter   | Retry attempts by result                                                                                                                              | `rate(email_to_telegram_retry_attempts_total{result="succeeded"}[5m])`                                           |
| `email_to_telegram_deliveries_lost_total{stage}`                   | counter   | Delivery logs closed as `permanently_failed` by stage: `initial`, `retry`, `cleanup` (raw email expired)                                              | `sum by (stage)(increase(email_to_telegram_deliveries_lost_total[7d]))`                                          |
| `email_to_telegram_deliveries_deferred_total`                      | counter   | Backpressure: accepted mail left for the retry worker because `MAX_INFLIGHT_DELIVERIES` was reached (not the preflight deferral)                      | `increase(email_to_telegram_deliveries_deferred_total[24h])`                                                     |
| `email_to_telegram_delivery_latency_seconds_*{path}`               | histogram | `received_at` to Telegram accepting the first message of a successful delivery; `path` = `initial` or `retry`                                         | `histogram_quantile(0.95, sum by (le)(rate(email_to_telegram_delivery_latency_seconds_bucket[1h])))`             |
| `email_to_telegram_delivery_backlog{state}`                        | gauge     | Delivery logs not in a final state, by `final_status` (`received`, `processing`, `retrying`, `failed`)                                                | `sum(email_to_telegram_delivery_backlog)`                                                                        |
| `email_to_telegram_delivery_backlog_oldest_age_seconds`            | gauge     | Age of the oldest non-final delivery log; 0 when there is none                                                                                        | `email_to_telegram_delivery_backlog_oldest_age_seconds > 600`                                                    |
| `email_to_telegram_rich_messages_total{result}`                    | counter   | Rich-message outcomes: `success`, `fallback` (classic message sent instead), `disabled`                                                               | `sum by (result)(increase(email_to_telegram_rich_messages_total[1h]))`                                           |
| `email_to_telegram_rich_ineligible_total{reason}`                  | counter   | Classic sends whose body hit a rich limit: first limit hit, or `delivery_budget` (header or attachments). Not privacy mode or `fallback`              | `sum by (reason)(increase(email_to_telegram_rich_ineligible_total[1h]))`                                         |
| `email_to_telegram_telegram_send_failures_total{error_class}`      | counter   | Telegram send failures bucketed by error class                                                                                                        | `topk(5, sum by (error_class)(rate(email_to_telegram_telegram_send_failures_total[1h])))`                        |
| `email_to_telegram_quota_rejections_total{reason}`                 | counter   | Quota rejections by reason                                                                                                                            | `sum by (reason)(rate(email_to_telegram_quota_rejections_total[1h]))`                                            |
| `email_to_telegram_activation_notices_total{stage,result}`         | counter   | Bounce notices to the owner of a not-yet-working alias; `stage` = `raw` or `preflight`, `result` below                                                | `sum by (result)(increase(email_to_telegram_activation_notices_total[7d]))`                                      |
| `email_to_telegram_activation_allows_total{result}`                | counter   | Taps on a notice's one-tap allow: `added`, `expired` (spent, replaced, expired or stale button), `failed` (rule limit or DB error)                    | `increase(email_to_telegram_activation_allows_total{result="added"}[7d])`                                        |
| `email_to_telegram_bot_updates_skipped_total{reason}`              | counter   | Telegram updates received but not handled: `stale` = a text message older than `STALE_TEXT_UPDATE_MAX_AGE_S` (a backlog after an outage)              | `increase(email_to_telegram_bot_updates_skipped_total{reason="stale"}[24h])`                                     |
| `email_to_telegram_manual_plan_grants_total{plan}`                 | counter   | Manual billing plan grants                                                                                                                            | `increase(email_to_telegram_manual_plan_grants_total[7d])`                                                       |
| `email_to_telegram_http_requests_total{route,method,status_class}` | counter   | HTTP request count                                                                                                                                    | `sum by (status_class)(rate(email_to_telegram_http_requests_total[5m]))`                                         |
| `email_to_telegram_http_request_duration_seconds_*`                | histogram | HTTP latency histogram (`_bucket`, `_sum`, `_count`)                                                                                                  | `histogram_quantile(0.95, sum by (le, route)(rate(email_to_telegram_http_request_duration_seconds_bucket[5m])))` |

`users{state="ever_delivered"}` counts users with `delivered_count > 0` in any
month of `user_usage_months`. That counter moves when mail is accepted into
delivery and is refunded on a permanent Telegram failure. It is read from
`user_usage_months`, not `delivery_logs`, because free-plan delivery logs are
purged after 7 days.

`activation_notices_total` results: `sent` (Telegram accepted the notice),
`gated` (the alias already delivered, is not active, or is older than 7 days
with an owner who had mail accepted),
`not_claimed` (the 24 h window or the 3-notice lifetime budget of the alias,
or a concurrent bounce took the claim), `dropped` (the bounded queue was full
or shutting down, or a deadline stopped the job), `stale` (the alias or its
claim changed before the send), `failed` (a DB or Telegram error). A claim is
spent before the send, so `failed` and `dropped` after a claim still use up
budget. Conversion, from the database (`first_sent_at` is the first
acknowledged notice):

```sql
SELECT count(*) FILTER (WHERE first_sent_at IS NOT NULL) AS notified,
       count(*) FILTER (WHERE first_delivered_at > first_sent_at) AS delivered_after,
       count(*) FILTER (WHERE claims_used > 0 AND first_sent_at IS NULL) AS claimed_never_sent
FROM alias_activation;
```

The `delivery_backlog` gauges are refreshed on every scrape from the partial
index `idx_log_backlog_received` (migration `0010`), which holds only the
non-final rows, so a scrape does not scan `delivery_logs`.

## Adding a new business gauge

1. Add a count helper in `src/db/repos/<table>.ts`.
2. Register the `Gauge` in `src/observability/metrics.ts`.
3. Add a refresh function and wire it into `refreshBusinessGauges`.
4. Update `tests/unit/http/metrics.test.ts` to assert the new series is exposed.
5. Add a panel to a dashboard under `monitoring/grafana/provisioning/dashboards/json/`.
6. Document the metric in the catalog above.

## Adding a new scrape target

Edit `monitoring/prometheus/prometheus.yml`. Add a job under `scrape_configs`:

```yaml
- job_name: my_service
  metrics_path: /metrics
  scheme: http
  bearer_token_file: /etc/prometheus/secrets/my_service_token
  static_configs:
    - targets: ["my-service:3000"]
```

Pass the token to the `Deploy Monitoring` render step and write it in `monitoring/deploy/render-payload.sh` next to the app tokens (`bearer/`), so `stack-deploy.sh` lands it at `~/monitoring/prometheus/secrets/my_service_token`. Redeploy via the workflow. Confirm the target is `UP` in `/targets`.

## Production scraping

Prod scraping is **enabled**: the `email_to_telegram_prod` job in
`monitoring/prometheus/prometheus.yml` scrapes `10.0.88.2:3000`. The app
dashboards default to `env=prod`. If it ever needs re-enabling from
scratch:

1. Confirm prod is reachable from the staging VM over VPN:
   ```sh
   ssh <staging-host> 'curl -sS http://<prod-private-ip>:3000/healthz'
   ```
2. Ensure the `email_to_telegram_prod` job exists in `monitoring/prometheus/prometheus.yml`.
3. Ensure the GitHub secret `METRICS_BEARER_TOKEN_PROD` matches prod's `METRICS_TOKEN` in its `.env`.
4. Push to `main` and re-run `Deploy Monitoring`.
5. Verify the new target is `UP` in Prometheus.

## Retention and disk

- Loki: 7 days (configured in `monitoring/loki/loki-config.yml`); the compactor deletes older chunks asynchronously, after a 2-hour delay.
- Container log files on each VM: json-file, rotated by size (app and agent 10 MB × 3). Docker removes them with the container on every recreate. They have no age guarantee: on a quiet service they can hold lines for longer than 7 days, until the next rotation or recreate.
- Prometheus: 90 days (`--storage.tsdb.retention.time=90d` in the compose
  command). Raised from 15d in 2026-07 so the 30d business-trend panels
  (delivered/day, user growth) have history; at this metric cardinality the
  disk cost is a few hundred MB.
- Storage lives in named Docker volumes (`prometheus_data`, `grafana_data`, `loki_data`), not in `~/monitoring/`. Compose-managed; do not edit the volume contents directly.

Inspect volume disk usage:

```sh
ssh <staging-host> 'docker system df -v | grep -E "^(VOLUME|monitoring_)"'
```

Prune unused images when low on space:

```sh
docker image prune -f
```

Do not `docker volume prune` blindly — it can wipe Grafana dashboards if the volume is detached.

Check that retention actually deletes data, separately from what queries show. Loki logs at `warn` (at `info` it would log every query's text, identifiers included), so the compactor's progress comes from its metrics. On the staging VM:

```sh
cd ~/monitoring
dc() { docker compose -f docker-compose.monitoring.yml --env-file .env "$@"; }
# Compactor and sweeper ran: a recent timestamp, marker files being processed.
metrics=$(dc exec -T loki wget -qO- http://127.0.0.1:3100/metrics)
grep -E '^loki_boltdb_shipper_(apply_retention_last_successful_run_timestamp_seconds|retention_sweeper_marker_files_(current|deleted_total))' <<<"$metrics"
# No chunk file older than retention plus the delete delay is left on disk.
dc exec -T loki find /loki/chunks -type f -mmin +$((7 * 24 * 60 + 180)) | wc -l   # 0
```

## Formal erasure requests

Application logs hold identifiers (Telegram user and chat IDs, IP addresses, alias names, delivery and error codes), not message content. `/delete_me` does not remove them one by one: they expire with the Loki retention and, on the VMs, with rotation or the next recreate of the app container. A formal erasure request that cannot wait is handled in both stores.

1. Loki, on the staging VM. One delete request per identifier; repeat for each chat ID, alias name or IP. The identifier is read from a prompt, so it stays out of the shell history:

   ```sh
   cd ~/monitoring
   read -r -p 'identifier: ' ident
   q="{compose_project=\"email-to-telegram\", service=\"app\"} |= \"$ident\""
   enc=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().rstrip("\n")))' <<<"$q")
   start=$(( $(date +%s) - 8 * 86400 ))
   docker compose -f docker-compose.monitoring.yml --env-file .env exec -T loki \
     wget -qO- --post-data= "http://127.0.0.1:3100/loki/api/v1/delete?query=$enc&start=$start"
   unset ident q enc
   # List requests and their status (received, then processed):
   docker compose -f docker-compose.monitoring.yml --env-file .env exec -T loki \
     wget -qO- http://127.0.0.1:3100/loki/api/v1/delete
   ```

   Loki waits out its 24-hour cancellation period, then the compactor deletes the matching lines in both environments; `loki_compactor_pending_delete_requests_count` returns to 0 when it is done.

   Traces of the request itself: Loki logs at `warn`, so neither the delete request nor any query writes the identifier into Loki's container log. The delete request (its query, with the identifier) stays in Loki's compactor store (`/loki/compactor/deletion/` in the `loki_data` volume on the staging VM) as the record that the erasure was carried out; only the operator can read it. Do not search for the identifier in Grafana Explore: Grafana keeps its own query history.

2. The local log files on prod: recreate the app container only, on its current image, all under one hold of the host lock (inspection, recreate and the check that the old container is gone). Postgres is not touched. A plain redeploy of an unchanged release does not recreate the container and is not enough.

   ```sh
   cd ~/email-to-telegram
   flock -w 900 ~/.etg-deploy.lock bash -euo pipefail -c '
     old=$(docker inspect --format "{{.Id}}" "$(docker compose --env-file .env ps -q app)")
     image=$(docker inspect --format "{{.Config.Image}}" "$old")
     echo "recreating app container $old on $image"
     IMAGE_TAG="${image##*:}" docker compose --env-file .env up -d --force-recreate --no-deps app
     ids=$(docker ps -aq --no-trunc)
     [[ "$ids" != *"$old"* ]] || { echo "old container $old still exists" >&2; exit 1; }
     docker run --rm -v /var/lib/docker/containers:/c:ro busybox:1.37 test ! -e "/c/$old" ||
       { echo "/var/lib/docker/containers/$old still exists" >&2; exit 1; }
     echo "old container $old and its log directory are gone"
   '
   ```

   Repeat on staging if the person also used the staging bot.

## Operator alerts (Telegram)

The app pushes critical alerts straight to `ALERT_CHAT_ID` from the 5-minute
uptime check (`src/utils/uptime.ts`). The message lists the failing
dimensions: `db`, `disk`, `telegram`, `inbound`.

- **`inbound`** means the app is up but no mail can get in: the Cloudflare
  Worker → `/inbound/raw` contract is failing (signature version/secret/replay
  rejections) with **zero accepted inbound** in the last hour. A correctly
  deployed Worker never trips this. When it fires, check that the prod Worker
  is deployed and on the v2 signature scheme — it is deployed separately from
  the VPS app via `wrangler deploy --env production` (see
  `cloudflare-worker/`). This alert exists because a v1.2.0 app change went
  v2-only while the prod Worker was still on v1, and inbound was silently down
  for ~9 days. See `docs/agent/DECISIONS.md`.

### External heartbeat (healthchecks.io)

With `HEALTHCHECKS_URL` set, the same check also reports to healthchecks.io,
independently of Telegram configuration:

- all probes pass: GET `<url>` (success ping);
- a dimension reaches the alert threshold (2 consecutive failures): POST
  `<url>/fail` with body `health probe failed: <dimensions>`, every run until
  it recovers. healthchecks.io notifies immediately and shows the body as
  "Last Ping Body";
- a single failing run: nothing, and the grace time absorbs the missed ping.

App or host down shows up as missing pings after period plus grace. Configure
each check with period 5 min and grace 10 min. The body carries only fixed
text and dimension names, as the hosted privacy page promises.

## Troubleshooting

- **Grafana shows "no data"**: inspect the Prometheus targets endpoint from inside the container (port 9090 is not published on the host):
  ```sh
  ssh <staging-host> 'cd ~/monitoring && docker compose -f docker-compose.monitoring.yml --env-file .env exec prometheus wget -qO- http://127.0.0.1:9090/api/v1/targets' | jq
  ```
- **Promtail not shipping logs**: confirm the `docker_socket_proxy` container is healthy (`docker compose ... ps`) and that `/var/lib/docker/containers` is mounted read-only into promtail. Promtail talks to the proxy at `tcp://docker_socket_proxy:2375`, not the host docker socket directly. Only the app container is shipped; other containers are dropped on purpose.
- **`node` or `postgres` target down**: `401 Unauthorized` means Prometheus and the exporters disagree on the credential: `EXPORTER_BASIC_AUTH_USER` or `EXPORTER_BASIC_AUTH_PASSWORD` differ between the two environments, or one side was not redeployed after a change. An `x509` error means the VM's certificate does not chain to `monitoring/tls/ca.crt` or lacks its IP. A timeout on `:9100` only is the host firewall (see [Host agent](#host-agent)). `pg_up 0` with the target up means the exporter cannot log in: check `docker compose -p etg-agent ... logs postgres-exporter` and redeploy the agent, which reconciles the role.
- **Prod app lines (15 min) stays 0**: on prod, `docker compose -p etg-agent -f ~/monitoring-agent/docker-compose.agent.yml --env-file ~/monitoring-agent/.env logs --tail 50 promtail` shows push errors (`401`, `x509`, connection refused). If Promtail is quiet, check that the running app has the logging labels: `docker inspect --format '{{json .HostConfig.LogConfig}}' email-to-telegram-app-1` must list `labels`; a release from before that option ships nothing.
- **`bearer token authentication failed`**: the token file in `~/monitoring/prometheus/secrets/` does not match `METRICS_TOKEN` in the scraped app's `.env`. Rotate both sides via GitHub secrets and re-run `Deploy Monitoring`.
- **Grafana login fails after rotating password**: restart the Grafana container; the admin password env var is only read at startup.
- **`/api/live/ws` 401 loop (dashboards don't auto-refresh; log spam)**: symptom is a flood of `path=/api/live/ws status=401 userId=0` lines in `docker logs monitoring-grafana-1`, all from the Caddy host IP, while ordinary requests authenticate as `userId=1`. Cause is `GRAFANA_ROOT_URL` pointing at the internal `http://<vm-private-ip>:3001/` while browsers reach Grafana via Caddy at `https://grafana.example.com` — the Live WebSocket origin check derives allowed origins from `root_url`, so the mismatch rejects every upgrade. Fix: set `GRAFANA_ROOT_URL` to the Caddy URL (e.g. `https://grafana.example.com/`) in `~/monitoring/.env` and `docker compose -f docker-compose.monitoring.yml --env-file .env up -d grafana` (env is read only at startup). Verify a fresh browser connect logs `path=/api/live/ws status=-1 userId=1` (a successful upgrade), not `401`.

## Out of scope

- Alertmanager. The app already pushes operator alerts to Telegram via `ALERT_CHAT_ID`; Prometheus-side alerting is not wired up.
- Public Grafana exposure. Access stays LAN/VPN-only; Caddy 404s the public internet and no monitoring port binds to a public IP.
- Multi-region scraping. Single staging-VM scraper only; HA Prometheus is not in scope.
- Logs of any container other than the app. Postgres logs can contain statement text with values.
- Lossless log delivery (see [Prod logs](#prod-logs)).

## Known tech debt

- **Promtail is past Grafana's LTS window.** Grafana's recommended replacement is [Alloy](https://grafana.com/docs/alloy/latest/) with the `loki.source.docker` component. The 2.9.10 image still functions; migration to Alloy is tracked as a follow-up and will replace `monitoring/promtail/`, `monitoring/agent/promtail/` and both `promtail` compose services.
