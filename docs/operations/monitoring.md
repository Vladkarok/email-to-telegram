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

Required variables in `~/monitoring/.env` (read by docker compose at boot):

- `MONITORING_BIND_IP` — private interface IP for Grafana publish (e.g. the VPN IP). Compose refuses to start if unset.
- `GRAFANA_ADMIN_PASSWORD` — initial Grafana admin password. Required.
- `GRAFANA_ROOT_URL` — full URL operators use to reach Grafana, including trailing slash (e.g. `http://10.0.88.3:3001/`). Required; Grafana uses this for redirects and shared links.
- `GRAFANA_ADMIN_USER` — optional, defaults to `admin`.

**Bearer tokens are not in `~/monitoring/.env`.** Scrape auth comes from the GitHub repository secrets `METRICS_BEARER_TOKEN_STAGING` / `METRICS_BEARER_TOKEN_PROD`. The deploy workflow writes them into `~/monitoring/prometheus/secrets/{staging_token,prod_token}` on the host. Each secret must exactly match `METRICS_TOKEN` in the corresponding app deployment's `.env`; if they drift, Prometheus targets go red with `401 Unauthorized`. Rotate via the GitHub secret UI and re-run the workflow.

Trigger the `Deploy Monitoring` GitHub Action from the Actions tab to bring the stack up.

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
| `email_to_telegram_users_total`                                    | gauge     | Total users across all plans                              | `email_to_telegram_users_total`                                                                                  |
| `email_to_telegram_active_users_by_plan{plan}`                     | gauge     | Active users by plan                                      | `email_to_telegram_active_users_by_plan{plan="pro"}`                                                             |
| `email_to_telegram_chats{state}`                                   | gauge     | Chats by state (`total`, `active`)                        | `email_to_telegram_chats{state="active"}`                                                                        |
| `email_to_telegram_aliases{status}`                                | gauge     | Aliases grouped by status (`active`, `paused`, `deleted`) | `sum by (status)(email_to_telegram_aliases)`                                                                     |
| `email_to_telegram_attachments_stored`                             | gauge     | Stored attachment count                                   | `email_to_telegram_attachments_stored`                                                                           |
| `email_to_telegram_attachments_stored_bytes`                       | gauge     | Total stored attachment bytes                             | `email_to_telegram_attachments_stored_bytes / 1024 / 1024 / 1024`                                                |
| `email_to_telegram_delivery_attempts_total{result}`                | counter   | Delivery attempts by result                               | `sum by (result)(rate(email_to_telegram_delivery_attempts_total[5m]))`                                           |
| `email_to_telegram_retry_attempts_total{result}`                   | counter   | Retry attempts by result                                  | `rate(email_to_telegram_retry_attempts_total{result="succeeded"}[5m])`                                           |
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
- Prometheus: 15 days (`--storage.tsdb.retention.time=15d` in the compose command).
- Storage lives in named Docker volumes (`prometheus_data`, `grafana_data`, `loki_data`), not in `~/monitoring/`. Compose-managed; do not edit the volume contents directly.

Inspect volume disk usage:

```sh
ssh kc-vprojects 'docker system df -v | grep -E "^(VOLUME|monitoring_)"'
```

Prune unused images when low on space:

```sh
docker image prune -f
```

Do not `docker volume prune` blindly — it can wipe Grafana dashboards if the volume is detached.

## Troubleshooting

- **Grafana shows "no data"**: inspect the Prometheus targets endpoint from inside the container (port 9090 is not published on the host):
  ```sh
  ssh kc-vprojects 'cd ~/monitoring && docker compose -f docker-compose.monitoring.yml --env-file .env exec prometheus wget -qO- http://127.0.0.1:9090/api/v1/targets' | jq
  ```
- **Promtail not shipping logs**: confirm the `docker_socket_proxy` container is healthy (`docker compose ... ps`) and that `/var/lib/docker/containers` is mounted read-only into promtail. Promtail talks to the proxy at `tcp://docker_socket_proxy:2375`, not the host docker socket directly.
- **`bearer token authentication failed`**: the token file in `~/monitoring/prometheus/secrets/` does not match `METRICS_TOKEN` in the scraped app's `.env`. Rotate both sides via GitHub secrets and re-run `Deploy Monitoring`.
- **Grafana login fails after rotating password**: restart the Grafana container; the admin password env var is only read at startup.

## Out of scope

- Alertmanager. The app already pushes operator alerts to Telegram via `ALERT_CHAT_ID`; Prometheus-side alerting is not wired up.
- Public Grafana exposure. Access stays VPN-only.
- Multi-region scraping. Single staging-VM scraper only; HA Prometheus is not in scope.

## Known tech debt

- **Promtail is past Grafana's LTS window.** Grafana's recommended replacement is [Alloy](https://grafana.com/docs/alloy/latest/) with the `loki.source.docker` component. The 2.9.10 image still functions; migration to Alloy is tracked as a follow-up and will replace `monitoring/promtail/` plus the `promtail` compose service.
