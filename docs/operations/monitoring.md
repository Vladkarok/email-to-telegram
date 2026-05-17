# Monitoring Stack

## Overview

A self-hosted Prometheus + Grafana + Loki stack runs on the staging VM (`kc-vprojects`) alongside the application containers. Co-locating it with staging keeps cost and operational surface low while letting the same instance optionally scrape production. Grafana is reachable only through the WireGuard VPN; no monitoring port is published to the public internet.

## Architecture

```
                      kc-vprojects (staging VM)
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

  # Optional, disabled by default:
  # prometheus --scrape--> prod app (10.0.88.2:3000) over VPN
```

## First-time setup on the VM

Run once on `kc-vprojects` as the deploy user:

```sh
docker network create monitoring_scrape
mkdir -p ~/monitoring/prometheus/secrets
```

Create `~/monitoring/.env` from the template (`monitoring/.env.example` in the repo):

```sh
cp monitoring/.env.example ~/monitoring/.env
openssl rand -hex 16   # use as GRAFANA_ADMIN_PASSWORD
```

Required variables in `~/monitoring/.env`:

- `GRAFANA_ADMIN_PASSWORD`
- `METRICS_BEARER_TOKEN_STAGING`
- `METRICS_BEARER_TOKEN_PROD` (placeholder if prod scraping is off)

`METRICS_BEARER_TOKEN_STAGING` and `METRICS_BEARER_TOKEN_PROD` must exactly match `METRICS_TOKEN` in the corresponding app deployment's `.env`. If they drift, Prometheus targets go red with `401 Unauthorized`.

Trigger the `Deploy Monitoring` GitHub Action from the Actions tab. It writes the bearer token files into `~/monitoring/prometheus/secrets/`, renders the compose file, and brings the stack up.

## Accessing Grafana

Connect to the WireGuard VPN, then open:

```
http://<VPN-IP>:3001
```

Replace `<VPN-IP>` with the VM's VPN address. Log in as `admin` with the password from `~/monitoring/.env`.

Verify the port is not exposed publicly:

```sh
ssh kc-vprojects 'ss -tlnp | grep 3001'
```

The output must bind to the VPN interface only (not `0.0.0.0`).

## Business metrics catalog

All gauges/counters are prefixed `email_to_telegram_`. Exposed at `GET /metrics` (bearer-protected).

| Metric                                                             | Type      | Description                                               | Example PromQL                                                                                                   |
| ------------------------------------------------------------------ | --------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `email_to_telegram_users{state}`                                   | gauge     | Users by state (`total`, `allowed`)                       | `email_to_telegram_users{state="allowed"}`                                                                       |
| `email_to_telegram_chats{state}`                                   | gauge     | Chats by state (`total`, `active`)                        | `email_to_telegram_chats{state="active"}`                                                                        |
| `email_to_telegram_aliases{status}`                                | gauge     | Aliases grouped by status (`active`, `paused`, `deleted`) | `sum by (status)(email_to_telegram_aliases)`                                                                     |
| `email_to_telegram_organizations_total`                            | gauge     | Total organizations                                       | `email_to_telegram_organizations_total`                                                                          |
| `email_to_telegram_active_organizations{plan}`                     | gauge     | Active orgs by plan                                       | `email_to_telegram_active_organizations{plan="pro"}`                                                             |
| `email_to_telegram_attachments_stored`                             | gauge     | Stored attachment count                                   | `email_to_telegram_attachments_stored`                                                                           |
| `email_to_telegram_attachments_stored_bytes`                       | gauge     | Total stored attachment bytes                             | `email_to_telegram_attachments_stored_bytes / 1024 / 1024 / 1024`                                                |
| `email_to_telegram_delivery_attempts_total{result}`                | counter   | Delivery attempts by result                               | `sum by (result)(rate(email_to_telegram_delivery_attempts_total[5m]))`                                           |
| `email_to_telegram_retry_attempts_total{result}`                   | counter   | Retry attempts by result                                  | `rate(email_to_telegram_retry_attempts_total{result="success"}[5m])`                                             |
| `email_to_telegram_telegram_send_failures_total{error_class}`      | counter   | Telegram send failures bucketed by error class            | `topk(5, sum by (error_class)(rate(email_to_telegram_telegram_send_failures_total[1h])))`                        |
| `email_to_telegram_quota_rejections_total{reason}`                 | counter   | Quota rejections by reason                                | `sum by (reason)(rate(email_to_telegram_quota_rejections_total[1h]))`                                            |
| `email_to_telegram_manual_plan_grants_total{plan}`                 | counter   | Manual billing plan grants                                | `increase(email_to_telegram_manual_plan_grants_total[7d])`                                                       |
| `email_to_telegram_http_requests_total{route,method,status_class}` | counter   | HTTP request count                                        | `sum by (status_class)(rate(email_to_telegram_http_requests_total[5m]))`                                         |
| `email_to_telegram_http_request_duration_seconds_*`                | histogram | HTTP latency histogram (`_bucket`, `_sum`, `_count`)      | `histogram_quantile(0.95, sum by (le, route)(rate(email_to_telegram_http_request_duration_seconds_bucket[5m])))` |

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

## Enabling production scraping

1. Confirm prod is reachable from the staging VM over VPN:
   ```sh
   ssh kc-vprojects 'curl -sS http://10.0.88.2:3000/healthz'
   ```
2. Uncomment the `email_to_telegram_prod` job in `monitoring/prometheus/prometheus.yml`.
3. Ensure the GitHub secret `METRICS_BEARER_TOKEN_PROD` matches prod's `METRICS_TOKEN` in its `.env`.
4. Push to `main` and re-run `Deploy Monitoring`.
5. Verify the new target is `UP` in Prometheus.

## Retention and disk

- Loki: 7 days (configured in `monitoring/loki/loki-config.yml`).
- Prometheus: 15 days (default `--storage.tsdb.retention.time`).
- Data volumes: `~/monitoring/data/prometheus`, `~/monitoring/data/loki`, `~/monitoring/data/grafana`.

Check disk usage:

```sh
ssh kc-vprojects 'docker system df && du -sh ~/monitoring/data/*'
```

Prune unused images/volumes when low on space:

```sh
docker system prune -f
```

Do not `docker volume prune` blindly — it can wipe Grafana dashboards if the volume is detached.

## Troubleshooting

- **Grafana shows "no data"**: check Prometheus targets. Port 9090 is not published, so tunnel it:
  ```sh
  ssh -L 9090:prometheus:9090 kc-vprojects
  ```
  Then open `http://localhost:9090/targets`.
- **Promtail not shipping logs**: confirm the container is on `monitoring_internal` and that `/var/run/docker.sock` and `/var/lib/docker/containers` are mounted read-only.
- **`bearer token authentication failed`**: the token file in `~/monitoring/prometheus/secrets/` does not match `METRICS_TOKEN` in the scraped app's `.env`. Rotate both sides via GitHub secrets and redeploy.
- **Grafana login fails after rotating password**: restart the Grafana container; the admin password env var is only read at startup.

## Out of scope

- Alertmanager. The app already pushes operator alerts to Telegram via `ALERT_CHAT_ID`; Prometheus-side alerting is not wired up.
- Public Grafana exposure. Access stays VPN-only.
- Multi-region scraping. Single staging-VM scraper only; HA Prometheus is not in scope.
