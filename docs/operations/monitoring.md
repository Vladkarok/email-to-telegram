# Monitoring Stack

## Overview

A self-hosted Prometheus + Grafana + Loki stack runs on the staging VM alongside the application containers. Co-locating it with staging keeps cost and operational surface low while letting the same instance optionally scrape production. Grafana is fronted by a Caddy reverse proxy (vhost `grafana.example.com`, configured outside this repo) and reachable only from the LAN / WireGuard VPN — Caddy returns 404 to any request from the public internet. Grafana's raw port is still published on the private VPN interface (see below) but the canonical access path is the Caddy HTTPS URL.

## Architecture

```
                            staging VM
 +-------------------------------------------------------------+
 |                                                             |
 |  docker compose: app                docker compose: monitoring
 |  +--------------------+              +---------------------+ |
 |  |  app (Node)        |              |  prometheus         | |
 |  |   :3000 /metrics   |<--scrape-----|   :9090             | |
 |  |                    |   (bearer)   |                     | |
 |  +---------+----------+              +---+-------+---------+ |
 |            |                             |       |           |
 |            | stdout logs                 |       |           |
 |            v                             v       v           |
 |  /var/lib/docker/containers          +-------+ +-----+       |
 |            ^                         | loki  | |grafa|       |
 |            |                         | :3100 | | na  |       |
 |  +---------+----------+   push       +---+---+ |:3001|       |
 |  |  promtail          |------------------>     +--+--+       |
 |  +--------------------+                          |           |
 |                                                  |           |
 |  networks:                                       |           |
 |   - monitoring_scrape   (external, app + prom)   |           |
 |   - monitoring_internal (prom, loki, grafana,    |           |
 |                          promtail)               |           |
 +--------------------------------------------------+-----------+
                                                    |
                                                    v
                                        VPN client (operator laptop)
                                        http://<VPN-IP>:3001

  # Enabled: prometheus --scrape--> prod app (10.0.88.2:3000) over the
  # private network (job email_to_telegram_prod in prometheus.yml).
  # Loki/promtail, however, ship STAGING container logs only — prod logs
  # do not reach Loki yet.
```

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
- `GRAFANA_ADMIN_PASSWORD` — initial Grafana admin password. Required.
- `GRAFANA_ROOT_URL` — full URL operators use to reach Grafana, including trailing slash. **Must be the public Caddy URL** (e.g. `https://grafana.example.com/`), not the internal `http://<vm-private-ip>:3001/`. Grafana uses this for redirects, shared links, **and the Grafana Live WebSocket origin check**: if it points at the internal IP while the browser reaches Grafana via Caddy, the browser Origin no longer matches and every `/api/live/ws` upgrade is rejected `401`, producing a reconnect loop (see Troubleshooting).
- `GRAFANA_ADMIN_USER` — optional, defaults to `admin`.

**Bearer tokens are not in `~/monitoring/.env`.** Scrape auth comes from the GitHub repository secrets `METRICS_BEARER_TOKEN_STAGING` / `METRICS_BEARER_TOKEN_PROD`. The deploy workflow writes them into `~/monitoring/prometheus/secrets/{staging_token,prod_token}` on the host. Each secret must exactly match `METRICS_TOKEN` in the corresponding app deployment's `.env`; if they drift, Prometheus targets go red with `401 Unauthorized`. Rotate via the GitHub secret UI and re-run the workflow.

Trigger the `Deploy Monitoring` GitHub Action from the Actions tab to bring the stack up.

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

- Top row, always visible: Scrape up · Version · Uptime · Offered (24h,
  preflight decisions without signature failures) · Delivered (24h, first
  attempts plus retries) · Lost (7d, permanently failed retries; red above 0) ·
  Backlog now (pending logs and the oldest one's age) · Latency (24h, delivery
  p95).
- **Inbound**: preflight decisions per hour (accepted / deferred / bounced),
  preflight bounces by reason, raw uploads per hour (accepted / rejected), raw
  rejections by reason.
- **Delivery**: deliveries per hour by path and result, delivery latency p50 /
  p95, first-attempt success rate per hour, delivery backlog, Telegram send
  failures by class, rich vs classic fallback, backpressure (24h stat and per
  hour).
- **HTTP**: requests per hour by status class and by route, p95 latency by route
  (1 h window). `/healthz` and `/metrics` are excluded: probe and scrape traffic
  would otherwise drown real requests.
- **Logs** (collapsed): app error logs from Loki for the selected env. Only
  staging ships logs today, so prod stays empty until promtail runs there.
- **Host & database** (collapsed): root filesystem free, memory available,
  load, swap, `pg_up`, connections and size of the `emailtelegram` database,
  off-site backup age (red above 30 h). These read node_exporter (job `node`)
  and postgres_exporter (job `postgres`), both labelled `env`, and
  `etg_offsite_backup_last_success_timestamp_seconds` from node_exporter's
  textfile collector. They show "No data" until those exporters are deployed.

**Email to Telegram – Product** (`e2t-product`, default range 30 d, refresh 5
min): activation funnel (signed up → created an alias → ever received mail →
received mail this month), users and aliases over time, delivered per day,
quota rejections per day by reason, users by plan, aliases by status, chats,
attachments storage.

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
| `email_to_telegram_deliveries_deferred_total`                      | counter   | Backpressure: accepted mail left for the retry worker because `MAX_INFLIGHT_DELIVERIES` was reached (not the preflight deferral)                      | `increase(email_to_telegram_deliveries_deferred_total[24h])`                                                     |
| `email_to_telegram_delivery_latency_seconds_*{path}`               | histogram | `received_at` to Telegram accepting the first message of a successful delivery; `path` = `initial` or `retry`                                         | `histogram_quantile(0.95, sum by (le)(rate(email_to_telegram_delivery_latency_seconds_bucket[1h])))`             |
| `email_to_telegram_delivery_backlog{state}`                        | gauge     | Delivery logs not in a final state, by `final_status` (`received`, `processing`, `retrying`, `failed`)                                                | `sum(email_to_telegram_delivery_backlog)`                                                                        |
| `email_to_telegram_delivery_backlog_oldest_age_seconds`            | gauge     | Age of the oldest non-final delivery log; 0 when there is none                                                                                        | `email_to_telegram_delivery_backlog_oldest_age_seconds > 600`                                                    |
| `email_to_telegram_rich_messages_total{result}`                    | counter   | Rich-message outcomes: `success`, `fallback` (classic message sent instead), `disabled`                                                               | `sum by (result)(increase(email_to_telegram_rich_messages_total[1h]))`                                           |
| `email_to_telegram_telegram_send_failures_total{error_class}`      | counter   | Telegram send failures bucketed by error class                                                                                                        | `topk(5, sum by (error_class)(rate(email_to_telegram_telegram_send_failures_total[1h])))`                        |
| `email_to_telegram_quota_rejections_total{reason}`                 | counter   | Quota rejections by reason                                                                                                                            | `sum by (reason)(rate(email_to_telegram_quota_rejections_total[1h]))`                                            |
| `email_to_telegram_manual_plan_grants_total{plan}`                 | counter   | Manual billing plan grants                                                                                                                            | `increase(email_to_telegram_manual_plan_grants_total[7d])`                                                       |
| `email_to_telegram_http_requests_total{route,method,status_class}` | counter   | HTTP request count                                                                                                                                    | `sum by (status_class)(rate(email_to_telegram_http_requests_total[5m]))`                                         |
| `email_to_telegram_http_request_duration_seconds_*`                | histogram | HTTP latency histogram (`_bucket`, `_sum`, `_count`)                                                                                                  | `histogram_quantile(0.95, sum by (le, route)(rate(email_to_telegram_http_request_duration_seconds_bucket[5m])))` |

`users{state="ever_delivered"}` counts users with `delivered_count > 0` in any
month of `user_usage_months`. That counter moves when mail is accepted into
delivery and is refunded on a permanent Telegram failure. It is read from
`user_usage_months`, not `delivery_logs`, because free-plan delivery logs are
purged after 7 days.

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

Add the bearer token to the `Deploy Monitoring` workflow so it lands at `~/monitoring/prometheus/secrets/my_service_token`. Redeploy via the workflow. Confirm the target is `UP` in `/targets`.

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

- Loki: 7 days (configured in `monitoring/loki/loki-config.yml`).
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
- **Promtail not shipping logs**: confirm the `docker_socket_proxy` container is healthy (`docker compose ... ps`) and that `/var/lib/docker/containers` is mounted read-only into promtail. Promtail talks to the proxy at `tcp://docker_socket_proxy:2375`, not the host docker socket directly.
- **`bearer token authentication failed`**: the token file in `~/monitoring/prometheus/secrets/` does not match `METRICS_TOKEN` in the scraped app's `.env`. Rotate both sides via GitHub secrets and re-run `Deploy Monitoring`.
- **Grafana login fails after rotating password**: restart the Grafana container; the admin password env var is only read at startup.
- **`/api/live/ws` 401 loop (dashboards don't auto-refresh; log spam)**: symptom is a flood of `path=/api/live/ws status=401 userId=0` lines in `docker logs monitoring-grafana-1`, all from the Caddy host IP, while ordinary requests authenticate as `userId=1`. Cause is `GRAFANA_ROOT_URL` pointing at the internal `http://<vm-private-ip>:3001/` while browsers reach Grafana via Caddy at `https://grafana.example.com` — the Live WebSocket origin check derives allowed origins from `root_url`, so the mismatch rejects every upgrade. Fix: set `GRAFANA_ROOT_URL` to the Caddy URL (e.g. `https://grafana.example.com/`) in `~/monitoring/.env` and `docker compose -f docker-compose.monitoring.yml --env-file .env up -d grafana` (env is read only at startup). Verify a fresh browser connect logs `path=/api/live/ws status=-1 userId=1` (a successful upgrade), not `401`.

## Out of scope

- Alertmanager. The app already pushes operator alerts to Telegram via `ALERT_CHAT_ID`; Prometheus-side alerting is not wired up.
- Public Grafana exposure. Access stays LAN/VPN-only; Caddy 404s the public internet and no monitoring port binds to a public IP.
- Multi-region scraping. Single staging-VM scraper only; HA Prometheus is not in scope.

## Known tech debt

- **Promtail is past Grafana's LTS window.** Grafana's recommended replacement is [Alloy](https://grafana.com/docs/alloy/latest/) with the `loki.source.docker` component. The 2.9.10 image still functions; migration to Alloy is tracked as a follow-up and will replace `monitoring/promtail/` plus the `promtail` compose service.
