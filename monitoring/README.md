# Monitoring stack

Self-hosted Prometheus + Grafana + Loki + Promtail for the email-to-telegram
staging VM. Co-located on the same host as the app; Grafana is the only
service published to the host and only on a private VPN-reachable IP.

## Services

- **Prometheus** (`prom/prometheus:v2.55.1`) — scrapes the app `/metrics`
  endpoint using a bearer token. 90-day TSDB retention.
- **Grafana** (`grafana/grafana-oss:11.3.0`) — UI on
  `${MONITORING_BIND_IP}:3001`. Provisioned datasources and dashboards.
- **Loki** (`grafana/loki:2.9.10`) — single-binary, filesystem storage,
  7-day retention via compactor.
- **Promtail** (`grafana/promtail:2.9.10`) — Docker SD; ships container
  logs with labels `service`, `compose_project`, `container_name`, `env`.

## Dashboards

Provisioned from `grafana/provisioning/dashboards/json/`:

- **Email to Telegram – Operations** (`e2t-app`) — mail flow from preflight
  to Telegram: inbound, delivery, latency, backlog, HTTP, logs, host and
  database.
- **Email to Telegram – Product** (`e2t-product`) — activation funnel, users,
  aliases, daily volume, quota rejections.
- **Email to Telegram – Runtime** (`e2t-runtime`) — Node.js process health.

Panel guide: `docs/operations/monitoring.md#dashboards`.

## Networking

Two networks:

- `monitoring_internal` (bridge, this compose only) — grafana <-> prometheus <-> loki.
- `monitoring_scrape` (external, shared) — created once on the host with
  `docker network create monitoring_scrape`. The app compose joins this same
  network so Prometheus can resolve `app:3000`.

## Secrets

`./prometheus/secrets/staging_token` and `prod_token` are bind-mounted
read-only into Prometheus and referenced via `bearer_token_file`. The deploy
workflow writes those files from `METRICS_BEARER_TOKEN_STAGING` /
`METRICS_BEARER_TOKEN_PROD`. Never commit secret files.

Grafana admin credentials and the bind IP come from `./.env` (see
`.env.example`). Compose fails fast if `MONITORING_BIND_IP` or
`GRAFANA_ADMIN_PASSWORD` are unset.

## Adding a scrape target

Edit `prometheus/prometheus.yml`, add a new job (mirror the staging job),
then reload with `curl -X POST http://prometheus:9090/-/reload` from inside
the `monitoring_internal` network or restart the container. The prod job
(`10.0.88.2:3000` over the VPN) is enabled.

## Retention

- Prometheus: 90 days TSDB (`--storage.tsdb.retention.time=90d`).
- Loki: 7 days (`retention_period: 168h`).

See `docs/operations/monitoring.md` for the full operator runbook.
